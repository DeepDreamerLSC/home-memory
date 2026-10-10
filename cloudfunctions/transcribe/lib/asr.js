"use strict";

/**
 * 腾讯云一句话识别(SentenceRecognition)HTTP 调用。
 * 使用 Node 内置 https,零 npm 依赖;密钥仅由参数传入,绝不打印。
 */

var https = require("https");
var { buildSignedHeaders } = require("./tc3");

var HOST = "asr.tencentcloudapi.com";
var SERVICE = "asr";
var ACTION = "SentenceRecognition";
var VERSION = "2019-06-14";

/**
 * @param audioBase64 wav/mp3 等音频的 base64(≤1MB)
 * @param voiceFormat 音频格式(wav/mp3/m4a/...)
 * @param secretId / secretKey 腾讯云 API 密钥
 * @param timeoutMs 超时(毫秒)
 * @returns Promise<{ text }> 或抛错(带 .code)
 */
function recognizeOnce(audioBase64, voiceFormat, secretId, secretKey, timeoutMs) {
  return new Promise(function (resolve, reject) {
    // DataLen 为官方接口 SourceType=1 时的条件必填参数:音频原始字节数(非 base64 长度)
    var payload = JSON.stringify({
      EngSerViceType: "16k_zh",
      SourceType: 1,
      VoiceFormat: voiceFormat,
      UsrAudioKey: "home-memory",
      Data: audioBase64,
      DataLen: Buffer.byteLength(audioBase64, "base64")
    });
    var timestamp = Math.floor(Date.now() / 1000);
    var headers = buildSignedHeaders(secretId, secretKey, HOST, SERVICE, ACTION, VERSION, payload, timestamp);

    var req = https.request(
      {
        hostname: HOST,
        method: "POST",
        path: "/",
        headers: headers,
        timeout: timeoutMs
      },
      function (res) {
        var chunks = [];
        res.on("data", function (c) { chunks.push(c); });
        res.on("end", function () {
          var body = Buffer.concat(chunks).toString("utf8");
          var parsed;
          try {
            parsed = JSON.parse(body);
          } catch (e) {
            reject(errWith("BAD_RESPONSE", "ASR 响应不是合法 JSON"));
            return;
          }
          if (parsed && parsed.Response && parsed.Response.Error) {
            var e = parsed.Response.Error;
            var err = errWith("ASR_ERROR", "ASR " + e.Code + ":" + e.Message);
            err.detail = String(e.Code);
            reject(err);
            return;
          }
          var text = parsed && parsed.Response && parsed.Response.Result;
          if (typeof text !== "string") {
            reject(errWith("BAD_RESPONSE", "ASR 响应缺少 Result"));
            return;
          }
          resolve({ text: text });
        });
      }
    );
    req.on("timeout", function () {
      req.destroy(function () {
        reject(errWith("TIMEOUT", "ASR 请求超时"));
      });
      reject(errWith("TIMEOUT", "ASR 请求超时"));
    });
    req.on("error", function (e) {
      reject(errWith("NETWORK", String(e && e.message ? e.message : e)));
    });
    req.write(payload);
    req.end();
  });
}

function errWith(code, message) {
  var e = new Error(message);
  e.code = code;
  return e;
}

module.exports = { recognizeOnce: recognizeOnce };
