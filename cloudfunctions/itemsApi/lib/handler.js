"use strict";

/**
 * itemsApi 纯函数 handler(docs/API_CONTRACT.md「itemsApi 协议」)。
 * handler(event, deps):身份只来自 deps.householdId,绝不从 event 读取任何身份字段;
 * 依赖注入以便离线测试。校验失败绝不写入;查询与列表永远过滤 deleted 为 false。
 * 提醒实体(issue #36 二阶段):独立 reminders 集合,绝不把提醒字段堆到 items
 * 文档上;create 增可选 reminder 参数,新增 remindList/remindComplete/remindClear/
 * remindSet 四个 action(remindSet:为已有物品把提醒设为所选日子——AI 没提取出
 * 日期或用户清过的物品也能补录,不必删掉重建)。PR #52 二轮复审 N1/N2/N3 收口:
 * 集合内另有每物品一条 slot 生命周期权威文档(单调轮次 rev + 跨操作欠账声明),
 * complete/set/clear 共享其 CAS 为线性化点——轮次单调绝不重用、每 item 至多
 * 一条 active、清除不复活、创建自愈凭可信欠账。家庭推导(#34 fail-closed)与
 * 共享家庭写硬门(双 marker)口径与 items 完全一致,不另起炉灶。
 */

var normalizeName = require("./normalize").normalizeName;
var checkWriteScopeBinding = require("./household").checkWriteScopeBinding;

var COLLECTION = "items";
var REMINDERS_COLLECTION = "reminders";
var NAME_MAX = 50;
var LOCATION_MAX = 200;
var NOTE_MAX = 200;
var OPERATION_ID_MAX = 64;
var QUERY_LIMIT = 20;
var LIST_DEFAULT = 50;
var LIST_MAX = 50;
// CloudBase 云函数端单次 get() 默认最多返回 100 条;query/list 必须显式分页拉全量,
// 否则家庭文档超过 100 条后被静默截断(query 漏匹配、list 降序基于截断集)。
var PAGE_SIZE = 100;
// 护栏:超过 100 页(1 万条)视为异常,如实抛错绝不静默截断(PR1 家庭规模远小于此)。
var MAX_PAGES = 100;
// 提醒类别(#36 冻结词表,与 extractDraft v2 的 remind_kind 同源)
var REMIND_KINDS = ["有效期", "开封后", "下次维护"];
// 提醒原话锚点上限(码点,与 extractDraft 的 quote 口径一致)
var REMIND_QUOTE_MAX = 200;
// 周期再生的天数护栏:0-3650(10 年),防误传巨值生成荒谬日期
var REMIND_PERIOD_MAX = 3650;
var REMIND_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

var ERROR_MESSAGES = {
  INVALID_INPUT: "输入不合法,请检查后重试",
  NOT_FOUND: "没有找到这条记录",
  VERSION_CONFLICT: "内容已被修改,已为你刷新,请重试",
  UNAUTHORIZED: "请先登录",
  OPERATION_CONFLICT: "这条已保存过且内容与当前填写不同,请到详情页修改",
  FAMILY_SWITCHED: "家庭已切换,本次操作未保存,请确认当前家庭后重试",
  FAMILY_STALE_SCOPE: "家庭刚发生成员或作用域变化,本次操作未保存,请刷新后重试"
};

function fail(error) {
  return { ok: false, error: error, message: ERROR_MESSAGES[error] };
}

/** 同 operation_id 重放时的内容比对(创建幂等只对「同键同内容」成立) */
function sameCreateContent(doc, name, locationText, note) {
  var noteNorm = note === undefined ? "" : note;
  return (
    doc.name === name &&
    doc.location_text === locationText &&
    (doc.note || "") === noteNorm
  );
}

/** 提醒三元组逐字段比对(due_date/kind/quote;quote 缺省按空串归一) */
function sameReminderContent(doc, reminder) {
  return (
    doc.due_date === reminder.due_date &&
    doc.kind === reminder.kind &&
    (doc.quote || "") === (reminder.quote || "")
  );
}

/**
 * 原键重放的提醒对账(PR #52 Low-1 + 二轮 N3):物品内容一致时,再按
 * 「已存 active 提醒」与 slot 欠账可信史裁定,返回 null / "HEAL" /
 * "CONFLICT" / "STALE":
 * - 请求不带提醒而已存 active:提醒被清过的重试,显式冲突(绝不静默保留);
 * - 请求带提醒而已存 active:内容一致=原键原提醒重放(幂等成功),
 *   不一致=原键但提醒变更,显式冲突(指向详情页改,绝不静默吞);
 * - 已存无 active 且 slot 有未消费的 create 欠账:首建追加中断的自愈窗口,
 *   同内容 → HEAL 按欠账补建;换内容 → CONFLICT(原键提醒变更);
 * - 已存无 active 且无欠账:该物品的提醒此前被用户主动清除或完成过——
 *   没有可信欠账就拒绝猜测(N3):STALE 显式拒绝并引导详情页补录,
 *   用户主动清除的提醒绝不被自动复活。
 */
async function reconcileDuplicateReminder(deps, itemId, reminder) {
  var actives = await reminders(deps)
    .where({ household_id: deps.householdId, item_id: itemId, status: "active" })
    .get();
  var rows = (actives && actives.data) || [];
  if (rows.length > 0) {
    if (reminder === null) {
      return "CONFLICT";
    }
    for (var i = 0; i < rows.length; i++) {
      if (sameReminderContent(rows[i], reminder)) {
        return null;
      }
    }
    return "CONFLICT";
  }
  var slot = await ensureSlot(deps, itemId);
  var claim = readClaim(slot);
  if (claim && claim.kind === "create") {
    if (reminder === null) {
      // 首建本意带提醒,重试却不再带:原键提醒变更,显式冲突
      return "CONFLICT";
    }
    return claim.rd === reminder.due_date && claim.rk === reminder.kind && claim.rq === (reminder.quote || "")
      ? "HEAL"
      : "CONFLICT";
  }
  if (reminder === null) {
    return null; // 无欠账且不带提醒:普通幂等重放
  }
  return "STALE"; // 无可信欠账却带提醒:拒绝猜测,绝不复活已清除/已完成的提醒
}

/** N3 STALE 拒绝:明确告知提醒不会自动恢复,引导详情页按需补录 */
function reminderStaleConflict(doc) {
  return {
    ok: false,
    error: "OPERATION_CONFLICT",
    message: "这条的提醒此前已清除或已完成,不会自动恢复;如仍需要,请到详情页重新设置",
    existing: project(doc)
  };
}

/**
 * 同键异内容(或命中已删文档):明确冲突,绝不静默返回旧数据。
 * deleted 为 true 时不带 existing(内容已抹空,进详情页无意义)。
 */
function operationConflict(doc) {
  if (doc && doc.deleted) {
    return {
      ok: false,
      error: "OPERATION_CONFLICT",
      message: "这条记录已删除过,本次操作未保存,请重新记一件"
    };
  }
  return {
    ok: false,
    error: "OPERATION_CONFLICT",
    message: ERROR_MESSAGES.OPERATION_CONFLICT,
    existing: project(doc)
  };
}

/** 修改内容的稳定指纹(键排序后的 JSON 字符串):重放识别除 update_id 外还要求内容一致 */
function changesFingerprint(changes) {
  var keys = Object.keys(changes).sort();
  var parts = [];
  for (var i = 0; i < keys.length; i++) {
    parts.push(JSON.stringify(keys[i]) + ":" + JSON.stringify(changes[keys[i]]));
  }
  return "{" + parts.join(",") + "}";
}

function validUpdateId(v) {
  return isString(v) && v.length >= 1 && v.length <= OPERATION_ID_MAX;
}

/** 识别 CloudBase 唯一索引拒绝并发插入的错误(E11000 duplicate key) */
function isDuplicateKeyError(e) {
  var msg = e && e.message ? String(e.message) : "";
  return msg.indexOf("E11000") !== -1 || msg.indexOf("duplicate key") !== -1;
}

function isString(v) {
  return typeof v === "string";
}

/** 校验并清洗必填文本:去首尾空白后长度在 [min, max],非法返回 null */
function cleanRequired(v, max) {
  if (!isString(v)) {
    return null;
  }
  var trimmed = v.trim();
  if (trimmed.length < 1 || trimmed.length > max) {
    return null;
  }
  return trimmed;
}

/** 校验可选文本:未传返回 undefined;可传空串;去首尾空白后长度 ≤ max,非法返回 null */
function cleanOptional(v, max) {
  if (v === undefined) {
    return undefined;
  }
  if (!isString(v)) {
    return null;
  }
  var trimmed = v.trim();
  if (trimmed.length > max) {
    return null;
  }
  return trimmed;
}

/** 校验 item_id:非空字符串 */
function validItemId(v) {
  return isString(v) && v.length >= 1;
}

function collection(deps) {
  return deps.db.collection(COLLECTION);
}

/** query/list 返回的用户可见投影,绝不包含内部字段 */
function project(doc) {
  return {
    item_id: doc._id,
    name: doc.name,
    location_text: doc.location_text,
    note: doc.note,
    version: doc.version,
    updated_at: doc.updated_at
  };
}

/** updated_at 降序(ISO 字符串按字典序比较) */
function byUpdatedDesc(a, b) {
  if (a.updated_at === b.updated_at) {
    return 0;
  }
  return a.updated_at < b.updated_at ? 1 : -1;
}

// ---------- 提醒实体(issue #36 二阶段:独立 reminders 集合) ----------

function codePointLength(s) {
  return Array.from(s).length;
}

/**
 * 严格日期校验:YYYY-MM-DD 且为真实日历日(2026-02-30、无补零、斜杠分隔一律非法)。
 * #36 日期纪律:提醒日期只有「原话明确绝对日期(客户端已锚定)」与「用户日期
 * 选择器」两个来源,服务端无从也绝不判断语义,但格式必须严格,绝不放宽。
 */
function isValidDueDate(v) {
  if (!isString(v)) {
    return false;
  }
  var s = v.trim();
  if (!REMIND_DATE_RE.test(s)) {
    return false;
  }
  var year = Number(s.slice(0, 4));
  var month = Number(s.slice(5, 7));
  var day = Number(s.slice(8, 10));
  if (month < 1 || month > 12 || day < 1) {
    return false;
  }
  var leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  var daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= daysInMonth[month - 1];
}

/**
 * 校验 create 的可选 reminder 入参 { due_date, kind, quote? }。
 * 返回 null(未带提醒)/ "INVALID"(非法,调用方返回 INVALID_INPUT 且零写入)/
 * { due_date, kind, quote }(规范化后)。
 * quote 的「原话逐字子串」这条在服务端放宽:锚定由客户端在确认页完成,
 * create 时服务端没有原话可比对;日期选择器来源的提醒本就没有 quote。
 * 只做类型与长度校验;due_date 与 kind 必须严格。
 */
function parseReminderInput(reminder) {
  if (reminder === undefined || reminder === null) {
    return null;
  }
  if (typeof reminder !== "object" || Array.isArray(reminder)) {
    return "INVALID";
  }
  if (!isValidDueDate(reminder.due_date)) {
    return "INVALID";
  }
  if (REMIND_KINDS.indexOf(reminder.kind) === -1) {
    return "INVALID";
  }
  var quote = "";
  if (reminder.quote !== undefined && reminder.quote !== null) {
    if (!isString(reminder.quote)) {
      return "INVALID";
    }
    quote = reminder.quote.trim();
    if (codePointLength(quote) > REMIND_QUOTE_MAX) {
      return "INVALID";
    }
  }
  return { due_date: reminder.due_date.trim(), kind: reminder.kind, quote: quote };
}

/** 完成日+周期(UTC 日历日算术,跨月/跨年自然进位):"2026-10-31" + 1 → "2026-11-01" */
function addDays(dueDate, days) {
  var t = Date.UTC(
    Number(dueDate.slice(0, 4)),
    Number(dueDate.slice(5, 7)) - 1,
    Number(dueDate.slice(8, 10))
  );
  var dt = new Date(t + days * 86400000);
  var pad = function (n) {
    return n < 10 ? "0" + n : String(n);
  };
  return dt.getUTCFullYear() + "-" + pad(dt.getUTCMonth() + 1) + "-" + pad(dt.getUTCDate());
}

function reminders(deps) {
  return deps.db.collection(REMINDERS_COLLECTION);
}

function buildReminderDoc(deps, itemId, docId, dueDate, kind, quote, now, generation) {
  return {
    _id: docId,
    household_id: deps.householdId,
    item_id: itemId,
    status: "active",
    generation: generation,
    due_date: dueDate,
    kind: kind,
    quote: quote,
    created_at: now
  };
}

// ---------- 提醒生命周期权威(PR #52 二轮复审 N1/N2/N3 收口:每物品一个 slot 文档) ----------
//
// slot 文档仍在 reminders 集合内(_id = "slot_"+item_id,status 固定 "slot"),
// 与行查询的 active/done 过滤天然隔离,remindList 与级联清理永不误读误删:
// - rev:单调代际权威——已发行(含预留)的最大提醒轮次号,只增不减,
//   remindClear 硬删提醒行后依然保留,旧轮次号永不与新轮复用(N1 的
//   「清除后 generation 回到 1」顺序 ABA 由此关闭);
// - pending_*:跨操作共享的欠账/声明标记(pending_gen=0 为净空)。周期再生
//   (remindComplete)、补录/改期(remindSet)、首建追加(create 带 reminder)
//   都必须先对 slot 做一次条件更新(CAS)认领目标轮次并登记欠账,行落地后
//   消费欠账;remindClear 显式消费欠账并作废 done 行上的历史标记。这一次
//   CAS 就是 complete/set/clear 共享的线性化点:「更新一轮」与「声明下一轮」
//   并发时恰有一个命中,其余显式冲突(N2 双 active 的根因)。
// - 欠账同时是「首建追加是否成功」的可信史(N3):create 带 reminder 先把
//   认领+欠账原子写进 slot(同一文档一次 add),行追加成功才消费欠账、用户
//   remindClear 亦消费欠账。因此「无 active 且 create 欠账仍在」= 首建追加
//   中断、可自愈;「无 active 且无欠账」= 用户已主动清除/完成,原键重放绝不
//   自动复活,显式拒绝并引导详情页补录。
// 行级 _id 前缀:rg_(周期再生)/rs_(补录改期)/rh_(首建与自愈)均为
// item_id + 目标轮次的确定性派生——并发孪生撞集合 _id 唯一性后回查收敛。

var SLOT_STATUS = "slot";

function slotDocId(itemId) {
  return "slot_" + itemId;
}

/** 欠账净空 patch(消费欠账/回退认领时写) */
function cleanPendingPatch() {
  return {
    pending_gen: 0,
    pending_kind: "",
    pending_base_gen: 0,
    pending_period_days: 0,
    pending_due: "",
    pending_rd: "",
    pending_rk: "",
    pending_rq: ""
  };
}

/** 从 slot 文档读出当前欠账/声明(pending_gen>0 才有),净空返回 null */
function readClaim(slot) {
  if (!slot || !Number.isInteger(slot.pending_gen) || slot.pending_gen <= 0) {
    return null;
  }
  var kind = slot.pending_kind === "regen" || slot.pending_kind === "set" ? slot.pending_kind : "create";
  return {
    kind: kind,
    gen: slot.pending_gen,
    baseGen: Number.isInteger(slot.pending_base_gen) ? slot.pending_base_gen : 0,
    periodDays: Number.isInteger(slot.pending_period_days) ? slot.pending_period_days : 0,
    due: slot.pending_due || "",
    rd: slot.pending_rd || "",
    rk: slot.pending_rk || "",
    rq: slot.pending_rq || ""
  };
}

/** 欠账的完整平铺字段(写 slot 与 CAS 条件共用,字段全量比对防 ABA) */
function claimPatch(claim) {
  return {
    pending_gen: claim.gen,
    pending_kind: claim.kind,
    pending_base_gen: claim.baseGen,
    pending_period_days: claim.periodDays,
    pending_due: claim.due,
    pending_rd: claim.rd,
    pending_rk: claim.rk,
    pending_rq: claim.rq
  };
}

function sameClaim(a, b) {
  return JSON.stringify(claimPatch(a)) === JSON.stringify(claimPatch(b));
}

async function readSlotDoc(deps, itemId) {
  var got = await reminders(deps)
    .where({ _id: slotDocId(itemId), household_id: deps.householdId })
    .get();
  return (got.data && got.data[0]) || null;
}

/**
 * 懒启动 slot:无则按现存提醒行(含 done 历史)推导 rev 后建档。clear 会在
 * 硬删行之前先 ensureSlot,「被清掉的轮次」永远已刻进权威,不会因行被删而
 * 回退(N1)。并发 bootstrap 撞确定性 _id 后回读真实 slot 收敛。
 */
async function ensureSlot(deps, itemId) {
  var existing = await readSlotDoc(deps, itemId);
  if (existing) {
    return existing;
  }
  var rows = await reminders(deps)
    .where({ household_id: deps.householdId, item_id: itemId })
    .get();
  var data = (rows && rows.data) || [];
  var max = 0;
  for (var i = 0; i < data.length; i++) {
    var g = data[i].generation;
    if (Number.isInteger(g) && g > max) {
      max = g;
    }
  }
  var now = deps.now();
  var doc = Object.assign(
    {
      _id: slotDocId(itemId),
      household_id: deps.householdId,
      item_id: itemId,
      status: SLOT_STATUS,
      rev: max,
      created_at: now,
      updated_at: now
    },
    cleanPendingPatch()
  );
  try {
    await reminders(deps).add({ data: doc });
    return doc;
  } catch (e) {
    if (!isDuplicateKeyError(e)) {
      throw e;
    }
    var reread = await readSlotDoc(deps, itemId);
    if (reread) {
      return reread;
    }
    throw e;
  }
}

/** slot 条件更新(唯一线性化点);返回是否命中 */
async function casSlot(deps, itemId, extraCond, patch) {
  var cond = Object.assign({ _id: slotDocId(itemId), household_id: deps.householdId }, extraCond);
  var res = await reminders(deps).where(cond).update({
    data: Object.assign({ updated_at: deps.now() }, patch)
  });
  return ((res && res.stats && res.stats.updated) || 0) > 0;
}

/** 消费欠账(仍须归本认领,字段全量比对);幂等失败返回 false */
function casClearClaim(deps, itemId, claim) {
  return casSlot(deps, itemId, claimPatch(claim), cleanPendingPatch());
}

/**
 * 认领后的行落地——所有「新 active 行」的唯一入口:
 * ① 复核 slot 欠账仍归本认领(认领到插入之间可能已被 clear 消费/他人接管);
 * ② 确定性 _id 插入:并发孪生撞 _id 唯一性被拒后回查收敛(同轮同图景);
 * ③ 行落地后 CAS 消费欠账(仍归本认领):消费失败 = 认领中途被消费(典型:
 *    用户 clear)→ 补偿删除自己刚落地的行,显式冲突——已清除的提醒绝不被
 *    在途声明复活(N2 清除复活竞态)。
 * 基础设施失败如实上抛(欠账仍在,同参重试治愈)。
 */
async function materializeClaimedRow(deps, itemId, claim, buildRow) {
  var slot = await ensureSlot(deps, itemId);
  var current = readClaim(slot);
  if (!current || !sameClaim(current, claim)) {
    return { verdict: "aborted" };
  }
  var doc = buildRow(claim.gen);
  var landed;
  try {
    await reminders(deps).add({ data: doc });
    landed = doc;
  } catch (e) {
    if (!isDuplicateKeyError(e)) {
      throw e;
    }
    var twin = await reminders(deps)
      .where({
        household_id: deps.householdId,
        item_id: itemId,
        status: "active",
        generation: claim.gen
      })
      .get();
    if (twin.data && twin.data.length > 0) {
      return { verdict: "converged", row: twin.data[0] };
    }
    // 同 _id 行存在但非 active(如已完成):该轮行已有归宿,不再落地第二条
    var anyRow = await reminders(deps)
      .where({ _id: doc._id, household_id: deps.householdId })
      .get();
    if (anyRow.data && anyRow.data.length > 0) {
      return { verdict: "stale", row: anyRow.data[0] };
    }
    throw e;
  }
  if (!(await casClearClaim(deps, itemId, claim))) {
    // 认领已被消费:补偿删除自己刚落地的行,绝不复活
    await reminders(deps)
      .where({ _id: doc._id, household_id: deps.householdId, item_id: itemId, status: "active" })
      .remove();
    return { verdict: "conflict" };
  }
  return { verdict: "landed", row: landed };
}

/**
 * 周期再生行的确定性 _id(item + 目标轮次唯一):并发下两个请求对同一轮
 * 再生只会插成同一 _id,第二个插入被集合 _id 唯一性拒绝(E11000 同款),
 * 捕获后回查收敛——「每 item 至多一条 active、同一轮至多再生一次」由此保证,
 * 不依赖先查后插的窄窗口。
 */
function regenReminderId(itemId, generation) {
  return "rg_" + itemId + "_g" + generation;
}

function buildRegenDoc(deps, itemId, generation, dueDate, now) {
  return {
    _id: regenReminderId(itemId, generation),
    household_id: deps.householdId,
    item_id: itemId,
    status: "active",
    generation: generation,
    due_date: dueDate,
    kind: "下次维护",
    quote: "",
    created_at: now
  };
}

/**
 * 为周期再生认领下一轮(remindComplete 专用):条件 {rev=baseGen 且欠账净空}。
 * 行已置 done 但 slot 还挂着「该轮的 create 欠账」(首建追加已落地、消费欠账
 * 的写入丢失/中断)时,顺带消费该陈年欠账再认领,不让它永久卡住完成。
 * 认领失败返回 null,由调用方分类(同参在途收敛 / 显式冲突)。
 */
async function reserveRegenClaim(deps, itemId, baseGen, periodDays, due) {
  var slot = await ensureSlot(deps, itemId);
  var claim = {
    kind: "regen",
    gen: slot.rev + 1,
    baseGen: baseGen,
    periodDays: periodDays,
    due: due,
    rd: "",
    rk: "",
    rq: ""
  };
  var patch = Object.assign({ rev: claim.gen }, claimPatch(claim));
  var ok = await casSlot(deps, itemId, { rev: slot.rev, pending_gen: 0 }, patch);
  if (!ok) {
    ok = await casSlot(
      deps,
      itemId,
      { rev: slot.rev, pending_gen: slot.rev, pending_kind: "create" },
      patch
    );
  }
  return ok ? claim : null;
}

/** 物品删除级联时消费在途欠账声明:物品已删,任何未落地的认领不再有意义 */
async function consumeAnyClaim(deps, itemId) {
  var slot = await readSlotDoc(deps, itemId);
  var claim = readClaim(slot);
  if (claim) {
    await casClearClaim(deps, itemId, claim);
  }
}

/** expected_generation 入参校验:可缺省(旧协议);携带须为 ≥0 的整数(0=客户端确认无 active) */
function validExpectedGeneration(event) {
  var v = event.expected_generation;
  if (v === undefined || v === null) {
    return undefined;
  }
  if (!Number.isInteger(v) || v < 0) {
    return "INVALID";
  }
  return v;
}

/**
 * 作废该 item 全部 done 行上的「欠账再生」标记(next_period_days/next_due):
 * 用户已显式改设/清除提醒,历史欠账不再可被治愈复活(防旧欠账日后冒出新提醒)。
 */
async function clearOwedRegen(deps, itemId) {
  var rows = await reminders(deps)
    .where({ household_id: deps.householdId, item_id: itemId, status: "done" })
    .get();
  var data = (rows && rows.data) || [];
  for (var i = 0; i < data.length; i++) {
    if (data[i].next_period_days > 0) {
      await reminders(deps)
        .where({ _id: data[i]._id })
        .update({ data: { next_period_days: 0, next_due: "" } });
    }
  }
}

/**
 * 收敛式补建(N3 自愈):仅在 slot 上有「未消费的 create 欠账」且请求内容与
 * 欠账逐字段一致时成立——欠账即「首建追加未成功」的可信史。按欠账里记好的
 * 三元组与轮次补 rh_ 行(确定性 _id,并发孪生撞 _id 后回查收敛),落地后
 * 消费欠账。欠账被中途消费(如用户 clear)则如实返回 null,调用方按
 * STALE 拒绝——用户主动清除的提醒绝不被自动复活。
 */
async function ensureActiveReminder(deps, itemId, reminder) {
  var slot = await ensureSlot(deps, itemId);
  var claim = readClaim(slot);
  if (
    !claim ||
    claim.kind !== "create" ||
    claim.rd !== reminder.due_date ||
    claim.rk !== reminder.kind ||
    claim.rq !== (reminder.quote || "")
  ) {
    return null; // 无可信欠账:拒绝猜测(调用方 STALE)
  }
  var r = await materializeClaimedRow(deps, itemId, claim, function (gen) {
    return buildReminderDoc(
      deps,
      itemId,
      "rh_" + itemId + "_g" + gen,
      claim.rd,
      claim.rk,
      claim.rq,
      deps.now(),
      gen
    );
  });
  if (r.verdict === "landed" || r.verdict === "converged") {
    return r.row;
  }
  return null; // aborted/conflict/stale:欠账易主或已有归宿,不复活
}

/** 硬删除某 item 的全部 active 提醒(done 历史保留);remindClear 与物品删除级联共用 */
async function removeActiveReminders(deps, itemId) {
  var res = await reminders(deps)
    .where({ household_id: deps.householdId, item_id: itemId, status: "active" })
    .remove();
  return (res && res.stats && res.stats.removed) || 0;
}

/**
 * 拉取当前家庭全部 active 提醒(分页拉全量,口径同 fetchActiveItems:
 * CloudBase 云函数端 get() 单次最多 100 条,超出护栏页数如实抛错)。
 */
async function fetchActiveReminders(deps) {
  var out = [];
  for (var page = 0; page < MAX_PAGES; page++) {
    var res = await reminders(deps)
      .where({ household_id: deps.householdId, status: "active" })
      .skip(out.length)
      .limit(PAGE_SIZE)
      .get();
    var batch = (res && res.data) || [];
    for (var i = 0; i < batch.length; i++) {
      out.push(batch[i]);
    }
    if (batch.length < PAGE_SIZE) {
      return out;
    }
  }
  throw new Error("reminders query exceeded " + MAX_PAGES * PAGE_SIZE + " documents");
}

/** remindList 行投影:物品名/位置文本/due/kind/item_id/generation,不带 quote 与内部字段 */
function remindRow(doc, item) {
  return {
    item_id: doc.item_id,
    name: item.name,
    location_text: item.location_text,
    due_date: doc.due_date,
    kind: doc.kind,
    generation: doc.generation
  };
}

/**
 * create:入参 { action, operation_id, name, location_text, note? }
 * 幂等:(household_id, operation_id) 已有则返回已有文档并 duplicated:true。
 */
async function createItem(event, deps) {
  var operationId = event.operation_id;
  if (!isString(operationId) || operationId.length < 1 || operationId.length > OPERATION_ID_MAX) {
    return fail("INVALID_INPUT");
  }
  var name = cleanRequired(event.name, NAME_MAX);
  if (name === null) {
    return fail("INVALID_INPUT");
  }
  var locationText = cleanRequired(event.location_text, LOCATION_MAX);
  if (locationText === null) {
    return fail("INVALID_INPUT");
  }
  var note = cleanOptional(event.note, NOTE_MAX);
  if (note === null) {
    return fail("INVALID_INPUT");
  }
  // 可选提醒(issue #36):校验在任何查询/写入之前,非法则 item 与 reminder 均零写入
  var reminder = parseReminderInput(event.reminder);
  if (reminder === "INVALID") {
    return fail("INVALID_INPUT");
  }

  // 幂等只对「同键同内容」成立:命中未删除的同键记录时,
  // 内容一致 → duplicated:true 稳定返回;内容不同 → OPERATION_CONFLICT(绝不静默吞掉用户的修改)。
  var existing = await collection(deps)
    .where({ household_id: deps.householdId, operation_id: operationId, deleted: false })
    .get();
  if (existing.data && existing.data.length > 0) {
    var doc = existing.data[0];
    if (sameCreateContent(doc, name, locationText, note)) {
      // 提醒对账(PR #52 Low-1 + 二轮 N3):物品内容一致还要提醒一致才算幂等
      // 重放——原键重试但提醒改过/清过 → 显式冲突指向详情页,绝不静默吞掉
      // 变更;无 active 且无 create 欠账时拒绝猜测(STALE),绝不自动复活
      // 用户已清除的提醒;仅凭未消费的 create 欠账自愈(HEAL)
      var verdict = await reconcileDuplicateReminder(deps, doc._id, reminder);
      if (verdict === "CONFLICT") {
        return operationConflict(doc);
      }
      if (verdict === "STALE") {
        return reminderStaleConflict(doc);
      }
      if (verdict === "HEAL") {
        var healed = await ensureActiveReminder(deps, doc._id, reminder);
        if (!healed) {
          // 欠账在裁定与补建之间被消费(如并发 clear):绝不复活,如实拒绝
          return reminderStaleConflict(doc);
        }
      }
      return { ok: true, item: project(doc), duplicated: true };
    }
    return operationConflict(doc);
  }

  var now = deps.now();
  var item = {
    _id: "it_" + deps.genId(),
    household_id: deps.householdId,
    name: name,
    name_norm: normalizeName(name),
    location_text: locationText,
    note: note === undefined ? "" : note,
    version: 1,
    deleted: false,
    operation_id: operationId,
    created_at: now,
    updated_at: now
  };
  try {
    await collection(deps).add({ data: item });
  } catch (e) {
    // 并发重放:唯一索引 (household_id, operation_id) 拒绝第二笔插入。
    // 回查后返回稳定结果:同内容 duplicated、异内容或命中已删 → OPERATION_CONFLICT。
    if (!isDuplicateKeyError(e)) {
      throw e;
    }
    var after = await collection(deps)
      .where({ household_id: deps.householdId, operation_id: operationId })
      .get();
    if (after.data && after.data.length > 0) {
      var raced = after.data[0];
      if (!raced.deleted && sameCreateContent(raced, name, locationText, note)) {
        // 提醒对账同 duplicated 分支(Low-1 + 二轮 N3):并发孪生同样区分
        // 重放/变更/拒绝猜测
        var racedVerdict = await reconcileDuplicateReminder(deps, raced._id, reminder);
        if (racedVerdict === "CONFLICT") {
          return operationConflict(raced);
        }
        if (racedVerdict === "STALE") {
          return reminderStaleConflict(raced);
        }
        if (racedVerdict === "HEAL") {
          var racedHealed = await ensureActiveReminder(deps, raced._id, reminder);
          if (!racedHealed) {
            return reminderStaleConflict(raced);
          }
        }
        return { ok: true, item: project(raced), duplicated: true };
      }
      return operationConflict(raced);
    }
    // 回查不到属于异常场景:按原始错误上抛,绝不假装成功。
    throw e;
  }
  if (reminder) {
    // item 文档由本次新建:先把「认领 + create 欠账」原子写进 slot(同一文档
    // 一次 add,N3 的可信史),再落地提醒行(rh_ 确定性 _id,与原键重试的
    // 自愈孪生收敛),落地后消费欠账。追加失败如实上抛——欠账仍在,客户端
    // 原键原内容重试命中 duplicated 分支凭欠账自愈,绝不丢用户意图。
    var nowClaim = deps.now();
    var createClaim = {
      kind: "create",
      gen: 1,
      baseGen: 0,
      periodDays: 0,
      due: "",
      rd: reminder.due_date,
      rk: reminder.kind,
      rq: reminder.quote
    };
    await reminders(deps).add({
      data: Object.assign(
        {
          _id: slotDocId(item._id),
          household_id: deps.householdId,
          item_id: item._id,
          status: SLOT_STATUS,
          rev: 1,
          created_at: nowClaim,
          updated_at: nowClaim
        },
        claimPatch(createClaim)
      )
    });
    var landed = await materializeClaimedRow(deps, item._id, createClaim, function (gen) {
      return buildReminderDoc(
        deps,
        item._id,
        "rh_" + item._id + "_g" + gen,
        reminder.due_date,
        reminder.kind,
        reminder.quote,
        deps.now(),
        gen
      );
    });
    if (landed.verdict !== "landed" && landed.verdict !== "converged") {
      // 全新物品的认领不会在落地前被他人在途消费(客户端尚未拿到 item_id);
      // 真发生即异常场景,如实上抛交由原键重试收敛,绝不假装成功
      throw new Error("create reminder append conflict on fresh item");
    }
  }
  return { ok: true, item: project(item), duplicated: false };
}

/**
 * update:入参 { action, item_id, expected_version, location_text?, name?, note? }
 * 乐观并发:条件更新 version 等于 expected_version;命中 0 条再区分 VERSION_CONFLICT / NOT_FOUND。
 */
async function updateItem(event, deps) {
  if (!validItemId(event.item_id)) {
    return fail("INVALID_INPUT");
  }
  var expectedVersion = event.expected_version;
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
    return fail("INVALID_INPUT");
  }
  // update_id(可选):同一次逻辑修改的标识,用于「响应丢失后重试」的重放识别
  var updateId = event.update_id;
  if (updateId !== undefined && !validUpdateId(updateId)) {
    return fail("INVALID_INPUT");
  }

  var changes = {};
  if (event.name !== undefined) {
    var name = cleanRequired(event.name, NAME_MAX);
    if (name === null) {
      return fail("INVALID_INPUT");
    }
    changes.name = name;
    changes.name_norm = normalizeName(name);
  }
  if (event.location_text !== undefined) {
    var locationText = cleanRequired(event.location_text, LOCATION_MAX);
    if (locationText === null) {
      return fail("INVALID_INPUT");
    }
    changes.location_text = locationText;
  }
  if (event.note !== undefined) {
    var note = cleanOptional(event.note, NOTE_MAX);
    if (note === null) {
      return fail("INVALID_INPUT");
    }
    changes.note = note;
  }
  if (Object.keys(changes).length === 0) {
    return fail("INVALID_INPUT");
  }

  // 指纹只覆盖用户内容字段(在注入 version/updated_at/last_update_* 元数据之前计算)
  var fingerprint = changesFingerprint(changes);

  changes.version = expectedVersion + 1;
  changes.updated_at = deps.now();
  if (updateId !== undefined) {
    changes.last_update_id = updateId;
    changes.last_update_fingerprint = fingerprint;
  }

  var res = await collection(deps)
    .where({
      _id: event.item_id,
      household_id: deps.householdId,
      deleted: false,
      version: expectedVersion
    })
    .update({ data: changes });
  var updated = (res && res.stats && res.stats.updated) || 0;
  if (updated >= 1) {
    var after = await collection(deps)
      .where({ _id: event.item_id, household_id: deps.householdId, deleted: false })
      .get();
    return { ok: true, item: project(after.data[0]) };
  }

  // 命中 0 条:同一 _id 与 household 且未删仍存在 → 版本冲突;否则 NOT_FOUND
  var still = await collection(deps)
    .where({ _id: event.item_id, household_id: deps.householdId, deleted: false })
    .get();
  if (still.data && still.data.length > 0) {
    var current = still.data[0];
    // 重放识别(三重条件):版本恰为 expected+1、last_update_id 相同、且修改内容指纹一致。
    // 相同 update_id 但内容不同 → 一律 VERSION_CONFLICT,绝不把新内容当重放吞掉。
    if (
      updateId !== undefined &&
      current.version === expectedVersion + 1 &&
      current.last_update_id === updateId &&
      current.last_update_fingerprint === fingerprint
    ) {
      return { ok: true, item: project(current), replayed: true };
    }
    return fail("VERSION_CONFLICT");
  }
  return fail("NOT_FOUND");
}

/**
 * delete:入参 { action, item_id }
 * 软删除:置 deleted 为 true,并把 name、name_norm、location_text、note 全部抹成空字符串。
 */
async function deleteItem(event, deps) {
  if (!validItemId(event.item_id)) {
    return fail("INVALID_INPUT");
  }
  var res = await collection(deps)
    .where({ _id: event.item_id, household_id: deps.householdId, deleted: false })
    .update({ data: { deleted: true, name: "", name_norm: "", location_text: "", note: "" } });
  var updated = (res && res.stats && res.stats.updated) || 0;
  if (updated >= 1) {
    // 级联(issue #36):物品删除后其 active 提醒一并硬删(done 历史保留),
    // remindList 不再出现该物品;绝不让提醒指向已删物品。同时在途欠账声明
    // 一并消费——物品已删,任何未落地的再生/补录认领不再有意义
    await removeActiveReminders(deps, event.item_id);
    await consumeAnyClaim(deps, event.item_id);
    return { ok: true };
  }
  return fail("NOT_FOUND");
}

/**
 * 拉取当前家庭全部未删除文档(query/list 共用)。
 * CloudBase 云函数端 get() 单次最多返回 100 条,这里用 .skip() + .limit() 逐页拉全量;
 * 匹配与排序仍在内存完成,契约语义不变。超出护栏页数时抛错(绝不静默返回部分数据)。
 */
async function fetchActiveItems(deps) {
  var out = [];
  for (var page = 0; page < MAX_PAGES; page++) {
    var res = await collection(deps)
      .where({ household_id: deps.householdId, deleted: false })
      .skip(out.length)
      .limit(PAGE_SIZE)
      .get();
    var batch = (res && res.data) || [];
    for (var i = 0; i < batch.length; i++) {
      out.push(batch[i]);
    }
    if (batch.length < PAGE_SIZE) {
      return out;
    }
  }
  throw new Error("items query exceeded " + MAX_PAGES * PAGE_SIZE + " documents");
}

/**
 * query:入参 { action, q }
 * name_norm 精确匹配优先、其次前缀、最后包含,各自按 updated_at 降序,合并去重,最多 20 条。
 */
async function queryItems(event, deps) {
  if (!isString(event.q)) {
    return fail("INVALID_INPUT");
  }
  var q = event.q.trim();
  if (q.length < 1) {
    return fail("INVALID_INPUT");
  }
  var nq = normalizeName(q);
  if (nq === "") {
    // 查询词归一化后为空(如纯标点)无法与任何名称匹配,按无结果处理
    return { ok: true, items: [], match_type: "none" };
  }

  var docs = await fetchActiveItems(deps);
  var exact = [];
  var prefix = [];
  var contains = [];
  for (var i = 0; i < docs.length; i++) {
    var d = docs[i];
    if (!isString(d.name_norm)) {
      continue;
    }
    if (d.name_norm === nq) {
      exact.push(d);
    } else if (d.name_norm.indexOf(nq) === 0) {
      prefix.push(d);
    } else if (d.name_norm.indexOf(nq) !== -1) {
      contains.push(d);
    }
  }
  exact.sort(byUpdatedDesc);
  prefix.sort(byUpdatedDesc);
  contains.sort(byUpdatedDesc);

  var merged = [];
  var seen = Object.create(null);
  var ordered = exact.concat(prefix, contains);
  for (var j = 0; j < ordered.length; j++) {
    if (merged.length >= QUERY_LIMIT) {
      break;
    }
    if (seen[ordered[j]._id]) {
      continue;
    }
    seen[ordered[j]._id] = true;
    merged.push(ordered[j]);
  }

  var matchType =
    exact.length > 0 ? "exact" : prefix.length > 0 ? "prefix" : contains.length > 0 ? "contains" : "none";
  return { ok: true, items: merged.map(project), match_type: matchType };
}

/**
 * list:入参 { action, limit? }
 * deleted 为 false,updated_at 降序,limit 默认 50、最大 50。
 * 响应带 household_id(issue #34 P0):服务端解析的当前家庭(sha256 派生或共享
 * 家庭 id,非 PII),供客户端捕获家庭作用域(缓存/草稿键隔离的依据)。
 * 共享家庭另带 scope_revision(issue #34 P1-A):写请求前的 expected_scope_revision
 * 捕获来源。集合权限不变;仅此只读 action 与 locations.list 携带这些字段。
 */
async function listItems(event, deps) {
  var limit = LIST_DEFAULT;
  if (event.limit !== undefined) {
    if (!Number.isInteger(event.limit) || event.limit < 1) {
      return fail("INVALID_INPUT");
    }
    limit = Math.min(event.limit, LIST_MAX);
  }
  var docs = await fetchActiveItems(deps);
  docs.sort(byUpdatedDesc); // fetchActiveItems 返回新建数组,可原地排序
  var res = { ok: true, household_id: deps.householdId, items: docs.slice(0, limit).map(project) };
  if (deps.householdShared === true) {
    // 共享家庭附带 scope_revision(issue #34 P1-A):客户端写请求前捕获作用域+修订,
    // 作为 expected_scope_revision 的来源(仅一致性前置条件,不授权)
    res.scope_revision = deps.scopeRevision;
  }
  return res;
}

/**
 * get:入参 { action:"get", item_id }
 * 按 id 单查(带 household 条件,过滤已删),供详情页冲突刷新等场景使用,
 * 不受 list 分页截断影响。
 */
async function getItem(event, deps) {
  if (!validItemId(event.item_id)) {
    return fail("INVALID_INPUT");
  }
  var got = await collection(deps)
    .where({ _id: event.item_id, household_id: deps.householdId, deleted: false })
    .get();
  if (got.data && got.data.length > 0) {
    return { ok: true, item: project(got.data[0]) };
  }
  return fail("NOT_FOUND");
}

/**
 * remindList:入参 { action:"remindList" }(只读,不参与写硬门校验)。
 * 当前家庭全部 active 提醒按 due_date 升序(同日按 created_at、再按 _id,
 * 确定性排序);行投影 { item_id, name, location_text, due_date, kind }。
 * 物品已删/跨家庭的悬挂行读侧容忍跳过(级联应保证不出现,出现即悬挂,
 * 同 locations 挂载的读侧容忍口径)。响应携带 household_id(共享家庭另带
 * scope_revision)——口径同 list:客户端 remindComplete/remindClear 写请求
 * 双 marker 的捕获来源。日志只记计数,绝不记物品名与日期明细。
 */
async function remindListItems(event, deps) {
  var docs = await fetchActiveReminders(deps);
  docs.sort(function (a, b) {
    if (a.due_date !== b.due_date) {
      return a.due_date < b.due_date ? -1 : 1;
    }
    if (a.created_at !== b.created_at) {
      return a.created_at < b.created_at ? -1 : 1;
    }
    if (a._id === b._id) {
      return 0;
    }
    return a._id < b._id ? -1 : 1;
  });
  var itemCache = Object.create(null);
  var out = [];
  for (var i = 0; i < docs.length; i++) {
    var r = docs[i];
    if (!Object.prototype.hasOwnProperty.call(itemCache, r.item_id)) {
      var got = await collection(deps)
        .where({ _id: r.item_id, household_id: deps.householdId, deleted: false })
        .get();
      itemCache[r.item_id] = (got.data && got.data[0]) || null;
    }
    var item = itemCache[r.item_id];
    if (!item) {
      continue; // 悬挂行:物品已删/跨家庭,不展示
    }
    out.push(remindRow(r, item));
  }
  var res = { ok: true, household_id: deps.householdId, reminders: out };
  if (deps.householdShared === true) {
    res.scope_revision = deps.scopeRevision;
  }
  return res;
}

/**
 * remindComplete:入参 { action:"remindComplete", item_id, expected_generation?,
 * period_days?, complete_date? }。
 * period_days 缺省或 0 表示不周期再生;携带则须为 0-3650 的整数,否则 INVALID_INPUT。
 * complete_date(PR #52 Low-3):客户端携带的「用户本地自然日」完成日(YYYY-MM-DD
 * 真实日历日,严格校验)。家庭提醒日期的合同=按用户本地自然日:客户端随请求
 * 携带本地完成日,服务端不靠运行时区猜(北京时间 00:00-08:00 完成不再被 UTC
 * 日期折早一天)。缺省 = 旧协议按服务端当天 UTC 日期,行为不变。
 * expected_generation(PR #52 B1):remindList 行返回的提醒轮次号,携带时服务端
 * 只完成「用户实际看到的那一轮」——条件更新命中 0 条即本轮已非该轮:
 * 他轮仍在 → VERSION_CONFLICT(绝不误伤新一轮);本轮已完成且已再生、请求与
 * 当时一致 → 幂等收敛成功;本轮已完成但再生曾失败(done 行欠账标记)→ 治愈
 * 补建后如实成功。缺省 = 旧协议宽口径(该 item 全部 active 置 done),行为不变。
 * 物品必须存在且属于当前家庭且未删(否则 NOT_FOUND);该 item 无 active 提醒也
 * NOT_FOUND(已完成的重复完成按刷新列表收敛,绝不静默复活)。
 * 将命中的 active 提醒置 done 并记 completed_at;period_days>0 时先在 slot 上
 * 认领下一轮(N2:与 set/clear 共享线性化点,「完成更新一轮」与「声明下一轮」
 * 并发互斥),再按确定性 _id 落地再生行:due_date = 完成基准日(complete_date,
 * 缺省服务端 UTC 当天)+ period_days 天(跨月/跨年自然进位,纯日期算术),
 * kind 固定「下次维护」(周期再生语义),quote 为空(再生提醒无原话锚点)。
 * 新轮次号一律取自 slot 单调代际权威(N1:清除后也不回退);认领/落地被并发
 * 操作抢先 → 显式 VERSION_CONFLICT,绝不插出第二条 active。再生插入失败时
 * 如实上抛(绝不假装完成),欠账记在 slot 与 done 行(next_period_days/
 * next_due),同参数重试走治愈路径恢复(next_due 在完成时按当时基准算好,
 * 治愈不漂移)。
 */
async function remindCompleteItem(event, deps) {
  if (!validItemId(event.item_id)) {
    return fail("INVALID_INPUT");
  }
  var expectedGeneration = validExpectedGeneration(event);
  if (expectedGeneration === "INVALID") {
    return fail("INVALID_INPUT");
  }
  var periodDays = 0;
  if (event.period_days !== undefined && event.period_days !== null) {
    if (
      !Number.isInteger(event.period_days) ||
      event.period_days < 0 ||
      event.period_days > REMIND_PERIOD_MAX
    ) {
      return fail("INVALID_INPUT");
    }
    periodDays = event.period_days;
  }
  // 完成基准日(Low-3):用户本地自然日随请求携带;缺省回退服务端 UTC 当天
  var completeDate = null;
  if (event.complete_date !== undefined && event.complete_date !== null) {
    if (!isValidDueDate(event.complete_date)) {
      return fail("INVALID_INPUT");
    }
    completeDate = event.complete_date.trim();
  }
  var got = await collection(deps)
    .where({ _id: event.item_id, household_id: deps.householdId, deleted: false })
    .get();
  if (!got.data || got.data.length === 0) {
    return fail("NOT_FOUND");
  }
  var item = got.data[0];

  var now = deps.now();
  var regenDue = null;
  if (periodDays > 0) {
    regenDue = addDays(completeDate !== null ? completeDate : now.slice(0, 10), periodDays);
  }
  // 条件更新(CAS):带轮次号时只命中「用户看到的那一轮」;
  // 命中 0 条 → 本轮已非该轮,交由 divergence 裁定(冲突/收敛/治愈),绝不误伤
  var cond = { household_id: deps.householdId, item_id: event.item_id, status: "active" };
  if (expectedGeneration !== undefined) {
    cond.generation = expectedGeneration;
  }
  var upd = await reminders(deps).where(cond).update({
    data: {
      status: "done",
      completed_at: now,
      next_period_days: periodDays,
      next_due: regenDue === null ? "" : regenDue
    }
  });
  var updated = (upd && upd.stats && upd.stats.updated) || 0;
  if (updated === 0) {
    if (expectedGeneration === undefined) {
      // 旧协议宽口径例外:无 active 且 slot 上挂着未消费的再生欠账(此前宽口径
      // 完成在途/插入失败)→ 治愈收敛;确无欠账 → NOT_FOUND(既有语义,刷新收敛)
      return completeLegacyDivergence(deps, item, periodDays);
    }
    return completeDivergence(deps, item, expectedGeneration, periodDays);
  }

  if (periodDays > 0) {
    // 认领下一轮(N2 共享线性化点):携带轮次时以该轮为基准(权威 rev 必须
    // 仍在该轮);旧协议宽口径以 slot 当前 rev 为基准。认领失败分类处理。
    var baseGen = expectedGeneration;
    if (baseGen === undefined) {
      var slot = await ensureSlot(deps, event.item_id);
      baseGen = slot.rev;
    }
    var claim = await reserveRegenClaim(deps, event.item_id, baseGen, periodDays, regenDue);
    if (!claim) {
      return completeReserveFailure(deps, item, expectedGeneration, periodDays);
    }
    var r = await materializeClaimedRow(deps, event.item_id, claim, function (gen) {
      return buildRegenDoc(deps, event.item_id, gen, claim.due, deps.now());
    });
    if (r.verdict === "landed") {
      return { ok: true, reminder: remindRow(r.row, item) };
    }
    if (r.verdict === "converged") {
      return { ok: true, reminder: remindRow(r.row, item), replayed: true };
    }
    // aborted/conflict/stale:认领易主或该轮行已有归宿 → 显式冲突,绝不复活
    return fail("VERSION_CONFLICT");
  }
  return { ok: true };
}

/**
 * 再生认领失败的分类(该轮已置 done,但下一轮声明被并发操作抢先):
 * slot 上挂着「同轮同周期」的再生欠账(此前同参完成的在途/中断)→ 收敛补齐
 * (replayed);其余(他人 set/clear 抢先、权威已前移)→ 显式 VERSION_CONFLICT,
 * 客户端刷新后重试收敛,绝不插出第二条 active。
 */
async function completeReserveFailure(deps, item, expectedGeneration, periodDays) {
  var slot = await ensureSlot(deps, item._id);
  var claim = readClaim(slot);
  if (
    claim &&
    claim.kind === "regen" &&
    claim.periodDays === periodDays &&
    (expectedGeneration === undefined || claim.baseGen === expectedGeneration)
  ) {
    var r = await materializeClaimedRow(deps, item._id, claim, function (gen) {
      return buildRegenDoc(deps, item._id, gen, claim.due, deps.now());
    });
    if (r.verdict === "landed") {
      return { ok: true, reminder: remindRow(r.row, item) };
    }
    if (r.verdict === "converged") {
      return { ok: true, reminder: remindRow(r.row, item), replayed: true };
    }
  }
  return fail("VERSION_CONFLICT");
}

/**
 * 旧协议宽口径命中 0 条后的裁定:确无欠账 → NOT_FOUND(刷新收敛,旧语义);
 * slot 挂着未消费的再生欠账(此前宽口径完成在途/插入失败)→ 治愈收敛。
 */
async function completeLegacyDivergence(deps, item, periodDays) {
  var slot = await ensureSlot(deps, item._id);
  var claim = readClaim(slot);
  if (!claim) {
    return fail("NOT_FOUND");
  }
  var actives = await reminders(deps)
    .where({ household_id: deps.householdId, item_id: item._id, status: "active" })
    .get();
  if ((actives.data || []).length > 0) {
    // 他人已立新提醒:绝不动,刷新收敛
    return fail("NOT_FOUND");
  }
  if (claim.kind !== "regen" || claim.periodDays !== periodDays) {
    return fail("NOT_FOUND");
  }
  var r = await materializeClaimedRow(deps, item._id, claim, function (gen) {
    return buildRegenDoc(deps, item._id, gen, claim.due, deps.now());
  });
  if (r.verdict === "landed") {
    return { ok: true, reminder: remindRow(r.row, item) };
  }
  if (r.verdict === "converged") {
    return { ok: true, reminder: remindRow(r.row, item), replayed: true };
  }
  return fail("NOT_FOUND");
}

/**
 * 条件更新命中 0 条后的裁定(仅 expected_generation 携带时):
 * ① slot 上挂着「同轮(base=该轮)」的再生欠账:同周期 → 治愈补齐(同参数,
 *    due 用欠账里记好的原值,不随治愈时间漂移),换周期 → 显式冲突绝不猜;
 * ② 已有更新的一轮 active(他人完成了本轮并再生/改设):请求与该轮完成时的
 *    周期一致 → 幂等收敛成功(replayed);否则 VERSION_CONFLICT,绝不误伤;
 * ③ 无 active 且该轮 done 行带欠账标记(slot 欠账已被消费的兜底/存量形态)
 *    → 经 slot 权威重新认领后治愈补建;无欠账 → NOT_FOUND(刷新收敛,旧语义)。
 */
async function completeDivergence(deps, item, expectedGeneration, periodDays) {
  var itemId = item._id;
  var slot = await ensureSlot(deps, itemId);
  var claim = readClaim(slot);
  var actives = await reminders(deps)
    .where({ household_id: deps.householdId, item_id: itemId, status: "active" })
    .get();
  var activeRows = (actives && actives.data) || [];
  var doneRes = await reminders(deps)
    .where({
      household_id: deps.householdId,
      item_id: itemId,
      generation: expectedGeneration,
      status: "done"
    })
    .get();
  var doneRow = (doneRes.data || [])[0];

  if (claim && claim.kind === "regen" && claim.baseGen === expectedGeneration) {
    if (claim.periodDays !== periodDays) {
      // 同轮但请求周期与当时不同:显式冲突,绝不猜
      return fail("VERSION_CONFLICT");
    }
    if (activeRows.length === 0) {
      // 治愈:补齐欠账声明的再生行(due 记在欠账里,不漂移)
      var healed = await materializeClaimedRow(deps, itemId, claim, function (gen) {
        return buildRegenDoc(deps, itemId, gen, claim.due, deps.now());
      });
      if (healed.verdict === "landed") {
        return { ok: true, reminder: remindRow(healed.row, item) };
      }
      if (healed.verdict === "converged") {
        return { ok: true, reminder: remindRow(healed.row, item), replayed: true };
      }
      return fail("VERSION_CONFLICT");
    }
    // 欠账仍在但已有 active:孪生可能已补齐,交由下方收敛裁定
  }

  if (activeRows.length > 0) {
    // 收敛豁免:下一轮恰为该轮的周期再生行,且与本次请求的周期一致
    if (
      doneRow &&
      periodDays > 0 &&
      doneRow.next_period_days === periodDays
    ) {
      for (var i = 0; i < activeRows.length; i++) {
        if (activeRows[i].generation === expectedGeneration + 1) {
          return { ok: true, reminder: remindRow(activeRows[i], item), replayed: true };
        }
      }
    }
    return fail("VERSION_CONFLICT");
  }

  if (!doneRow) {
    return fail("NOT_FOUND");
  }
  if (Number.isInteger(doneRow.next_period_days) && doneRow.next_period_days > 0) {
    if (doneRow.next_period_days !== periodDays) {
      // 同一轮但请求周期与当时不同:显式冲突,绝不猜
      return fail("VERSION_CONFLICT");
    }
    // 兜底治愈(slot 欠账已被消费的存量形态):经权威重新认领下一轮再补建,
    // 新轮次号仍取自单调权威,不与任何历史轮复用(N1)
    var fallbackClaim = await reserveRegenClaim(
      deps,
      itemId,
      slot.rev,
      periodDays,
      doneRow.next_due
    );
    if (!fallbackClaim) {
      return fail("VERSION_CONFLICT");
    }
    var r2 = await materializeClaimedRow(deps, itemId, fallbackClaim, function (gen) {
      return buildRegenDoc(deps, itemId, gen, fallbackClaim.due, deps.now());
    });
    if (r2.verdict === "landed") {
      return { ok: true, reminder: remindRow(r2.row, item) };
    }
    if (r2.verdict === "converged") {
      return { ok: true, reminder: remindRow(r2.row, item), replayed: true };
    }
    return fail("VERSION_CONFLICT");
  }
  return fail("NOT_FOUND");
}

/**
 * remindClear:入参 { action:"remindClear", item_id, expected_generation? }。
 * 硬删除该 item 的全部 active 提醒(done 历史保留);天然幂等,
 * 无可清时 cleared:0 也是成功。物品删除(delete)的级联清理同款。
 * expected_generation(PR #52 B1):携带时只清「用户看到的那一轮」——
 * 命中 0 条且仍有 active(他人后来更新)→ VERSION_CONFLICT,绝不静默删掉
 * 别人的新提醒;命中 0 条且确无 active → 幂等成功(cleared:0)。
 * 清除成功同时作废 done 行的欠账再生标记与 slot 上未消费的欠账声明
 * (用户不要任何提醒,旧欠账不复活;被消费的在途认领会在落地复核时中止并
 * 补偿——「clear 在 done-未再生窗口清欠账后,在途再生复活」的竞态由此关闭)。
 */
async function remindClearItem(event, deps) {
  if (!validItemId(event.item_id)) {
    return fail("INVALID_INPUT");
  }
  var expectedGeneration = validExpectedGeneration(event);
  if (expectedGeneration === "INVALID") {
    return fail("INVALID_INPUT");
  }
  // 先固化单调代际权威再删行(N1):被清掉的轮次已刻进 slot 的 rev,
  // 后续 remindSet 补录取 rev+1,generation 绝不回到 1 与旧轮复用
  var slot = await ensureSlot(deps, event.item_id);
  var claim = readClaim(slot);
  if (claim) {
    // 消费欠账:宽口径全消费;窄口径只消费「第 g 轮生命周期内」的欠账——
    // 再生声明的 base_gen=g(第 g 轮的未落地延续),或目标轮恰为 g 的
    // create/set 认领。清除的是用户看到的那一轮及其延续,他人的认领不动。
    var consume =
      expectedGeneration === undefined ||
      (claim.kind === "regen" && claim.baseGen === expectedGeneration) ||
      claim.gen === expectedGeneration;
    if (consume) {
      await casClearClaim(deps, event.item_id, claim); // 已被他人消费则幂等跳过
    }
  }
  var removed = 0;
  if (expectedGeneration !== undefined) {
    var rm = await reminders(deps)
      .where({
        household_id: deps.householdId,
        item_id: event.item_id,
        status: "active",
        generation: expectedGeneration
      })
      .remove();
    removed = (rm && rm.stats && rm.stats.removed) || 0;
    if (removed === 0) {
      var actives = await reminders(deps)
        .where({ household_id: deps.householdId, item_id: event.item_id, status: "active" })
        .get();
      if (actives.data && actives.data.length > 0) {
        return fail("VERSION_CONFLICT");
      }
      // 早已清空:幂等成功
    }
  } else {
    removed = await removeActiveReminders(deps, event.item_id);
  }
  await clearOwedRegen(deps, event.item_id);
  return { ok: true, cleared: removed };
}

/**
 * remindSet:入参 { action:"remindSet", item_id, due_date, kind?, quote?,
 * expected_generation? }。
 * 为已有物品把提醒设为用户所选的日子(日期选择器来源,#36 两个合法日期来源之一):
 * AI 没提取出日期或用户清过的物品,在这里补录提醒,不必删掉重建。
 * 物品必须存在、属当前家庭且未删(否则 NOT_FOUND);due_date 严格 YYYY-MM-DD
 * 真实日历日(服务端只验格式绝不猜语义,口径同 create 的 reminder 入参);
 * kind 缺省「下次维护」(用户选日子的通用语义),携带须在冻结词表内;
 * quote 可缺省(选择器来源本无原话锚点);非法一律 INVALID_INPUT 且零写入。
 * expected_generation(PR #52 B1):remindList 行的轮次号;0=客户端确认当前
 * 无提醒(补录)。携带时按轮次条件替换——0 时若已有 active、或 n>0 时命中
 * 不了第 n 轮(他人后来更新过)→ VERSION_CONFLICT,刷新后重选,绝不静默
 * 覆盖别人的新提醒。缺省 = 旧协议宽口径替换,行为不变。
 * 替换语义:新行轮次一律取自 slot 单调代际权威 rev+1(单调递增绝不重置,
 * 旧页的 expected_generation 永远命中不了新行)——「每 item 至多一条 active」
 * 不变形,重复对同一物品设不同日子不堆积;认领(N2 共享线性化点)与落地
 * (确定性 _id + 欠账消费复核)并发安全;成功后作废历史欠账再生标记。
 * 返回 { ok:true, reminder(remindList 行投影) }。
 */
async function remindSetItem(event, deps) {
  if (!validItemId(event.item_id)) {
    return fail("INVALID_INPUT");
  }
  var expectedGeneration = validExpectedGeneration(event);
  if (expectedGeneration === "INVALID") {
    return fail("INVALID_INPUT");
  }
  var kind = event.kind === undefined || event.kind === null ? "下次维护" : event.kind;
  var reminder = parseReminderInput({ due_date: event.due_date, kind: kind, quote: event.quote });
  if (reminder === "INVALID") {
    return fail("INVALID_INPUT");
  }
  var got = await collection(deps)
    .where({ _id: event.item_id, household_id: deps.householdId, deleted: false })
    .get();
  if (!got.data || got.data.length === 0) {
    return fail("NOT_FOUND");
  }
  var item = got.data[0];

  // 前置检查(在认领之前,旧页请求直接显式冲突,不白烧一个轮次号):
  // 0=补录:页面确认无提醒,他人已立 → 冲突;n>0=改期:第 n 轮必须仍在,
  // 他人已更新 → 冲突;缺省=旧协议宽口径替换。
  // 例外(响应丢失重试):第 n 轮不在但 slot 挂着「同参 set 声明」= 自己此前
  // 的替换流程已清旧行、新行未落地 → 按声明收敛补齐,不当旧页冲突。
  var activesBefore = await reminders(deps)
    .where({ household_id: deps.householdId, item_id: event.item_id, status: "active" })
    .get();
  var beforeRows = (activesBefore && activesBefore.data) || [];
  if (expectedGeneration === 0 && beforeRows.length > 0) {
    return fail("VERSION_CONFLICT");
  }
  if (expectedGeneration !== undefined && expectedGeneration > 0) {
    var seenStill = false;
    for (var b = 0; b < beforeRows.length; b++) {
      if (beforeRows[b].generation === expectedGeneration) {
        seenStill = true;
        break;
      }
    }
    if (!seenStill) {
      var ownSlot = await ensureSlot(deps, event.item_id);
      var ownClaim = readClaim(ownSlot);
      if (
        ownClaim &&
        ownClaim.kind === "set" &&
        ownClaim.rd === reminder.due_date &&
        ownClaim.rk === reminder.kind &&
        ownClaim.rq === (reminder.quote || "")
      ) {
        var ownRelanded = await materializeClaimedRow(deps, event.item_id, ownClaim, function (gen) {
          return buildReminderDoc(
            deps,
            event.item_id,
            "rs_" + event.item_id + "_g" + gen,
            reminder.due_date,
            reminder.kind,
            reminder.quote,
            deps.now(),
            gen
          );
        });
        if (ownRelanded.verdict === "landed" || ownRelanded.verdict === "converged") {
          await clearOwedRegen(deps, event.item_id);
          return {
            ok: true,
            reminder: remindRow(ownRelanded.row, item),
            replayed: ownRelanded.verdict === "converged"
          };
        }
      }
      return fail("VERSION_CONFLICT");
    }
  }

  // 认领下一轮(slot CAS = 与 complete/clear 共享的线性化点,N2):
  // 新行轮次一律取自单调代际权威 rev+1(N1:清除后绝不回退),绝不复用旧轮。
  var claimRes = await claimNextForSet(deps, event.item_id, reminder);
  if (!claimRes) {
    return fail("VERSION_CONFLICT");
  }

  if (claimRes.replay) {
    // 自己的同参声明在途(响应丢失后原样重试):收敛补齐,不重复建第二条
    var otherRows = beforeRows.filter(function (row) {
      return row.generation !== claimRes.replay.gen;
    });
    for (var o = 0; o < otherRows.length; o++) {
      await reminders(deps)
        .where({ _id: otherRows[o]._id, household_id: deps.householdId, status: "active" })
        .remove();
    }
    var replayed = await materializeClaimedRow(deps, event.item_id, claimRes.replay, function (gen) {
      return buildReminderDoc(
        deps,
        event.item_id,
        "rs_" + event.item_id + "_g" + gen,
        reminder.due_date,
        reminder.kind,
        reminder.quote,
        deps.now(),
        gen
      );
    });
    if (replayed.verdict !== "landed" && replayed.verdict !== "converged") {
      return fail("VERSION_CONFLICT");
    }
    await clearOwedRegen(deps, event.item_id);
    return {
      ok: true,
      reminder: remindRow(replayed.row, item),
      replayed: replayed.verdict === "converged"
    };
  }

  var claim = claimRes.claim;
  if (claimRes.superseded) {
    // 接管了他人未落地的认领:被接管方可能已把行落地(认领未及消费),一并清掉
    await removeActiveReminders(deps, event.item_id);
  } else if (expectedGeneration === undefined) {
    // 旧协议:无条件替换(既有语义)
    await removeActiveReminders(deps, event.item_id);
  } else if (expectedGeneration > 0) {
    // 改期:只替换「用户看到的那一轮」,命中不了 → 他人已更新,绝不静默覆盖。
    // 回退认领(rev 已前移,该号作废不再复用,只留空洞)
    var rm = await reminders(deps)
      .where({
        household_id: deps.householdId,
        item_id: event.item_id,
        status: "active",
        generation: expectedGeneration
      })
      .remove();
    var removed = (rm && rm.stats && rm.stats.removed) || 0;
    if (removed === 0) {
      await casClearClaim(deps, event.item_id, claim);
      return fail("VERSION_CONFLICT");
    }
  }
  // expected_generation === 0(补录):前置已确认无 active;认领互斥保证认领后
  // 不再冒出新的并发 active,悬挂的陈年行(若有)由 removeActiveReminders 兜底
  if (expectedGeneration === 0) {
    await removeActiveReminders(deps, event.item_id);
  }

  // 确定性 _id(item + 目标轮次唯一)落地;认领中途被消费(如用户 clear)时
  // 落地流程自行补偿删除并显式冲突,绝不插出第二条 active、绝不复活已清除
  var landed = await materializeClaimedRow(deps, event.item_id, claim, function (gen) {
    return buildReminderDoc(
      deps,
      event.item_id,
      "rs_" + event.item_id + "_g" + gen,
      reminder.due_date,
      reminder.kind,
      reminder.quote,
      deps.now(),
      gen
    );
  });
  if (landed.verdict !== "landed" && landed.verdict !== "converged") {
    return fail("VERSION_CONFLICT");
  }
  // 新提醒已立:历史欠账再生标记一并作废(防旧欠账日后被治愈复活)
  await clearOwedRegen(deps, event.item_id);
  return {
    ok: true,
    reminder: remindRow(landed.row, item),
    replayed: landed.verdict === "converged"
  };
}

/**
 * remindSet 的下一轮认领:优先「欠账净空」认领(slot rev+1);
 * 净空认领失败时按 slot 现存欠账裁定:
 * - 同参 set 声明在途(响应丢失重试)→ 返回 replay 交由调用方收敛补齐;
 * - 他人未落地的认领(create 首建追加未落地 / complete 再生在途 / 他人 set
 *   在途)→ 接管(supersede):被接管方的落地流程会在复核/消费时发现认领
 *   易主而中止并补偿,「≤1 active」不破,被接管方收到显式冲突;
 * 接管/认领均不命中 → null(调用方 VERSION_CONFLICT,刷新后重试)。
 */
async function claimNextForSet(deps, itemId, reminder) {
  var slot = await ensureSlot(deps, itemId);
  var freshClaim = {
    kind: "set",
    gen: slot.rev + 1,
    baseGen: 0,
    periodDays: 0,
    due: "",
    rd: reminder.due_date,
    rk: reminder.kind,
    rq: reminder.quote
  };
  var ok = await casSlot(
    deps,
    itemId,
    { rev: slot.rev, pending_gen: 0 },
    Object.assign({ rev: freshClaim.gen }, claimPatch(freshClaim))
  );
  if (ok) {
    return { claim: freshClaim };
  }
  var reread = await ensureSlot(deps, itemId);
  var cur = readClaim(reread);
  if (!cur) {
    return null; // 权威在裁定间隙前移且无欠账:刷新后重试
  }
  if (
    cur.kind === "set" &&
    cur.rd === reminder.due_date &&
    cur.rk === reminder.kind &&
    cur.rq === (reminder.quote || "")
  ) {
    return { replay: cur };
  }
  var supersededClaim = {
    kind: "set",
    gen: reread.rev + 1,
    baseGen: 0,
    periodDays: 0,
    due: "",
    rd: reminder.due_date,
    rk: reminder.kind,
    rq: reminder.quote
  };
  var ok2 = await casSlot(
    deps,
    itemId,
    { rev: reread.rev, pending_gen: cur.gen },
    Object.assign({ rev: supersededClaim.gen }, claimPatch(supersededClaim))
  );
  if (ok2) {
    return { claim: supersededClaim, superseded: true };
  }
  return null;
}

var ACTIONS = {
  create: createItem,
  update: updateItem,
  delete: deleteItem,
  get: getItem,
  query: queryItems,
  list: listItems,
  remindList: remindListItems,
  remindComplete: remindCompleteItem,
  remindClear: remindClearItem,
  remindSet: remindSetItem
};

/**
 * 写类 action(issue #34 P0 F2 + P1-A 写入硬门,lib/household.js 的
 * checkWriteScopeBinding 统一裁定):
 * - 共享家庭(解析为 shared):必须携带与解析一致的 expected_household_id 与
 *   expected_scope_revision(客户端从 list/remindList 响应捕获)。缺失/不一致 →
 *   FAMILY_SWITCHED / FAMILY_STALE_SCOPE,零业务写入,绝不静默改投当前家庭;
 *   单调 scope_revision 挡成员变更后的旧请求误写与 A→B→A 的 ABA 重放
 *   (P1 硬门 B 第 1、2 条);
 * - 个人(单人)家庭:维持 P0 宽松口径——expected_household_id 可选(携带则
 *   校验,不一致 FAMILY_SWITCHED)、expected_scope_revision 忽略,0.4.7 及
 *   以前客户端单人零回归。
 * 提醒写操作(issue #36):remindComplete/remindClear/remindSet 与
 * create/update/delete 同走此硬门,不另起炉灶。
 * 两参数仅做一致性校验,不具任何授权效力;身份与家庭归属始终由服务端独立解析。
 */
var WRITE_ACTIONS = {
  create: true,
  update: true,
  delete: true,
  remindComplete: true,
  remindClear: true,
  remindSet: true
};

/**
 * 日志只输出 action、错误码、耗时、计数;绝不输出原文、身份、物品名、位置,
 * 也不输出提醒的日期明细(remindList 只记行数)。
 */
function logResult(deps, action, result, startedAt) {
  if (!deps || !deps.logger || typeof deps.logger.log !== "function") {
    return;
  }
  var entry = {
    action: isString(action) ? action : null,
    error: result && result.ok === false ? result.error : null,
    ms: Date.now() - startedAt
  };
  if (result && result.ok) {
    entry.count = Array.isArray(result.items)
      ? result.items.length
      : Array.isArray(result.reminders)
        ? result.reminders.length
        : 1;
  } else {
    entry.count = 0;
  }
  try {
    deps.logger.log(entry);
  } catch (e) {
    // 日志失败绝不影响业务结果
  }
}

/**
 * 纯函数入口:handler(event, deps)
 * deps = { db, now(), genId(), householdId, householdShared?, scopeRevision?, logger }
 * (householdShared/scopeRevision 由 index.js 从解析结果注入:共享家庭写硬门依据)
 * 返回 { ok:true, ... } 或 { ok:false, error, message(中文) }。
 */
async function handler(event, deps) {
  var startedAt = Date.now();
  var action = event && event.action;
  var result;
  try {
    if (!deps || !deps.householdId) {
      result = fail("UNAUTHORIZED");
    } else if (!isString(action) || !ACTIONS[action]) {
      // 未知 action、缺必填 action 一律 INVALID_INPUT
      result = fail("INVALID_INPUT");
    } else if (WRITE_ACTIONS[action]) {
      // F2 写入硬门(issue #34 P0+P1-A):共享家庭强制作用域绑定(缺 marker /
      // 旧修订 → FAMILY_SWITCHED / FAMILY_STALE_SCOPE,零写入);个人家庭维持
      // P0 宽松口径(可选 marker)。gate 返回 null = 放行
      var gate = checkWriteScopeBinding(
        deps.householdId,
        deps.householdShared === true,
        deps.scopeRevision,
        event
      );
      result = gate === null ? await ACTIONS[action](event, deps) : gate;
    } else {
      result = await ACTIONS[action](event, deps);
    }
  } catch (err) {
    // 基础设施异常不属于契约四种业务错误码:如实记日志(仅 action/错误码/耗时/计数)后向上抛出,
    // 绝不静默、绝不假装业务成功。
    logResult(deps, action, { ok: false, error: "INTERNAL" }, startedAt);
    throw err;
  }
  logResult(deps, action, result, startedAt);
  return result;
}

module.exports = {
  handler: handler,
  ERROR_MESSAGES: ERROR_MESSAGES
};
