"use strict";

/**
 * 字段级冲突判定(issue #6)的离线测试(纯逻辑,零外部依赖)。
 * 被测对象是 `npm run build:mp` 产出的 miniprogram/utils/conflict.js
 * (package.json 的 pretest 已保证先编译)。
 *
 * 覆盖 issue #6 验收清单里可自动化的项:
 * - 不同字段修改:不判冲突,三方合并保留双方变更;
 * - 同一字段三方不同:判冲突,输出两版值供页面并排展示;
 * - 双方改成相同值(local == remote):不判冲突;
 * - 选择远端/本地各自的结果形状(buildUpdateChanges 视角):
 *   选远端与最新基准一致 → 无 changes(不自动再写);
 *   选本地保留差异 → 以该字段提交(由页面带最新 expected_version 发出)。
 * 两台真机交互(冲突面板展示、选择按钮)属手动验收,见 PR 描述。
 */

var test = require("node:test");
var assert = require("node:assert/strict");

var conflict = require("../miniprogram/utils/conflict");
var mergeLatest = conflict.mergeLatest;
var chosenValue = conflict.chosenValue;
var buildUpdateChanges = conflict.buildUpdateChanges;

function values(name, location, note) {
  return { name: name, location: location, note: note };
}

test("不同字段修改:不判冲突,三方合并保留双方变更", function () {
  // 设备 1(本机)改名称,设备 2(远端)改位置,备注都没动
  var out = mergeLatest(
    values("钥匙", "位置A", "备注N"),
    values("钥匙串", "位置A", "备注N"),
    values("钥匙", "位置B", "备注N")
  );
  assert.deepEqual(out.conflicts, [], "双方改的是不同字段,不应判冲突");
  assert.deepEqual(
    out.merged,
    values("钥匙串", "位置B", "备注N"),
    "合并应保留双方变更:名称取本地,位置取远端"
  );
});

test("同一字段三方不同:判冲突,并排输出你的修改与最新记录", function () {
  // issue 复现场景:基准位置 A,本机改 C,远端改 B
  var out = mergeLatest(
    values("钥匙", "位置A", "备注N"),
    values("钥匙", "位置C", "备注N"),
    values("钥匙", "位置B", "备注N")
  );
  assert.equal(out.conflicts.length, 1, "仅位置一个字段冲突");
  assert.deepEqual(out.conflicts[0], {
    key: "location",
    label: "位置",
    localValue: "位置C",
    remoteValue: "位置B",
  });
  assert.equal(out.merged.location, "位置C", "冲突字段回填表单暂取本地值,等待显式选择");
  assert.deepEqual(
    { name: out.merged.name, note: out.merged.note },
    { name: "钥匙", note: "备注N" },
    "无关字段不受冲突影响"
  );
});

test("双方改成相同值(local == remote):不判冲突,合并为该值", function () {
  var out = mergeLatest(
    values("钥匙", "位置A", "备注N"),
    values("钥匙", "位置B", "备注N"),
    values("钥匙", "位置B", "备注N")
  );
  assert.deepEqual(out.conflicts, [], "两边最终一致,无需用户裁决");
  assert.equal(out.merged.location, "位置B");
});

test("仅一方修改(另一方与基准一致):不判冲突,采纳修改方", function () {
  // 仅本地改:保留本地
  var localOnly = mergeLatest(
    values("钥匙", "位置A", "备注N"),
    values("钥匙", "位置C", "备注N"),
    values("钥匙", "位置A", "备注N")
  );
  assert.deepEqual(localOnly.conflicts, []);
  assert.equal(localOnly.merged.location, "位置C");

  // 仅远端改:采纳远端
  var remoteOnly = mergeLatest(
    values("钥匙", "位置A", "备注N"),
    values("钥匙", "位置A", "备注N"),
    values("钥匙", "位置B", "备注N")
  );
  assert.deepEqual(remoteOnly.conflicts, []);
  assert.equal(remoteOnly.merged.location, "位置B");
});

test("多个字段各自冲突:逐字段输出,互不还原", function () {
  var out = mergeLatest(
    values("钥匙", "位置A", "备注N"),
    values("钥匙串", "位置C", ""),
    values("备用钥匙", "位置B", "挂玄关")
  );
  assert.equal(out.conflicts.length, 3, "名称/位置/备注三方各不相同,均判冲突");
  assert.deepEqual(
    out.conflicts.map(function (c) { return c.key; }),
    ["name", "location", "note"]
  );
  // 空字符串也是有效值:备注「清空」与远端「挂玄关」冲突,localValue 为空串
  assert.deepEqual(out.conflicts[2], {
    key: "note",
    label: "备注",
    localValue: "",
    remoteValue: "挂玄关",
  });
  assert.deepEqual(
    out.merged,
    values("钥匙串", "位置C", ""),
    "冲突字段暂取本地值,无字段被整表单回退"
  );
});

test("选择远端版本:回显并保留远端值,与最新基准一致即无 changes(不自动再写)", function () {
  var out = mergeLatest(
    values("钥匙", "位置A", "备注N"),
    values("钥匙", "位置C", "备注N"),
    values("钥匙", "位置B", "备注N")
  );
  var resolved = out.merged;
  resolved.location = chosenValue(out.conflicts[0], "remote");
  assert.equal(resolved.location, "位置B", "选择远端应回填最新记录的值");
  // 刷新后基准已更新为远端值:选远端的结果与之完全一致,保存时无 changes
  assert.deepEqual(
    buildUpdateChanges(values("钥匙", "位置B", "备注N"), resolved),
    {},
    "选远端后表单与最新基准一致,不应产生任何提交"
  );
});

test("选择本地版本:保留用户值,保存时仅提交该字段(以最新 expected_version)", function () {
  var out = mergeLatest(
    values("钥匙", "位置A", "旧备注"),
    values("钥匙", "位置C", "新备注"),
    values("钥匙", "位置B", "旧备注")
  );
  // 位置冲突选本地;备注是仅本地修改的非冲突字段,三方合并保留本地
  var resolved = out.merged;
  resolved.location = chosenValue(out.conflicts[0], "local");
  assert.equal(resolved.location, "位置C");
  assert.deepEqual(
    buildUpdateChanges(values("钥匙", "位置B", "旧备注"), resolved),
    { location_text: "位置C", note: "新备注" },
    "选择本地后,冲突字段与本地独有修改都应进入 changes,基准为刷新后的最新值"
  );
});

test("buildUpdateChanges:与保存口径一致,无变化返回空对象", function () {
  assert.deepEqual(
    buildUpdateChanges(values("钥匙", "位置A", "备注N"), values("钥匙", "位置A", "备注N")),
    {}
  );
  assert.deepEqual(
    buildUpdateChanges(values("钥匙", "位置A", "备注N"), values("钥匙", "位置A", "备注X")),
    { note: "备注X" },
    "location 差异应映射为 wire 字段名 location_text"
  );
  assert.deepEqual(
    buildUpdateChanges(values("钥匙", "位置A", "备注N"), values("钥匙B", "位置A2", "备注X")),
    { name: "钥匙B", location_text: "位置A2", note: "备注X" }
  );
});

test("旧文档缺 note(undefined)按空串参与比较,不产生 undefined 值", function () {
  // 远端投影原样返回缺失的 note(undefined):与用户清空的 "" 视为同一值,
  // 不应让用户在两个看不见差异的「(空)」里做选择
  var cleared = mergeLatest(
    values("钥匙", "位置A", "旧备注"),
    values("钥匙", "位置A", ""),
    { name: "钥匙", location: "位置A", note: undefined }
  );
  assert.deepEqual(cleared.conflicts, [], "空串与缺失视为同一值(都等于没有备注)");
  assert.equal(cleared.merged.note, "");

  // 用户改了备注、远端缺 note:判冲突,但远端值必须是字符串,选远端回填后 .trim() 不抛错
  var conflictOut = mergeLatest(
    values("钥匙", "位置A", "旧备注"),
    values("钥匙", "位置A", "新备注"),
    { name: "钥匙", location: "位置A", note: undefined }
  );
  assert.equal(conflictOut.conflicts.length, 1, "备注一方清缺、一方改写,应判冲突");
  assert.equal(conflictOut.conflicts[0].remoteValue, "", "undefined 应兜底为空串");
  assert.equal(
    typeof conflictOut.conflicts[0].remoteValue,
    "string",
    "冲突两版值必须是字符串,否则回填表单后保存 .trim() 会抛 TypeError"
  );
  assert.equal(chosenValue(conflictOut.conflicts[0], "remote"), "");
  assert.equal(conflictOut.merged.note, "新备注", "冲突字段回填表单暂取本地值");
});
