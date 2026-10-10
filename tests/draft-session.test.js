"use strict";

const test = require("node:test");
const assert = require("node:assert");

const ds = require("../miniprogram/utils/draft-session.js");

const DRAFT = {
  name: "钥匙",
  location_text: "玄关抽屉",
  certain: true,
  qualifiers: [],
  source_quote: "钥匙放在玄关抽屉",
};

test("草稿会话:create → get 回放原话与草稿 → clear 后不可再取", function () {
  const sid = ds.createDraftSession("钥匙放在玄关抽屉", [DRAFT]);
  assert.match(sid, /^[0-9a-f-]{36}$/, "sid 应为 uuid 形态");
  const payload = ds.getDraftSession(sid);
  assert.ok(payload, "刚创建的会话应可取");
  assert.equal(payload.originalText, "钥匙放在玄关抽屉");
  assert.equal(payload.drafts.length, 1);
  assert.equal(payload.drafts[0].name, "钥匙");
  ds.clearDraftSession(sid);
  assert.equal(ds.getDraftSession(sid), null, "清除后取不到");
  ds.clearDraftSession(sid); // 幂等
});

test("草稿会话:未知 sid 返回 null(如实,不编造空草稿)", function () {
  assert.equal(ds.getDraftSession("not-exist"), null);
});

test("草稿会话:超过 TTL 的会话视为过期并清理", function () {
  const sid = ds.createDraftSession("猕猴桃在果篮", [
    Object.assign({}, DRAFT, { name: "猕猴桃", source_quote: "猕猴桃在果篮" }),
  ]);
  const created = ds.getDraftSession(sid).createdAt;
  const justBefore = created + 10 * 60 * 1000; // TTL 边界(10 分钟)内仍可用
  assert.ok(ds.getDraftSession(sid, justBefore), "TTL 内可取");
  const justAfter = created + 10 * 60 * 1000 + 1;
  assert.equal(ds.getDraftSession(sid, justAfter), null, "超时即过期");
  assert.equal(ds.pruneDraftSessions(justAfter), 0, "过期会话已被清理");
});
