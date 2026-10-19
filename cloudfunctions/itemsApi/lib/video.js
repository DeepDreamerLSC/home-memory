"use strict";
// 视频证据(单件留证):上传票据、证据绑定、回放读取、删除清理。
// 核心边界:一个视频只绑定用户在详情页明确选择的一件物品;不做批量识物,
// 不按同名自动合并物理身份,不自动生成高亮框。
var EV = "video_evidence";
var TK = "video_upload_tickets";
var FILE_MAX = 512;
var DIM_MAX = 10000;
var DURATION_MAX_MS = 10 * 60 * 1000;
var PER_ITEM = 3;
var TICKET_TTL_MS = 15 * 60 * 1000;
var PATH_PREFIX = "video-evidence/";
var CONSENT_VERSION = "v1";
var EXTS = ["mp4", "mov", "m4v"];

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

  function projectEvidence(row, videoUrl) {
    return {
      evidence_id: row._id,
      item_id: row.item_id,
      file_id: row.file_id,
      video_url: videoUrl || "",
      duration_ms: row.duration_ms,
      video_w: row.video_w,
      video_h: row.video_h,
      captured_location_text: isString(row.captured_location_text) ? row.captured_location_text : "",
      consent_version: row.consent_version === CONSENT_VERSION ? CONSENT_VERSION : "",
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
   */
  async function findEvidenceForTicket(deps, ticket) {
    var got = await evidenceCol(deps).where({
      household_id: deps.householdId,
      item_id: ticket.item_id,
      file_id: ticket.file_id || ""
    }).get();
    return got && got.data && got.data.length > 0 ? got.data[0] : null;
  }

  async function repairTicketBound(deps, ticket, evidenceId) {
    try {
      await ticketCol(deps).where({ _id: ticket._id, household_id: deps.householdId }).update({
        data: { status: "bound", bound_at: ticket.bound_at || deps.now(), evidence_id: evidenceId || ticket.evidence_id || "" }
      });
      return true;
    } catch (e) {
      // 证据已存在时的修复失败不掩盖事实;清理任务会再次核对证据引用。
      return false;
    }
  }

  async function removeEvidenceRows(deps, itemId, evidenceId) {
    var cond = { household_id: deps.householdId, item_id: itemId };
    if (isString(evidenceId) && evidenceId !== "") cond._id = evidenceId;
    var got = await evidenceCol(deps).where(cond).get();
    var rows = (got && got.data) || [];
    if (rows.length === 0) return { ok: true, deleted: 0, failed_file_ids: [] };
    var fileIds = rows.map(function (r) { return r.file_id; }).filter(function (id) { return isString(id) && id !== ""; });
    var del = await deleteFilesStrict(deps, fileIds);
    var deletedSet = Object.create(null);
    for (var i = 0; i < del.deleted.length; i++) deletedSet[del.deleted[i]] = true;
    var deletedCount = 0;
    for (var j = 0; j < rows.length; j++) {
      var row = rows[j];
      var fileOk = row.file_id === undefined || row.file_id === null || row.file_id === "" || deletedSet[row.file_id] === true;
      if (fileOk) {
        await evidenceCol(deps).where({ _id: row._id, household_id: deps.householdId, item_id: itemId }).remove();
        deletedCount += 1;
      }
    }
    return { ok: del.ok, deleted: deletedCount, failed_file_ids: del.failed };
  }

  /**
   * 删除物品前清理:
   * - 已绑定证据:逐文件删除成功后删证据行;
   * - pending 票据:如果已收到过 upload receipt(记录 file_id),同样逐文件删除;
   * - 删除失败的票据/证据都保留,物品删除被阻断,可重试。
   * 只有数据库中可归属的 file_id 会被删除;未知 file_id 的极端窗口由
   * videoCleanup 定时任务和生命周期兜底处理。
   */
  async function cleanupForItem(deps, itemId) {
    var ev = await removeEvidenceRows(deps, itemId, "");
    if (ev.ok === false) {
      return { ok: false, error: "VIDEO_DELETE_FAILED", deleted: ev.deleted, failed_file_ids: ev.failed_file_ids };
    }
    var ticketsRes = await ticketCol(deps).where({ household_id: deps.householdId, item_id: itemId }).get();
    var tickets = (ticketsRes && ticketsRes.data) || [];
    var extraFileIds = [];
    for (var i = 0; i < tickets.length; i++) {
      if (tickets[i].status === "pending" && isString(tickets[i].file_id) && tickets[i].file_id !== "") {
        extraFileIds.push(tickets[i].file_id);
      }
    }
    var pendingDel = await deleteFilesStrict(deps, extraFileIds);
    var pendingDeleted = Object.create(null);
    for (var j = 0; j < pendingDel.deleted.length; j++) pendingDeleted[pendingDel.deleted[j]] = true;
    var now = deps.now();
    for (var k = 0; k < tickets.length; k++) {
      var t = tickets[k];
      if (t.status === "pending") {
        if (isString(t.file_id) && t.file_id !== "" && pendingDeleted[t.file_id] !== true) continue;
        await ticketCol(deps).doc(t._id).update({ data: { status: "cancelled", cancelled_at: now } });
      } else if (t.status === "bound") {
        await ticketCol(deps).doc(t._id).update({ data: { status: "deleted", deleted_at: now } });
      }
    }
    var result = { ok: pendingDel.ok, deleted: ev.deleted };
    if (pendingDel.ok === false) {
      result.error = "VIDEO_DELETE_FAILED";
      result.failed_file_ids = pendingDel.failed;
    }
    return result;
  }

  async function videoUploadBegin(event, deps) {
    if (h.validItemId(event.item_id) === false) return fail("INVALID_INPUT");
    var item = await itemAlive(deps, event.item_id);
    if (item === null) return fail("NOT_FOUND");
    var ext = event.ext === undefined || event.ext === null ? "mp4" : event.ext;
    if (isString(ext) === false || EXTS.indexOf(ext) === -1) return fail("INVALID_INPUT");
    var now = deps.now();
    var nowMs = Date.parse(now);
    // 每次申请新票据:不复用同物品旧 pending 票据,避免新旧上传互相覆盖/取消。
    var ticket = "vt_" + deps.genId();
    var path = PATH_PREFIX + deps.householdId + "/" + ticket + "." + ext;
    var doc = {
      _id: ticket,
      household_id: deps.householdId,
      item_id: event.item_id,
      cloud_path: path,
      ext: ext,
      status: "pending",
      created_at: now,
      expires_at: new Date(nowMs + TICKET_TTL_MS).toISOString()
    };
    await ticketCol(deps).add({ data: doc });
    return { ok: true, upload_ticket: ticket, upload_path: path, expires_at: doc.expires_at };
  }

  /**
   * 上传回执:客户端 uploadFile 成功后立即调用,把 file_id 落到服务端票据。
   * 这样即使客户端 pending 丢失或换设备,服务端仍知道该未绑定视频的 file_id,
   * 可在删除物品或定时清理时删除;不再只能依赖客户端本地记忆。
   */
  async function videoUploadReceipt(event, deps) {
    if (isString(event.upload_ticket) === false || event.upload_ticket.length < 8 || event.upload_ticket.length > 128) return fail("INVALID_INPUT");
    if (isString(event.file_id) === false || event.file_id.length < 1 || event.file_id.length > FILE_MAX) return fail("INVALID_INPUT");
    var gotTicket = await ticketCol(deps).doc(event.upload_ticket).get();
    var ticket = gotTicket && gotTicket.data;
    if (ticket === null || ticket === undefined) return fail("VIDEO_TICKET_EXPIRED");
    if (ticket.household_id !== deps.householdId) return fail("FILE_NOT_OWNED");
    if (ticket.status === "binding" || ticket.status === "cleaning" || ticket.status === "cancelling") return fail("VIDEO_TICKET_BUSY");
    if (ticket.status === "cancelled" || ticket.status === "deleted") return fail("VIDEO_TICKET_EXPIRED");
    if (ticket.status === "pending" && Date.parse(ticket.expires_at) < Date.parse(deps.now())) return fail("VIDEO_TICKET_EXPIRED");
    var actualPath = filePath(event.file_id);
    if (actualPath === null || actualPath !== ticket.cloud_path) return fail("FILE_NOT_OWNED");
    if (isString(ticket.file_id) && ticket.file_id !== "" && ticket.file_id !== event.file_id) return fail("FILE_NOT_OWNED");
    if (ticket.file_id !== event.file_id || ticket.receipt_at === undefined) {
      await ticketCol(deps).doc(ticket._id).update({ data: { file_id: event.file_id, receipt_at: deps.now() } });
    }
    return { ok: true };
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
      duration_ms: event.duration_ms,
      video_w: event.video_w,
      video_h: event.video_h,
      captured_location_text: isString(item.location_text) ? item.location_text : "",
      consent_version: CONSENT_VERSION,
      upload_ticket: ticket._id,
      source: "manual",
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
  }

  async function videoUploadCancel(event, deps) {
    if (isString(event.upload_ticket) === false || event.upload_ticket.length < 8) return fail("INVALID_INPUT");
    var got = await ticketCol(deps).doc(event.upload_ticket).get();
    var ticket = got && got.data;
    if (ticket === null || ticket === undefined || ticket.household_id !== deps.householdId) return fail("NOT_FOUND");

    // 已绑定(或证据已存在):取消不能删文件,修复票据并返回 bound。
    var pre = await findEvidenceForTicket(deps, ticket);
    if (pre !== null) {
      await repairTicketBound(deps, ticket, pre._id);
      return { ok: true, state: "bound", evidence: projectEvidence(pre, await verifyFile(deps, pre.file_id)) };
    }
    if (ticket.status === "bound") return fail("VIDEO_TICKET_BUSY");
    if (ticket.status === "cancelled" || ticket.status === "deleted") return { ok: true, state: "cancelled" };
    if (ticket.status !== "pending") return fail("VIDEO_TICKET_BUSY");

    // pending -> cancelling CAS:与 attach 的 pending -> binding 互斥。
    var claim = await ticketCol(deps).where({
      _id: ticket._id,
      household_id: deps.householdId,
      status: "pending"
    }).update({ data: { status: "cancelling", cancelling_at: deps.now() } });
    if (((claim && claim.stats && claim.stats.updated) || 0) === 0) {
      var latestGot = await ticketCol(deps).doc(ticket._id).get();
      var latest = latestGot && latestGot.data;
      if (latest !== null && latest !== undefined) {
        var latestEvidence = await findEvidenceForTicket(deps, latest);
        if (latestEvidence !== null) {
          await repairTicketBound(deps, latest, latestEvidence._id);
          return { ok: true, state: "bound", evidence: projectEvidence(latestEvidence, await verifyFile(deps, latestEvidence.file_id)) };
        }
        if (latest.status === "cancelled" || latest.status === "deleted") return { ok: true, state: "cancelled" };
      }
      return fail("VIDEO_TICKET_BUSY");
    }

    // 抢到独占状态后再核对一次证据,封住「查询 pending 与删除文件」之间的竞态。
    var afterClaim = await findEvidenceForTicket(deps, ticket);
    if (afterClaim !== null) {
      await repairTicketBound(deps, ticket, afterClaim._id);
      return { ok: true, state: "bound", evidence: projectEvidence(afterClaim, await verifyFile(deps, afterClaim.file_id)) };
    }

    if (isString(ticket.file_id) && ticket.file_id !== "") {
      var del = await deleteFilesStrict(deps, [ticket.file_id]);
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

  async function videoEvidenceDelete(event, deps) {
    if (h.validItemId(event.item_id) === false) return fail("INVALID_INPUT");
    if (event.evidence_id !== undefined && event.evidence_id !== null && isString(event.evidence_id) === false) return fail("INVALID_INPUT");
    var res = await removeEvidenceRows(deps, event.item_id, event.evidence_id || "");
    if (res.ok === false) {
      var failed = fail("VIDEO_DELETE_FAILED");
      failed.deleted = res.deleted;
      failed.failed_file_ids = res.failed_file_ids;
      return failed;
    }
    return { ok: true, deleted: res.deleted };
  }

  return {
    videoUploadBegin: videoUploadBegin,
    videoUploadReceipt: videoUploadReceipt,
    videoEvidenceAttach: videoEvidenceAttach,
    videoUploadCancel: videoUploadCancel,
    videoEvidenceGet: videoEvidenceGet,
    videoEvidenceDelete: videoEvidenceDelete,
    cleanupForItem: cleanupForItem
  };
}

module.exports = { createVideoActions: createVideoActions, CONSENT_VERSION: CONSENT_VERSION };
