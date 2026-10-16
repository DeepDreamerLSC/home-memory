"use strict";

/**
 * 到期推送聚合纯函数(issue #36 V1.5):日期窗口判定 + 按家庭聚合出订阅消息
 * 卡片四字段。无 IO、无身份输入,便于离线测试(tests/remind-notify.test.js RN-AGG)。
 * 口径:
 * - 「今天/明天」按 Asia/Shanghai(UTC+8 固定偏移,中国无夏令时)的自然日
 *   判定(timer 每天 08:00 触发,此刻 UTC 为 00:00,绝不能按 UTC 折日期);
 * - 主物品 = 最早到期的一件(同日按 item_id 稳定排序),到期日期 = 最早日期;
 * - thing 字段 20 码点硬上限(微信订阅消息 thing.DATA 限制):单件名称直取截断,
 *   多件先留足「 等 N 件」后缀再截名称,后缀必须完整保留;
 * - 多件且位置文本不同 → 「家中多处」;同一位置文本 → 沿用该文本(同样截断);
 * - 温馨提醒:只要有一件今天到期 → 「今天到期,点开处理」;全是明天 →
 *   「明天到期,记得看看」(两者均 ≤20 字)。
 */

var THING_MAX_CODEPOINTS = 20;
var TZ_SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
var YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

function pad2(n) {
  return n < 10 ? "0" + n : String(n);
}

/** ISO 时间 → Asia/Shanghai 自然日(YYYY-MM-DD);解析失败返回 null */
function shanghaiYmd(nowIso) {
  var t = Date.parse(nowIso);
  if (Number.isNaN(t)) {
    return null;
  }
  var d = new Date(t + TZ_SHANGHAI_OFFSET_MS);
  return d.getUTCFullYear() + "-" + pad2(d.getUTCMonth() + 1) + "-" + pad2(d.getUTCDate());
}

/** 纯日期算术(UTC 日历日,跨月/跨年自然进位;与 itemsApi 的 addDays 同口径) */
function addDaysYmd(ymd, days) {
  var t = Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(5, 7)) - 1, Number(ymd.slice(8, 10)));
  var dt = new Date(t + days * 86400000);
  return dt.getUTCFullYear() + "-" + pad2(dt.getUTCMonth() + 1) + "-" + pad2(dt.getUTCDate());
}

/** 到期窗口:due_date ∈ {今天, 明天}(两端含);形状非法一律不纳入 */
function inDueWindow(dueDate, todayYmd) {
  if (typeof dueDate !== "string" || !YMD_RE.test(dueDate)) {
    return false;
  }
  return dueDate === todayYmd || dueDate === addDaysYmd(todayYmd, 1);
}

/** 码点截断(thing.DATA 上限 20 字符,按 Unicode 码点数不按 UTF-16 单元) */
function clampCodePoints(text, max) {
  var chars = Array.from(text);
  if (chars.length <= max) {
    return text;
  }
  return chars.slice(0, max).join("");
}

/** 主物品排序:最早到期优先;同日按 item_id 升序保证确定性 */
function byDueThenItemId(a, b) {
  if (a.due_date !== b.due_date) {
    return a.due_date < b.due_date ? -1 : 1;
  }
  if (a.item_id === b.item_id) {
    return 0;
  }
  return a.item_id < b.item_id ? -1 : 1;
}

/**
 * 按家庭聚合订阅消息卡片四字段(纯函数)。
 * rows:已过滤进窗口、已连接物品的提醒行
 *   [{ household_id, item_id, name, location_text, due_date }]。
 * 返回 { <household_id>: { name, date, location, tip } }——语义字段名,
 * 模板关键词 key(thing1/date2/…)的映射在调用方(handler.js 单一常量处)。
 */
function buildHouseholdCards(rows, todayYmd) {
  var grouped = {};
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (!Object.prototype.hasOwnProperty.call(grouped, r.household_id)) {
      grouped[r.household_id] = [];
    }
    grouped[r.household_id].push(r);
  }
  var cards = {};
  var ids = Object.keys(grouped);
  for (var g = 0; g < ids.length; g++) {
    var householdId = ids[g];
    var sorted = grouped[householdId].slice().sort(byDueThenItemId);
    var primary = sorted[0];
    var nameField;
    if (sorted.length === 1) {
      nameField = clampCodePoints(primary.name, THING_MAX_CODEPOINTS);
    } else {
      // 多件:「X 等 N 件」——名称先留足后缀长度再截断,后缀完整不丢「件」字
      var suffix = " 等 " + sorted.length + " 件";
      var base = clampCodePoints(primary.name, Math.max(1, THING_MAX_CODEPOINTS - Array.from(suffix).length));
      nameField = base + suffix;
    }
    var locations = [];
    for (var s = 0; s < sorted.length; s++) {
      var loc = sorted[s].location_text || "";
      if (locations.indexOf(loc) === -1) {
        locations.push(loc);
      }
    }
    var locationField =
      locations.length <= 1
        ? clampCodePoints(locations[0] || "", THING_MAX_CODEPOINTS)
        : "家中多处";
    var hasToday = false;
    for (var d = 0; d < sorted.length; d++) {
      if (sorted[d].due_date === todayYmd) {
        hasToday = true;
        break;
      }
    }
    cards[householdId] = {
      name: nameField,
      date: primary.due_date,
      location: locationField,
      tip: hasToday ? "今天到期,点开处理" : "明天到期,记得看看"
    };
  }
  return cards;
}

module.exports = {
  shanghaiYmd: shanghaiYmd,
  addDaysYmd: addDaysYmd,
  inDueWindow: inDueWindow,
  buildHouseholdCards: buildHouseholdCards
};
