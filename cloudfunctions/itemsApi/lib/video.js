"use strict";

var crypto = require("crypto");
// 视频证据:单件留证 + PR B 场景扫描批量确认。
// 核心边界:单件入口只绑一件；场景确认允许同一原视频为多件各建一行 evidence。
// 不按同名自动合并物理身份，不把 AI 候选当事实；删除必须做共享文件引用复核。
var EV = "video_evidence";
var TK = "video_upload_tickets";
var LOCK = "video_item_locks";
var LOCK_TTL_MS = 60 * 1000;
var FILE_MAX = 512;
var DIM_MAX = 10000;
var DURATION_MAX_MS = 10 * 60 * 1000;
var PER_ITEM = 3;
var TICKET_TTL_MS = 15 * 60 * 1000;
var PATH_PREFIX = "video-evidence/";
var CONSENT_VERSION = "v1";
var EXTS = ["mp4", "mov", "m4v"];
var HIGHLIGHT_MAX = 8;
var HIGHLIGHT_UPDATE_ID_MIN = 8;
var HIGHLIGHT_UPDATE_ID_MAX = 64;
var HIGHLIGHT_SOURCE = "user_confirmed";
var SCENE_ITEMS_MAX = 12;
var SCENE_ID_MIN = 8;
var SCENE_ID_MAX = 64;
var SCENE_DRAFT_KEY_MAX = 64;
// D1 位置级视频清点(issue #94):location_scans 独立集合 + commit 可选位置上下文。
// 全部新逻辑只在 event.location 存在的分支内生效;缺省时本文件行为与 PR B 逐字节一致。
var LS = "location_scans";
var LOCATIONS_COLLECTION = "locations";
var LOCATION_ID_MAX = 128;
var SCAN_CANDIDATE_MAX = 500;
var LOCATION_PATH_SEPARATOR = " / ";
var LOCATION_SNAPSHOT_SEGMENTS_MAX = 6;

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

function createVideoActions(h) {
  var isString = h.isString;
  var fail = h.fail;

  function filePath(fileId) {
    if (isString(fileId) === false || fileId.indexOf("cloud://") !== 0) return null;
    var rest = fileId.slice("cloud://".length);
    var slash = rest.indexOf("/");
    if (slash === -1) return null;
    var path = rest.slice(slash + 1);
    if (path === "" || path.indexOf("..") !== -1) return null;
    return path;
  }

  function evidenceCol(deps) { return deps.db.collection(EV); }
  function ticketCol(deps) { return deps.db.collection(TK); }
  function lockCol(deps) { return deps.db.collection(LOCK); }
  function itemLockId(itemId) { return "vil_" + itemId; }
  function assetLockId(assetId) { return "val_" + assetId; }

  /**
   * 文件/asset 逻辑锁。新场景行统一使用 ticket.asset_id；旧 #89 行没有
   * asset_id 时按 file_id 的稳定摘要回退，保证旧单件删除仍能加锁。
   */
  function lockKeyForEvidence(row) {
    if (isString(row.asset_id) && row.asset_id.length > 0) return row.asset_id;
    if (isString(row.file_id) && row.file_id.length > 0) return "legacy_" + stableTextHash(row.file_id);
    return "legacy_" + stableTextHash(row._id || "");
  }

  /**
   * 通用互斥锁(复用 video_item_locks 集合):
   * - item 锁 _id=vil_<item_id>；asset 锁 _id=val_<asset_id>；
   * - 单文档 CAS:owner_token + expires_at；
   * - 进程中断后 60s 过期可接管；
   * - 调用方必须按「item 锁(item_id 升序) → asset 锁(asset_id 升序)」取锁。
   */
  async function acquireNamedLock(deps, id, kind, ownerValue, purpose) {
    var token = "vl_" + deps.genId();
    var now = deps.now();
    var nowMs = Date.parse(now);
    for (var attempt = 0; attempt < 2; attempt++) {
      var got;
      try {
        got = await lockCol(deps).doc(id).get();
      } catch (e) {
        got = null;
      }
      var existing = got && got.data;
      if (existing === null || existing === undefined) {
        var doc = {
          _id: id,
          household_id: deps.householdId,
          lock_kind: kind,
          owner_token: token,
          purpose: purpose,
          created_at: now,
          expires_at: new Date(nowMs + LOCK_TTL_MS).toISOString()
        };
        if (kind === "item") doc.item_id = ownerValue;
        else doc.asset_id = ownerValue;
        try {
          await lockCol(deps).add({ data: doc });
          return { ok: true, token: token };
        } catch (e) {
          if (h.isDuplicateKeyError(e) === false) throw e;
          continue;
        }
      }
      var expires = Date.parse(existing.expires_at || "");
      if (Number.isNaN(expires) === false && expires > nowMs) return { ok: false, error: "VIDEO_ITEM_BUSY" };
      var patch = {
        household_id: deps.householdId,
        lock_kind: kind,
        owner_token: token,
        purpose: purpose,
        claimed_at: now,
        expires_at: new Date(nowMs + LOCK_TTL_MS).toISOString()
      };
      if (kind === "item") patch.item_id = ownerValue;
      else patch.asset_id = ownerValue;
      var claim = await lockCol(deps).where({ _id: id, owner_token: existing.owner_token }).update({ data: patch });
      if (((claim && claim.stats && claim.stats.updated) || 0) === 1) return { ok: true, token: token };
    }
    return { ok: false, error: "VIDEO_ITEM_BUSY" };
  }

  async function acquireItemLock(deps, itemId, purpose) {
    return acquireNamedLock(deps, itemLockId(itemId), "item", itemId, purpose);
  }

  async function acquireAssetLock(deps, assetId, purpose) {
    if (isString(assetId) === false || assetId.length === 0 || assetId.length > 128) {
      return { ok: false, error: "INVALID_INPUT" };
    }
    return acquireNamedLock(deps, assetLockId(assetId), "asset", assetId, purpose);
  }

  async function releaseNamedLock(deps, id, token) {
    try {
      await lockCol(deps).where({ _id: id, owner_token: token }).remove();
    } catch (e) {}
  }

  async function releaseItemLock(deps, itemId, token) {
    await releaseNamedLock(deps, itemLockId(itemId), token);
  }

  async function releaseAssetLock(deps, assetId, token) {
    await releaseNamedLock(deps, assetLockId(assetId), token);
  }

  function hasOwn(obj, key) {
    return obj !== null && typeof obj === "object" && Object.prototype.hasOwnProperty.call(obj, key);
  }

  function sortHighlights(list) {
    list.sort(function (a, b) {
      if (a.start_ms !== b.start_ms) return a.start_ms - b.start_ms;
      return a.end_ms - b.end_ms;
    });
    return list;
  }

  /**
   * 严格解析客户端确认高亮(输入形状门,不依赖 duration_ms):
   * - 1..8 条;start/end 整数、start>=0、end>start;box 必填且 null 或 0-1 有效框;
   * - frame_ms 可选,必须是 [start_ms,end_ms) 内整数;
   * - 客户端携带的 source/confidence/候选 id 等一律无视,source 由服务端固定。
   */
  function parseHighlightInput(raw) {
    if (Array.isArray(raw) === false || raw.length < 1 || raw.length > HIGHLIGHT_MAX) return "INVALID";
    var out = [];
    for (var i = 0; i < raw.length; i++) {
      var item = raw[i];
      if (item === null || typeof item !== "object" || Array.isArray(item)) return "INVALID";
      var start = item.start_ms;
      var end = item.end_ms;
      if (Number.isInteger(start) === false || start < 0) return "INVALID";
      if (Number.isInteger(end) === false || end <= start) return "INVALID";
      if (hasOwn(item, "box") === false || item.box === undefined) return "INVALID";
      var box = h.parseBoxInput(item.box);
      if (box === "INVALID") return "INVALID";
      var clean = { start_ms: start, end_ms: end, box: box };
      if (item.frame_ms !== undefined) {
        if (
          Number.isInteger(item.frame_ms) === false ||
          item.frame_ms < start ||
          item.frame_ms >= end
        ) {
          return "INVALID";
        }
        clean.frame_ms = item.frame_ms;
      }
      clean.source = HIGHLIGHT_SOURCE;
      out.push(clean);
    }
    return sortHighlights(out);
  }

  function highlightsWithinDuration(list, durationMs) {
    if (Number.isInteger(durationMs) === false || durationMs < 1) return false;
    for (var i = 0; i < list.length; i++) {
      if (list[i].end_ms > durationMs) return false;
    }
    return true;
  }

  /**
   * 读侧只投影服务端认可的用户确认高亮。旧行/非法行返回 [] + 0;
   * 不把任何 AI candidate/目标名/置信度字段透出。
   */
  function sanitizeStoredHighlights(raw, durationMs) {
    var parsed = parseHighlightInput(raw);
    if (parsed === "INVALID") return null;
    for (var i = 0; i < raw.length; i++) {
      if (raw[i].source !== HIGHLIGHT_SOURCE) return null;
    }
    if (highlightsWithinDuration(parsed, durationMs) === false) return null;
    return parsed;
  }

  function projectHighlightFields(row) {
    var highlights = [];
    var version = 0;
    if (Array.isArray(row.highlights) && row.highlights.length > 0) {
      var sanitized = sanitizeStoredHighlights(row.highlights, row.duration_ms);
      if (sanitized !== null && Number.isInteger(row.highlight_version) && row.highlight_version >= 0) {
        highlights = sanitized;
        version = row.highlight_version;
      }
    }
    return { highlights: highlights, highlight_version: version };
  }

  /** 幂等内容指纹:以服务端规范化后的字段比较,输入顺序不影响重放识别。 */
  function highlightsContentKey(list) {
    var canonical = [];
    for (var i = 0; i < list.length; i++) {
      var item = list[i];
      var one = { start_ms: item.start_ms, end_ms: item.end_ms, box: item.box };
      if (item.frame_ms !== undefined) one.frame_ms = item.frame_ms;
      one.source = HIGHLIGHT_SOURCE;
      canonical.push(one);
    }
    return JSON.stringify(canonical);
  }

  function projectEvidence(row, videoUrl) {
    var highlightFields = projectHighlightFields(row);
    return {
      evidence_id: row._id,
      item_id: row.item_id,
      file_id: row.file_id,
      asset_id: isString(row.asset_id) ? row.asset_id : "",
      // D1:scan_id 关联字段(旧行/B 行无此字段时投影为 "",读侧零破坏)
      scan_id: isString(row.scan_id) ? row.scan_id : "",
      source: row.source === "scene" ? "scene" : "manual",
      video_url: videoUrl || "",
      duration_ms: row.duration_ms,
      video_w: row.video_w,
      video_h: row.video_h,
      captured_location_text: isString(row.captured_location_text) ? row.captured_location_text : "",
      consent_version: row.consent_version === CONSENT_VERSION ? CONSENT_VERSION : "",
      highlights: highlightFields.highlights,
      highlight_version: highlightFields.highlight_version,
      created_at: row.created_at
    };
  }

  async function itemAlive(deps, itemId) {
    var got = await h.collection(deps).where({ _id: itemId, household_id: deps.householdId, deleted: false }).get();
    return got.data && got.data.length > 0 ? got.data[0] : null;
  }

  async function verifyFile(deps, fileId) {
    if (typeof deps.getTempFileUrls !== "function") return "";
    try {
      var map = h.mapTempUrls(await deps.getTempFileUrls([fileId]));
      return Object.prototype.hasOwnProperty.call(map, fileId) ? map[fileId] : "";
    } catch (e) {
      return "";
    }
  }

  function isCloudDeleteSuccess(item) {
    return item && (item.status === 0 || item.status === -503003 || item.status === "0" || item.status === "-503003");
  }

  async function deleteFilesStrict(deps, fileIds) {
    var unique = [];
    var seen = Object.create(null);
    for (var i = 0; i < fileIds.length; i++) {
      if (isString(fileIds[i]) && fileIds[i] !== "" && seen[fileIds[i]] !== true) {
        seen[fileIds[i]] = true;
        unique.push(fileIds[i]);
      }
    }
    if (unique.length === 0) return { ok: true, deleted: [], failed: [] };
    if (typeof deps.deleteCloudFiles !== "function") return { ok: false, deleted: [], failed: unique };
    var result;
    try {
      result = await deps.deleteCloudFiles(unique);
    } catch (e) {
      return { ok: false, deleted: [], failed: unique };
    }
    var list = result && Array.isArray(result.fileList) ? result.fileList : [];
    var byId = Object.create(null);
    for (var j = 0; j < list.length; j++) {
      if (list[j] && isString(list[j].fileID)) byId[list[j].fileID] = list[j];
    }
    var deleted = [];
    var failed = [];
    for (var k = 0; k < unique.length; k++) {
      if (isCloudDeleteSuccess(byId[unique[k]])) deleted.push(unique[k]);
      else failed.push(unique[k]);
    }
    return { ok: failed.length === 0, deleted: deleted, failed: failed };
  }

  /**
   * 删除命中证据行:只有对应云文件返回 status 0(或文件已不存在 -503003)
   * 的数据库行才删除;其余行原样保留,绝不因 Promise 未抛错而误删证据。
   *
   * 同一 file_id 可由多个 item evidence 引用。查询时同时按 asset_id(新场景)
   * 和 file_id(旧 #89 行回退)合并去重，任何删除/清理都不得只看 ticket.item_id。
   */
  async function evidenceRowsForFile(deps, fileId, assetId) {
    var rows = [];
    var seen = Object.create(null);
    async function append(cond) {
      var got = await evidenceCol(deps).where(cond).get();
      var list = (got && got.data) || [];
      for (var i = 0; i < list.length; i++) {
        var row = list[i];
        if (row && isString(row._id) && seen[row._id] !== true) {
          seen[row._id] = true;
          rows.push(row);
        }
      }
    }
    if (isString(assetId) && assetId !== "") {
      await append({ household_id: deps.householdId, asset_id: assetId });
    }
    if (isString(fileId) && fileId !== "") {
      await append({ household_id: deps.householdId, file_id: fileId });
    }
    return rows;
  }

  async function evidenceRowsForTicket(deps, ticket) {
    if (ticket.purpose === "scene") {
      return evidenceRowsForFile(deps, ticket.file_id || "", ticket.asset_id || "");
    }
    var got = await evidenceCol(deps).where({
      household_id: deps.householdId,
      item_id: ticket.item_id,
      file_id: ticket.file_id || ""
    }).get();
    return (got && got.data) || [];
  }

  async function findEvidenceForTicket(deps, ticket) {
    var rows = await evidenceRowsForTicket(deps, ticket);
    return rows.length > 0 ? rows[0] : null;
  }

  async function repairTicketBound(deps, ticket, evidenceId, evidenceCount) {
    try {
      var patch = {
        status: "bound",
        bound_at: ticket.bound_at || deps.now(),
        evidence_id: evidenceId || ticket.evidence_id || ""
      };
      if (ticket.purpose === "scene") patch.scene_evidence_count = Number.isInteger(evidenceCount) ? evidenceCount : 0;
      await ticketCol(deps).where({ _id: ticket._id, household_id: deps.householdId }).update({ data: patch });
      return true;
    } catch (e) {
      // 证据已存在时的修复失败不掩盖事实;清理任务会再次核对证据引用。
      return false;
    }
  }

  async function markTicketsDeleted(deps, ticketIds, reason) {
    var now = deps.now();
    var seen = Object.create(null);
    for (var i = 0; i < ticketIds.length; i++) {
      var id = ticketIds[i];
      if (isString(id) === false || id === "" || seen[id] === true) continue;
      seen[id] = true;
      try {
        await ticketCol(deps).where({
          _id: id,
          household_id: deps.householdId
        }).update({ data: { status: "deleted", deleted_at: now, cleanup_reason: reason } });
      } catch (e) {
        // 票据修复失败不掩盖证据事实；worker 后续仍可凭 file_id 收敛。
      }
    }
  }

  /**
   * 引用感知删除：
   * - 调用方已持有目标 item 锁（videoEvidenceDelete / deleteItem 均是）；
   * - 目标文件按 asset/file 锁升序加锁（锁序在 item 锁之后）；
   * - 锁内重新查询剩余 evidence；仍有其他 item 引用则只删当前行，绝不删云文件；
   * - 最后一条引用才删云文件，删除成功后才删最后一行。
   */
  async function removeEvidenceRows(deps, itemId, evidenceId) {
    var cond = { household_id: deps.householdId, item_id: itemId };
    if (isString(evidenceId) && evidenceId !== "") cond._id = evidenceId;
    var got = await evidenceCol(deps).where(cond).get();
    var rows = (got && got.data) || [];
    if (rows.length === 0) return { ok: true, deleted: 0, failed_file_ids: [], deleted_files: [], error: null };

    // 按文件分组，并对 asset/file 锁按 key 升序获取。
    var groupsByKey = Object.create(null);
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var key = lockKeyForEvidence(row);
      if (groupsByKey[key] === undefined) groupsByKey[key] = [];
      groupsByKey[key].push(row);
    }
    var lockKeys = Object.keys(groupsByKey).sort();
    var heldLocks = [];
    try {
      for (var l = 0; l < lockKeys.length; l++) {
        var key = lockKeys[l];
        var lock = await acquireAssetLock(deps, key, "evidence_delete");
        if (lock.ok !== true) {
          return { ok: false, deleted: 0, failed_file_ids: [], deleted_files: [], error: lock.error || "VIDEO_ITEM_BUSY" };
        }
        heldLocks.push({ key: key, token: lock.token });
      }

      var deletedCount = 0;
      var deletedFiles = [];
      var failedFileIds = [];
      for (var g = 0; g < lockKeys.length; g++) {
        var groupKey = lockKeys[g];
        var targetRows = groupsByKey[groupKey];
        var targetIds = Object.create(null);
        var fileIds = [];
        var ticketIds = [];
        for (var t = 0; t < targetRows.length; t++) {
          targetIds[targetRows[t]._id] = true;
          if (isString(targetRows[t].file_id) && targetRows[t].file_id !== "") fileIds.push(targetRows[t].file_id);
          if (isString(targetRows[t].upload_ticket) && targetRows[t].upload_ticket !== "") ticketIds.push(targetRows[t].upload_ticket);
        }
        var uniqueFileIds = [];
        var seenFiles = Object.create(null);
        for (var f = 0; f < fileIds.length; f++) {
          if (seenFiles[fileIds[f]] !== true) { seenFiles[fileIds[f]] = true; uniqueFileIds.push(fileIds[f]); }
        }
        var allRows = await evidenceRowsForFile(
          deps,
          uniqueFileIds.length > 0 ? uniqueFileIds[0] : "",
          targetRows[0].asset_id || ""
        );
        var otherRefs = 0;
        for (var o = 0; o < allRows.length; o++) {
          if (targetIds[allRows[o]._id] !== true) otherRefs += 1;
        }

        if (otherRefs > 0) {
          // 共享文件仍被其他 item 使用：只解除当前 item 的引用。
          for (var r1 = 0; r1 < targetRows.length; r1++) {
            await evidenceCol(deps).where({
              _id: targetRows[r1]._id,
              household_id: deps.householdId,
              item_id: itemId
            }).remove();
            deletedCount += 1;
          }
          continue;
        }

        var allFileIds = [];
        var seenAll = Object.create(null);
        for (var a = 0; a < allRows.length; a++) {
          if (isString(allRows[a].file_id) && allRows[a].file_id !== "" && seenAll[allRows[a].file_id] !== true) {
            seenAll[allRows[a].file_id] = true;
            allFileIds.push(allRows[a].file_id);
          }
        }
        var del = await deleteFilesStrict(deps, allFileIds);
        for (var d = 0; d < del.deleted.length; d++) deletedFiles.push(del.deleted[d]);
        for (var fd = 0; fd < del.failed.length; fd++) {
          if (failedFileIds.indexOf(del.failed[fd]) === -1) failedFileIds.push(del.failed[fd]);
        }
        if (del.ok !== true) continue; // 云删除失败：目标行保留，可重试

        for (var r2 = 0; r2 < targetRows.length; r2++) {
          await evidenceCol(deps).where({
            _id: targetRows[r2]._id,
            household_id: deps.householdId,
            item_id: itemId
          }).remove();
          deletedCount += 1;
        }
        await markTicketsDeleted(deps, ticketIds, "last_evidence_deleted");
      }

      var ok = failedFileIds.length === 0;
      return {
        ok: ok,
        deleted: deletedCount,
        failed_file_ids: failedFileIds,
        deleted_files: deletedFiles,
        error: ok ? null : "VIDEO_DELETE_FAILED"
      };
    } finally {
      for (var h = heldLocks.length - 1; h >= 0; h--) {
        await releaseAssetLock(deps, heldLocks[h].key, heldLocks[h].token);
      }
    }
  }

  /**
   * 删除物品前清理(调用方已持有 item 锁):
   * - evidence 走引用感知删除：共享文件有其他 item 引用时只删本 item 行；
   * - 再处理本 item 的票据：有 evidence 引用的文件绝不删；无引用才逐文件删除；
   * - 云删除失败保留票据与物品，deleteItem 返回可重试错误。
   * 删除顺序固定为 item 锁(外层已持有) → asset/file 锁(本函数内部获取)。
   */
  async function cleanupForItem(deps, itemId) {
    var ev = await removeEvidenceRows(deps, itemId, "");
    if (ev.ok === false) {
      var evFail = { ok: false, error: ev.error || "VIDEO_DELETE_FAILED", deleted: ev.deleted, failed_file_ids: ev.failed_file_ids };
      return evFail;
    }

    var ticketsRes = await ticketCol(deps).where({ household_id: deps.householdId, item_id: itemId }).get();
    var tickets = (ticketsRes && ticketsRes.data) || [];
    var now = deps.now();
    var failedFileIds = [];
    var deletedFiles = Object.create(null);
    for (var d0 = 0; d0 < ev.deleted_files.length; d0++) deletedFiles[ev.deleted_files[d0]] = true;

    // 按 file/asset 锁分组，按 key 升序获取（item 锁已由调用方持有）。
    var groups = Object.create(null);
    var noFileTickets = [];
    for (var i = 0; i < tickets.length; i++) {
      var ticket = tickets[i];
      if (ticket.status === "cancelled" || ticket.status === "deleted") continue;
      if (isString(ticket.file_id) === false || ticket.file_id === "") {
        noFileTickets.push(ticket);
        continue;
      }
      var key = isString(ticket.asset_id) && ticket.asset_id !== ""
        ? ticket.asset_id
        : "legacy_" + stableTextHash(ticket.file_id);
      if (groups[key] === undefined) groups[key] = [];
      groups[key].push(ticket);
    }

    var keys = Object.keys(groups).sort();
    var held = [];
    try {
      for (var l = 0; l < keys.length; l++) {
        var lock = await acquireAssetLock(deps, keys[l], "item_cleanup");
        if (lock.ok !== true) {
          return { ok: false, error: lock.error || "VIDEO_ITEM_BUSY", deleted: ev.deleted, failed_file_ids: [] };
        }
        held.push({ key: keys[l], token: lock.token });
      }

      for (var g = 0; g < keys.length; g++) {
        var groupTickets = groups[keys[g]];
        for (var t = 0; t < groupTickets.length; t++) {
          var tk = groupTickets[t];
          var refs = await evidenceRowsForFile(deps, tk.file_id, tk.asset_id || "");
          if (refs.length > 0) {
            // 文件仍被其他 item 的 evidence 使用：保留文件和票据。
            continue;
          }
          if (deletedFiles[tk.file_id] !== true) {
            var del = await deleteFilesStrict(deps, [tk.file_id]);
            for (var df = 0; df < del.deleted.length; df++) deletedFiles[del.deleted[df]] = true;
            if (del.ok !== true) {
              if (failedFileIds.indexOf(tk.file_id) === -1) failedFileIds.push(tk.file_id);
              continue;
            }
          }
          await ticketCol(deps).where({
            _id: tk._id,
            household_id: deps.householdId,
            status: tk.status
          }).update({ data: { status: "deleted", deleted_at: now, cleanup_reason: "item_deleted" } });
        }
      }
    } finally {
      for (var h = held.length - 1; h >= 0; h--) await releaseAssetLock(deps, held[h].key, held[h].token);
    }

    // 无 file_id 的票据（不占云文件）直接收口。
    for (var n = 0; n < noFileTickets.length; n++) {
      var nt = noFileTickets[n];
      await ticketCol(deps).where({
        _id: nt._id,
        household_id: deps.householdId,
        status: nt.status
      }).update({ data: { status: "deleted", deleted_at: now, cleanup_reason: "item_deleted" } });
    }

    if (failedFileIds.length > 0) {
      return { ok: false, error: "VIDEO_DELETE_FAILED", deleted: ev.deleted, failed_file_ids: failedFileIds };
    }
    return { ok: true, deleted: ev.deleted };
  }

  async function videoUploadBegin(event, deps) {
    var purpose = event.purpose === undefined || event.purpose === null ? "item" : event.purpose;
    if (purpose !== "item" && purpose !== "scene") return fail("INVALID_INPUT");
    var ext = event.ext === undefined || event.ext === null ? "mp4" : event.ext;
    if (isString(ext) === false || EXTS.indexOf(ext) === -1) return fail("INVALID_INPUT");

    var now = deps.now();
    var nowMs = Date.parse(now);
    var assetId = "va_" + deps.genId();

    if (purpose === "scene") {
      if (
        isString(event.scene_id) === false ||
        event.scene_id.length < SCENE_ID_MIN ||
        event.scene_id.length > SCENE_ID_MAX
      ) return fail("INVALID_INPUT");
      if (
        Number.isInteger(event.duration_ms) === false ||
        event.duration_ms < 1 ||
        event.duration_ms > DURATION_MAX_MS ||
        Number.isInteger(event.video_w) === false ||
        event.video_w < 1 ||
        event.video_w > DIM_MAX ||
        Number.isInteger(event.video_h) === false ||
        event.video_h < 1 ||
        event.video_h > DIM_MAX
      ) return fail("INVALID_INPUT");
      var sceneTicket = "vt_" + deps.genId();
      var scenePath = PATH_PREFIX + deps.householdId + "/" + sceneTicket + "." + ext;
      var sceneDoc = {
        _id: sceneTicket,
        household_id: deps.householdId,
        purpose: "scene",
        scene_id: event.scene_id,
        asset_id: assetId,
        duration_ms: event.duration_ms,
        video_w: event.video_w,
        video_h: event.video_h,
        cloud_path: scenePath,
        ext: ext,
        status: "pending",
        scene_payload_sig: "",
        scene_evidence_count: 0,
        created_at: now,
        expires_at: new Date(nowMs + TICKET_TTL_MS).toISOString()
      };
      await ticketCol(deps).add({ data: sceneDoc });
      return {
        ok: true,
        upload_ticket: sceneTicket,
        upload_path: scenePath,
        expires_at: sceneDoc.expires_at,
        asset_id: assetId
      };
    }

    if (h.validItemId(event.item_id) === false) return fail("INVALID_INPUT");
    // B16:begin 也抢物品锁,防止「删除物品软删完成后又新建一张 pending 票据」。
    var itemLock = await acquireItemLock(deps, event.item_id, "begin");
    if (itemLock.ok !== true) return fail(itemLock.error || "VIDEO_ITEM_BUSY");
    try {
      var item = await itemAlive(deps, event.item_id);
      if (item === null) return fail("NOT_FOUND");
      // 每次申请新票据:不复用同物品旧 pending 票据,避免新旧上传互相覆盖/取消。
      var ticket = "vt_" + deps.genId();
      var path = PATH_PREFIX + deps.householdId + "/" + ticket + "." + ext;
      var doc = {
        _id: ticket,
        household_id: deps.householdId,
        purpose: "item",
        item_id: event.item_id,
        asset_id: assetId,
        cloud_path: path,
        ext: ext,
        status: "pending",
        created_at: now,
        expires_at: new Date(nowMs + TICKET_TTL_MS).toISOString()
      };
      await ticketCol(deps).add({ data: doc });
      return { ok: true, upload_ticket: ticket, upload_path: path, expires_at: doc.expires_at, asset_id: assetId };
    } finally {
      await releaseItemLock(deps, event.item_id, itemLock.token);
    }
  }

  /**
   * 上传回执:客户端 uploadFile 成功后立即调用,把 file_id 落到服务端票据。
   * 这样即使客户端 pending 丢失或换设备,服务端仍知道该未绑定视频的 file_id,
   * 可在删除物品或定时清理时删除;不再只能依赖客户端本地记忆。
   */
  async function receiptApply(event, deps) {
    var gotTicket = await ticketCol(deps).doc(event.upload_ticket).get();
    var ticket = gotTicket && gotTicket.data;
    if (ticket === null || ticket === undefined) return fail("VIDEO_TICKET_EXPIRED");
    if (ticket.household_id !== deps.householdId) return fail("FILE_NOT_OWNED");
    var actualPath = filePath(event.file_id);
    if (actualPath === null || actualPath !== ticket.cloud_path) return fail("FILE_NOT_OWNED");
    if (isString(ticket.file_id) && ticket.file_id !== "" && ticket.file_id !== event.file_id) return fail("FILE_NOT_OWNED");

    if (ticket.status === "bound") return { ok: true };
    if (ticket.status === "binding" || ticket.status === "cleaning" || ticket.status === "cancelling") return fail("VIDEO_TICKET_BUSY");
    if (ticket.status === "cancelled" || ticket.status === "deleted") return fail("VIDEO_TICKET_EXPIRED");
    if (ticket.status !== "pending") return fail("VIDEO_TICKET_EXPIRED");
    if (Date.parse(ticket.expires_at) < Date.parse(deps.now())) return fail("VIDEO_TICKET_EXPIRED");

    // 条件更新:持锁/或 CAS 后,若取消已抢走 pending,绝不把 file_id 写回。
    var receipt = await ticketCol(deps).where({
      _id: ticket._id,
      household_id: deps.householdId,
      status: "pending"
    }).update({ data: { file_id: event.file_id, receipt_at: deps.now() } });
    if (((receipt && receipt.stats && receipt.stats.updated) || 0) === 0) {
      var latestGot = await ticketCol(deps).doc(ticket._id).get();
      var latest = latestGot && latestGot.data;
      if (latest !== null && latest !== undefined && latest.status === "bound" && latest.file_id === event.file_id) return { ok: true };
      if (latest !== null && latest !== undefined && (latest.status === "binding" || latest.status === "cleaning" || latest.status === "cancelling")) return fail("VIDEO_TICKET_BUSY");
      return fail("VIDEO_TICKET_EXPIRED");
    }
    return { ok: true };
  }

  /**
   * 上传回执:
   * - item ticket 沿用 #89 item 锁 + CAS；
   * - scene ticket 无具体 item，仅票据 CAS；receipt 与 cancel 的竞态由
   *   pending 条件写 + cancel 抢到 cancelling 后强制重读最新 file_id 封住。
   */
  async function videoUploadReceipt(event, deps) {
    if (isString(event.upload_ticket) === false || event.upload_ticket.length < 8 || event.upload_ticket.length > 128) return fail("INVALID_INPUT");
    if (isString(event.file_id) === false || event.file_id.length < 1 || event.file_id.length > FILE_MAX) return fail("INVALID_INPUT");
    var initialGot = await ticketCol(deps).doc(event.upload_ticket).get();
    var initial = initialGot && initialGot.data;
    if (initial === null || initial === undefined) return fail("VIDEO_TICKET_EXPIRED");
    if (initial.household_id !== deps.householdId) return fail("FILE_NOT_OWNED");
    if (initial.purpose === "scene") return receiptApply(event, deps);

    // B17:receipt 与删除物品共用 item 锁。删除持锁时 receipt 不能写入 file_id;
    // 反之 receipt 持锁完成 CAS 后,删除流程才会读取到最新 file_id 并清理。
    var itemLock = await acquireItemLock(deps, initial.item_id, "receipt");
    if (itemLock.ok === false) return fail(itemLock.error || "VIDEO_ITEM_BUSY");
    try {
      return await receiptApply(event, deps);
    } finally {
      await releaseItemLock(deps, initial.item_id, itemLock.token);
    }
  }

  async function videoEvidenceAttach(event, deps) {
    if (isString(event.upload_ticket) === false || event.upload_ticket.length < 8 || event.upload_ticket.length > 128) return fail("INVALID_INPUT");
    if (isString(event.file_id) === false || event.file_id.length < 1 || event.file_id.length > FILE_MAX) return fail("INVALID_INPUT");
    if (Number.isInteger(event.duration_ms) === false || event.duration_ms < 1 || event.duration_ms > DURATION_MAX_MS) return fail("INVALID_INPUT");
    if (Number.isInteger(event.video_w) === false || event.video_w < 1 || event.video_w > DIM_MAX) return fail("INVALID_INPUT");
    if (Number.isInteger(event.video_h) === false || event.video_h < 1 || event.video_h > DIM_MAX) return fail("INVALID_INPUT");
    if (event.consent_version !== CONSENT_VERSION) return fail("INVALID_INPUT");
    var gotTicket = await ticketCol(deps).doc(event.upload_ticket).get();
    var ticket = gotTicket && gotTicket.data;
    if (ticket === null || ticket === undefined) return fail("VIDEO_TICKET_EXPIRED");
    if (ticket.household_id !== deps.householdId) return fail("FILE_NOT_OWNED");
    if (ticket.purpose === "scene") return fail("INVALID_INPUT");
    if (ticket.status === "pending" || ticket.status === "bound" || ticket.status === "binding") {
      // 合法可继续/等待的状态
    } else {
      return fail("VIDEO_TICKET_EXPIRED");
    }
    if (ticket.status === "pending" && Date.parse(ticket.expires_at) < Date.parse(deps.now())) return fail("VIDEO_TICKET_EXPIRED");
    var actualPath = filePath(event.file_id);
    if (actualPath === null || actualPath !== ticket.cloud_path) return fail("FILE_NOT_OWNED");
    if (ticket.file_id !== event.file_id) return fail("INVALID_INPUT");
    var item = await itemAlive(deps, ticket.item_id);
    if (item === null) return fail("NOT_FOUND");
    var itemLock = await acquireItemLock(deps, ticket.item_id, "attach");
    if (itemLock.ok !== true) return fail(itemLock.error || "VIDEO_ITEM_BUSY");
    try {
      // 抢到物品锁后重查一次,防止 item 在读取票与抢锁之间被删除。
      item = await itemAlive(deps, ticket.item_id);
      if (item === null) return fail("NOT_FOUND");

    // 先查已有证据:命中即修复票据 bound,绝不重复插入。
    var pre = await findEvidenceForTicket(deps, ticket);
    if (pre !== null) {
      await repairTicketBound(deps, ticket, pre._id);
      return { ok: true, evidence: projectEvidence(pre, await verifyFile(deps, event.file_id)), duplicated: true };
    }
    if (ticket.status === "binding") return fail("VIDEO_TICKET_BUSY");

    var url = await verifyFile(deps, event.file_id);
    if (url === "") return fail("VIDEO_NOT_AVAILABLE");
    var now = deps.now();

    // pending -> binding CAS:与定时清理/取消抢同一个独占状态。
    if (ticket.status === "pending") {
      var claim = await ticketCol(deps).where({
        _id: ticket._id,
        household_id: deps.householdId,
        status: "pending"
      }).update({ data: { status: "binding", binding_at: now } });
      if (((claim && claim.stats && claim.stats.updated) || 0) === 0) {
        var latestGot = await ticketCol(deps).doc(ticket._id).get();
        var latest = latestGot && latestGot.data;
        if (latest !== null && latest !== undefined) {
          var latestEvidence = await findEvidenceForTicket(deps, latest);
          if (latestEvidence !== null) {
            await repairTicketBound(deps, latest, latestEvidence._id);
            return { ok: true, evidence: projectEvidence(latestEvidence, url), duplicated: true };
          }
        }
        return fail("VIDEO_TICKET_BUSY");
      }
    }

    var doc = {
      _id: "ve_" + deps.genId(),
      household_id: deps.householdId,
      item_id: ticket.item_id,
      file_id: event.file_id,
      asset_id: isString(ticket.asset_id) ? ticket.asset_id : "",
      duration_ms: event.duration_ms,
      video_w: event.video_w,
      video_h: event.video_h,
      captured_location_text: isString(item.location_text) ? item.location_text : "",
      consent_version: CONSENT_VERSION,
      upload_ticket: ticket._id,
      source: "manual",
      highlights: [],
      highlight_version: 0,
      created_at: now
    };
    try {
      await evidenceCol(deps).add({ data: doc });
    } catch (e) {
      if (h.isDuplicateKeyError(e) === false) {
        // 证据插入失败:尽量把票据退回 pending,避免卡在 binding。
        try {
          await ticketCol(deps).where({ _id: ticket._id, status: "binding" }).update({ data: { status: "pending", bind_failed_at: now } });
        } catch (e2) {}
        throw e;
      }
      var twin = await findEvidenceForTicket(deps, ticket);
      if (twin !== null) {
        await repairTicketBound(deps, ticket, twin._id);
        return { ok: true, evidence: projectEvidence(twin, url), duplicated: true };
      }
      throw e;
    }
    // 证据已写成功。即使此处票据状态更新失败,清理任务也会先核对证据引用再删文件。
    await repairTicketBound(deps, ticket, doc._id);
    return { ok: true, evidence: projectEvidence(doc, url), duplicated: false };
    } finally {
      await releaseItemLock(deps, ticket.item_id, itemLock.token);
    }
  }

  function boundStateFromRows(ticket, rows, urlMap) {
    var out = {
      ok: true,
      state: "bound",
      evidence: projectEvidence(rows[0], urlMap && urlMap[rows[0].file_id] ? urlMap[rows[0].file_id] : "")
    };
    if (ticket.purpose === "scene") {
      var ids = [];
      var seen = Object.create(null);
      for (var i = 0; i < rows.length; i++) {
        if (seen[rows[i].item_id] !== true) {
          seen[rows[i].item_id] = true;
          ids.push(rows[i].item_id);
        }
      }
      out.linked_item_ids = ids;
      out.evidence_count = rows.length;
    }
    return out;
  }

  async function tempUrlMap(deps, rows) {
    var ids = [];
    var seen = Object.create(null);
    for (var i = 0; i < rows.length; i++) {
      if (isString(rows[i].file_id) && rows[i].file_id !== "" && seen[rows[i].file_id] !== true) {
        seen[rows[i].file_id] = true;
        ids.push(rows[i].file_id);
      }
    }
    if (ids.length === 0 || typeof deps.getTempFileUrls !== "function") return {};
    try { return h.mapTempUrls(await deps.getTempFileUrls(ids)); } catch (e) { return {}; }
  }

  async function videoUploadCancel(event, deps) {
    if (isString(event.upload_ticket) === false || event.upload_ticket.length < 8) return fail("INVALID_INPUT");
    var got = await ticketCol(deps).doc(event.upload_ticket).get();
    var ticket = got && got.data;
    if (ticket === null || ticket === undefined || ticket.household_id !== deps.householdId) return fail("NOT_FOUND");

    // 已绑定(或证据已存在):取消不能删文件,修复票据并返回 bound。
    // scene ticket 可能对应多个 item 行，必须收集全部引用，不能拿单 item 判断。
    var preRows = await evidenceRowsForTicket(deps, ticket);
    if (preRows.length > 0) {
      await repairTicketBound(deps, ticket, preRows[0]._id, preRows.length);
      return boundStateFromRows(ticket, preRows, await tempUrlMap(deps, preRows));
    }
    // D1(§2.4):commit 已落 scan 但 0 件证据成功的会话,其视频是该 scan 的回看
    // 内容,取消不得删云文件——按 asset/file 复核 location_scans,任一 scan 行存在
    // 即视为有引用,bound 态保留。scan 只能由 commit 写出,cancel-before-commit
    // 场景查不到,行为与 B 完全一致。
    if (await locationScanRefExists(deps, ticket)) {
      return retainTicketForScan(deps, ticket);
    }
    if (ticket.status === "bound") return fail("VIDEO_TICKET_BUSY");
    if (ticket.status === "cancelled" || ticket.status === "deleted") return { ok: true, state: "cancelled" };
    if (ticket.status !== "pending") return fail("VIDEO_TICKET_BUSY");

    // pending -> cancelling CAS:与 attach/scene commit 的 pending -> binding 互斥。
    var claim = await ticketCol(deps).where({
      _id: ticket._id,
      household_id: deps.householdId,
      status: "pending"
    }).update({ data: { status: "cancelling", cancelling_at: deps.now() } });
    if (((claim && claim.stats && claim.stats.updated) || 0) === 0) {
      var latestGot = await ticketCol(deps).doc(ticket._id).get();
      var latest = latestGot && latestGot.data;
      if (latest !== null && latest !== undefined) {
        var latestRows = await evidenceRowsForTicket(deps, latest);
        if (latestRows.length > 0) {
          await repairTicketBound(deps, latest, latestRows[0]._id, latestRows.length);
          return boundStateFromRows(latest, latestRows, await tempUrlMap(deps, latestRows));
        }
        if (latest.status === "cancelled" || latest.status === "deleted") return { ok: true, state: "cancelled" };
      }
      return fail("VIDEO_TICKET_BUSY");
    }

    // B15:抢到 cancelling 后必须重读票据。CAS 之前可能有 receipt 刚写入 file_id，
    // 旧快照没有 file_id 会漏删真实视频；后续判断一律使用最新快照。
    var freshGot = await ticketCol(deps).doc(ticket._id).get();
    var fresh = freshGot && freshGot.data;
    if (fresh === null || fresh === undefined) return { ok: true, state: "cancelled" };
    // 再核对一次 evidence,封住「查询 pending 与删除文件」之间的竞态。
    var afterClaimRows = await evidenceRowsForTicket(deps, fresh);
    if (afterClaimRows.length > 0) {
      await repairTicketBound(deps, fresh, afterClaimRows[0]._id, afterClaimRows.length);
      return boundStateFromRows(fresh, afterClaimRows, await tempUrlMap(deps, afterClaimRows));
    }
    // D1(§2.4):抢到 cancelling 之后同样先复核 scan 引用再谈删文件。
    if (await locationScanRefExists(deps, fresh)) {
      await ticketCol(deps).where({ _id: ticket._id, household_id: deps.householdId, status: "cancelling" }).update({
        data: {
          status: "bound",
          bound_at: fresh.bound_at || deps.now(),
          scan_retained_at: deps.now(),
          cleanup_reason: "scan_ref_found"
        }
      });
      return { ok: true, state: "bound", scan_retained: true };
    }

    if (isString(fresh.file_id) && fresh.file_id !== "") {
      var del = await deleteFilesStrict(deps, [fresh.file_id]);
      if (del.ok === false) {
        try {
          await ticketCol(deps).where({ _id: ticket._id, status: "cancelling" }).update({ data: { status: "pending", cancel_failed_at: deps.now() } });
        } catch (e) {}
        return fail("VIDEO_DELETE_FAILED");
      }
    }
    await ticketCol(deps).where({ _id: ticket._id, status: "cancelling" }).update({
      data: { status: "cancelled", cancelled_at: deps.now(), cleanup_reason: "user_cancel" }
    });
    return { ok: true, state: "cancelled" };
  }

  function sha256Hex(deps, text) {
    if (typeof deps.sha256 === "function") return deps.sha256(text);
    return crypto.createHash("sha256").update(String(text)).digest("hex");
  }

  /**
   * canonical 输入(D1 增量):location 存在时逐件追加 node_id[]/move_to_node_id[],
   * 并把位置上下文 { location_id, scan_id, path_snapshot } 并入签名输入——同一票据
   * 先无位置后有位置(或反之)→ 签名失配 → OPERATION_CONFLICT,杜绝混合模式重试。
   * location 缺省时输出与 B 逐字节相同(零感知硬保证,由回归测试锁定)。
   * expected_version 不进签名:客户端刷新物品版本后同载荷重试必须过签名门。
   */
  function canonicalSceneItems(items, locationCtx) {
    var out = [];
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var one = {
        draft_key: it.draft_key,
        target: it.target,
        highlights: JSON.parse(highlightsContentKey(it.highlights))
      };
      if (it.target === "new") {
        one.operation_id = it.operation_id;
        one.name = it.name;
        one.location_text = it.location_text;
        one.note = it.note;
        if (locationCtx && it.node_id !== undefined) one.node_id = it.node_id;
      } else {
        one.item_id = it.item_id;
        if (locationCtx && it.move_to_node_id !== undefined) one.move_to_node_id = it.move_to_node_id;
      }
      out.push(one);
    }
    out.sort(function (a, b) { return a.draft_key < b.draft_key ? -1 : a.draft_key > b.draft_key ? 1 : 0; });
    return out;
  }

  function scenePayloadSignature(deps, items, locationCtx) {
    var canonical = canonicalSceneItems(items, locationCtx || null);
    if (locationCtx == null) {
      return sha256Hex(deps, JSON.stringify(canonical));
    }
    return sha256Hex(deps, JSON.stringify({
      location: {
        location_id: locationCtx.location_id,
        scan_id: locationCtx.scan_id,
        path_snapshot: locationCtx.path_snapshot
      },
      items: canonical
    }));
  }

  async function saveSceneEvidence(deps, ticket, item, highlights, now, scanId) {
    var existingGot = await evidenceCol(deps).where({
      household_id: deps.householdId,
      item_id: item._id,
      file_id: ticket.file_id
    }).get();
    var existing = existingGot && existingGot.data && existingGot.data.length > 0 ? existingGot.data[0] : null;
    if (existing !== null) {
      var stored = sanitizeStoredHighlights(existing.highlights, existing.duration_ms);
      var same =
        existing.source === "scene" &&
        existing.asset_id === ticket.asset_id &&
        existing.duration_ms === ticket.duration_ms &&
        existing.video_w === ticket.video_w &&
        existing.video_h === ticket.video_h &&
        (isString(existing.scan_id) ? existing.scan_id : "") === (scanId || "") &&
        stored !== null &&
        highlightsContentKey(stored) === highlightsContentKey(highlights);
      if (same) return { ok: true, duplicated: true, evidence: existing };
      return { ok: false, error: "OPERATION_CONFLICT", message: h.ERROR_MESSAGES.OPERATION_CONFLICT };
    }
    var doc = {
      _id: "ve_" + deps.genId(),
      household_id: deps.householdId,
      item_id: item._id,
      file_id: ticket.file_id,
      asset_id: ticket.asset_id,
      duration_ms: ticket.duration_ms,
      video_w: ticket.video_w,
      video_h: ticket.video_h,
      captured_location_text: isString(item.location_text) ? item.location_text : "",
      consent_version: CONSENT_VERSION,
      upload_ticket: ticket._id,
      source: "scene",
      highlights: highlights,
      highlight_version: 1,
      highlight_updated_at: now,
      created_at: now
    };
    if (scanId) doc.scan_id = scanId;
    try {
      await evidenceCol(deps).add({ data: doc });
      return { ok: true, duplicated: false, evidence: doc };
    } catch (e) {
      if (h.isDuplicateKeyError(e) === false) return { ok: false, error: "EVIDENCE_WRITE_FAILED", message: "视频证据写入失败,请重试" };
      var twinGot = await evidenceCol(deps).where({
        household_id: deps.householdId,
        item_id: item._id,
        file_id: ticket.file_id
      }).get();
      var twin = twinGot && twinGot.data && twinGot.data.length > 0 ? twinGot.data[0] : null;
      if (twin === null) return { ok: false, error: "EVIDENCE_WRITE_FAILED", message: "视频证据写入失败,请重试" };
      var twinStored = sanitizeStoredHighlights(twin.highlights, twin.duration_ms);
      if (
        twin.asset_id === ticket.asset_id &&
        (isString(twin.scan_id) ? twin.scan_id : "") === (scanId || "") &&
        twinStored !== null &&
        highlightsContentKey(twinStored) === highlightsContentKey(highlights)
      ) {
        return { ok: true, duplicated: true, evidence: twin };
      }
      return { ok: false, error: "OPERATION_CONFLICT", message: h.ERROR_MESSAGES.OPERATION_CONFLICT };
    }
  }

  async function claimSceneTicket(deps, initialTicket, signature) {
    var ticket = initialTicket;
    for (var attempt = 0; attempt < 3; attempt++) {
      if (ticket.status === "pending") {
        if (isString(ticket.scene_payload_sig) && ticket.scene_payload_sig !== "" && ticket.scene_payload_sig !== signature) {
          return { ok: false, error: "OPERATION_CONFLICT" };
        }
        var claim = await ticketCol(deps).where({
          _id: ticket._id,
          household_id: deps.householdId,
          status: "pending"
        }).update({ data: {
          status: "binding",
          binding_at: ticket.binding_at || deps.now(),
          scene_payload_sig: signature,
          scene_evidence_count: Number.isInteger(ticket.scene_evidence_count) ? ticket.scene_evidence_count : 0
        } });
        if (((claim && claim.stats && claim.stats.updated) || 0) === 1) {
          var afterClaim = await ticketCol(deps).doc(ticket._id).get();
          return { ok: true, ticket: afterClaim && afterClaim.data ? afterClaim.data : ticket };
        }
      } else if (ticket.status === "binding" || ticket.status === "bound") {
        if (isString(ticket.scene_payload_sig) === false && ticket.scene_payload_sig !== "") {
          return { ok: false, error: "OPERATION_CONFLICT" };
        }
        if (isString(ticket.scene_payload_sig) === false || ticket.scene_payload_sig === "") {
          var sigClaim = await ticketCol(deps).where({
            _id: ticket._id,
            household_id: deps.householdId,
            status: ticket.status,
            scene_payload_sig: ""
          }).update({ data: { scene_payload_sig: signature } });
          if (((sigClaim && sigClaim.stats && sigClaim.stats.updated) || 0) === 1) {
            var sigRead = await ticketCol(deps).doc(ticket._id).get();
            return { ok: true, ticket: sigRead && sigRead.data ? sigRead.data : ticket };
          }
        } else {
          return { ok: true, ticket: ticket };
        }
      } else if (ticket.status === "cancelled" || ticket.status === "deleted") {
        return { ok: false, error: "VIDEO_TICKET_EXPIRED" };
      } else {
        return { ok: false, error: "VIDEO_TICKET_BUSY" };
      }
      var reread = await ticketCol(deps).doc(initialTicket._id).get();
      ticket = reread && reread.data ? reread.data : null;
      if (ticket === null || ticket === undefined) return { ok: false, error: "VIDEO_TICKET_EXPIRED" };
    }
    return { ok: false, error: "VIDEO_TICKET_BUSY" };
  }

  // ---------------------------------------------------------------------------
  // D1 位置清点(issue #94,docs/design/video-ai/D1-IMPLEMENTATION.md §2):
  // location 上下文解析、itemsApi 内的子树等价实现、显式移动/挂载、location_scans 落库。
  // 所有入口只在 event.location 存在时被调用;集合权限「所有用户不可读不可写」,
  // 一切读写走本云函数,日志只记计数/错误码。
  // ---------------------------------------------------------------------------

  function scanCol(deps) { return deps.db.collection(LS); }

  function codePointLength(s) { return Array.from(s).length; }

  /** path_snapshot 段形状门:去首尾空白 1-30 码点(与 locations 的节点名同款门槛) */
  function cleanSnapshotSegment(v) {
    if (isString(v) === false) return null;
    var trimmed = v.trim();
    var len = codePointLength(trimmed);
    if (len < 1 || len > 30) return null;
    return trimmed;
  }

  /**
   * 解析 event.location(D1 可选参数)。缺省/未携带返回 null(= B 现行为,零感知);
   * 形状非法返回 "INVALID"(调用方整批零写)。scene_id 三方一致的第一方在这里:
   * location.scan_id 必须 === event.scene_id(第二方在 ticket 校验,既有逻辑)。
   */
  function parseLocationContext(event) {
    if (event.location === undefined || event.location === null) return null;
    var loc = event.location;
    if (loc === null || typeof loc !== "object" || Array.isArray(loc)) return "INVALID";
    if (
      isString(loc.location_id) === false ||
      loc.location_id.length < 1 ||
      loc.location_id.length > LOCATION_ID_MAX
    ) return "INVALID";
    if (
      isString(loc.scan_id) === false ||
      loc.scan_id.length < SCENE_ID_MIN ||
      loc.scan_id.length > SCENE_ID_MAX ||
      loc.scan_id !== event.scene_id
    ) return "INVALID";
    if (
      Array.isArray(loc.path_snapshot) === false ||
      loc.path_snapshot.length < 1 ||
      loc.path_snapshot.length > LOCATION_SNAPSHOT_SEGMENTS_MAX
    ) return "INVALID";
    var segments = [];
    for (var i = 0; i < loc.path_snapshot.length; i++) {
      var seg = cleanSnapshotSegment(loc.path_snapshot[i]);
      if (seg === null) return "INVALID";
      segments.push(seg);
    }
    if (isString(loc.text_snapshot) === false) return "INVALID";
    if (loc.text_snapshot !== segments.join(LOCATION_PATH_SEPARATOR)) return "INVALID";
    return { location_id: loc.location_id, scan_id: loc.scan_id, path_snapshot: segments };
  }

  /**
   * 拉本家庭全部位置节点(分页拉全量 + 护栏,locations/lib/handler.js fetchAllPages 同款)。
   * itemsApi 与 locations 是两个独立部署包,不能 require locations/lib/tree.js
   * (locations 读 items 集合的先例已存在,此处反向对称);子树算法等价性由
   * tests/location-scan-commit.test.js 的行为级用例保证,两处需同步演进。
   */
  async function fetchHouseholdLocationNodes(deps) {
    var out = [];
    for (var page = 0; page < 100; page++) {
      var res = await deps.db.collection(LOCATIONS_COLLECTION)
        .where({ household_id: deps.householdId })
        .skip(out.length)
        .limit(100)
        .get();
      var batch = (res && res.data) || [];
      for (var i = 0; i < batch.length; i++) out.push(batch[i]);
      if (batch.length < 100) return out;
    }
    throw new Error("locations query exceeded 10000 documents");
  }

  /**
   * collectSubtree 等价实现(locations/lib/tree.js:39 同款 BFS):返回 rootId 子树的
   * id→node 映射(含自身);rootId 不在节点集内返回 null。
   */
  function subtreeNodesById(nodes, rootId) {
    var byParent = Object.create(null);
    var root = null;
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      if (n._id === rootId) root = n;
      if (Object.prototype.hasOwnProperty.call(byParent, n.parent_id) === false) {
        byParent[n.parent_id] = [];
      }
      byParent[n.parent_id].push(n);
    }
    if (root === null) return null;
    var subtree = Object.create(null);
    subtree[root._id] = root;
    var queue = [root];
    while (queue.length > 0) {
      var cur = queue.shift();
      var children = byParent[cur._id] || [];
      for (var c = 0; c < children.length; c++) {
        subtree[children[c]._id] = children[c];
        queue.push(children[c]);
      }
    }
    return subtree;
  }

  /**
   * location_id 归属与子树校验(读 DB,仍在票据 CAS 之前,非法输入零写):
   * - 按 { _id, household_id } 查 locations:跨家庭/不存在 → NOT_FOUND(findNodeById 同语义);
   * - home 根拒绝(清点入口只在非根层,物品不允许挂根);
   * - 逐件校验 node_id/move_to_node_id ∈ subtree(location_id)(含自身),越界 →
   *   INVALID_INPUT + detail.out_of_subtree,整批零写;
   * - target:"new" 的 location_text 必须逐字 === 目标节点 path.join(" / ")
   *   (服务端权威,消除双份真相);不一致 → INVALID_INPUT 零写。
   */
  async function resolveLocationContext(deps, prepared, locationCtx) {
    var got = await deps.db.collection(LOCATIONS_COLLECTION)
      .where({ _id: locationCtx.location_id, household_id: deps.householdId })
      .get();
    var node = got && got.data && got.data.length > 0 ? got.data[0] : null;
    if (node === null) return { ok: false, error: "NOT_FOUND" };
    if (node.parent_id === "") return { ok: false, error: "INVALID_INPUT" };
    var nodes = await fetchHouseholdLocationNodes(deps);
    var subtree = subtreeNodesById(nodes, locationCtx.location_id);
    if (subtree === null) return { ok: false, error: "NOT_FOUND" };
    var outOfSubtree = [];
    var targets = Object.create(null);
    for (var i = 0; i < prepared.length; i++) {
      var p = prepared[i];
      if (p.target === "new") {
        var targetId = p.node_id !== undefined ? p.node_id : locationCtx.location_id;
        var targetNode = subtree[targetId];
        if (targetNode === undefined) {
          outOfSubtree.push(p.draft_key);
          continue;
        }
        if (p.location_text !== targetNode.path.join(LOCATION_PATH_SEPARATOR)) {
          return { ok: false, error: "INVALID_INPUT", detail: { location_text_mismatch: [p.draft_key] } };
        }
        targets[p.draft_key] = { node_id: targetId, path_text: targetNode.path.join(LOCATION_PATH_SEPARATOR) };
      } else if (p.move_to_node_id !== undefined && subtree[p.move_to_node_id] === undefined) {
        outOfSubtree.push(p.draft_key);
      }
    }
    if (outOfSubtree.length > 0) {
      return { ok: false, error: "INVALID_INPUT", detail: { out_of_subtree: outOfSubtree } };
    }
    return { ok: true, node: node, subtree: subtree, targets: targets };
  }

  /** 修改内容指纹(键排序 JSON,itemsApi changesFingerprint 同款算法) */
  function scanChangesFingerprint(changes) {
    var keys = Object.keys(changes).sort();
    var parts = [];
    for (var i = 0; i < keys.length; i++) {
      parts.push(JSON.stringify(keys[i]) + ":" + JSON.stringify(changes[keys[i]]));
    }
    return "{" + parts.join(",") + "}";
  }

  /**
   * D1 显式移动(target:"existing" + move_to_node_id):itemsApi.update 同构的
   * 版本条件更新,一次写 location_text(目标节点路径文本)+ location_node_id;
   * update_id = "d1move:"+sha256Hex(scan_id+":"+item_id),确定性,响应丢失重试
   * 可被三重重放识别。0 命中回查三态:已在目标节点(already)/三重条件命中
   * (replayed)/否则 VERSION_CONFLICT(该件不写 evidence,由调用方标记,绝不
   * 静默降级为「只关联」)。expected_version 不进载荷签名:客户端刷新版本后
   * 同载荷重试必须能过签名门(D1-IMPLEMENTATION §2.1 第 4 条)。
   */
  async function applyScanMove(deps, itemId, expectedVersion, targetNodeId, targetPathText, scanId) {
    var updateId = "d1move:" + sha256Hex(deps, scanId + ":" + itemId);
    var fingerprint = scanChangesFingerprint({ location_text: targetPathText, location_node_id: targetNodeId });
    var res = await h.collection(deps).where({
      _id: itemId,
      household_id: deps.householdId,
      deleted: false,
      version: expectedVersion
    }).update({
      data: {
        location_text: targetPathText,
        location_node_id: targetNodeId,
        version: expectedVersion + 1,
        updated_at: deps.now(),
        last_update_id: updateId,
        last_update_fingerprint: fingerprint
      }
    });
    if (((res && res.stats && res.stats.updated) || 0) >= 1) return { ok: true, move: "moved" };
    var curGot = await h.collection(deps)
      .where({ _id: itemId, household_id: deps.householdId, deleted: false })
      .get();
    var cur = curGot && curGot.data && curGot.data.length > 0 ? curGot.data[0] : null;
    if (cur === null) return { ok: false, error: "NOT_FOUND" };
    // 三重重放识别先于 already:同一 d1move 派生标识 + 版本恰为 expected+1 + 内容指纹
    // 一致 = 本请求自己的上次写入,报 replayed;否则已在目标节点才归 already。
    if (
      cur.version === expectedVersion + 1 &&
      cur.last_update_id === updateId &&
      cur.last_update_fingerprint === fingerprint
    ) {
      return { ok: true, move: "replayed", item: cur };
    }
    if (cur.location_node_id === targetNodeId) return { ok: true, move: "already", item: cur };
    return { ok: false, error: "VERSION_CONFLICT" };
  }

  /**
   * D1 新物品挂载(target:"new" 建档后):同款条件更新挂 location_node_id
   * (expected_version=1;update_id = "d1mount:"+sha256Hex(scan_id+":"+item_id))。
   * 挂载失败(并发编辑的理论窗口)不推翻「物品已按正确 location_text 建档 +
   * 证据已存」的事实:返回 mounted:false + mount_error,绝不删物品。
   */
  async function applyScanMount(deps, itemId, targetNodeId, scanId) {
    var updateId = "d1mount:" + sha256Hex(deps, scanId + ":" + itemId);
    var fingerprint = scanChangesFingerprint({ location_node_id: targetNodeId });
    var res = await h.collection(deps).where({
      _id: itemId,
      household_id: deps.householdId,
      deleted: false,
      version: 1
    }).update({
      data: {
        location_node_id: targetNodeId,
        version: 2,
        updated_at: deps.now(),
        last_update_id: updateId,
        last_update_fingerprint: fingerprint
      }
    });
    if (((res && res.stats && res.stats.updated) || 0) >= 1) return { mounted: true, replayed: false };
    var curGot = await h.collection(deps)
      .where({ _id: itemId, household_id: deps.householdId, deleted: false })
      .get();
    var cur = curGot && curGot.data && curGot.data.length > 0 ? curGot.data[0] : null;
    if (cur === null) return { mounted: false, mount_error: "NOT_FOUND" };
    if (cur.location_node_id === targetNodeId) return { mounted: true, replayed: false };
    if (
      cur.version === 2 &&
      cur.last_update_id === updateId &&
      cur.last_update_fingerprint === fingerprint
    ) {
      return { mounted: true, replayed: true };
    }
    return { mounted: false, mount_error: "VERSION_CONFLICT" };
  }

  /**
   * location_scans 落库(锁内、逐件循环之后,§2.2 第 4 条):(household_id, scan_id)
   * 为幂等键。无 → add(_id="ls_"+genId(),E11000 并发 → 回查走下一分支);已有且
   * file_id/asset_id/location_id 一致 → 以活证据自愈式更新:confirmed_item_ids 由
   * 调用方从 evidenceRowsForFile 的活行重新算出(部分失败重试后第二次 commit 会把
   * 补齐的证据计入),candidate_count 取 max(旧, 新),返回 duplicated:true;已有但
   * file_id/asset_id/location_id 不一致 → OPERATION_CONFLICT(scan_id 被复用到另一段
   * 视频的客户端 bug 硬门)。零确认件也落 scan(confirmed_count:0)。
   */
  async function upsertLocationScan(deps, ticket, locationCtx, node, candidateCount, confirmedItemIds) {
    var col = scanCol(deps);
    var existingGot = await col.where({ household_id: deps.householdId, scan_id: locationCtx.scan_id }).get();
    var existing = existingGot && existingGot.data && existingGot.data.length > 0 ? existingGot.data[0] : null;
    var now = deps.now();
    if (existing === null) {
      var doc = {
        _id: "ls_" + deps.genId(),
        household_id: deps.householdId,
        scan_id: locationCtx.scan_id,
        location_id: locationCtx.location_id,
        location_path_snapshot: node.path,
        location_text_snapshot: node.path.join(LOCATION_PATH_SEPARATOR),
        file_id: ticket.file_id,
        asset_id: ticket.asset_id,
        upload_ticket: ticket._id,
        duration_ms: ticket.duration_ms,
        video_w: ticket.video_w,
        video_h: ticket.video_h,
        candidate_count: candidateCount,
        confirmed_count: confirmedItemIds.length,
        confirmed_item_ids: confirmedItemIds,
        created_at: now,
        updated_at: now,
        status: "active"
      };
      try {
        await col.add({ data: doc });
        return { ok: true, duplicated: false, scan: doc };
      } catch (e) {
        if (h.isDuplicateKeyError(e) === false) throw e;
        existingGot = await col.where({ household_id: deps.householdId, scan_id: locationCtx.scan_id }).get();
        existing = existingGot && existingGot.data && existingGot.data.length > 0 ? existingGot.data[0] : null;
        if (existing === null) throw e;
      }
    }
    if (
      existing.file_id !== ticket.file_id ||
      existing.asset_id !== ticket.asset_id ||
      existing.location_id !== locationCtx.location_id
    ) {
      return { ok: false, error: "OPERATION_CONFLICT" };
    }
    var patch = {
      confirmed_item_ids: confirmedItemIds,
      confirmed_count: confirmedItemIds.length,
      updated_at: now
    };
    patch.candidate_count = Math.max(
      Number.isInteger(existing.candidate_count) ? existing.candidate_count : 0,
      candidateCount
    );
    await col.where({ _id: existing._id, household_id: deps.householdId }).update({ data: patch });
    return { ok: true, duplicated: true, scan: Object.assign({}, existing, patch) };
  }

  /**
   * location_scans 按 asset/file 的引用复核(§2.4):任一 scan 行存在即视为有引用。
   * 用于取消与孤儿回收——commit 已落 scan 但 0 件证据成功的会话,其视频是该 scan
   * 的回看内容,不得删云文件;cancel-before-commit(scan 尚不存在)行为与 B 一致。
   */
  async function locationScanRefExists(deps, ticket) {
    if (isString(ticket.asset_id) && ticket.asset_id !== "") {
      var byAsset = await scanCol(deps).where({ household_id: deps.householdId, asset_id: ticket.asset_id }).get();
      if (byAsset && byAsset.data && byAsset.data.length > 0) return true;
    }
    if (isString(ticket.file_id) && ticket.file_id !== "") {
      var byFile = await scanCol(deps).where({ household_id: deps.householdId, file_id: ticket.file_id }).get();
      if (byFile && byFile.data && byFile.data.length > 0) return true;
    }
    return false;
  }

  /** D1:scan 引用保留的取消收敛——票据修复为 bound(零证据场景),文件绝不删 */
  async function retainTicketForScan(deps, ticket) {
    if (ticket.status === "pending" || ticket.status === "binding") {
      try {
        await ticketCol(deps).where({ _id: ticket._id, household_id: deps.householdId }).update({
          data: { status: "bound", bound_at: ticket.bound_at || deps.now(), scan_retained_at: deps.now() }
        });
      } catch (e) {
        // 状态修复失败不改变「不删文件」的事实;清理任务会再次按 scan 引用复核
      }
    }
    return { ok: true, state: "bound", scan_retained: true };
  }

  function parseSceneCommitItems(raw) {
    if (Array.isArray(raw) === false || raw.length < 1 || raw.length > SCENE_ITEMS_MAX) return "INVALID";
    var out = [];
    var seenDraft = Object.create(null);
    var seenOperation = Object.create(null);
    var seenExisting = Object.create(null);
    for (var i = 0; i < raw.length; i++) {
      var it = raw[i];
      if (it === null || typeof it !== "object" || Array.isArray(it)) return "INVALID";
      if (isString(it.draft_key) === false || it.draft_key.length < 1 || it.draft_key.length > SCENE_DRAFT_KEY_MAX) return "INVALID";
      if (seenDraft[it.draft_key] === true) return "INVALID";
      seenDraft[it.draft_key] = true;
      var highlights = parseHighlightInput(it.highlights);
      if (highlights === "INVALID") return "INVALID";
      // D1 可选字段(缺省 = B 现行为):node_id 仅 target:"new";move_to_node_id 仅
      // target:"existing" 且 expected_version 必填当且仅当 move_to_node_id 出现。
      var hasNodeId = it.node_id !== undefined && it.node_id !== null;
      var hasMoveTo = it.move_to_node_id !== undefined && it.move_to_node_id !== null;
      var hasExpectedVersion = it.expected_version !== undefined && it.expected_version !== null;
      if (hasNodeId && (isString(it.node_id) === false || it.node_id.length < 1 || it.node_id.length > LOCATION_ID_MAX)) return "INVALID";
      if (hasMoveTo && (isString(it.move_to_node_id) === false || it.move_to_node_id.length < 1 || it.move_to_node_id.length > LOCATION_ID_MAX)) return "INVALID";
      if (hasExpectedVersion && (Number.isInteger(it.expected_version) === false || it.expected_version < 1)) return "INVALID";
      if (it.target === "new") {
        if (hasMoveTo || hasExpectedVersion) return "INVALID";
        if (isString(it.operation_id) === false || it.operation_id.length < 1 || it.operation_id.length > h.OPERATION_ID_MAX) return "INVALID";
        if (seenOperation[it.operation_id] === true) return "INVALID";
        seenOperation[it.operation_id] = true;
        var name = h.cleanRequired(it.name, h.NAME_MAX);
        if (name === null) return "INVALID";
        var location = h.cleanRequired(it.location_text, h.LOCATION_MAX);
        if (location === null) return "INVALID";
        var note = h.cleanOptional(it.note, h.NOTE_MAX);
        if (note === null) return "INVALID";
        var newItemOut = { draft_key: it.draft_key, target: "new", operation_id: it.operation_id, name: name, location_text: location, note: note, highlights: highlights };
        if (hasNodeId) newItemOut.node_id = it.node_id;
        out.push(newItemOut);
      } else if (it.target === "existing") {
        if (hasNodeId) return "INVALID";
        if (hasMoveTo !== hasExpectedVersion) return "INVALID";
        if (h.validItemId(it.item_id) === false) return "INVALID";
        if (seenExisting[it.item_id] === true) return "INVALID";
        seenExisting[it.item_id] = true;
        var existingItemOut = { draft_key: it.draft_key, target: "existing", item_id: it.item_id, highlights: highlights };
        if (hasMoveTo) {
          existingItemOut.move_to_node_id = it.move_to_node_id;
          existingItemOut.expected_version = it.expected_version;
        }
        out.push(existingItemOut);
      } else {
        return "INVALID";
      }
    }
    return out;
  }

  async function videoSceneCommit(event, deps) {
    if (isString(event.scene_id) === false || event.scene_id.length < SCENE_ID_MIN || event.scene_id.length > SCENE_ID_MAX) return fail("INVALID_INPUT");
    if (isString(event.upload_ticket) === false || event.upload_ticket.length < 8 || event.upload_ticket.length > 128) return fail("INVALID_INPUT");
    if (isString(event.asset_id) === false || event.asset_id.length < 3 || event.asset_id.length > 128) return fail("INVALID_INPUT");
    if (isString(event.file_id) === false || event.file_id.length < 1 || event.file_id.length > FILE_MAX) return fail("INVALID_INPUT");
    if (
      Number.isInteger(event.duration_ms) === false || event.duration_ms < 1 || event.duration_ms > DURATION_MAX_MS ||
      Number.isInteger(event.video_w) === false || event.video_w < 1 || event.video_w > DIM_MAX ||
      Number.isInteger(event.video_h) === false || event.video_h < 1 || event.video_h > DIM_MAX
    ) return fail("INVALID_INPUT");
    if (event.consent_version !== CONSENT_VERSION) return fail("INVALID_INPUT");
    var prepared = parseSceneCommitItems(event.items);
    if (prepared === "INVALID") return fail("INVALID_INPUT");
    for (var hp = 0; hp < prepared.length; hp++) {
      if (highlightsWithinDuration(prepared[hp].highlights, event.duration_ms) === false) return fail("INVALID_INPUT");
    }

    // D1 位置上下文(可选;缺省 = B 现行为零感知):形状门先于一切读写,
    // 非法参数整批零写(与 B 的「纯参数错误零写」同款纪律)。
    var locationCtx = parseLocationContext(event);
    if (locationCtx === "INVALID") return fail("INVALID_INPUT");
    var hasCandidateCount = event.candidate_count !== undefined && event.candidate_count !== null;
    if (hasCandidateCount && locationCtx === null) return fail("INVALID_INPUT");
    var candidateCount = 0;
    if (hasCandidateCount) {
      if (
        Number.isInteger(event.candidate_count) === false ||
        event.candidate_count < 0 ||
        event.candidate_count > SCAN_CANDIDATE_MAX
      ) return fail("INVALID_INPUT");
      candidateCount = event.candidate_count;
    }

    // D1 归属与子树校验(读 DB,仍在票据 CAS 之前,非法输入零写):
    // 跨家庭 location_id → NOT_FOUND;件选子树外节点 → INVALID_INPUT + out_of_subtree;
    // target:"new" 的 location_text 必须 === 目标节点路径文本(服务端权威)。
    var locationInfo = null;
    if (locationCtx !== null) {
      var resolvedLocation = await resolveLocationContext(deps, prepared, locationCtx);
      if (resolvedLocation.ok !== true) {
        if (resolvedLocation.detail) {
          return {
            ok: false,
            error: resolvedLocation.error,
            message: h.ERROR_MESSAGES.INVALID_INPUT,
            detail: resolvedLocation.detail
          };
        }
        return fail(resolvedLocation.error);
      }
      locationInfo = resolvedLocation;
    }

    var gotTicket = await ticketCol(deps).doc(event.upload_ticket).get();
    var ticket = gotTicket && gotTicket.data;
    if (ticket === null || ticket === undefined) return fail("VIDEO_TICKET_EXPIRED");
    if (ticket.household_id !== deps.householdId) return fail("FILE_NOT_OWNED");
    if (ticket.purpose !== "scene") return fail("INVALID_INPUT");
    if (ticket.asset_id !== event.asset_id) return fail("FILE_NOT_OWNED");
    if (ticket.scene_id !== event.scene_id) return fail("OPERATION_CONFLICT");
    var actualPath = filePath(event.file_id);
    if (actualPath === null || actualPath !== ticket.cloud_path) return fail("FILE_NOT_OWNED");
    if (ticket.file_id !== event.file_id) return fail("INVALID_INPUT");
    if (ticket.duration_ms !== event.duration_ms || ticket.video_w !== event.video_w || ticket.video_h !== event.video_h) return fail("INVALID_INPUT");
    if (ticket.status === "pending" && Date.parse(ticket.expires_at) < Date.parse(deps.now())) return fail("VIDEO_TICKET_EXPIRED");
    if (ticket.status !== "pending" && ticket.status !== "binding" && ticket.status !== "bound") {
      return ticket.status === "cancelled" || ticket.status === "deleted" ? fail("VIDEO_TICKET_EXPIRED") : fail("VIDEO_TICKET_BUSY");
    }

    // commit 阶段不做 AI/VL；只做一次已有文件快速换链可用性检查。
    var url = await verifyFile(deps, event.file_id);
    if (url === "") return fail("VIDEO_NOT_AVAILABLE");

    var signature = scenePayloadSignature(deps, prepared, locationCtx);
    if (isString(ticket.scene_payload_sig) && ticket.scene_payload_sig !== "" && ticket.scene_payload_sig !== signature) {
      return fail("OPERATION_CONFLICT");
    }
    var claimed = await claimSceneTicket(deps, ticket, signature);
    if (claimed.ok !== true) return fail(claimed.error || "VIDEO_TICKET_BUSY");
    ticket = claimed.ticket;

    // 先幂等建档/解析 item。新物品的 operation_id 由客户端稳定提供；
    // 同名不同 operation_id 必然得到不同 item，服务端绝不按 name 查重。
    var resolved = [];
    var failedKeys = [];
    for (var i = 0; i < prepared.length; i++) {
      var p = prepared[i];
      if (p.target === "new") {
        var createRes = await h.createItem({
          operation_id: p.operation_id,
          name: p.name,
          location_text: p.location_text,
          note: p.note
        }, deps);
        if (createRes === null || createRes === undefined || createRes.ok !== true) {
          failedKeys.push(p.draft_key);
          resolved.push({ p: p, item: null, created: false, duplicated: false, createError: createRes && createRes.error ? createRes.error : "INTERNAL", createMessage: createRes && createRes.message ? createRes.message : "创建物品失败" });
          continue;
        }
        resolved.push({ p: p, item: { _id: createRes.item.item_id, location_text: p.location_text }, created: createRes.duplicated !== true, duplicated: createRes.duplicated === true, createError: null });
      } else {
        var item = await itemAlive(deps, p.item_id);
        if (item === null) {
          failedKeys.push(p.draft_key);
          resolved.push({ p: p, item: null, created: false, duplicated: false, createError: "NOT_FOUND", createMessage: h.ERROR_MESSAGES.NOT_FOUND });
        } else {
          resolved.push({ p: p, item: item, created: false, duplicated: false, createError: null });
        }
      }
    }

    var itemIds = [];
    var seenItems = Object.create(null);
    for (var ri = 0; ri < resolved.length; ri++) {
      if (resolved[ri].item === null || resolved[ri].item === undefined) continue;
      if (seenItems[resolved[ri].item._id] !== true) {
        seenItems[resolved[ri].item._id] = true;
        itemIds.push(resolved[ri].item._id);
      }
    }
    itemIds.sort();
    var heldItems = [];
    var assetLock = null;
    try {
      for (var li = 0; li < itemIds.length; li++) {
        var ilock = await acquireItemLock(deps, itemIds[li], "scene_commit");
        if (ilock.ok !== true) return fail(ilock.error || "VIDEO_ITEM_BUSY");
        heldItems.push({ itemId: itemIds[li], token: ilock.token });
      }
      assetLock = await acquireAssetLock(deps, ticket.asset_id, "scene_commit");
      if (assetLock.ok !== true) return fail(assetLock.error || "VIDEO_ITEM_BUSY");

      var results = [];
      for (var rj = 0; rj < resolved.length; rj++) {
        var rr = resolved[rj];
        var itemId = rr.item ? rr.item._id : "";
        if (rr.item === null || rr.item === undefined) {
          results.push({ draft_key: rr.p.draft_key, ok: false, error: rr.createError || "INTERNAL", message: rr.createMessage || "物品未创建" });
          continue;
        }
        var alive = await itemAlive(deps, itemId);
        if (alive === null) {
          results.push({ draft_key: rr.p.draft_key, ok: false, item_id: itemId, error: "NOT_FOUND", message: h.ERROR_MESSAGES.NOT_FOUND });
          if (failedKeys.indexOf(rr.p.draft_key) === -1) failedKeys.push(rr.p.draft_key);
          continue;
        }
        // D1 显式移动(target:"existing" + move_to_node_id):移动先于证据——若先存
        // 证据再移动失败,结果是用户未同意的「只关联」,违背显式确认原则;冲突时
        // 该件不写 evidence(绝不静默降级为「只关联」),其余件照常。
        var pendingMove = null;
        if (locationCtx !== null && rr.p.target === "existing" && rr.p.move_to_node_id !== undefined) {
          var moveRes = await applyScanMove(
            deps,
            itemId,
            rr.p.expected_version,
            rr.p.move_to_node_id,
            locationInfo.subtree[rr.p.move_to_node_id].path.join(LOCATION_PATH_SEPARATOR),
            locationCtx.scan_id
          );
          if (moveRes.ok !== true) {
            results.push({
              draft_key: rr.p.draft_key,
              ok: false,
              item_id: itemId,
              error: moveRes.error === "NOT_FOUND" ? "NOT_FOUND" : "VERSION_CONFLICT",
              message: moveRes.error === "NOT_FOUND" ? h.ERROR_MESSAGES.NOT_FOUND : h.ERROR_MESSAGES.VERSION_CONFLICT,
              moved: false
            });
            if (failedKeys.indexOf(rr.p.draft_key) === -1) failedKeys.push(rr.p.draft_key);
            continue;
          }
          pendingMove = moveRes.move;
          // 新证据行的 captured_location_text 取移动后物品的 location_text(新位置);
          // 旧证据行的 captured_location_text 创建时已冻结,天然不动。
          if (moveRes.item !== undefined && moveRes.item !== null) {
            alive = moveRes.item;
          } else {
            alive = await itemAlive(deps, itemId);
          }
        }
        var saveRes = await saveSceneEvidence(
          deps,
          ticket,
          alive,
          rr.p.highlights,
          deps.now(),
          locationCtx !== null ? locationCtx.scan_id : ""
        );
        if (saveRes.ok !== true) {
          results.push({ draft_key: rr.p.draft_key, ok: false, item_id: itemId, error: saveRes.error, message: saveRes.message || "视频证据写入失败" });
          if (failedKeys.indexOf(rr.p.draft_key) === -1) failedKeys.push(rr.p.draft_key);
          continue;
        }
        var resultRow = {
          draft_key: rr.p.draft_key,
          ok: true,
          item_id: itemId,
          created: rr.created,
          duplicated: rr.duplicated,
          evidence_saved: true,
          evidence_duplicated: saveRes.duplicated === true
        };
        // D1 响应增量:existing 显式移动 → move:moved|already|replayed;new → node_id +
        // mounted(挂载失败不推翻建档与证据,mount_error 如实上报,绝不删物品)。
        if (pendingMove !== null) resultRow.move = pendingMove;
        if (locationCtx !== null && rr.p.target === "new") {
          var mountTarget = locationInfo.targets[rr.p.draft_key];
          resultRow.node_id = mountTarget.node_id;
          var mountRes = await applyScanMount(deps, itemId, mountTarget.node_id, locationCtx.scan_id);
          resultRow.mounted = mountRes.mounted === true;
          if (mountRes.mounted !== true) {
            resultRow.mount_error = mountRes.mount_error || "VERSION_CONFLICT";
          }
        }
        results.push(resultRow);
      }

      var refs = await evidenceRowsForFile(deps, ticket.file_id, ticket.asset_id);
      // D1 location_scans 落库(锁内、逐件循环之后):confirmed_item_ids 不取自载荷,
      // 而是重新查询活证据行中 scan_id 相等、且 item_id ∈ 本次提交 item 集合的行——
      // 部分失败重试后第二次 commit 会把补齐的证据计入,confirmed_count 自然收敛。
      var scanInfo = null;
      if (locationCtx !== null) {
        var commitItemIds = Object.create(null);
        for (var ci = 0; ci < resolved.length; ci++) {
          if (resolved[ci].item) commitItemIds[resolved[ci].item._id] = true;
        }
        var confirmedIds = [];
        var seenConfirmed = Object.create(null);
        for (var sr = 0; sr < refs.length; sr++) {
          if (
            refs[sr].scan_id === locationCtx.scan_id &&
            commitItemIds[refs[sr].item_id] === true &&
            seenConfirmed[refs[sr].item_id] !== true
          ) {
            seenConfirmed[refs[sr].item_id] = true;
            confirmedIds.push(refs[sr].item_id);
          }
        }
        confirmedIds.sort();
        var scanRes = await upsertLocationScan(
          deps,
          ticket,
          locationCtx,
          locationInfo.node,
          candidateCount,
          confirmedIds
        );
        if (scanRes.ok !== true) return fail(scanRes.error || "OPERATION_CONFLICT");
        scanInfo = scanRes;
      }
      if (refs.length > 0) {
        await ticketCol(deps).where({ _id: ticket._id, household_id: deps.householdId }).update({ data: {
          status: "bound",
          bound_at: ticket.bound_at || deps.now(),
          scene_evidence_count: refs.length,
          scene_partial_at: failedKeys.length > 0 ? deps.now() : ""
        } });
      } else {
        await ticketCol(deps).where({ _id: ticket._id, household_id: deps.householdId }).update({ data: {
          scene_partial_at: deps.now()
        } });
      }
      var commitResponse = {
        ok: true,
        scene_id: event.scene_id,
        asset_id: ticket.asset_id,
        ticket_state: refs.length > 0 ? "bound" : "partial",
        results: results,
        evidence_failed: failedKeys
      };
      if (locationCtx !== null) {
        commitResponse.scan = {
          scan_id: locationCtx.scan_id,
          location_id: locationCtx.location_id,
          status: "active",
          confirmed_count: scanInfo.scan.confirmed_count,
          evidence_failed: failedKeys
        };
      }
      return commitResponse;
    } finally {
      if (assetLock !== null && assetLock.ok === true) {
        await releaseAssetLock(deps, ticket.asset_id, assetLock.token);
      }
      for (var hh = heldItems.length - 1; hh >= 0; hh--) {
        await releaseItemLock(deps, heldItems[hh].itemId, heldItems[hh].token);
      }
    }
  }

  async function videoEvidenceGet(event, deps) {
    var ids = event.item_ids;
    if (Array.isArray(ids) === false || ids.length < 1 || ids.length > 10) return fail("INVALID_INPUT");
    for (var i = 0; i < ids.length; i++) if (h.validItemId(ids[i]) === false) return fail("INVALID_INPUT");
    var evidence = [];
    var fileIds = [];
    var seen = Object.create(null);
    for (var j = 0; j < ids.length; j++) {
      var alive = await h.collection(deps).where({ _id: ids[j], household_id: deps.householdId, deleted: false }).get();
      if (alive.data === undefined || alive.data.length === 0) continue;
      var got = await evidenceCol(deps).where({ household_id: deps.householdId, item_id: ids[j] }).get();
      var rows = (got && got.data) || [];
      rows.sort(h.byCreatedDesc);
      var top = rows.slice(0, PER_ITEM);
      for (var k = 0; k < top.length; k++) {
        var row = top[k];
        evidence.push(projectEvidence(row, ""));
        if (isString(row.file_id) && seen[row.file_id] !== true) {
          seen[row.file_id] = true;
          fileIds.push(row.file_id);
        }
      }
    }
    if (fileIds.length > 0 && typeof deps.getTempFileUrls === "function") {
      try {
        var map = h.mapTempUrls(await deps.getTempFileUrls(fileIds));
        for (var m = 0; m < evidence.length; m++) {
          if (Object.prototype.hasOwnProperty.call(map, evidence[m].file_id)) evidence[m].video_url = map[evidence[m].file_id];
        }
      } catch (e) {}
    }
    var res = { ok: true, household_id: deps.householdId, evidence: evidence };
    if (deps.householdShared === true) res.scope_revision = deps.scopeRevision;
    return res;
  }

  /**
   * 用户确认高亮保存:
   * - 输入门先于任何写入;item 必须在当前家庭且未删除,evidence 必须同归属;
   * - 与 attach/删除物品/删除证据共用 item 锁;锁内重读 item+evidence 并做版本 CAS;
   * - 同 highlight_update_id 且规范化内容一致 → 幂等返回当前值(不递增版本),
   *   同 update_id 异内容 → OPERATION_CONFLICT;版本不符 → VERSION_CONFLICT;
   * - source 固定 user_confirmed;只写用户确认的时间窗/框/观察帧,不落 AI 原文。
   */
  async function videoEvidenceHighlightSave(event, deps) {
    if (h.validItemId(event.item_id) === false) return fail("INVALID_INPUT");
    if (
      isString(event.evidence_id) === false ||
      event.evidence_id.length < 1 ||
      event.evidence_id.length > 128
    ) {
      return fail("INVALID_INPUT");
    }
    if (
      Number.isInteger(event.expected_highlight_version) === false ||
      event.expected_highlight_version < 0
    ) {
      return fail("INVALID_INPUT");
    }
    if (
      isString(event.highlight_update_id) === false ||
      event.highlight_update_id.length < HIGHLIGHT_UPDATE_ID_MIN ||
      event.highlight_update_id.length > HIGHLIGHT_UPDATE_ID_MAX
    ) {
      return fail("INVALID_INPUT");
    }
    var parsedHighlights = parseHighlightInput(event.highlights);
    if (parsedHighlights === "INVALID") return fail("INVALID_INPUT");

    // 先做轻量归属/存活检查,避免为不存在/他家的 item 创建锁文档。
    var item = await itemAlive(deps, event.item_id);
    if (item === null) return fail("NOT_FOUND");

    var itemLock = await acquireItemLock(deps, event.item_id, "highlight_save");
    if (itemLock.ok !== true) return fail(itemLock.error || "VIDEO_ITEM_BUSY");
    try {
      // 锁内重查 item+evidence:删除/attach 都持同一把锁,领取锁期间的变更必须重判。
      item = await itemAlive(deps, event.item_id);
      if (item === null) return fail("NOT_FOUND");

      var got = await evidenceCol(deps).where({
        _id: event.evidence_id,
        household_id: deps.householdId,
        item_id: event.item_id
      }).get();
      var row = got && got.data && got.data.length > 0 ? got.data[0] : null;
      if (row === null) return fail("NOT_FOUND");
      if (highlightsWithinDuration(parsedHighlights, row.duration_ms) === false) {
        return fail("INVALID_INPUT");
      }

      var currentVersion = Number.isInteger(row.highlight_version) && row.highlight_version >= 0
        ? row.highlight_version
        : 0;

      // 幂等重放先于版本 CAS:响应丢失后的同 update_id 重试仍应成功。
      if (row.highlight_update_id === event.highlight_update_id) {
        var stored = sanitizeStoredHighlights(row.highlights, row.duration_ms);
        if (stored !== null &&
            highlightsContentKey(stored) === highlightsContentKey(parsedHighlights)) {
          return {
            ok: true,
            evidence_id: row._id,
            highlights: stored,
            highlight_version: currentVersion,
            duplicated: true
          };
        }
        return fail("OPERATION_CONFLICT");
      }

      if (event.expected_highlight_version !== currentVersion) return fail("VERSION_CONFLICT");

      // 版本 CAS:新行带 highlight_version 条件;旧行没有该字段时由 item 锁 +
      // _id/household/item 条件更新保证线性化,_id 不存在则 stats.updated=0,
      // 绝不把已删除证据行“复活”。
      var casCond = {
        _id: row._id,
        household_id: deps.householdId,
        item_id: event.item_id
      };
      if (row.highlight_version !== undefined) {
        casCond.highlight_version = currentVersion;
      }
      var now = deps.now();
      var updated = await evidenceCol(deps).where(casCond).update({
        data: {
          highlights: parsedHighlights,
          highlight_version: currentVersion + 1,
          highlight_updated_at: now,
          highlight_update_id: event.highlight_update_id
        }
      });
      if (((updated && updated.stats && updated.stats.updated) || 0) !== 1) {
        var latestGot = await evidenceCol(deps).where({
          _id: event.evidence_id,
          household_id: deps.householdId,
          item_id: event.item_id
        }).get();
        if (latestGot && latestGot.data && latestGot.data.length > 0) return fail("VERSION_CONFLICT");
        return fail("NOT_FOUND");
      }
      return {
        ok: true,
        evidence_id: row._id,
        highlights: parsedHighlights,
        highlight_version: currentVersion + 1,
        duplicated: false
      };
    } finally {
      await releaseItemLock(deps, event.item_id, itemLock.token);
    }
  }

  /**
   * 删除证据同样持 item 锁:删除读文件列表、逐文件删云文件、删行期间,
   * highlight save 无法插队;失败也 finally 释放,行不会被交错“复活”。
   * cleanupForItem 只由 deleteItem 在已持锁时调用,此处不重复抢锁。
   */
  async function videoEvidenceDelete(event, deps) {
    if (h.validItemId(event.item_id) === false) return fail("INVALID_INPUT");
    if (event.evidence_id !== undefined && event.evidence_id !== null && isString(event.evidence_id) === false) return fail("INVALID_INPUT");
    var itemLock = await acquireItemLock(deps, event.item_id, "evidence_delete");
    if (itemLock.ok !== true) return fail(itemLock.error || "VIDEO_ITEM_BUSY");
    try {
      var res = await removeEvidenceRows(deps, event.item_id, event.evidence_id || "");
      if (res.ok === false) {
        var code = res.error === "VIDEO_ITEM_BUSY" ? "VIDEO_ITEM_BUSY" : "VIDEO_DELETE_FAILED";
        var failed = fail(code);
        failed.deleted = res.deleted;
        failed.failed_file_ids = res.failed_file_ids;
        return failed;
      }
      return { ok: true, deleted: res.deleted };
    } finally {
      await releaseItemLock(deps, event.item_id, itemLock.token);
    }
  }

  return {
    videoUploadBegin: videoUploadBegin,
    videoUploadReceipt: videoUploadReceipt,
    videoEvidenceAttach: videoEvidenceAttach,
    videoUploadCancel: videoUploadCancel,
    videoEvidenceGet: videoEvidenceGet,
    videoEvidenceHighlightSave: videoEvidenceHighlightSave,
    videoEvidenceDelete: videoEvidenceDelete,
    videoSceneCommit: videoSceneCommit,
    cleanupForItem: cleanupForItem,
    acquireItemLock: acquireItemLock,
    acquireAssetLock: acquireAssetLock,
    releaseItemLock: releaseItemLock,
    releaseAssetLock: releaseAssetLock
  };
}

module.exports = { createVideoActions: createVideoActions, CONSENT_VERSION: CONSENT_VERSION };
