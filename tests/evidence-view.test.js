"use strict";

/**
 * 拍照识物证据回放视图纯函数(#3,IMPLEMENTATION.md §6):
 * miniprogram/utils/evidence-view.js 编译产物的数据映射 / 无证据降级 /
 * 历史语义文案(照片=历史证据,不冒充当前位置)。
 *
 * 离线纪律:零网络、零外部依赖、不 require wx-server-sdk;被测对象是
 * `npm run build:mp` 产物,直接 require。时间戳用本地时间构造(toISOString
 * 落在同一自然日,免时区漂移,与 tests/updated-at-wording.test.js 同款)。
 */

var test = require("node:test");
var assert = require("node:assert/strict");
var path = require("node:path");

var ROOT = path.join(__dirname, "..");

var evidenceView = require(path.join(ROOT, "miniprogram", "utils", "evidence-view.js"));

function localIso(y, m, d, h) {
  return new Date(y, m - 1, d, h || 10, 30, 0).toISOString();
}

/** 证据行工厂(合成数据;真实照片绝不进仓库) */
function evRow(overrides) {
  return Object.assign(
    {
      item_id: "it-1",
      file_id: "cloud://photo-evidence/default/202610/a.jpg",
      photo_url: "https://tmp.example/a.jpg",
      box: { x1: 0.273, y1: 0.389, x2: 0.593, y2: 0.507 },
      img_w: 1024,
      img_h: 768,
      captured_location_text: "客厅电视柜 · 第一层",
      source: "vl",
      created_at: localIso(2026, 10, 17, 10),
    },
    overrides,
  );
}

/* ---------------- 数据映射 ---------------- */

test("证据行→视图:角标「📷 拍摄于 MM-DD · 当时记录:…」、框 0-1→百分比、aspect 字符串", function () {
  var view = evidenceView.mapEvidenceView([evRow()], "客厅电视柜 · 第一层");
  assert.notEqual(view, null, "有证据行必须有视图");
  assert.equal(
    view.latest.badge,
    "📷 拍摄于 10-17 · 当时记录:客厅电视柜 · 第一层",
    "角标如实说明拍摄当日记录在哪",
  );
  assert.equal(view.latest.aspect, "1024 / 768", "等比容器 aspect-ratio 值");
  assert.deepEqual(
    view.latest.box,
    { left: 27.3, top: 38.9, width: 32, height: 11.8 },
    "0-1 框映射为 0-100 百分比(容器等比跟随原图)",
  );
  assert.equal(view.latest.photoUrl, "https://tmp.example/a.jpg", "临时链接透传");
  assert.equal(view.latest.urlFail, false, "换链成功行不带失败标记");
  assert.equal(view.olderCount, 0, "单行没有更早列表");
  assert.deepEqual(view.older, [], "更早列表为空数组");
});

test("box=null 的证据行:只显照片不画框(整照关联/手动行)", function () {
  var view = evidenceView.mapEvidenceView(
    [evRow({ box: null, source: "circle" })],
    "客厅电视柜 · 第一层",
  );
  assert.equal(view.latest.box, null, "无框行视图 box 为 null");
});

test("多行按 created_at 降序:最新一张主显,其余进「更早的照片」", function () {
  var view = evidenceView.mapEvidenceView(
    [
      evRow({ file_id: "cloud://old.jpg", photo_url: "https://tmp.example/old.jpg", created_at: localIso(2026, 9, 30, 10) }),
      evRow({ created_at: localIso(2026, 10, 17, 10) }),
      evRow({ file_id: "cloud://mid.jpg", photo_url: "https://tmp.example/mid.jpg", created_at: localIso(2026, 10, 10, 10) }),
    ],
    "客厅电视柜 · 第一层",
  );
  assert.equal(view.latest.photoUrl, "https://tmp.example/a.jpg", "最新一张(10-17)主显");
  assert.equal(view.olderCount, 2, "更早的照片 2 张");
  assert.equal(view.older[0].photoUrl, "https://tmp.example/mid.jpg", "更早列表同样降序(10-10 在前)");
  assert.equal(view.older[1].photoUrl, "https://tmp.example/old.jpg", "最旧(09-30)最后");
});

test("created_at 解析不出时不编造日期:角标去掉日期段,只留「留证照片」", function () {
  var view = evidenceView.mapEvidenceView(
    [evRow({ created_at: "not-a-date" })],
    "客厅电视柜 · 第一层",
  );
  assert.equal(
    view.latest.badge,
    "📷 留证照片 · 当时记录:客厅电视柜 · 第一层",
    "不冒充拍摄日期",
  );
});

test("行视图 key = file_id(唯一索引成员,列表 key 稳定)", function () {
  var view = evidenceView.mapEvidenceView([evRow()], "客厅电视柜 · 第一层");
  assert.equal(view.latest.key, "cloud://photo-evidence/default/202610/a.jpg");
});

/* ---------------- 无证据降级 ---------------- */

test("空集合 → null:整卡不渲染,不存在假证据", function () {
  assert.equal(evidenceView.mapEvidenceView([], "厨房"), null, "空数组");
  assert.equal(evidenceView.mapEvidenceView(undefined, "厨房"), null, "undefined 容错");
});

test("photo_url 为空串(换链失败):urlFail=true,file_id 仍在视图 key 里可重试", function () {
  var view = evidenceView.mapEvidenceView(
    [evRow({ photo_url: "" })],
    "客厅电视柜 · 第一层",
  );
  assert.equal(view.latest.urlFail, true, "换链失败标记");
  assert.equal(view.latest.photoUrl, "", "空链接如实透传");
  assert.notEqual(view.latest.key, "", "file_id 仍在");
});

/* ---------------- 历史语义文案(照片=历史证据) ---------------- */

test("位置已变更:拍摄时位置文本 ≠ 当前记录 → 徽标 +「现在:…(以文字为准);旧照片仅作证据」", function () {
  var view = evidenceView.mapEvidenceView(
    [evRow({ captured_location_text: "玄关柜 · 第二层" })],
    "玄关柜 · 第一层",
  );
  assert.equal(view.latest.changed, true, "位置已变更判定");
  assert.equal(
    view.latest.subText,
    "现在:玄关柜 · 第一层(以文字为准);旧照片仅作证据",
    "副文案以文字位置为准,旧照片只作证据",
  );
});

test("位置一致(首尾空白不计):changed=false,副文案「照片与当前记录一致」", function () {
  var view = evidenceView.mapEvidenceView(
    [evRow({ captured_location_text: "  客厅电视柜 · 第一层  " })],
    "客厅电视柜 · 第一层",
  );
  assert.equal(view.latest.changed, false, "trim 后一致不算变更");
  assert.equal(view.latest.subText, "照片与当前记录一致");
});

test("文案纪律红线:任何分支都不出现「现在就在这里」式断言,照片不冒充当前位置", function () {
  var changed = evidenceView.mapEvidenceView(
    [evRow({ captured_location_text: "旧位置" })],
    "新位置",
  );
  var same = evidenceView.mapEvidenceView([evRow()], "客厅电视柜 · 第一层");
  [changed.latest, same.latest].forEach(function (v) {
    assert.ok(v.subText.indexOf("以文字为准") !== -1 || v.changed === false, "副文案语义完整");
    assert.ok(v.badge.indexOf("当时记录") !== -1, "角标必须说明「当时记录」,不是现在");
  });
});

/* ---------------- 搜索结果行缩略映射 ---------------- */

test("pickEvidenceUrls:每件取最新一张换链成功的链接;空链接/无关行不返回", function () {
  var urls = evidenceView.pickEvidenceUrls(
    [
      evRow({ item_id: "it-a", photo_url: "https://tmp.example/a1.jpg", created_at: localIso(2026, 10, 1, 10) }),
      evRow({ item_id: "it-a", photo_url: "https://tmp.example/a2.jpg", created_at: localIso(2026, 10, 17, 10) }),
      evRow({ item_id: "it-b", photo_url: "", created_at: localIso(2026, 10, 17, 10) }),
      evRow({ item_id: "it-c", photo_url: "https://tmp.example/c.jpg", created_at: localIso(2026, 10, 5, 10) }),
      evRow({ item_id: "it-other", photo_url: "https://tmp.example/x.jpg", created_at: localIso(2026, 10, 5, 10) }),
    ],
    ["it-a", "it-b", "it-c"],
  );
  assert.equal(urls["it-a"], "https://tmp.example/a2.jpg", "取该件最新一张");
  assert.equal(urls["it-b"], undefined, "换链失败(空链接)没有可渲染 src,不返回");
  assert.equal(urls["it-c"], "https://tmp.example/c.jpg");
  assert.equal(urls["it-other"], undefined, "不在结果清单里的行不返回");
  assert.equal(urls["it-nope"], undefined, "无证据的物品不编造");
});
