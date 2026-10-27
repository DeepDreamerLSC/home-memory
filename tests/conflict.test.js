"use strict";

/**
 * 字段级冲突判定(issue #6)的离线测试(纯逻辑 + 页面接线静态断言,零外部依赖)。
 * 被测对象是 `npm run build:mp` 产出的 miniprogram/utils/conflict.js 与
 * miniprogram/pages/item 的源码/产物(package.json 的 pretest 已保证先编译)。
 *
 * 移植自 PR #12 的 tests/conflict.test.js(9 项全数保留,values 助手按 main 的
 * 四字段合同加了一个提醒位),并新增移植到新 D1 详情页所需的覆盖:
 * - 提醒字段(旧 PR 没有)的双值冲突判定与选边落地口径;
 * - 新页面结构下的「禁用-选择-提交」链(门禁纯函数 + 折叠内面板/保存禁用接线)。
 * 两台真机交互(冲突面板展示、选择按钮)属手动验收,见 PR 描述。
 */

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");

var conflict = require("../miniprogram/utils/conflict");
var mergeLatest = conflict.mergeLatest;
var chosenValue = conflict.chosenValue;
var buildUpdateChanges = conflict.buildUpdateChanges;
var conflictUnresolved = conflict.conflictUnresolved;
var resolveRemindChoice = conflict.resolveRemindChoice;
var carryUnresolved = conflict.carryUnresolved;

var ROOT = path.join(__dirname, "..");

function read(rel) {
  return fs.readFileSync(path.join(ROOT, "miniprogram", rel), "utf8");
}

/** 四字段快照助手:提醒为 YYYY-MM-DD 日期串,缺省 "" = 不带提醒 */
function values(name, location, note, remind) {
  return { name: name, location: location, note: note, remind: remind || "" };
}

/* ---------------- 移植自 PR #12 的 9 项(断言口径不变) ---------------- */

test("不同字段修改:不判冲突,三方合并保留双方变更", function () {
  // 设备 1(本机)改名称,设备 2(远端)改位置,备注/提醒都没动
  var out = mergeLatest(
    values("钥匙", "位置A", "备注N", "2026-10-20"),
    values("钥匙串", "位置A", "备注N", "2026-10-20"),
    values("钥匙", "位置B", "备注N", "2026-10-20")
  );
  assert.deepEqual(out.conflicts, [], "双方改的是不同字段,不应判冲突");
  assert.deepEqual(
    out.merged,
    values("钥匙串", "位置B", "备注N", "2026-10-20"),
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
    buildUpdateChanges({ name: "钥匙", location: "位置B", note: "备注N" }, resolved),
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
    buildUpdateChanges({ name: "钥匙", location: "位置B", note: "旧备注" }, resolved),
    { location_text: "位置C", note: "新备注" },
    "选择本地后,冲突字段与本地独有修改都应进入 changes,基准为刷新后的最新值"
  );
});

test("buildUpdateChanges:与保存口径一致,无变化返回空对象", function () {
  assert.deepEqual(
    buildUpdateChanges({ name: "钥匙", location: "位置A", note: "备注N" }, { name: "钥匙", location: "位置A", note: "备注N" }),
    {}
  );
  assert.deepEqual(
    buildUpdateChanges({ name: "钥匙", location: "位置A", note: "备注N" }, { name: "钥匙", location: "位置A", note: "备注X" }),
    { note: "备注X" },
    "location 差异应映射为 wire 字段名 location_text"
  );
  assert.deepEqual(
    buildUpdateChanges({ name: "钥匙", location: "位置A", note: "备注N" }, { name: "钥匙B", location: "位置A2", note: "备注X" }),
    { name: "钥匙B", location_text: "位置A2", note: "备注X" }
  );
});

test("旧文档缺 note(undefined)按空串参与比较,不产生 undefined 值", function () {
  // 远端投影原样返回缺失的 note(undefined):与用户清空的 "" 视为同一值,
  // 不应让用户在两个看不见差异的「(空)」里做选择
  var cleared = mergeLatest(
    values("钥匙", "位置A", "旧备注"),
    values("钥匙", "位置A", ""),
    { name: "钥匙", location: "位置A", note: undefined, remind: "" }
  );
  assert.deepEqual(cleared.conflicts, [], "空串与缺失视为同一值(都等于没有备注)");
  assert.equal(cleared.merged.note, "");

  // 用户改了备注、远端缺 note:判冲突,但远端值必须是字符串,选远端回填后 .trim() 不抛错
  var conflictOut = mergeLatest(
    values("钥匙", "位置A", "旧备注"),
    values("钥匙", "位置A", "新备注"),
    { name: "钥匙", location: "位置A", note: undefined, remind: "" }
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

/* ---------------- 移植新增:提醒字段(#36 后新详情页才有) ---------------- */

test("提醒字段冲突:双方改不同日子,判冲突并排输出两版日期", function () {
  // 基准 10-20(进页时所见),本机改到 10-25,家人改到 11-01
  var out = mergeLatest(
    values("钥匙", "玄关抽屉", "备注N", "2026-10-20"),
    values("钥匙", "玄关抽屉", "备注N", "2026-10-25"),
    values("钥匙", "玄关抽屉", "备注N", "2026-11-01")
  );
  assert.equal(out.conflicts.length, 1, "仅提醒一个字段冲突");
  assert.deepEqual(out.conflicts[0], {
    key: "remind",
    label: "提醒",
    localValue: "2026-10-25",
    remoteValue: "2026-11-01",
  });
  assert.equal(out.merged.remind, "2026-10-25", "冲突字段回填表单暂取本地值,等待显式选择");
  assert.equal(out.merged.name, "钥匙", "无关字段不受提醒冲突影响");

  // 双方改成同一天:不判冲突(无需裁决)
  var sameDay = mergeLatest(
    values("钥匙", "玄关抽屉", "备注N", "2026-10-20"),
    values("钥匙", "玄关抽屉", "备注N", "2026-10-25"),
    values("钥匙", "玄关抽屉", "备注N", "2026-10-25")
  );
  assert.deepEqual(sameDay.conflicts, [], "两边改成同一天,无需用户裁决");
  assert.equal(sameDay.merged.remind, "2026-10-25");

  // 仅家人改了提醒(本机没动):不判冲突,静默采纳远端(既有三方合并语义)
  var remoteOnly = mergeLatest(
    values("钥匙", "玄关抽屉", "备注N", "2026-10-20"),
    values("钥匙", "玄关抽屉", "备注N", "2026-10-20"),
    values("钥匙", "玄关抽屉", "备注N", "2026-11-01")
  );
  assert.deepEqual(remoteOnly.conflicts, []);
  assert.equal(remoteOnly.merged.remind, "2026-11-01");
});

test("提醒清空与他处改期冲突:空串与日期并排,选边落地口径完整", function () {
  // 本机想清除提醒,家人改了期:基准 10-20,local 空,remote 11-01
  var out = mergeLatest(
    values("钥匙", "玄关抽屉", "备注N", "2026-10-20"),
    values("钥匙", "玄关抽屉", "备注N", ""),
    values("钥匙", "玄关抽屉", "备注N", "2026-11-01")
  );
  assert.equal(out.conflicts.length, 1, "清空与他处改期应判冲突");
  var field = out.conflicts[0];
  assert.equal(field.key, "remind");
  assert.equal(field.localValue, "", "空串=不带提醒,是有效的一边");
  assert.equal(field.remoteValue, "2026-11-01");

  // 选远端:回显远端日期即停,不再写库
  var takeRemote = resolveRemindChoice(field, "remote");
  assert.deepEqual(
    takeRemote,
    { displayDate: "2026-11-01", writeAction: null, writeDate: "" },
    "选远端 = 与最新记录一致,不自动再写"
  );

  // 选本地(清空):按既有 remindClear 路径补写,不混进 update changes
  var takeLocal = resolveRemindChoice(field, "local");
  assert.deepEqual(
    takeLocal,
    { displayDate: "", writeAction: "clear", writeDate: "" },
    "选本地清空 = remindClear 补写(以刷新后的最新轮次号)"
  );

  // 反向:本机改期、家人清除 —— 选本地 = remindSet 补写所选日子
  var reverse = mergeLatest(
    values("钥匙", "玄关抽屉", "备注N", "2026-10-20"),
    values("钥匙", "玄关抽屉", "备注N", "2026-10-25"),
    values("钥匙", "玄关抽屉", "备注N", "")
  ).conflicts[0];
  assert.deepEqual(
    resolveRemindChoice(reverse, "local"),
    { displayDate: "2026-10-25", writeAction: "set", writeDate: "2026-10-25" },
    "选本地改期 = remindSet 补写所选日子(以刷新后的最新轮次号)"
  );
});

test("提醒不进 update changes:提醒差异单独走提醒路径,不混入文本提交", function () {
  // 四字段都变了:名称/位置/备注按 update 口径提交,提醒绝不混进 changes
  var changes = buildUpdateChanges(
    { name: "钥匙", location: "位置A", note: "备注N" },
    { name: "钥匙B", location: "位置A2", note: "备注X" }
  );
  assert.deepEqual(
    changes,
    { name: "钥匙B", location_text: "位置A2", note: "备注X" },
    "update changes 只含 name/location_text/note(itemsApi update 合同没有提醒参数)"
  );
  assert.ok(!("remind" in changes) && !("due_date" in changes), "提醒字段不得出现在 update changes 里");
  // 提醒的落地只由 resolveRemindChoice 决定(remindSet/remindClear),与 update 分道
  var field = {
    key: "remind",
    label: "提醒",
    localValue: "2026-10-25",
    remoteValue: "2026-11-01",
  };
  assert.equal(resolveRemindChoice(field, "local").writeAction, "set");
  assert.equal(resolveRemindChoice(field, "remote").writeAction, null);
});

/* ---------------- 移植新增:新 D1 详情页的禁用-选择-提交链 ---------------- */

test("门禁链:未选完冲突字段前禁止提交,逐项显式选择后解禁", function () {
  // 名称/位置/提醒三字段同时冲突:全部未选 → 门禁
  var out = mergeLatest(
    values("钥匙", "位置A", "备注N", "2026-10-20"),
    values("钥匙串", "位置C", "备注N", "2026-10-25"),
    values("备用钥匙", "位置B", "备注N", "2026-11-01")
  );
  assert.equal(out.conflicts.length, 3, "名称/位置/提醒三方各不相同,均判冲突");
  var entries = out.conflicts.map(function (c) {
    return { key: c.key, choice: null };
  });
  assert.equal(conflictUnresolved(entries), true, "存在未选择字段:保存必须禁用");
  // 用户在冲突字段输入框里直接改字:不算选择,门禁保持(页面口径:只同步「你的修改」)
  assert.equal(conflictUnresolved(entries), true, "直接编辑不解除门禁");
  // 逐项显式选择:选完一项门禁仍在,选完全部才解禁
  entries[0].choice = "local";
  assert.equal(conflictUnresolved(entries), true, "还有两个字段没选");
  entries[1].choice = "remote";
  assert.equal(conflictUnresolved(entries), true, "还有一个字段没选");
  entries[2].choice = "local";
  assert.equal(conflictUnresolved(entries), false, "全部选完:保存解禁");
  // 撤回任一选择(输入撤回语义):门禁恢复
  entries[1].choice = null;
  assert.equal(conflictUnresolved(entries), true, "撤回选择后门禁恢复");
  // 空面板:无冲突不设门禁
  assert.equal(conflictUnresolved([]), false);
});

test("提交链:选远端无任何提交,选本地按各自路径提交(文本 update / 提醒 remind*)", function () {
  // 场景:进页基准 名称=钥匙/提醒=10-20,本机改 名称=钥匙串/提醒=10-25,
  // 服务端最新 名称=备用钥匙/提醒=11-01 → 名称与提醒两字段冲突
  var entry = values("钥匙", "位置B", "备注N", "2026-10-20");
  var base = values("备用钥匙", "位置B", "备注N", "2026-11-01");
  var out = mergeLatest(
    entry,
    values("钥匙串", "位置B", "备注N", "2026-10-25"),
    base
  );
  assert.deepEqual(
    out.conflicts.map(function (c) { return c.key; }),
    ["name", "remind"],
    "名称与提醒两字段冲突"
  );
  var nameField = out.conflicts[0];
  var remindField = out.conflicts[1];

  // 都选远端:回填后与最新基准一致,update 无 changes、提醒无需补写
  var allRemote = {
    name: chosenValue(nameField, "remote"),
    location: out.merged.location,
    note: out.merged.note,
  };
  assert.deepEqual(buildUpdateChanges(base, allRemote), {}, "文本与基准一致:无 update 提交");
  assert.equal(resolveRemindChoice(remindField, "remote").writeAction, null, "提醒选远端:无补写");

  // 都选本地:名称进 update changes;提醒走 remindSet(不混入 changes)
  var allLocal = {
    name: chosenValue(nameField, "local"),
    location: out.merged.location,
    note: out.merged.note,
  };
  assert.deepEqual(
    buildUpdateChanges(base, allLocal),
    { name: "钥匙串" },
    "选本地的名称以刷新后最新基准计算 changes(以最新 expected_version 提交)"
  );
  assert.deepEqual(
    resolveRemindChoice(remindField, "local"),
    { displayDate: "2026-10-25", writeAction: "set", writeDate: "2026-10-25" },
    "选本地的提醒按 remindSet 补写,与 update 分道"
  );
});

test("新页面结构接线:冲突面板在独立编辑面板内,保存禁用与双保险门禁在册", function () {
  var wxml = read("pages/item/item.wxml");
  // 冲突在独立编辑面板内、字段之前展示。
  var panelIdx = wxml.indexOf('id="item-edit-panel"');
  var conflictIdx = wxml.indexOf('class="card conflict-card"');
  var fieldIdx = wxml.indexOf('bindinput="onNameInput"');
  assert.ok(panelIdx >= 0 && panelIdx < conflictIdx && conflictIdx < fieldIdx);
  // 双值并排 + 选边按钮 + 提醒用换算后的用户词汇展示
  assert.ok(wxml.indexOf("你的修改") !== -1 && wxml.indexOf("最新记录") !== -1, "并排展示两版值");
  assert.ok(wxml.indexOf("onChooseLocal") !== -1 && wxml.indexOf("onChooseRemote") !== -1, "选边按钮接线");
  assert.ok(wxml.indexOf("localDisplay") !== -1 && wxml.indexOf("remoteDisplay") !== -1, "提醒日期换算后展示");
  // 保存按钮:未选完禁用(门禁可视层)
  var saveIdx = wxml.indexOf("保存修改");
  assert.ok(saveIdx !== -1, "保存按钮在");
  assert.match(wxml, /<button[^>]*disabled="{{\s*conflictPending\s*}}"[^>]*bindtap="onSaveTap">保存修改/, "保存按钮保持冲突禁用门禁");
  // 编译产物:双保险门禁 + 四字段刷新 + 提醒补写路径
  var js = read("pages/item/item.js");
  assert.ok(js.indexOf("请先为冲突字段选择保留哪一版") !== -1, "onSaveTap 内的门禁提示在册");
  assert.ok(js.indexOf("conflictUnresolved") !== -1, "门禁判定复用纯函数(与测试同源)");
  assert.ok(js.indexOf("refreshForConflict") !== -1, "四字段冲突刷新入口在册");
  assert.ok(js.indexOf('action: "remindSet"') !== -1 && js.indexOf('action: "remindClear"') !== -1, "提醒补写复用既有提醒路径");
  assert.ok(js.indexOf("expected_generation") !== -1, "提醒补写携带轮次号(并发写仍走服务端检查)");
});

/* ---------------- 复核修复:未选边冲突跨刷新保留 + 整理位置不再绕开门禁 ---------------- */

test("carryUnresolved:未选边的冲突字段跨刷新保留,门禁不随面板消失", function () {
  // 上一轮:名称冲突(你的修改=钥匙串 / 最新记录=备用钥匙),用户还没选边;
  // 本轮冲突刷新后基准已对齐远端(备用钥匙),名称退化成「仅本机修改」不被重判
  var previous = [
    { key: "name", label: "名称", localValue: "钥匙串", remoteValue: "备用钥匙", choice: null }
  ];
  var carried = carryUnresolved(
    previous,
    [],
    values("钥匙串", "位置A", "备注N", ""),
    values("备用钥匙", "位置A", "备注N", "")
  );
  assert.deepEqual(
    carried,
    [{ key: "name", label: "名称", localValue: "钥匙串", remoteValue: "备用钥匙" }],
    "远端没变、用户没选:条目按两版现值保留"
  );
  // 若不保留,该字段会以新基准算出 {name: 钥匙串} 静默提交覆盖对方——门禁必须仍在:
  assert.equal(
    conflictUnresolved(carried.map(function (c) { return { key: c.key, choice: null }; })),
    true,
    "保留的条目未选边:保存仍被禁"
  );
  // 远端又改了一版:条目按最新两版现值重建(你的修改不变,最新记录换成新值)
  var carriedNew = carryUnresolved(
    previous,
    [],
    values("钥匙串", "位置A", "备注N", ""),
    values("第三版名称", "位置A", "备注N", "")
  );
  assert.deepEqual(
    carriedNew.map(function (c) { return c.remoteValue; }),
    ["第三版名称"],
    "跨刷新保留时最新记录取远端现值"
  );
});

test("carryUnresolved:已选边不保留、两版一致出面板、本轮重判不重复", function () {
  var previous = [
    { key: "name", label: "名称", localValue: "钥匙串", remoteValue: "备用钥匙", choice: "local" },
    { key: "remind", label: "提醒", localValue: "", remoteValue: "2026-11-01", choice: null },
    { key: "note", label: "备注", localValue: "新备注", remoteValue: "挂玄关", choice: null }
  ];
  // 已选边(名称):按普通编辑对待,不回面板;用户值成为待提交修改而非待裁决
  var out = carryUnresolved(
    previous,
    [],
    values("钥匙串", "位置A", "新备注", ""),
    values("备用钥匙", "位置A", "挂玄关", "2026-11-01")
  );
  assert.deepEqual(
    out.map(function (c) { return c.key; }),
    ["remind", "note"],
    "已选边的名称不保留,未选边的提醒/备注保留"
  );
  // 两版已一致(对方把提醒改成了用户选的日子,备注改成了相同值):自然出面板
  var converged = carryUnresolved(
    previous,
    [],
    values("钥匙串", "位置A", "新备注", ""),
    values("备用钥匙", "位置A", "挂玄关", "")
  );
  assert.deepEqual(
    converged.map(function (c) { return c.key; }),
    ["note"],
    "提醒两版一致:无需裁决,不再回面板"
  );
  // 本轮已重判为冲突的字段沿用新条目,不与旧条目重复
  var fresh = [
    { key: "note", label: "备注", localValue: "新备注", remoteValue: "挂玄关" }
  ];
  var deduped = carryUnresolved(
    previous,
    fresh,
    values("钥匙串", "位置A", "新备注", ""),
    values("备用钥匙", "位置A", "挂玄关", "")
  );
  assert.deepEqual(
    deduped.map(function (c) { return c.key; }),
    [],
    "提醒两版一致、备注已重判:无重复条目"
  );
});

test("复核修复接线:整理位置冲突接入选边门禁,静默清面板路径已移除", function () {
  var js = read("pages/item/item.js");
  // 整理位置两个入口的 VERSION_CONFLICT 分支接入四字段冲突刷新;
  // 旧的「静默三方合并 + 顺手清空冲突面板」刷新整体移除,不再留下绕开门禁的路径
  assert.ok(js.indexOf("refreshLatest") === -1, "静默合并并清空面板的旧刷新已移除");
  var pickerEntry = js.slice(js.indexOf("doLinkToNode"), js.indexOf("confirmMount"));
  var confirmEntry = js.slice(js.indexOf("confirmMount"), js.indexOf("cancelMount"));
  assert.ok(pickerEntry.indexOf("refreshForConflict") !== -1, "选择器入口(doLinkToNode)冲突分支接入冲突刷新");
  assert.ok(confirmEntry.indexOf("refreshForConflict") !== -1, "候选分段入口(confirmMount)冲突分支接入冲突刷新");
  assert.ok(js.indexOf("carryUnresolved") !== -1, "未选边冲突跨刷新保留已接线");
  // 提醒远端不可得:基准不向表单值对齐(remindRemoteUnknown 标记)、如实提示、
  // 回页不再清掉待补写的提醒选择
  assert.ok(js.indexOf("remindRemoteUnknown") !== -1, "提醒远端不可得有显式标记");
  assert.ok(js.indexOf("提醒没存上,你的选择已保留") !== -1, "远端不可得时如实说没存上(不说已刷新)");
  var onShow = js.slice(js.indexOf("onShow"), js.indexOf("onNameInput"));
  assert.ok(onShow.indexOf("pendingRemindWrite") !== -1, "有待补写的提醒选择时回页不刷新提醒行");
});
