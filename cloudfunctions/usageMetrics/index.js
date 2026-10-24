"use strict";
// usageMetrics:视频确认流零隐私使用埋点(#85/#76 降本阶梯第 2 级)。
// 完全匿名:不取任何身份上下文、不读任何身份字段;载荷只有数值计数、毫秒时长、
// platform/kind 枚举与服务端时间戳,绝不含身份标识/昵称/物品名/位置文本/任何
// 用户输入内容/任何文件 id。纯 append:不更新不查询,合法即向 usage_metrics 插一行。
var cloud = require("wx-server-sdk");
var handler = require("./lib/handler").handler;

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

exports.main = async function (event) {
  return handler({
    event: event === null || event === undefined ? {} : event,
    db: cloud.database(),
    now: function () { return new Date().toISOString(); },
    logger: { log: function (entry) { console.log(JSON.stringify(entry)); } }
  });
};
