"use strict";
// 视频证据(video_evidence):视频建档、回放与高亮。
// 客户端抽帧识别,用户确认后上传原视频;本模块只做证据行,不做视频解码。
var C = {
  fileMax: 512,
  dimMax: 10000,
  durationMaxMs: 10 * 60 * 1000,
  highlightsMax: 12,
  perItem: 3,
  sources: ["vl", "manual", "circle"],
  pathPrefix: "video-evidence/"
};

function createVideoActions(h) {
  var isString = h.isString;
  var fail = h.fail;
  var parseBox = h.parseBoxInput;

  function own(deps, fileId) {
    var path = null;
    if (isString(fileId) && fileId.indexOf("cloud://") === 0) {
      var rest = fileId.slice("cloud://".length);
      var slash = rest.indexOf("/");
      if (slash != -1) {
        var cand = rest.slice(slash + 1);
        if (cand.length > 0 && cand.indexOf("..") === -1) path = cand;
      }
    }
    if (path === null) return "INVALID";
    if (path.indexOf(C.pathPrefix + deps.householdId + "/") != 0) return "FILE_NOT_OWNED";
    return null;
  }

  function parseVideo(v) {
    if (v === null || typeof v != "object" || Array.isArray(v)) return "INVALID";
    if (isString(v.file_id) === false || v.file_id.length < 1 || v.file_id.length > C.fileMax) return "INVALID";
    if (Number.isInteger(v.duration_ms) === false || v.duration_ms < 1 || v.duration_ms > C.durationMaxMs) return "INVALID";
    if (Number.isInteger(v.video_w) === false || v.video_w < 1 || v.video_w > C.dimMax) return "INVALID";
    if (Number.isInteger(v.video_h) === false || v.video_h < 1 || v.video_h > C.dimMax) return "INVALID";
    return { file_id: v.file_id, duration_ms: v.duration_ms, video_w: v.video_w, video_h: v.video_h };
  }

  function parseHighlights(raw, durationMs) {
    if (raw === undefined || raw === null) return [];
    if (Array.isArray(raw) === false || raw.length > C.highlightsMax) return "INVALID";
    var out = [];
    for (var i = 0; i < raw.length; i++) {
      var x = raw[i];
      if (x === null || typeof x != "object" || Array.isArray(x)) return "INVALID";
      if (Number.isInteger(x.start_ms) === false || Number.isInteger(x.end_ms) === false) return "INVALID";
      if (x.start_ms < 0 || x.end_ms <= x.start_ms || x.end_ms > durationMs) return "INVALID";
      var box = parseBox(x.box);
      if (box === "INVALID") return "INVALID";
      var source = x.source === undefined || x.source === null ? "vl" : x.source;
      if (C.sources.indexOf(source) === -1) return "INVALID";
      out.push({ start_ms: x.start_ms, end_ms: x.end_ms, box: box, source: source });
    }
    return out;
  }

  function projectHighlights(raw, durationMs) {
    if (Array.isArray(raw) === false) return [];
    var out = [];
    for (var i = 0; i < raw.length && out.length < C.highlightsMax; i++) {
      var x = raw[i];
      if (x === null || typeof x != "object" || Array.isArray(x)) continue;
      if (Number.isInteger(x.start_ms) === false || Number.isInteger(x.end_ms) === false) continue;
      if (x.start_ms < 0 || x.end_ms <= x.start_ms || x.end_ms > durationMs) continue;
      var box = parseBox(x.box);
      if (box === "INVALID") box = null;
      out.push({ start_ms: x.start_ms, end_ms: x.end_ms, box: box, source: C.sources.indexOf(x.source) === -1 ? "vl" : x.source });
    }
    return out;
  }

  async function saveEvidence(deps, itemId, video, highlights, locationText) {
    var col = deps.db.collection("video_evidence");
    var pre = await col.where({ household_id: deps.householdId, item_id: itemId, file_id: video.file_id }).get();
    if (pre.data && pre.data.length > 0) return false;
    var doc = {
      _id: "ve_" + deps.genId(),
      household_id: deps.householdId,
      item_id: itemId,
      file_id: video.file_id,
      duration_ms: video.duration_ms,
      video_w: video.video_w,
      video_h: video.video_h,
      highlights: highlights,
      captured_location_text: locationText,
      source: highlights.length > 0 ? "vl" : "manual",
      created_at: deps.now()
    };
    try {
      await col.add({ data: doc });
      return true;
    } catch (e) {
      if (h.isDuplicateKeyError(e) === false) throw e;
      var twin = await col.where({ household_id: deps.householdId, item_id: itemId, file_id: video.file_id }).get();
      if (twin.data && twin.data.length > 0) return true;
      throw e;
    }
  }

  async function videoCommit(event, deps) {
    if (isString(event.batch_id) === false || event.batch_id.length < 8 || event.batch_id.length > 64) return fail("INVALID_INPUT");
    var video = parseVideo(event.video);
    if (video === "INVALID") return fail("INVALID_INPUT");
    var ownErr = own(deps, video.file_id);
    if (ownErr === "INVALID") return fail("INVALID_INPUT");
    if (ownErr === "FILE_NOT_OWNED") return fail("FILE_NOT_OWNED");
    if (Array.isArray(event.items) === false || event.items.length < 1 || event.items.length > 10) return fail("INVALID_INPUT");
    var prepared = [];
    for (var i = 0; i < event.items.length; i++) {
      var it = event.items[i];
      if (it === null || typeof it != "object" || Array.isArray(it)) return fail("INVALID_INPUT");
      if (isString(it.operation_id) === false || it.operation_id.length < 1 || it.operation_id.length > h.OPERATION_ID_MAX) return fail("INVALID_INPUT");
      var name = h.cleanRequired(it.name, h.NAME_MAX);
      if (name === null) return fail("INVALID_INPUT");
      var loc = h.cleanRequired(it.location_text, h.LOCATION_MAX);
      if (loc === null) return fail("INVALID_INPUT");
      var note = h.cleanOptional(it.note, h.NOTE_MAX);
      if (note === null) return fail("INVALID_INPUT");
      var reminder = h.parseReminderInput(it.reminder);
      if (reminder === "INVALID") return fail("INVALID_INPUT");
      var highlights = parseHighlights(it.highlights, video.duration_ms);
      if (highlights === "INVALID") return fail("INVALID_INPUT");
      prepared.push({ op: it.operation_id, name: name, loc: loc, note: note, reminder: reminder, highlights: highlights });
    }
    var results = [];
    var failed = [];
    for (var j = 0; j < prepared.length; j++) {
      var p = prepared[j];
      var created = await h.createItem({ operation_id: p.op, name: p.name, location_text: p.loc, note: p.note, reminder: p.reminder === null ? undefined : p.reminder }, deps);
      if (created === null || created === undefined || created.ok != true) {
        results.push({ index: j, ok: false, error: created && created.error ? created.error : "INTERNAL", message: created && created.message ? created.message : h.ERROR_MESSAGES.INVALID_INPUT });
        continue;
      }
      var row = { index: j, ok: true, item_id: created.item.item_id, duplicated: created.duplicated === true, evidence_saved: false, version: created.item.version };
      try {
        row.evidence_saved = await saveEvidence(deps, created.item.item_id, video, p.highlights, p.loc);
      } catch (e) {
        failed.push(created.item.item_id);
      }
      results.push(row);
    }
    var res = { ok: true, results: results };
    if (failed.length > 0) res.evidence_failed = failed;
    return res;
  }

  async function videoEvidenceRetry(event, deps) {
    var video = parseVideo(event.video);
    if (video === "INVALID") return fail("INVALID_INPUT");
    var ownErr = own(deps, video.file_id);
    if (ownErr === "INVALID") return fail("INVALID_INPUT");
    if (ownErr === "FILE_NOT_OWNED") return fail("FILE_NOT_OWNED");
    if (Array.isArray(event.items) === false || event.items.length < 1 || event.items.length > 10) return fail("INVALID_INPUT");
    var prepared = [];
    for (var i = 0; i < event.items.length; i++) {
      var it = event.items[i];
      if (it === null || typeof it != "object" || Array.isArray(it)) return fail("INVALID_INPUT");
      if (h.validItemId(it.item_id) === false) return fail("INVALID_INPUT");
      var highlights = parseHighlights(it.highlights, video.duration_ms);
      if (highlights === "INVALID") return fail("INVALID_INPUT");
      prepared.push({ itemId: it.item_id, highlights: highlights });
    }
    var results = [];
    for (var j = 0; j < prepared.length; j++) {
      var q = prepared[j];
      var got = await h.collection(deps).where({ _id: q.itemId, household_id: deps.householdId, deleted: false }).get();
      if (got.data && got.data.length > 0) {
        try {
          var saved = await saveEvidence(deps, q.itemId, video, q.highlights, isString(got.data[0].location_text) ? got.data[0].location_text : "");
          results.push({ index: j, item_id: q.itemId, ok: true, evidence_saved: saved });
        } catch (e) {
          results.push({ index: j, item_id: q.itemId, ok: false, error: "EVIDENCE_WRITE_FAILED", message: h.ERROR_MESSAGES.EVIDENCE_WRITE_FAILED });
        }
      } else {
        results.push({ index: j, item_id: q.itemId, ok: false, error: "NOT_FOUND", message: h.ERROR_MESSAGES.NOT_FOUND });
      }
    }
    return { ok: true, results: results };
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
      var got = await deps.db.collection("video_evidence").where({ household_id: deps.householdId, item_id: ids[j] }).get();
      var rows = (got && got.data) || [];
      rows.sort(h.byCreatedDesc);
      var top = rows.slice(0, C.perItem);
      for (var k = 0; k < top.length; k++) {
        var row = top[k];
        var dur = Number.isInteger(row.duration_ms) ? row.duration_ms : 0;
        evidence.push({
          item_id: row.item_id,
          file_id: row.file_id,
          video_url: "",
          duration_ms: dur,
          video_w: Number.isInteger(row.video_w) ? row.video_w : 0,
          video_h: Number.isInteger(row.video_h) ? row.video_h : 0,
          highlights: projectHighlights(row.highlights, dur),
          captured_location_text: isString(row.captured_location_text) ? row.captured_location_text : "",
          source: C.sources.indexOf(row.source) === -1 ? "manual" : row.source,
          created_at: row.created_at
        });
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

  return { videoCommit: videoCommit, videoEvidenceRetry: videoEvidenceRetry, videoEvidenceGet: videoEvidenceGet };
}

module.exports = { createVideoActions: createVideoActions };
