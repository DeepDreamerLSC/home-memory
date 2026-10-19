"use strict";
// 孤儿视频回收:只处理 24h 前过期且状态仍 pending、并且已回执 file_id 的票据。
// 已绑定证据不在此删除;没有 file_id 的票据只能标记取消,无法定位云对象。
var TK = "video_upload_tickets";
var EV = "video_evidence";
var PAGE_SIZE = 100;
var MAX_PAGES = 100;
var GRACE_MS = 24 * 60 * 60 * 1000;

function isDeleteSuccess(item) {
  return item && (item.status === 0 || item.status === -503003 || item.status === "0" || item.status === "-503003");
}

async function deleteStrict(deps, fileId) {
  try {
    var res = await deps.deleteCloudFiles([fileId]);
    var list = res && Array.isArray(res.fileList) ? res.fileList : [];
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].fileID === fileId && isDeleteSuccess(list[i])) return true;
    }
    return false;
  } catch (e) {
    return false;
  }
}

async function evidenceRefsTicket(deps, ticket) {
  if (typeof ticket.file_id !== "string" || ticket.file_id === "") return null;
  var got = await deps.db.collection(EV).where({
    household_id: ticket.household_id,
    item_id: ticket.item_id,
    file_id: ticket.file_id
  }).get();
  return got && got.data && got.data.length > 0 ? got.data[0] : null;
}

async function collectExpired(deps, cutoffMs) {
  var out = [];
  var offset = 0;
  for (var page = 0; page < MAX_PAGES; page++) {
    var res = await deps.db.collection(TK)
      .where({ status: "pending" })
      .skip(offset)
      .limit(PAGE_SIZE)
      .get();
    var batch = (res && res.data) || [];
    for (var i = 0; i < batch.length; i++) {
      var expires = Date.parse(batch[i].expires_at);
      if (Number.isNaN(expires) === false && expires < cutoffMs) out.push(batch[i]);
    }
    offset += batch.length;
    if (batch.length < PAGE_SIZE) break;
  }
  return out;
}

async function handler(deps) {
  var startedAt = Date.now();
  var now = deps.now ? deps.now() : new Date().toISOString();
  var cutoffMs = Date.parse(now) - GRACE_MS;
  var tickets = await collectExpired(deps, cutoffMs);
  var cleaned = 0;
  var cancelledWithoutFile = 0;
  var repaired = 0;
  var skippedClaimed = 0;
  var failed = 0;
  for (var i = 0; i < tickets.length; i++) {
    var t = tickets[i];
    // 与 attach 的 pending -> binding 抢同一张票;抢不到说明已进入绑定/取消流程。
    var claim = await deps.db.collection(TK).where({
      _id: t._id,
      status: "pending"
    }).update({ data: { status: "cleaning", cleaning_at: now } });
    if (((claim && claim.stats && claim.stats.updated) || 0) === 0) {
      skippedClaimed += 1;
      continue;
    }
    // 抢到独占状态后再核对证据引用。即使绑定流程先写证据后更新票据失败,
    // 这里也会修复票据并跳过文件删除。
    var evidence = null;
    try {
      evidence = await evidenceRefsTicket(deps, t);
    } catch (e) {
      await deps.db.collection(TK).where({ _id: t._id, status: "cleaning" }).update({ data: { status: "pending", cleanup_failed_at: now } });
      failed += 1;
      continue;
    }
    if (evidence !== null) {
      await deps.db.collection(TK).where({ _id: t._id, status: "cleaning" }).update({
        data: { status: "bound", bound_at: t.bound_at || now, evidence_id: evidence._id, cleanup_reason: "evidence_ref_found" }
      });
      repaired += 1;
      continue;
    }
    if (typeof t.file_id === "string" && t.file_id !== "") {
      var deleted = await deleteStrict(deps, t.file_id);
      if (deleted === false) {
        await deps.db.collection(TK).where({ _id: t._id, status: "cleaning" }).update({ data: { status: "pending", cleanup_failed_at: now } });
        failed += 1;
        continue;
      }
    } else {
      cancelledWithoutFile += 1;
    }
    await deps.db.collection(TK).where({ _id: t._id, status: "cleaning" }).update({
      data: { status: "cancelled", cleanup_at: now, cleanup_reason: "expired_pending" }
    });
    cleaned += 1;
  }
  var result = {
    ok: true,
    scanned: tickets.length,
    cleaned: cleaned,
    cancelled_without_file: cancelledWithoutFile,
    repaired_bound: repaired,
    skipped_claimed: skippedClaimed,
    failed: failed,
    ms: Date.now() - startedAt
  };
  if (deps.logger && typeof deps.logger.log === "function") {
    try { deps.logger.log(result); } catch (e) {}
  }
  return result;
}

module.exports = { handler: handler, GRACE_MS: GRACE_MS };
