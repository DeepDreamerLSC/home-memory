export interface UserProfile { nickname: string; avatarFileId: string; version: number }
let remembered: UserProfile = { nickname: "", avatarFileId: "", version: 0 };
let pendingRead: Promise<UserProfile> | null = null;
let generation = 0;
export function cachedUserProfile(): UserProfile { return { ...remembered }; }
async function call(data: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (typeof wx === "undefined" || !wx.cloud || typeof wx.cloud.callFunction !== "function") throw new Error("个人资料暂时不可用");
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; reject(new Error("网络较慢，请稍后重试")); } }, 20000);
    wx.cloud.callFunction({ name: "userProfile", data, success: res => {
      if (done) return; done = true; clearTimeout(timer);
      const result = res.result as Record<string, unknown> | undefined;
      if (!result || result.ok !== true) { reject(new Error(typeof result?.message === "string" ? result.message : "个人资料暂时不可用")); return; }
      resolve(result);
    }, fail: () => { if (done) return; done = true; clearTimeout(timer); reject(new Error("个人资料暂时不可用，请检查网络后重试")); } });
  });
}
function parse(result: Record<string, unknown>): UserProfile {
  const p = result.profile as Record<string, unknown> | undefined;
  if (!p || typeof p.nickname !== "string" || typeof p.avatar_file_id !== "string" || !Number.isInteger(p.version) || (p.version as number) < 0) throw new Error("个人资料返回格式不正确");
  return { nickname: p.nickname, avatarFileId: p.avatar_file_id, version: p.version as number };
}
export function getUserProfile(): Promise<UserProfile> {
  if (pendingRead) return pendingRead;
  const seq = generation;
  const request = call({ action: "get" }).then(result => { const p = parse(result); if (seq === generation) remembered = p; return cachedUserProfile(); });
  pendingRead = request;
  void request.finally(() => { if (pendingRead === request) pendingRead = null; }).catch(() => {});
  return request;
}
async function compress(path: string): Promise<string> {
  return new Promise((resolve, reject) => wx.compressImage({ src: path, quality: 75, compressedWidth: 512, success: r => resolve(r.tempFilePath), fail: () => reject(new Error("头像处理失败，请重新选择")) }));
}
export async function saveUserProfile(input: { nickname: string; avatarPath?: string; version: number }): Promise<UserProfile> {
  const data: Record<string, unknown> = { action: "save", nickname: input.nickname, version: input.version };
  if (input.avatarPath) {
    const filePath = await compress(input.avatarPath);
    const ticket = await call({ action: "prepareAvatar" });
    if (typeof ticket.cloud_path !== "string" || typeof ticket.nonce !== "string") throw new Error("头像上传凭据不正确");
    const uploaded = await new Promise<{fileID:string}>((resolve, reject) => wx.cloud.uploadFile({ cloudPath: ticket.cloud_path as string, filePath, success: resolve, fail: () => reject(new Error("头像上传失败，请重试")) }));
    data.avatar_file_id = uploaded.fileID; data.nonce = ticket.nonce;
  }
  const profile = parse(await call(data));
  generation++; pendingRead = null; if (profile.version >= remembered.version) remembered = profile;
  return cachedUserProfile();
}
