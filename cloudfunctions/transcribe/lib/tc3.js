"use strict";

/**
 * 腾讯云 TC3-HMAC-SHA256 签名(纯函数,可离线测试)。
 * 仅实现 SentenceRecognition 单一 POST 接口所需的最小签名面。
 */

var crypto = require("crypto");

function sha256Hex(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function hmacSha256(key, data) {
  return crypto.createHmac("sha256", key).update(data).digest();
}

/**
 * 生成 TC3 签名请求头。
 * @param secretId  腾讯云 API SecretId
 * @param secretKey 腾讯云 API SecretKey
 * @param host      服务域名(如 asr.tencentcloudapi.com)
 * @param service   服务名(如 asr)
 * @param action    接口名(如 SentenceRecognition)
 * @param version   接口版本(如 2019-06-14)
 * @param payload   请求体字符串
 * @param timestamp Unix 秒
 */
function buildSignedHeaders(secretId, secretKey, host, service, action, version, payload, timestamp) {
  var date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  var hashedPayload = sha256Hex(payload);

  var canonicalRequest = [
    "POST",
    "/",
    "",
    "content-type:application/json; charset=utf-8",
    "host:" + host,
    "x-tc-action:" + action.toLowerCase(),
    "",
    "content-type;host;x-tc-action",
    hashedPayload
  ].join("\n");

  var credentialScope = date + "/" + service + "/tc3_request";
  var stringToSign = [
    "TC3-HMAC-SHA256",
    String(timestamp),
    credentialScope,
    sha256Hex(canonicalRequest)
  ].join("\n");

  var secretDate = hmacSha256(Buffer.from("TC3" + secretKey, "utf8"), date);
  var secretService = hmacSha256(secretDate, service);
  var secretSigning = hmacSha256(secretService, "tc3_request");
  var signature = crypto
    .createHmac("sha256", secretSigning)
    .update(stringToSign)
    .digest("hex");

  var authorization =
    "TC3-HMAC-SHA256 " +
    "Credential=" + secretId + "/" + credentialScope +
    ", SignedHeaders=content-type;host;x-tc-action" +
    ", Signature=" + signature;

  return {
    "Content-Type": "application/json; charset=utf-8",
    Host: host,
    "X-TC-Action": action,
    "X-TC-Version": version,
    "X-TC-Timestamp": String(timestamp),
    Authorization: authorization
  };
}

module.exports = { buildSignedHeaders: buildSignedHeaders };
