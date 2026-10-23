"use strict";
const COLLECTION = "user_profiles";
const empty = () => ({ nickname: "", avatar_file_id: "", version: 0 });
const fail = (error, message) => ({ ok: false, error, message });
const project = p => ({ nickname: p.nickname || "", avatar_file_id: p.avatar_file_id || "", version: p.version || 0 });
async function read(deps) {
  const r = await deps.db.collection(COLLECTION).where({ _id: deps.memberKey }).get();
  return (r.data || [])[0] || null;
}
async function ensure(deps) {
  let p = await read(deps);
  if (p) return p;
  try { await deps.db.collection(COLLECTION).add({ data: { _id: deps.memberKey, ...empty() } }); }
  catch (e) { if (!/duplicate|E11000/i.test(String(e.message))) throw e; }
  p = await read(deps);
  if (!p) throw new Error("profile unavailable");
  return p;
}
async function handler(event, deps) {
  if (!deps || !/^[0-9a-f]{64}$/.test(deps.memberKey || "")) return fail("UNAUTHORIZED", "请重新打开小程序");
  try {
    if (event.action === "get") return { ok: true, profile: project(await read(deps) || empty()) };
    if (event.action === "prepareAvatar") {
      await ensure(deps);
      const nonce = deps.nonce();
      const path = `avatars/${deps.memberKey}/${nonce}.jpg`;
      const expires = deps.now() + 10 * 60 * 1000;
      await deps.db.collection(COLLECTION).where({ _id: deps.memberKey }).update({ data: { upload_nonce: nonce, upload_path: path, upload_expires_at: expires } });
      return { ok: true, nonce, cloud_path: path };
    }
    if (event.action !== "save") return fail("INVALID_INPUT", "不支持的资料操作");
    if (typeof event.nickname !== "string" || !Number.isInteger(event.version) || event.version < 0) return fail("INVALID_INPUT", "资料格式不正确");
    const nickname = event.nickname.trim();
    if (!nickname || Array.from(nickname).length > 20 || /[\u0000-\u001f\u007f]/.test(nickname)) return fail("INVALID_INPUT", "昵称需为1–20个字，不能包含控制字符");
    const p = await ensure(deps);
    if (p.version !== event.version) return fail("PROFILE_CONFLICT", "资料已在别处更新，请重新打开后再修改");
    const where = { _id: deps.memberKey, version: event.version };
    const patch = { nickname, version: event.version + 1, updated_at: new Date(deps.now()).toISOString() };
    if (event.avatar_file_id !== undefined) {
      const file = event.avatar_file_id;
      if (typeof file !== "string" || !p.upload_nonce || event.nonce !== p.upload_nonce || deps.now() >= p.upload_expires_at || !deps.ownsFile(file, p.upload_path)) return fail("INVALID_AVATAR", "头像上传凭据无效，请重新选择头像");
      if (!await deps.validImage(file)) return fail("INVALID_AVATAR", "头像上传失败或图片无效，请重试");
      where.upload_nonce = p.upload_nonce;
      patch.avatar_file_id = file;
      patch.upload_nonce = ""; patch.upload_path = ""; patch.upload_expires_at = 0;
    }
    const r = await deps.db.collection(COLLECTION).where(where).update({ data: patch });
    if (!r.stats || r.stats.updated !== 1) return fail("PROFILE_CONFLICT", "资料已更新，请重新打开后再修改");
    return { ok: true, profile: project({ ...p, ...patch }) };
  } catch (_) { return fail("PROFILE_UNAVAILABLE", "个人资料暂时无法保存，请稍后重试"); }
}
module.exports = { handler, COLLECTION };
