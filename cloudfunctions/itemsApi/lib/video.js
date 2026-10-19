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

  async function removeEvidenceRows(deps, itemId, evidenceId) {
    var cond = { household_id: deps.householdId, item_id: itemId };
    if (isString(evidenceId) && evidenceId !== "") cond._id = evidenceId;
    var got = await evidenceCol(deps).where(cond).get();
    var rows = (got && got.data) || [];
    if (rows.length === 0) return { ok: true, deleted: 0 };
    var fileIds = rows.map(function (r) { return r.file_id; }).filter(function (id) { return isString(id) && id !== ""; });
    if (fileIds.length > 0) {
      if (typeof deps.deleteCloudFiles !== "function") return { ok: false, error: "VIDEO_DELETE_FAILED" };
      try {
        await deps.deleteCloudFiles(fileIds);
      } catch (e) {
        return { ok: false, error: "VIDEO_DELETE_FAILED" };
      }
    }
    await evidenceCol(deps).where(cond).remove();
    var tickets = await ticketCol(deps).where({ household_id: deps.householdId, item_id: itemId }).get();
    for (var i = 0; i < ((tickets && tickets.data) || []).length; i++) {
      var t = tickets.data[i];
      if (t.status === "bound" && rows.some(function (r) { return r._id === t.evidence_id; })) {
        await ticketCol(deps).doc(t._id).update({ data: { status: "deleted" } });
      }
    }
    return { ok: true, deleted: rows.length };
  }

  async function cleanupForItem(deps, itemId) {
    return removeEvidenceRows(deps, itemId, "");
  }

  async function videoUploadBegin(event, deps) {
    if (h.validItemId(event.item_id) === false) return fail("INVALID_INPUT");
    var item = await itemAlive(deps, event.item_id);
    if (item === null) return fail("NOT_FOUND");
    var ext = event.ext === undefined || event.ext === null ? "mp4" : event.ext;
    if (isString(ext) === false || EXTS.indexOf(ext) === -1) return fail("INVALID_INPUT");
    var now = deps.now();
    var nowMs = Date.parse(now);
    var pending = await ticketCol(deps).where({ household_id: deps.householdId, item_id: event.item_id, status: "pending" }).get();
    var rows = (pending && pending.data) || [];
    for (var i = 0; i < rows.length; i++) {
      if (Date.parse(rows[i].expires_at) > nowMs && rows[i].ext === ext) {
        return { ok: true, upload_ticket: rows[i]._id, upload_path: rows[i].cloud_path, expires_at: rows[i].expires_at };
      }
    }
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

  async function videoEvidenceAttach(event, deps) {
    if (isString(event.upload_ticket) === false || event.upload_ticket.length < 8 || event.upload_ticket.length > 128) return fail("INVALID_INPUT");
    if (isString(event.file_id) === false || event.file_id.length < 1 || event.file_id.length > FILE_MAX) return fail("INVALID_INPUT");
    if (Number.isInteger(event.duration_ms) === false || event.duration_ms < 1 || event.duration_ms > DURATION_MAX_MS) return fail("INVALID_INPUT");
    if (Number.isInteger(event.video_w) === false || event.video_w < 1 || event.video_w > DIM_MAX) return fail("INVALID_INPUT");
    if (Number.isInteger(event.video_h) === false || event.video_h < 1 || event.video_h > DIM_MAX) return fail("INVALID_INPUT");
    if (event.consent_version !== CONSENT_VERSION) return fail("INVALID_INPUT");
    var gotTicket = await ticketCol(deps).doc(event.upload_ticket).get();
    var ticket = gotTicket && gotTicket.data;
    if (ticket === null || ticket === undefined) return fail("INVALID_INPUT");
    if (ticket.household_id !== deps.householdId) return fail("FILE_NOT_OWNED");
    if (ticket.status !== "pending" && ticket.status !== "bound") return fail("INVALID_INPUT");
    if (ticket.status === "pending" && Date.parse(ticket.expires_at) < Date.parse(deps.now())) return fail("INVALID_INPUT");
    var actualPath = filePath(event.file_id);
    if (actualPath === null || actualPath !== ticket.cloud_path) return fail("FILE_NOT_OWNED");
    var item = await itemAlive(deps, ticket.item_id);
    if (item === null) return fail("NOT_FOUND");
    var pre = await evidenceCol(deps).where({ household_id: deps.householdId, item_id: ticket.item_id, file_id: event.file_id }).get();
    if (pre.data && pre.data.length > 0) {
      return { ok: true, evidence: projectEvidence(pre.data[0], await verifyFile(deps, event.file_id)), duplicated: true };
    }
    var url = await verifyFile(deps, event.file_id);
    if (url === "") return fail("VIDEO_NOT_AVAILABLE");
    var now = deps.now();
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
      if (h.isDuplicateKeyError(e) === false) throw e;
      var twin = await evidenceCol(deps).where({ household_id: deps.householdId, item_id: ticket.item_id, file_id: event.file_id }).get();
      if (twin.data && twin.data.length > 0) {
        return { ok: true, evidence: projectEvidence(twin.data[0], url), duplicated: true };
      }
      throw e;
    }
    await ticketCol(deps).doc(ticket._id).update({ data: { status: "bound", bound_at: now, evidence_id: doc._id } });
    return { ok: true, evidence: projectEvidence(doc, url), duplicated: false };
  }

  async function videoUploadCancel(event, deps) {
    if (isString(event.upload_ticket) === false || event.upload_ticket.length < 8) return fail("INVALID_INPUT");
    var got = await ticketCol(deps).doc(event.upload_ticket).get();
    var ticket = got && got.data;
    if (ticket === null || ticket === undefined || ticket.household_id !== deps.householdId) return fail("NOT_FOUND");
    if (ticket.status === "pending") {
      await ticketCol(deps).doc(ticket._id).update({ data: { status: "cancelled", cancelled_at: deps.now() } });
    }
    return { ok: true };
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
    if (res.ok === false) return fail(res.error);
    return { ok: true, deleted: res.deleted };
  }

  return {
    videoUploadBegin: videoUploadBegin,
    videoEvidenceAttach: videoEvidenceAttach,
    videoUploadCancel: videoUploadCancel,
    videoEvidenceGet: videoEvidenceGet,
    videoEvidenceDelete: videoEvidenceDelete,
    cleanupForItem: cleanupForItem
  };
}

module.exports = { createVideoActions: createVideoActions, CONSENT_VERSION: CONSENT_VERSION };
