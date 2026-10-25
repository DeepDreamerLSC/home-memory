"use strict";

/**
 * remindNotify 纯函数 handler(issue #36 V1.5 到期微信提醒推送)。
 * handler(event, deps) 两个入口:
 * a) action=recordSubscription(小程序端 wx.requestSubscribeMessage accept 后调用):
 *    身份只来自 deps.openid / deps.memberKey / deps.resolved(index.js 从可信
 *    OPENID 经 lib/household.js 三向解析注入,与 itemsApi/households 同口径),
 *    绝不从 event 读取任何身份字段;解析失败 fail-closed 零写入;
 *    upsert remind_subscriptions(_id = "rsub_"+household_id+"_"+member_key 确定性
 *    派生,集合 _id 唯一性天然防并发双写),字段:openid / household_id /
 *    member_key / template_id / updated_at / last_sent_date。
 * b) timer 触发(event 无 action;config.json cron 每天 08:00,含控制台手动触发):
 *    扫描全部 active 提醒(分页拉全量)→ 筛「今天/明天到期」(Asia/Shanghai
 *    自然日)→ 连接 items 取名称/位置(悬挂行读侧容忍跳过,口径同 remindList)
 *    → 按家庭聚合卡片四字段(lib/aggregate.js)→ 逐订阅资格复核
 *    (lib/eligibility.js:openid 重算 member_key + 共享家庭在册未解散 /
 *    个人家庭确定性派生)→ 幂等检查(last_sent_date=今天跳过)→ 发送
 *    (deps.send 注入 cloud.openapi.subscribeMessage.send)。
 * 纪律(硬红线):
 * - 日志只落计数与布尔(scanned/due/households/sent/failed/skipped),绝不落
 *   openid / member_key / 物品名 / 位置 / 家庭名 / 提醒日期明细;
 * - 发送成败都盖章 last_sent_date=今天(43101 用户已拒收/额度不足也不再当天
 *   重试打扰);单条失败绝不中断整轮扫描、绝不向上抛;
 * - 查询一律 skip/limit 分页拉全量,超护栏页数如实抛错绝不静默截断;
 * - remind_subscriptions 落 openid 的原因与隔离措施见 PR 安全披露段
 *   (订阅消息 touser 必需;集合权限「所有用户不可读不可写」)。
 */

var aggregate = require("./aggregate");
var eligibility = require("./eligibility");

var SUBSCRIPTIONS_COLLECTION = "remind_subscriptions";
var REMINDERS_COLLECTION = "reminders";
var ITEMS_COLLECTION = "items";
var MEMBERS_COLLECTION = "household_members";
var HOUSEHOLDS_COLLECTION = "households";
// CloudBase 云函数端 get() 单次默认最多 100 条,分页拉全量(itemsApi 同款护栏)
var PAGE_SIZE = 100;
var MAX_PAGES = 100;

/**
 * 订阅消息模板(微信公众平台「质保即将过期提醒」编号 75799,2026-10-16 添加):
 * 模板 ID 非密钥,收敛于本单一常量处(小程序端 miniprogram/utils/subscribe.ts
 * 持有同值的另一份常量)。注:首版用的「保质期到期提醒」模板(WUVZmS47…)在
 * 2026-10-16 当天服务端失效(20001 No template data return,同账号当日添加新
 * 模板后复现;开发者工具实证新模板可弹授权框),遂整体切换,勿回切旧 ID。
 */
var TEMPLATE_ID = "fM4crRcrPk2kQ5iRL0WwTPoRhNS7Da8skrWqfcEdBSM";
/** 卡片点击进入的落地页(提醒页三分组:已过期/这几天/再往后) */
var TEMPLATE_PAGE = "pages/reminders/reminders";
/**
 * 模板四字段关键词 key(2026-10-16 控制台模板详情核实:物品名称 thing1/过保日期
 * time2/所属位置 thing4/温馨提示 thing5——编号是选题顺序非展示顺序,勿按展示位
 * 推断);如控制台再变,只需改这一处映射,聚合语义字段 name/date/location/tip
 * 不变。time2 是**时间类型**关键词,值须带时分(templateData 处统一拼 08:00)。
 */
var TEMPLATE_FIELDS = { name: "thing1", date: "time2", location: "thing4", tip: "thing5" };

var ERROR_MESSAGES = {
  INVALID_INPUT: "输入不合法,请检查后重试",
  UNAUTHORIZED: "请先登录",
  HOUSEHOLD_UNAVAILABLE: "暂时无法确认当前家庭,请稍后重试"
};

function fail(error) {
  return { ok: false, error: error, message: ERROR_MESSAGES[error] };
}

function isString(v) {
  return typeof v === "string";
}

/** 识别 CloudBase 唯一索引拒绝并发插入的错误(E11000 duplicate key,itemsApi 同款) */
function isDuplicateKeyError(e) {
  var msg = e && e.message ? String(e.message) : "";
  return msg.indexOf("E11000") !== -1 || msg.indexOf("duplicate key") !== -1;
}

/** 分页拉全量(skip/limit 逐页,itemsApi fetchActiveReminders 同款模式与护栏) */
async function fetchAll(deps, name, cond) {
  var out = [];
  for (var page = 0; page < MAX_PAGES; page++) {
    var res = await deps.db.collection(name).where(cond).skip(out.length).limit(PAGE_SIZE).get();
    var batch = (res && res.data) || [];
    for (var i = 0; i < batch.length; i++) {
      out.push(batch[i]);
    }
    if (batch.length < PAGE_SIZE) {
      return out;
    }
  }
  throw new Error(name + " query exceeded " + MAX_PAGES * PAGE_SIZE + " documents");
}

/** 订阅文档确定性 _id:household_id + member_key(集合 _id 唯一性防并发双写) */
function subscriptionDocId(householdId, memberKey) {
  return "rsub_" + householdId + "_" + memberKey;
}

// ---------------------------------------------------------------------------
// a) action=recordSubscription:订阅授权落库
// ---------------------------------------------------------------------------

async function recordSubscriptionAction(deps) {
  var r = deps.resolved;
  if (!r || r.ok !== true || !isString(r.householdId) || !isString(deps.memberKey) || !isString(deps.openid)) {
    // fail-closed:家庭解析未通过(孤儿指针/已解散/查询异常)绝不落库
    return fail("HOUSEHOLD_UNAVAILABLE");
  }
  var now = deps.now();
  var doc = {
    _id: subscriptionDocId(r.householdId, deps.memberKey),
    household_id: r.householdId,
    member_key: deps.memberKey,
    openid: deps.openid,
    template_id: TEMPLATE_ID,
    last_sent_date: "",
    updated_at: now
  };
  try {
    await deps.db.collection(SUBSCRIPTIONS_COLLECTION).add({ data: doc });
  } catch (e) {
    if (!isDuplicateKeyError(e)) {
      throw e;
    }
    // 同键重订阅(upsert):刷新 openid / template_id / updated_at;
    // last_sent_date 不动——当天已发过的盖章不被重订阅重置(幂等口径不破)
    await deps.db
      .collection(SUBSCRIPTIONS_COLLECTION)
      .where({ _id: doc._id })
      .update({ data: { openid: doc.openid, template_id: TEMPLATE_ID, updated_at: now } });
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// b) timer 每日扫描:窗口过滤 → 聚合 → 资格复核 → 发送 → 盖章
// ---------------------------------------------------------------------------

/** 按 _id 查家庭元数据行,无则 null(个人家庭在 households 集合中无元数据行) */
async function getHouseholdDoc(deps, householdId) {
  var res = await deps.db.collection(HOUSEHOLDS_COLLECTION).where({ _id: householdId }).get();
  return res && res.data && res.data.length > 0 ? res.data[0] : null;
}

async function memberRowExists(deps, householdId, memberKey) {
  var res = await deps.db
    .collection(MEMBERS_COLLECTION)
    .where({ household_id: householdId, member_key: memberKey })
    .get();
  return !!(res && res.data && res.data.length > 0);
}

/**
 * 过保日期(time2,时间类型关键词)的值格式:微信 time.DATA 要求带时分,统一拼
 * 「X年X月X日 08:00」——08:00 即每日扫描发送时刻,语义如实;月/日不带前导零,
 * 贴官方示例「2019年10月1日 15:01」风格。入参是聚合层的 YYYY-MM-DD(聚合语义
 * 不变,时间化只发生在发送映射这一层);非预期形状原样透传(不在此处吞错)。
 */
function formatNotifyTime(ymd) {
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(typeof ymd === "string" ? ymd : "");
  if (!m) return ymd;
  return m[1] + "年" + Number(m[2]) + "月" + Number(m[3]) + "日 08:00";
}

/** 订阅消息 data 载荷(模板关键词 key 在 TEMPLATE_FIELDS 单一常量处映射) */
function templateData(card) {
  var data = {};
  data[TEMPLATE_FIELDS.name] = { value: card.name };
  data[TEMPLATE_FIELDS.date] = { value: formatNotifyTime(card.date) };
  data[TEMPLATE_FIELDS.location] = { value: card.location };
  data[TEMPLATE_FIELDS.tip] = { value: card.tip };
  return data;
}

async function runDailyScan(deps) {
  var stats = { scanned: 0, due: 0, households: 0, sent: 0, failed: 0, skipped: 0, sendErr: null };
  // 发送失败的微信错误码(纯数字,首次失败记录;43101=额度/拒收,47001/40003=参数等;
  // 不含任何身份/内容,符合「只落计数与布尔」的日志纪律延伸)
  function errCodeOf(e) {
    if (e && typeof e.errCode === "number") return e.errCode;
    var text = String((e && (e.errMsg || e.message)) || "");
    var m = /(?:errcode["\s:=]+|fail\s*)(\d{4,6})/i.exec(text);
    if (m === null) m = /\b(\d{4,6})\b/.exec(text); // 裸 "43101 xxx" 形态
    return m ? Number(m[1]) : -1;
  }
  var today = aggregate.shanghaiYmd(deps.now());

  // 1) 全部 active 提醒(分页拉全量;slot/done 行与 active 查询天然隔离)
  var rows = await fetchAll(deps, REMINDERS_COLLECTION, { status: "active" });
  stats.scanned = rows.length;

  // 2) 窗口过滤(今天/明天,Asia/Shanghai 自然日)+ 连接物品取名称/位置;
  //    物品已删或跨家庭的悬挂行读侧容忍跳过(口径同 itemsApi remindList)
  var itemCache = Object.create(null);
  var joined = [];
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    if (!aggregate.inDueWindow(row.due_date, today)) {
      continue;
    }
    var itemId = row.item_id;
    if (!Object.prototype.hasOwnProperty.call(itemCache, itemId)) {
      var got = await deps.db
        .collection(ITEMS_COLLECTION)
        .where({ _id: itemId, deleted: false })
        .get();
      itemCache[itemId] = (got.data && got.data[0]) || null;
    }
    var item = itemCache[itemId];
    if (!item || item.household_id !== row.household_id) {
      continue;
    }
    joined.push({
      household_id: row.household_id,
      item_id: itemId,
      name: isString(item.name) ? item.name : "",
      location_text: isString(item.location_text) ? item.location_text : "",
      due_date: row.due_date
    });
  }
  stats.due = joined.length;

  // 3) 按家庭聚合卡片四字段(主物品=最早到期件,20 码点截断,位置不同写「家中多处」)
  var cards = aggregate.buildHouseholdCards(joined, today);
  var householdIds = Object.keys(cards);
  stats.households = householdIds.length;

  // 4) 逐家庭逐订阅:资格复核 → 幂等 → 发送 → 盖章
  for (var h = 0; h < householdIds.length; h++) {
    var householdId = householdIds[h];
    var card = cards[householdId];
    var subs = await fetchAll(deps, SUBSCRIPTIONS_COLLECTION, { household_id: householdId });
    var householdDoc = await getHouseholdDoc(deps, householdId);
    for (var s = 0; s < subs.length; s++) {
      var sub = subs[s];
      // 资格复核:重算 sha256(openid) 的 member_key;共享家庭还须在册且未解散
      // (防「订阅后又被移出家庭」);个人家庭按确定性派生判定
      var recomputed = isString(sub.openid) ? deps.memberKeyOf(sub.openid) : null;
      var memberExists = false;
      if (householdDoc !== null) {
        memberExists = await memberRowExists(deps, householdId, recomputed);
      }
      if (!eligibility.eligibleForSend(sub, recomputed, householdDoc, memberExists)) {
        stats.skipped += 1;
        continue;
      }
      // 幂等:今天已发过则跳过(触发器重试/手动重复触发不重复打扰)
      if (eligibility.alreadySentToday(sub, today)) {
        stats.skipped += 1;
        continue;
      }
      var sentOk = false;
      try {
        await deps.send({
          touser: sub.openid,
          templateId: TEMPLATE_ID,
          page: TEMPLATE_PAGE,
          data: templateData(card)
        });
        sentOk = true;
      } catch (e) {
        // 43101 用户未订阅/额度不足等:如实计数,绝不抛出、绝不打断下一条
        sentOk = false;
        if (stats.sendErr === null) stats.sendErr = errCodeOf(e);
      }
      // 发送成败都盖章今天已处理(当天不再重试打扰;明日窗口重新判定)
      await deps.db
        .collection(SUBSCRIPTIONS_COLLECTION)
        .where({ _id: sub._id })
        .update({ data: { last_sent_date: today } });
      if (sentOk) {
        stats.sent += 1;
      } else {
        stats.failed += 1;
      }
    }
  }
  return {
    ok: true,
    sendErr: stats.sendErr,
    scanned: stats.scanned,
    due: stats.due,
    households: stats.households,
    sent: stats.sent,
    failed: stats.failed,
    skipped: stats.skipped
  };
}

// ---------------------------------------------------------------------------
// 路由与日志
// ---------------------------------------------------------------------------

/**
 * 日志只输出 action / 错误码 / 耗时 / 计数(itemsApi logResult 同款纪律),
 * 绝不输出 openid / member_key / 物品名 / 位置 / 家庭名 / 提醒日期明细。
 */
function logResult(deps, action, entry, startedAt) {
  if (!deps || !deps.logger || typeof deps.logger.log !== "function") {
    return;
  }
  var full = Object.assign({ action: isString(action) ? action : null, error: null, ms: Date.now() - startedAt }, entry);
  try {
    deps.logger.log(full);
  } catch (e) {
    // 日志失败绝不影响业务结果
  }
}

/**
 * 纯函数入口:handler(event, deps)
 * deps = { db, now(), memberKeyOf(openid), logger,
 *          send({touser, templateId, page, data}),                 // timer 用
 *          openid, memberKey, resolved }                            // recordSubscription 用
 * - event.action === "recordSubscription" → 订阅落库;
 * - event.action 为其他字符串 → INVALID_INPUT;
 * - event 无 action(timer 触发 / 控制台手动触发)→ 每日扫描推送。
 */
async function handler(event, deps) {
  var startedAt = Date.now();
  var action = event && event.action;
  var label = isString(action) ? action : "dailyScan";
  var result;
  try {
    if (action === "recordSubscription") {
      result = await recordSubscriptionAction(deps);
    } else if (isString(action)) {
      result = fail("INVALID_INPUT");
    } else {
      result = await runDailyScan(deps);
    }
  } catch (err) {
    // 基础设施异常如实记日志(仅 action/错误码/耗时)后向上抛出,绝不静默
    logResult(deps, label, { error: "INTERNAL" }, startedAt);
    throw err;
  }
  var entry = { error: result && result.ok === false ? result.error : null };
  if (action === "recordSubscription") {
    entry.count = result && result.ok ? 1 : 0;
  } else {
    entry.scanned = result.scanned;
    entry.due = result.due;
    entry.households = result.households;
    entry.sent = result.sent;
    entry.failed = result.failed;
    entry.skipped = result.skipped;
    if (result.sendErr !== null && result.sendErr !== undefined) entry.sendErr = result.sendErr;
  }
  logResult(deps, label, entry, startedAt);
  return result;
}

module.exports = {
  handler: handler,
  ERROR_MESSAGES: ERROR_MESSAGES,
  TEMPLATE_ID: TEMPLATE_ID,
  TEMPLATE_PAGE: TEMPLATE_PAGE
};
