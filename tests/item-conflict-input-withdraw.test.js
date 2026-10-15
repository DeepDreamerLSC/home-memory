"use strict";

/**
 * PR #56 架构复审 Low 项:syncConflictFromInput 的真实页面接线测试。
 *
 * 复审意见:输入撤回已选 choice、面板文案与禁用态的 setData 联动此前只有
 * 纯函数(conflict.test.js)+ 静态断言,不足以覆盖实际页面行为。本文件
 * 直接驱动编译产物 item.js 的输入处理器(onNameInput / onRemindDateChange /
 * onRemindFieldClear),按真实 setData 路径语义断言面板条目与保存禁用态
 * (conflictPending,即 wxml disabled 绑定)的联动,不是纯函数测试。
 */

var test = require("node:test");
var assert = require("node:assert/strict");
var path = require("node:path");

var ROOT = path.join(__dirname, "..");

var toasts = [];
var cloudCalls = [];

function installWx() {
  globalThis.wx = {
    showToast: function (o) {
      toasts.push(o);
    },
    showModal: function () {},
    navigateTo: function () {},
    navigateBack: function () {},
    reLaunch: function () {},
    getStorageSync: function () { return ""; },
    setStorageSync: function () {},
    removeStorageSync: function () {},
    cloud: {
      callFunction: function (o) {
        cloudCalls.push({ name: o.name, data: JSON.parse(JSON.stringify(o.data)) });
        Promise.resolve()
          .then(function () {
            return Promise.reject(new Error("本文件不发起任何云调用:" + o.name));
          })
          .then(
            function () {},
            function (err) {
              o.fail({ errMsg: String(err && err.message) });
            },
          );
      },
    },
  };
}

var pageConfig = null;
globalThis.Page = function (config) {
  pageConfig = config;
};

installWx();
require(path.join(ROOT, "miniprogram", "pages", "item", "item.js"));

/** setData 路径语法桩("conflicts[0].choice" 等;与真实 setData 同语义) */
function setPath(obj, key, value) {
  var parts = key.replace(/\]/g, "").split(/[.[]/);
  var cur = obj;
  for (var i = 0; i < parts.length - 1; i++) {
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

function makePage() {
  var page = {
    data: JSON.parse(JSON.stringify(pageConfig.data)),
    setData: function (patch) {
      Object.keys(patch).forEach(function (k) {
        if (k.indexOf(".") === -1 && k.indexOf("[") === -1) {
          page.data[k] = patch[k];
        } else {
          setPath(page.data, k, patch[k]);
        }
      });
    },
  };
  Object.keys(pageConfig).forEach(function (k) {
    if (k !== "data") {
      page[k] = pageConfig[k];
    }
  });
  return page;
}

/** 已进冲突态的页面:名称冲突(已选边)+ 提醒冲突(已选边),保存解禁 */
function chosenPage() {
  var page = makePage();
  pageConfig.applySummary.call(page, {
    item_id: "it-low",
    name: "钥匙",
    location_text: "玄关抽屉",
    note: "",
    version: 5,
    updated_at: "2026-10-14T02:00:00.000Z",
  });
  page.setData({
    conflicts: [
      {
        key: "name",
        label: "名称",
        localValue: "钥匙串",
        remoteValue: "备用钥匙",
        choice: "local",
        localDisplay: "钥匙串",
        remoteDisplay: "备用钥匙",
      },
      {
        key: "remind",
        label: "提醒",
        localValue: "2026-10-25",
        remoteValue: "2026-11-01",
        choice: "local",
        localDisplay: "10月25日 到期",
        remoteDisplay: "11月1日 到期",
      },
    ],
    conflictPending: false, // 两项都已选边:保存解禁
    name: "钥匙串",
    remindAt: "2026-10-25",
  });
  return page;
}

test("LOW-撤回-文本:输入框改字撤回已选 choice,面板「你的修改」与禁用态联动", function () {
  toasts = [];
  var page = chosenPage();
  assert.equal(page.data.conflictPending, false, "前置:两项已选边,保存解禁");

  // 用户在名称输入框里直接改字(不是点选边按钮)
  pageConfig.onNameInput.call(page, { detail: { value: "钥匙扣" } });

  var entry = page.data.conflicts[0];
  assert.equal(entry.choice, null, "输入撤回该字段已做的选择");
  assert.equal(entry.localValue, "钥匙扣", "面板「你的修改」同步为最新输入");
  assert.equal(entry.localDisplay, "钥匙扣", "面板展示文案随之更新");
  assert.equal(page.data.name, "钥匙扣", "表单值更新");
  assert.equal(page.data.conflictPending, true, "禁用态回挂:保存按钮再次禁用(wxml disabled 绑定源)");
  // 提醒条目不受牵连
  assert.equal(page.data.conflicts[1].choice, "local", "其他字段的选择不被误撤");

  // 输入与「你的修改」相同(只敲了空格再删掉):不产生任何 setData 变化
  var before = JSON.stringify(page.data.conflicts);
  pageConfig.onNameInput.call(page, { detail: { value: "钥匙扣" } });
  assert.equal(JSON.stringify(page.data.conflicts), before, "无变化输入不刷面板");

  // 撤回后重新点选边按钮:choice 恢复,其余字段已选,禁用态解除
  pageConfig.applyConflictChoice.call(page, "name", "local");
  assert.equal(page.data.conflicts[0].choice, "local", "重新显式选边生效");
  assert.equal(page.data.conflictPending, false, "全部选完:保存解禁");
});

test("LOW-撤回-提醒:冲突待选时改日子/清除只更新面板候选并撤回选择,不落库", async function () {
  toasts = [];
  cloudCalls = [];
  var page = chosenPage();

  // 改日子:面板「你的修改」换成新日子,撤回已选边,保存重新禁用
  await pageConfig.onRemindDateChange.call(page, { detail: { value: "2026-12-05" } });
  var remind = page.data.conflicts[1];
  assert.equal(remind.choice, null, "改日子撤回已选边");
  assert.equal(remind.localValue, "2026-12-05", "面板「你的修改」为新日子");
  assert.equal(remind.localDisplay, "12月5日 到期", "提醒按用户词汇(月日 到期)换算展示");
  assert.equal(page.data.remindAt, "2026-12-05", "表单候选更新");
  assert.equal(page.data.expire && page.data.expire.dueDate, "2026-12-05", "到期行同步候选便于对照两版");
  assert.equal(page.data.conflictPending, true, "禁用态回挂");
  assert.equal(cloudCalls.length, 0, "待选期间改日子不发任何云调用");

  // 清除:面板「你的修改」变为「不带提醒」,同样撤回选择
  toasts = [];
  await pageConfig.onRemindFieldClear.call(page);
  remind = page.data.conflicts[1];
  assert.equal(remind.choice, null, "清除也维持未选边");
  assert.equal(remind.localValue, "", "面板「你的修改」为空串(不带提醒)");
  assert.equal(remind.localDisplay, "不带提醒", "空值展示为「不带提醒」");
  assert.equal(page.data.remindAt, "", "表单候选清空");
  assert.equal(page.data.expire, null, "到期行随之收起");
  assert.equal(cloudCalls.length, 0, "待选期间清除不发任何云调用");
});
