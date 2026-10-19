"use strict";
// videoCleanup:每日清理超过 24h 仍 pending 且已回执 file_id 的孤儿视频。
// 只按 DB 票据的 file_id 删除,不按目录批量删除,绝不触碰 bound 证据。
var cloud = require("wx-server-sdk");
var handler = require("./lib/handler").handler;

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

exports.main = async function () {
  return handler({
    db: cloud.database(),
    now: function () { return new Date().toISOString(); },
    deleteCloudFiles: function (fileIds) {
      return cloud.deleteFile({ fileList: fileIds });
    },
    logger: { log: function (entry) { console.log(JSON.stringify(entry)); } }
  });
};
