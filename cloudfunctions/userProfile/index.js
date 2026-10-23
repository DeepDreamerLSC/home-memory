"use strict";
const cloud = require("wx-server-sdk");
const crypto = require("crypto");
const { handler } = require("./lib/handler");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
exports.main = async event => {
  const context = cloud.getWXContext();
  if (!context.OPENID) return { ok: false, error: "UNAUTHORIZED", message: "请重新打开小程序" };
  const env = context.ENV || process.env.TCB_ENV || process.env.SCF_NAMESPACE;
  return handler(event || {}, {
    db: cloud.database(), memberKey: crypto.createHash("sha256").update(context.OPENID).digest("hex"),
    nonce: () => crypto.randomBytes(20).toString("hex"), now: () => Date.now(),
    ownsFile(file, path) {
      if (!env || typeof file !== "string") return false;
      const match = /^cloud:\/\/([^/]+)\/(.+)$/.exec(file);
      return !!match && (match[1] === env || match[1].startsWith(env + ".")) && match[2] === path;
    },
    async validImage(fileID) {
      try {
        const result = await cloud.downloadFile({ fileID });
        const b = result.fileContent;
        return Buffer.isBuffer(b) && b.length > 8 && b.length <= 2 * 1024 * 1024 && ((b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) || b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])));
      } catch (_) { return false; }
    }
  });
};
