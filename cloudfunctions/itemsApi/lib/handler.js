"use strict";

/**
 * itemsApi 纯函数 handler(docs/API_CONTRACT.md「itemsApi 协议」)。
 * handler(event, deps):身份只来自 deps.householdId,绝不从 event 读取任何身份字段;
 * 依赖注入以便离线测试。校验失败绝不写入;查询与列表永远过滤 deleted 为 false。
 * 提醒实体(issue #36 二阶段):独立 reminders 集合,绝不把提醒字段堆到 items
 * 文档上;create 增可选 reminder 参数,新增 remindList/remindComplete/remindClear/
 * remindSet 四个 action(remindSet:为已有物品把提醒设为所选日子——AI 没提取出
 * 日期或用户清过的物品也能补录,不必删掉重建)。家庭推导(#34 fail-closed)与
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

function buildReminderDoc(deps, itemId, dueDate, kind, quote, now, generation) {
  return {
    _id: "rd_" + deps.genId(),
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

/**
 * 提醒轮次号(PR #52 复审 B1):同一 item 内单调递增、绝不重置,
 * 标识「用户看到的那一轮 active 提醒」。写操作携带 remindList 行的
 * generation 做条件更新(CAS):旧页/并发请求命中不了新一轮,绝不误伤。
 */
async function nextGeneration(deps, itemId) {
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
  return max + 1;
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
 * 收敛式补建:该 item 无 active 提醒时才补一条。
 * 场景:首次 create 已建 item 但 reminder 追加写入中断(无跨文档事务),
 * 客户端原键原内容重试命中 duplicated 分支——在这里自愈补上,不丢用户
 * 已确认的提醒,也不重复补第二条(已有 active 时原样返回)。
 */
/**
 * 收敛式补建:该 item 无 active 提醒时才补一条。
 * 场景:首次 create 已建 item 但 reminder 追加写入中断(无跨文档事务),
 * 客户端原键原内容重试命中 duplicated 分支——在这里自愈补上,不丢用户
 * 已确认的提醒,也不重复补第二条(已有 active 时原样返回)。
 * 补建行 _id 确定性派生(item + 目标轮次):并发重试的双补建只落一条,
 * 第二笔被 _id 唯一性拒绝后回查收敛(同一 create 请求的同一意图)。
 */
async function ensureActiveReminder(deps, itemId, reminder) {
  var existing = await reminders(deps)
    .where({ household_id: deps.householdId, item_id: itemId, status: "active" })
    .get();
  if (existing.data && existing.data.length > 0) {
    return existing.data[0];
  }
  var doc = buildReminderDoc(
    deps,
    itemId,
    reminder.due_date,
    reminder.kind,
    reminder.quote,
    deps.now(),
    await nextGeneration(deps, itemId)
  );
  doc._id = "rh_" + itemId + "_g" + doc.generation;
  try {
    await reminders(deps).add({ data: doc });
  } catch (e) {
    if (!isDuplicateKeyError(e)) {
      throw e;
    }
    var twin = await reminders(deps)
      .where({ household_id: deps.householdId, item_id: itemId, status: "active" })
      .get();
    if (twin.data && twin.data.length > 0) {
      return twin.data[0];
    }
    throw e;
  }
  return doc;
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
      if (reminder) {
        // 响应丢失后的原键重试:首建可能已建 item 但 reminder 追加中断,
        // 这里收敛补建(已有 active 则不重复),绝不丢用户已确认的提醒
        await ensureActiveReminder(deps, doc._id, reminder);
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
        if (reminder) {
          await ensureActiveReminder(deps, raced._id, reminder);
        }
        return { ok: true, item: project(raced), duplicated: true };
      }
      return operationConflict(raced);
    }
    // 回查不到属于异常场景:按原始错误上抛,绝不假装成功。
    throw e;
  }
  if (reminder) {
    // item 文档由本次新建,直接追加提醒文档(无跨文档事务:
    // 追加失败整体上抛,客户端原键重试走 duplicated 分支收敛自愈)
    await reminders(deps).add({
      data: buildReminderDoc(
        deps,
        item._id,
        reminder.due_date,
        reminder.kind,
        reminder.quote,
        deps.now(),
        1
      )
    });
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
    // remindList 不再出现该物品;绝不让提醒指向已删物品
    await removeActiveReminders(deps, event.item_id);
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
 * expected_generation(PR #52 B1):remindList 行返回的提醒轮次号,携带时服务端
 * 只完成「用户实际看到的那一轮」——条件更新命中 0 条即本轮已非该轮:
 * 他轮仍在 → VERSION_CONFLICT(绝不误伤新一轮);本轮已完成且已再生、请求与
 * 当时一致 → 幂等收敛成功;本轮已完成但再生曾失败(done 行欠账标记)→ 治愈
 * 补建后如实成功。缺省 = 旧协议宽口径(该 item 全部 active 置 done),行为不变。
 * 物品必须存在且属于当前家庭且未删(否则 NOT_FOUND);该 item 无 active 提醒也
 * NOT_FOUND(已完成的重复完成按刷新列表收敛,绝不静默复活)。
 * 将命中的 active 提醒置 done 并记 completed_at;period_days>0 时再生一条新
 * active 提醒:due_date = 完成基准日 + period_days 天(跨月/跨年自然进位),
 * kind 固定「下次维护」(周期再生语义),quote 为空(再生提醒无原话锚点)。
 * 再生行的 _id 由 (item, 下一轮次) 确定性派生:并发双写只插成一条,第二笔被
 * _id 唯一性拒绝后回查收敛——并发/重试/中断后「每 item 至多一条 active、
 * 同一轮至多完成与再生一次」。再生插入失败时如实上抛(绝不假装完成),done 行
 * 携带 next_period_days/next_due 欠账标记,同参数重试走治愈路径恢复。
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
    regenDue = addDays(now.slice(0, 10), periodDays);
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
      // 旧协议:无 active 即 NOT_FOUND(既有语义,刷新收敛)
      return fail("NOT_FOUND");
    }
    return completeDivergence(deps, item, expectedGeneration, periodDays);
  }

  if (periodDays > 0) {
    var newGen;
    if (expectedGeneration !== undefined) {
      newGen = expectedGeneration + 1;
    } else {
      // 旧协议:以本次刚置 done 的行(completed_at 唯一)推下一轮次
      var justDone = await reminders(deps)
        .where({
          household_id: deps.householdId,
          item_id: event.item_id,
          status: "done",
          completed_at: now
        })
        .get();
      var doneData = (justDone && justDone.data) || [];
      var maxGen = 0;
      for (var i = 0; i < doneData.length; i++) {
        if (Number.isInteger(doneData[i].generation) && doneData[i].generation > maxGen) {
          maxGen = doneData[i].generation;
        }
      }
      newGen = maxGen + 1;
    }
    return regenOrConverge(deps, item, newGen, regenDue, now);
  }
  return { ok: true };
}

/**
 * 条件更新命中 0 条后的裁定(仅 expected_generation 携带时):
 * ① 已有更新的一轮 active(他人完成了本轮并再生/改设):请求与该轮完成时的
 *    周期一致 → 幂等收敛成功(replayed);否则 VERSION_CONFLICT,绝不误伤;
 * ② 无 active 且该轮 done 行带欠账标记(再生插入曾失败)→ 治愈补建(同参数),
 *    这是「再生失败」的恢复路径;无欠账 → NOT_FOUND(刷新收敛,旧语义)。
 */
async function completeDivergence(deps, item, expectedGeneration, periodDays) {
  var itemId = item._id;
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
    // 治愈:按当时的欠账标记(due 已记录,不随治愈时间漂移)补建再生行
    return regenOrConverge(deps, item, expectedGeneration + 1, doneRow.next_due, deps.now());
  }
  return fail("NOT_FOUND");
}

/**
 * 插入周期再生行(确定性 _id):并发孪生已插成同一 _id 时捕获重复键错误后
 * 回查收敛成功;其他插入失败如实上抛(done 行欠账标记仍在,同参重试可治愈)。
 */
async function regenOrConverge(deps, item, newGen, dueDate, now) {
  var doc = buildRegenDoc(deps, item._id, newGen, dueDate, now);
  try {
    await reminders(deps).add({ data: doc });
    return { ok: true, reminder: remindRow(doc, item) };
  } catch (e) {
    if (!isDuplicateKeyError(e)) {
      // 再生失败:绝不假装完成——如实上抛,欠账标记留给重试治愈
      throw e;
    }
    var twin = await reminders(deps)
      .where({
        household_id: deps.householdId,
        item_id: item._id,
        status: "active",
        generation: newGen
      })
      .get();
    if (twin.data && twin.data.length > 0) {
      return { ok: true, reminder: remindRow(twin.data[0], item), replayed: true };
    }
    throw e;
  }
}

/**
 * remindClear:入参 { action:"remindClear", item_id, expected_generation? }。
 * 硬删除该 item 的全部 active 提醒(done 历史保留);天然幂等,
 * 无可清时 cleared:0 也是成功。物品删除(delete)的级联清理同款。
 * expected_generation(PR #52 B1):携带时只清「用户看到的那一轮」——
 * 命中 0 条且仍有 active(他人后来更新)→ VERSION_CONFLICT,绝不静默删掉
 * 别人的新提醒;命中 0 条且确无 active → 幂等成功(cleared:0)。
 * 清除成功同时作废 done 行的欠账再生标记(用户不要任何提醒,旧欠账不复活)。
 */
async function remindClearItem(event, deps) {
  if (!validItemId(event.item_id)) {
    return fail("INVALID_INPUT");
  }
  var expectedGeneration = validExpectedGeneration(event);
  if (expectedGeneration === "INVALID") {
    return fail("INVALID_INPUT");
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
 * 替换语义:先清该 item 命中的 active 提醒(remindClear 同款硬删)再建一条新
 * active,新行轮次 = 该 item 历史最大轮次 + 1(单调递增绝不重置,旧页的
 * expected_generation 永远命中不了新行)——「每 item 至多一条 active」不变形,
 * 重复对同一物品设不同日子不堆积;成功后作废历史欠账再生标记。
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

  // 轮次号先于任何删除计算:被替换的 active 行的轮次也计入历史最大值,
  // 新行轮次严格递增绝不重置(旧页的 expected_generation 永远命中不了新行)
  var gen = await nextGeneration(deps, event.item_id);

  if (expectedGeneration === undefined) {
    // 旧协议:无条件替换(既有语义)
    await removeActiveReminders(deps, event.item_id);
  } else if (expectedGeneration === 0) {
    // 补录:页面确认无提醒,若他人已立新提醒 → 显式冲突
    var actives = await reminders(deps)
      .where({ household_id: deps.householdId, item_id: event.item_id, status: "active" })
      .get();
    if (actives.data && actives.data.length > 0) {
      return fail("VERSION_CONFLICT");
    }
  } else {
    // 改期:只替换「用户看到的那一轮」,命中不了 → 他人已更新,绝不静默覆盖
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
      return fail("VERSION_CONFLICT");
    }
  }

  // 确定性 _id(item + 目标轮次唯一):并发同轮补录第二笔被 _id 唯一性拒绝,
  // 捕获后按显式冲突处理(他人已立提醒,刷新后重选),绝不插出第二条 active
  var doc = buildReminderDoc(
    deps,
    event.item_id,
    reminder.due_date,
    reminder.kind,
    reminder.quote,
    deps.now(),
    gen
  );
  doc._id = "rs_" + event.item_id + "_g" + gen;
  try {
    await reminders(deps).add({ data: doc });
  } catch (e) {
    if (!isDuplicateKeyError(e)) {
      throw e;
    }
    return fail("VERSION_CONFLICT");
  }
  // 新提醒已立:历史欠账再生标记一并作废(防旧欠账日后被治愈复活)
  await clearOwedRegen(deps, event.item_id);
  return { ok: true, reminder: remindRow(doc, item) };
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
