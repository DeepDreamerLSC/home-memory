"use strict";
// 视频票据回收 worker:
// 1) 恢复超时卡在 binding/cleaning/cancelling 的中间态;
// 2) 清理超过 24h 仍 pending 且已回执 file_id 的孤儿视频;
// 3) D2(issue #96 §5)0 确认 scan 的视频到期回收(active/location_deleted 满
//    30 天且无引用 → 云删成功后置 video_reclaimed_at,行保留、计数不动)。
// 任何删除前都必须抢 ticket CAS / asset 锁并二次核对引用矩阵(§1)。
var TK = "video_upload_tickets";
var EV = "video_evidence";
// D1(issue #94):location_scans 引用复核——commit 已落 scan 但 0 件证据成功的
// 会话,其视频是该 scan 的回看内容,24h 孤儿回收不得删它。
var LS = "location_scans";
// D2 §5:asset 锁复用 video_item_locks(与 itemsApi 同集合同键 val_<asset_id>)
var LOCKS = "video_item_locks";
var LOCK_TTL_MS = 60 * 1000;
var PAGE_SIZE = 100;
var MAX_PAGES = 100;
var GRACE_MS = 24 * 60 * 60 * 1000;
var STATE_STALE_MS = 10 * 60 * 1000;
// D2 §5 冻结常量:0 确认视频保留 30 天(恰好满 30 天即候选,29 天不收);
// 单轮批上限 50(每行 1 锁 + ≤5 查询 + ≤1 云删,50 行最坏仍在秒级,
// 保证 20 秒函数超时内完成,超出留给下一次每日运行)。
var RECLAIM_RETAIN_MS = 30 * 24 * 60 * 60 * 1000;
var RECLAIM_BATCH_MAX = 50;
var RECLAIM_STATUSES = ["active", "location_deleted"];
var RECLAIM_REASON = "zero_confirm_expired";

var lockSeq = 0;

/** 与 itemsApi video.js stableTextHash 同实现(legacy 锁键必须两包一致,双实现债务互指) */
function stableTextHash(text) {
  var h1 = 0x811c9dc5;
  var h2 = 0x01000193;
  var s = String(text);
  for (var i = 0; i < s.length; i++) {
    var c = s.charCodeAt(i);
    h1 ^= c;
    h1 = (h1 * 16777619) >>> 0;
    h2 = ((h2 ^ c) * 2166136261) >>> 0;
  }
  return ("00000000" + h1.toString(16)).slice(-8) + ("00000000" + h2.toString(16)).slice(-8);
}

/**
 * itemsApi video.js acquireNamedLock(asset 锁)的包内等价副本:videoCleanup 与
 * itemsApi 是两个部署包不能互 require;同 video_item_locks 集合、同
 * _id=val_<asset_id>、同 owner_token + 60s TTL CAS 语义;改锁语义必须两处同步
 * (D1 报告 §7.1 双实现债务先例,与 itemsApi 子树副本同款处理)。
 * 任何 add/查询异常都按「锁不可得」处理(fail-closed:调用方跳过该行)。
 */
async function acquireAssetLockHere(deps, householdId, assetId, purpose) {
  var id = "val_" + assetId;
  for (var attempt = 0; attempt < 2; attempt++) {
    lockSeq += 1;
    var token = "vl_" + Date.now().toString(36) + "_" + lockSeq.toString(36) + "_" + Math.random().toString(36).slice(2, 8);
    var now = deps.now();
    var nowMs = Date.parse(now);
    var got;
    try {
      got = await deps.db.collection(LOCKS).doc(id).get();
    } catch (e) {
      got = null;
    }
    var existing = got && got.data;
    if (existing === null || existing === undefined) {
      try {
        await deps.db.collection(LOCKS).add({
          data: {
            _id: id,
            household_id: householdId,
            lock_kind: "asset",
            owner_token: token,
            purpose: purpose,
            asset_id: assetId,
            created_at: now,
            expires_at: new Date(nowMs + LOCK_TTL_MS).toISOString()
          }
        });
        return { ok: true, token: token };
      } catch (e) {
        if (String(e && e.message).indexOf("E11000") === -1) return { ok: false, error: "VIDEO_ITEM_BUSY" };
        continue;
      }
    }
    var expires = Date.parse(existing.expires_at || "");
    if (Number.isNaN(expires) === false && expires > nowMs) return { ok: false, error: "VIDEO_ITEM_BUSY" };
    try {
      var claim = await deps.db.collection(LOCKS).where({ _id: id, owner_token: existing.owner_token }).update({
        data: {
          household_id: householdId,
          lock_kind: "asset",
          owner_token: token,
          purpose: purpose,
          asset_id: assetId,
          claimed_at: now,
          expires_at: new Date(nowMs + LOCK_TTL_MS).toISOString()
        }
      });
      if (((claim && claim.stats && claim.stats.updated) || 0) === 1) return { ok: true, token: token };
    } catch (e) {
      return { ok: false, error: "VIDEO_ITEM_BUSY" };
    }
  }
  return { ok: false, error: "VIDEO_ITEM_BUSY" };
}

async function releaseAssetLockHere(deps, assetId, token) {
  try {
    await deps.db.collection(LOCKS).where({ _id: "val_" + assetId, owner_token: token }).remove();
  } catch (e) {}
}

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

/**
 * D1(§2.4)+ D2 §1 收紧:location_scans 按 asset/file 的引用复核——
 * 「仍保留该视频」(status ∈ {active, location_deleted} 且未回收)的 scan 行
 * 才持有引用;终态 deleted 的审计行与已回收行不再永久挡住孤儿回收。
 * 0 确认 scan 未到期(绝大多数)仍持引用,行为与 D1 测试期望一致。
 * 查询异常向上抛(调用方既有 try/catch 会把票据退回 pending 并计 failed,
 * fail-closed:绝不因查询失败而误删仍被 scan 引用的视频)。
 */
async function scanRefsTicket(deps, ticket) {
  var rows = await scanRowsForKeys(deps, ticket.household_id, ticket.file_id, ticket.asset_id);
  for (var i = 0; i < rows.length; i++) {
    if (scanRowRetainsVideo(rows[i])) return true;
  }
  return false;
}

/** D2 §1 矩阵 R2 判定:scan 行「仍保留该视频」= status ∈ {active, location_deleted} 且未回收 */
function scanRowReclaimed(row) {
  return typeof row.video_reclaimed_at === "string" && row.video_reclaimed_at !== "";
}

function scanRowRetainsVideo(row) {
  if (row.status !== "active" && row.status !== "location_deleted") return false;
  return scanRowReclaimed(row) === false;
}

/** location_scans 按 asset/file 双查去重(旧行无 asset_id 回退 file_id,evidenceRowsForFile 同款纪律) */
async function scanRowsForKeys(deps, householdId, fileId, assetId) {
  var rows = [];
  var seen = Object.create(null);
  async function append(cond) {
    var got = await deps.db.collection(LS).where(cond).get();
    var list = (got && got.data) || [];
    for (var i = 0; i < list.length; i++) {
      var row = list[i];
      if (row && typeof row._id === "string" && seen[row._id] !== true) {
        seen[row._id] = true;
        rows.push(row);
      }
    }
  }
  if (typeof assetId === "string" && assetId !== "") {
    await append({ household_id: householdId, asset_id: assetId });
  }
  if (typeof fileId === "string" && fileId !== "") {
    await append({ household_id: householdId, file_id: fileId });
  }
  return rows;
}

/** D2 §1 矩阵 R3:实际未结算票据(pending/binding/cleaning/cancelling;bound/cancelled/deleted 不占引用) */
function isUnsettledTicketStatus(status) {
  return status === "pending" || status === "binding" || status === "cleaning" || status === "cancelling";
}

async function unsettledTicketRefs(deps, householdId, fileId, assetId) {
  var rows = [];
  var seen = Object.create(null);
  async function append(cond) {
    var got = await deps.db.collection(TK).where(cond).get();
    var list = (got && got.data) || [];
    for (var i = 0; i < list.length; i++) {
      var t = list[i];
      if (t && isUnsettledTicketStatus(t.status) && typeof t._id === "string" && seen[t._id] !== true) {
        seen[t._id] = true;
        rows.push(t);
      }
    }
  }
  if (typeof assetId === "string" && assetId !== "") {
    await append({ household_id: householdId, asset_id: assetId });
  }
  if (typeof fileId === "string" && fileId !== "") {
    await append({ household_id: householdId, file_id: fileId });
  }
  return rows.length > 0;
}

async function collectByStatus(deps, collectionName, status) {
  var out = [];
  var offset = 0;
  for (var page = 0; page < MAX_PAGES; page++) {
    var res = await deps.db.collection(collectionName)
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
    var rows = staleByField(await collectByStatus(deps, TK, spec.status), spec.field, cutoffMs);
    stats.scanned += rows.length;
    for (var i = 0; i < rows.length; i++) {
      var t = rows[i];
      var evidence = null;
      var scanRef = false;
      try {
        evidence = await evidenceRefsTicket(deps, t);
        if (evidence === null) scanRef = await scanRefsTicket(deps, t);
      } catch (e) {
        stats.failed += 1;
        continue;
      }
      if (evidence !== null || scanRef) {
        await deps.db.collection(TK).where({ _id: t._id, status: spec.status }).update({
          data: {
            status: "bound",
            bound_at: t.bound_at || now,
            evidence_id: evidence !== null ? evidence._id : "",
            recovered_at: now
          }
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
  var tickets = staleByField(await collectByStatus(deps, TK, "pending"), "expires_at", cutoffMs);
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
    var scanRef = false;
    try {
      evidence = await evidenceRefsTicket(deps, t);
      if (evidence === null) scanRef = await scanRefsTicket(deps, t);
    } catch (e) {
      await deps.db.collection(TK).where({ _id: t._id, status: "cleaning" }).update({ data: { status: "pending", cleanup_failed_at: now } });
      stats.failed += 1;
      continue;
    }
    if (evidence !== null || scanRef) {
      await deps.db.collection(TK).where({ _id: t._id, status: "cleaning" }).update({
        data: {
          status: "bound",
          bound_at: t.bound_at || now,
          evidence_id: evidence !== null ? evidence._id : "",
          cleanup_reason: evidence !== null ? "evidence_ref_found" : "scan_ref_found"
        }
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

/**
 * D2 §5 第三阶段:0 确认 scan 的视频到期回收。
 * 候选 = status ∈ {active, location_deleted}(两条各查一次后合并,status 之外的
 * 过滤一律函数内做——confirmed_count 整数零、未回收、恰满 30 天(含端点)、
 * file_id 非空)。单候选序列:asset 锁 → 锁内重读复核(挡候选查询与抢锁之间的
 * 删除/自愈)→ 锁内末引用复核(§1 矩阵,排除本行;异常视为有引用,fail-closed)
 * → 云删成功(status 0/-503003)才条件置 video_reclaimed_at——status 不迁移、
 * created_at/candidate_count/confirmed_count 一概不动;云删失败留待下次不假报。
 * 单轮 RECLAIM_BATCH_MAX=50,超出留给下一次每日运行。
 */
function isReclaimCandidate(row, nowMs) {
  if (Number.isInteger(row.confirmed_count) === false || row.confirmed_count !== 0) return false;
  if (scanRowReclaimed(row) === true) return false;
  var ts = Date.parse(typeof row.created_at === "string" ? row.created_at : "");
  if (Number.isNaN(ts) === true || ts > nowMs - RECLAIM_RETAIN_MS) return false;
  if (typeof row.file_id !== "string" || row.file_id === "") return false;
  return true;
}

function reclaimLockKey(scan) {
  if (typeof scan.asset_id === "string" && scan.asset_id !== "") return scan.asset_id;
  // 与 itemsApi lockKeyForEvidence 同款 legacy 键(file_id 稳定摘要)
  return "legacy_" + stableTextHash(typeof scan.file_id === "string" ? scan.file_id : "");
}

async function reclaimZeroConfirmScans(deps, now) {
  var nowMs = Date.parse(now);
  var stats = { scanned: 0, reclaimed: 0, skipped_lock: 0, skipped_ref: 0, skipped_changed: 0, failed: 0, deferred: 0 };
  var candidates = [];
  var seen = Object.create(null);
  for (var s = 0; s < RECLAIM_STATUSES.length; s++) {
    var rows = await collectByStatus(deps, LS, RECLAIM_STATUSES[s]);
    for (var c = 0; c < rows.length; c++) {
      var row = rows[c];
      if (seen[row._id] === true || isReclaimCandidate(row, nowMs) === false) continue;
      seen[row._id] = true;
      candidates.push(row);
    }
  }
  stats.scanned = candidates.length;
  var batch = candidates.slice(0, RECLAIM_BATCH_MAX);
  stats.deferred = candidates.length - batch.length;
  for (var i = 0; i < batch.length; i++) {
    var scan = batch[i];
    var lockKey = reclaimLockKey(scan);
    var lock = await acquireAssetLockHere(deps, scan.household_id, lockKey, "scan_reclaim");
    if (lock.ok !== true) {
      stats.skipped_lock += 1;
      continue;
    }
    try {
      var regot = await deps.db.collection(LS).where({ _id: scan._id, status: scan.status }).limit(1).get();
      var fresh = regot && regot.data && regot.data.length > 0 ? regot.data[0] : null;
      if (fresh === null || isReclaimCandidate(fresh, nowMs) === false) {
        stats.skipped_changed += 1;
        continue;
      }
      var fileId = typeof fresh.file_id === "string" ? fresh.file_id : "";
      var assetId = typeof fresh.asset_id === "string" ? fresh.asset_id : "";
      var hasRef = false;
      try {
        var evidence = await evidenceRefsTicket(deps, { household_id: fresh.household_id, asset_id: assetId, file_id: fileId });
        if (evidence !== null) {
          hasRef = true; // R1 活 evidence 行
        } else {
          var otherScans = await scanRowsForKeys(deps, fresh.household_id, fileId, assetId);
          for (var o = 0; o < otherScans.length; o++) {
            if (otherScans[o]._id !== fresh._id && scanRowRetainsVideo(otherScans[o])) {
              hasRef = true; // R2 其他仍保留视频的 scan(排除本行)
              break;
            }
          }
          if (hasRef === false && await unsettledTicketRefs(deps, fresh.household_id, fileId, assetId)) {
            hasRef = true; // R3 实际未结算票据
          }
        }
      } catch (e) {
        hasRef = true; // fail-closed:引用查询异常视为有引用,不删
      }
      if (hasRef === true) {
        stats.skipped_ref += 1;
        continue;
      }
      if (await deleteStrict(deps, fresh.file_id) !== true) {
        stats.failed += 1; // 云删失败:不落任何标记,留待下次
        continue;
      }
      var upd = await deps.db.collection(LS).where({
        _id: fresh._id,
        household_id: fresh.household_id,
        status: fresh.status
      }).update({
        data: { video_reclaimed_at: now, video_reclaim_reason: RECLAIM_REASON, updated_at: now }
      });
      if (((upd && upd.stats && upd.stats.updated) || 0) === 0) {
        stats.skipped_changed += 1; // 并发状态迁移:跳过不追改
        continue;
      }
      stats.reclaimed += 1;
      // best-effort:本 scan 的 bound 票据置 deleted(失败不影响回收事实;
      // 票据残留 bound 无害——矩阵 R 中 bound 不占引用)
      if (typeof fresh.upload_ticket === "string" && fresh.upload_ticket !== "") {
        try {
          var tGot = await deps.db.collection(TK).doc(fresh.upload_ticket).get();
          var t = tGot && tGot.data;
          if (t && t.household_id === fresh.household_id && t.status === "bound") {
            await deps.db.collection(TK).where({
              _id: fresh.upload_ticket,
              household_id: fresh.household_id,
              status: "bound"
            }).update({ data: { status: "deleted", deleted_at: now, cleanup_reason: "scan_reclaimed" } });
          }
        } catch (e) {}
      }
    } finally {
      await releaseAssetLockHere(deps, lockKey, lock.token);
    }
  }
  return stats;
}

async function handler(deps) {
  var startedAt = Date.now();
  var now = deps.now ? deps.now() : new Date().toISOString();
  var nowMs = Date.parse(now);
  var recovery = await recoverIntermediate(deps, now, nowMs - STATE_STALE_MS);
  var pending = await cleanupExpiredPending(deps, now, nowMs - GRACE_MS);
  var reclaim = await reclaimZeroConfirmScans(deps, now);
  var result = {
    ok: true,
    scanned: pending.scanned,
    cleaned: pending.cleaned,
    cancelled_without_file: pending.cancelled_without_file,
    repaired_bound: pending.repaired_bound,
    skipped_claimed: pending.skipped_claimed,
    failed: pending.failed + recovery.failed,
    recovery: recovery,
    reclaim: reclaim,
    ms: Date.now() - startedAt
  };
  if (deps.logger && typeof deps.logger.log === "function") {
    try { deps.logger.log(result); } catch (e) {}
  }
  return result;
}

module.exports = { handler: handler, GRACE_MS: GRACE_MS, STATE_STALE_MS: STATE_STALE_MS };
