"use strict";
// 视频票据回收 worker:
// 1) 恢复超时卡在 binding/cleaning/cancelling 的中间态;
// 2) 清理超过 24h 仍 pending 且已回执 file_id 的孤儿视频。
// 任何删除前都必须抢 ticket CAS 并二次核对视频证据引用。
var TK = "video_upload_tickets";
var EV = "video_evidence";
var PAGE_SIZE = 100;
var MAX_PAGES = 100;
var GRACE_MS = 24 * 60 * 60 * 1000;
var STATE_STALE_MS = 10 * 60 * 1000;

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

/**
 * 同一 file_id 可能对应多个 item evidence（PR B 场景扫描）。
 * 引用检查必须看 ticket.asset_id 或 file_id 下的全部 item，绝不能只看
 * ticket.item_id；否则场景票会被误判无引用并删掉共享云文件。
 * 旧 #89 行没有 asset_id，回退按 file_id 查询。
 */
async function evidenceRefsTicket(deps, ticket) {
  var rows = [];
  var seen = Object.create(null);
  async function append(cond) {
    var got = await deps.db.collection(EV).where(cond).get();
    var list = (got && got.data) || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i] && typeof list[i]._id === "string" && seen[list[i]._id] !== true) {
        seen[list[i]._id] = true;
        rows.push(list[i]);
      }
    }
  }
  if (typeof ticket.asset_id === "string" && ticket.asset_id !== "") {
    await append({ household_id: ticket.household_id, asset_id: ticket.asset_id });
  }
  if (typeof ticket.file_id === "string" && ticket.file_id !== "") {
    await append({ household_id: ticket.household_id, file_id: ticket.file_id });
  }
  return rows.length > 0 ? rows[0] : null;
}

async function collectByStatus(deps, status) {
  var out = [];
  var offset = 0;
  for (var page = 0; page < MAX_PAGES; page++) {
    var res = await deps.db.collection(TK)
      .where({ status: status })
      .skip(offset)
      .limit(PAGE_SIZE)
      .get();
    var batch = (res && res.data) || [];
    for (var i = 0; i < batch.length; i++) out.push(batch[i]);
    offset += batch.length;
    if (batch.length < PAGE_SIZE) break;
  }
  return out;
}

function staleByField(tickets, field, cutoffMs) {
  var out = [];
  for (var i = 0; i < tickets.length; i++) {
    var t = tickets[i];
    var timeText = t[field];
    if (typeof timeText !== "string") continue;
    var ts = Date.parse(timeText);
    if (Number.isNaN(ts) === false && ts < cutoffMs) out.push(t);
  }
  return out;
}

async function recoverIntermediate(deps, now, cutoffMs) {
  var stats = { scanned: 0, to_pending: 0, to_bound: 0, to_cancelled: 0, failed: 0 };
  var specs = [
    { status: "binding", field: "binding_at" },
    { status: "cleaning", field: "cleaning_at" },
    { status: "cancelling", field: "cancelling_at" }
  ];
  for (var s = 0; s < specs.length; s++) {
    var spec = specs[s];
    var rows = staleByField(await collectByStatus(deps, spec.status), spec.field, cutoffMs);
    stats.scanned += rows.length;
    for (var i = 0; i < rows.length; i++) {
      var t = rows[i];
      var evidence = null;
      try {
        evidence = await evidenceRefsTicket(deps, t);
      } catch (e) {
        stats.failed += 1;
        continue;
      }
      if (evidence !== null) {
        await deps.db.collection(TK).where({ _id: t._id, status: spec.status }).update({
          data: { status: "bound", bound_at: t.bound_at || now, evidence_id: evidence._id, recovered_at: now }
        });
        stats.to_bound += 1;
        continue;
      }
      if (spec.status === "cancelling" && typeof t.file_id === "string" && t.file_id !== "") {
        var deleted = await deleteStrict(deps, t.file_id);
        if (deleted === false) {
          await deps.db.collection(TK).where({ _id: t._id, status: spec.status }).update({
            data: { status: "pending", recovered_at: now, recovery_reason: "cancel_delete_failed" }
          });
          stats.failed += 1;
          continue;
        }
        await deps.db.collection(TK).where({ _id: t._id, status: spec.status }).update({
          data: { status: "cancelled", cancelled_at: now, recovered_at: now, recovery_reason: "stale_cancelling" }
        });
        stats.to_cancelled += 1;
        continue;
      }
      if (spec.status === "cancelling") {
        await deps.db.collection(TK).where({ _id: t._id, status: spec.status }).update({
          data: { status: "cancelled", cancelled_at: now, recovered_at: now, recovery_reason: "stale_cancelling_no_file" }
        });
        stats.to_cancelled += 1;
        continue;
      }
      // binding / cleaning 超时且无证据引用:退回 pending,由后续过期清理统一处理。
      await deps.db.collection(TK).where({ _id: t._id, status: spec.status }).update({
        data: { status: "pending", recovered_at: now, recovery_reason: "stale_" + spec.status }
      });
      stats.to_pending += 1;
    }
  }
  return stats;
}

async function cleanupExpiredPending(deps, now, cutoffMs) {
  var tickets = staleByField(await collectByStatus(deps, "pending"), "expires_at", cutoffMs);
  var stats = { scanned: tickets.length, cleaned: 0, cancelled_without_file: 0, repaired_bound: 0, skipped_claimed: 0, failed: 0 };
  for (var i = 0; i < tickets.length; i++) {
    var t = tickets[i];
    var claim = await deps.db.collection(TK).where({
      _id: t._id,
      status: "pending"
    }).update({ data: { status: "cleaning", cleaning_at: now } });
    if (((claim && claim.stats && claim.stats.updated) || 0) === 0) {
      stats.skipped_claimed += 1;
      continue;
    }
    var evidence = null;
    try {
      evidence = await evidenceRefsTicket(deps, t);
    } catch (e) {
      await deps.db.collection(TK).where({ _id: t._id, status: "cleaning" }).update({ data: { status: "pending", cleanup_failed_at: now } });
      stats.failed += 1;
      continue;
    }
    if (evidence !== null) {
      await deps.db.collection(TK).where({ _id: t._id, status: "cleaning" }).update({
        data: { status: "bound", bound_at: t.bound_at || now, evidence_id: evidence._id, cleanup_reason: "evidence_ref_found" }
      });
      stats.repaired_bound += 1;
      continue;
    }
    if (typeof t.file_id === "string" && t.file_id !== "") {
      var deleted = await deleteStrict(deps, t.file_id);
      if (deleted === false) {
        await deps.db.collection(TK).where({ _id: t._id, status: "cleaning" }).update({ data: { status: "pending", cleanup_failed_at: now } });
        stats.failed += 1;
        continue;
      }
    } else {
      stats.cancelled_without_file += 1;
    }
    await deps.db.collection(TK).where({ _id: t._id, status: "cleaning" }).update({
      data: { status: "cancelled", cleanup_at: now, cleanup_reason: "expired_pending" }
    });
    stats.cleaned += 1;
  }
  return stats;
}

async function handler(deps) {
  var startedAt = Date.now();
  var now = deps.now ? deps.now() : new Date().toISOString();
  var nowMs = Date.parse(now);
  var recovery = await recoverIntermediate(deps, now, nowMs - STATE_STALE_MS);
  var pending = await cleanupExpiredPending(deps, now, nowMs - GRACE_MS);
  var result = {
    ok: true,
    scanned: pending.scanned,
    cleaned: pending.cleaned,
    cancelled_without_file: pending.cancelled_without_file,
    repaired_bound: pending.repaired_bound,
    skipped_claimed: pending.skipped_claimed,
    failed: pending.failed + recovery.failed,
    recovery: recovery,
    ms: Date.now() - startedAt
  };
  if (deps.logger && typeof deps.logger.log === "function") {
    try { deps.logger.log(result); } catch (e) {}
  }
  return result;
}

module.exports = { handler: handler, GRACE_MS: GRACE_MS, STATE_STALE_MS: STATE_STALE_MS };
