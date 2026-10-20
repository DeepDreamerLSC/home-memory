"use strict";
// 视频证据(单件留证):上传票据、证据绑定、回放读取、删除清理。
// 核心边界:一个视频只绑定用户在详情页明确选择的一件物品;不做批量识物,
// 不按同名自动合并物理身份,不自动生成高亮框。
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
  function lockId(itemId) { return "vil_" + itemId; }

  /**
   * 物品级互斥锁:attach 与删除物品都必须先抢同一把锁。
   * - 单文档 CAS:owner_token + expires_at;
   * - 正常流程结束释放;进程中断后 60s 过期,可被下一次操作接管;
   * - 不引入通用事务,只封「删除物品」与「继续写证据」的并发窗口。
   */
  async function acquireItemLock(deps, itemId, purpose) {
    var id = lockId(itemId);
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
        try {
          await lockCol(deps).add({ data: {
            _id: id,
            item_id: itemId,
            household_id: deps.householdId,
            owner_token: token,
            purpose: purpose,
            created_at: now,
            expires_at: new Date(nowMs + LOCK_TTL_MS).toISOString()
          } });
          return { ok: true, token: token };
        } catch (e) {
          if (h.isDuplicateKeyError(e) === false) throw e;
          continue;
        }
      }
      var expires = Date.parse(existing.expires_at || "");
      if (Number.isNaN(expires) === false && expires > nowMs) return { ok: false, error: "VIDEO_ITEM_BUSY" };
      var claim = await lockCol(deps).where({ _id: id, owner_token: existing.owner_token }).update({ data: {
        owner_token: token,
        purpose: purpose,
        claimed_at: now,
        expires_at: new Date(nowMs + LOCK_TTL_MS).toISOString()
      } });
      if (((claim && claim.stats && claim.stats.updated) || 0) === 1) return { ok: true, token: token };
    }
    return { ok: false, error: "VIDEO_ITEM_BUSY" };
  }

  async function releaseItemLock(deps, itemId, token) {
    try {
      await lockCol(deps).where({ _id: lockId(itemId), owner_token: token }).remove();
    } catch (e) {}
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
    var fileIds = [];
    for (var i = 0; i < tickets.length; i++) {
      var t = tickets[i];
      if ((t.status === "pending" || t.status === "binding" || t.status === "cleaning" || t.status === "cancelling" || t.status === "bound") &&
          isString(t.file_id) && t.file_id !== "") {
        fileIds.push(t.file_id);
      }
    }
    var fileDel = await deleteFilesStrict(deps, fileIds);
    var deletedFiles = Object.create(null);
    for (var j = 0; j < fileDel.deleted.length; j++) deletedFiles[fileDel.deleted[j]] = true;
    var now = deps.now();
    var failedFileIds = [];
    for (var k = 0; k < tickets.length; k++) {
      var ticket = tickets[k];
      if (ticket.status === "cancelled" || ticket.status === "deleted") continue;
      var hasFile = isString(ticket.file_id) && ticket.file_id !== "";
      if (hasFile && deletedFiles[ticket.file_id] !== true) {
        failedFileIds.push(ticket.file_id);
        continue;
      }
      // 删除物品持有 item 锁,begin/attach 无法再进入;所有非终态票据统一收口。
      await ticketCol(deps).where({
        _id: ticket._id,
        household_id: deps.householdId,
        status: ticket.status
      }).update({ data: { status: "deleted", deleted_at: now, cleanup_reason: "item_deleted" } });
    }
    var ok = fileDel.ok && failedFileIds.length === 0;
    var result = { ok: ok, deleted: ev.deleted };
    if (ok === false) {
      result.error = "VIDEO_DELETE_FAILED";
      result.failed_file_ids = failedFileIds.concat(fileDel.failed);
    }
    return result;
  }

  async function videoUploadBegin(event, deps) {
    if (h.validItemId(event.item_id) === false) return fail("INVALID_INPUT");
    var ext = event.ext === undefined || event.ext === null ? "mp4" : event.ext;
    if (isString(ext) === false || EXTS.indexOf(ext) === -1) return fail("INVALID_INPUT");
    // B16:begin 也抢物品锁,防止「删除物品软删完成后又新建一张 pending 票据」。
    var itemLock = await acquireItemLock(deps, event.item_id, "begin");
    if (itemLock.ok !== true) return fail(itemLock.error || "VIDEO_ITEM_BUSY");
    try {
      var item = await itemAlive(deps, event.item_id);
      if (item === null) return fail("NOT_FOUND");
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
    } finally {
      await releaseItemLock(deps, event.item_id, itemLock.token);
    }
  }

  /**
   * 上传回执:客户端 uploadFile 成功后立即调用,把 file_id 落到服务端票据。
   * 这样即使客户端 pending 丢失或换设备,服务端仍知道该未绑定视频的 file_id,
   * 可在删除物品或定时清理时删除;不再只能依赖客户端本地记忆。
   */
  async function videoUploadReceipt(event, deps) {
    if (isString(event.upload_ticket) === false || event.upload_ticket.length < 8 || event.upload_ticket.length > 128) return fail("INVALID_INPUT");
    if (isString(event.file_id) === false || event.file_id.length < 1 || event.file_id.length > FILE_MAX) return fail("INVALID_INPUT");
    var initialGot = await ticketCol(deps).doc(event.upload_ticket).get();
    var initial = initialGot && initialGot.data;
    if (initial === null || initial === undefined) return fail("VIDEO_TICKET_EXPIRED");
    if (initial.household_id !== deps.householdId) return fail("FILE_NOT_OWNED");

    // B17:receipt 与删除物品共用 item 锁。删除持锁时 receipt 不能写入 file_id;
    // 反之 receipt 持锁完成 CAS 后,删除流程才会读取到最新 file_id 并清理。
    var itemLock = await acquireItemLock(deps, initial.item_id, "receipt");
    if (itemLock.ok === false) return fail(itemLock.error || "VIDEO_ITEM_BUSY");
    try {
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

      // 条件更新:持锁后再 CAS,若取消已抢走 pending,绝不把 file_id 写回。
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

    // B15:抢到 cancelling 后必须重读票据。CAS 之前可能有 receipt 刚写入 file_id,
    // 旧快照没有 file_id 会漏删真实视频;后续判断一律使用最新快照。
    var freshGot = await ticketCol(deps).doc(ticket._id).get();
    var fresh = freshGot && freshGot.data;
    if (fresh === null || fresh === undefined) return { ok: true, state: "cancelled" };
    // 再核对一次证据,封住「查询 pending 与删除文件」之间的竞态。
    var afterClaim = await findEvidenceForTicket(deps, fresh);
    if (afterClaim !== null) {
      await repairTicketBound(deps, fresh, afterClaim._id);
      return { ok: true, state: "bound", evidence: projectEvidence(afterClaim, await verifyFile(deps, afterClaim.file_id)) };
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
        var failed = fail("VIDEO_DELETE_FAILED");
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
    cleanupForItem: cleanupForItem,
    acquireItemLock: acquireItemLock,
    releaseItemLock: releaseItemLock
  };
}

module.exports = { createVideoActions: createVideoActions, CONSENT_VERSION: CONSENT_VERSION };
