"use strict";
/**
 * 拍照识物客户端识别封装(#3):本地压缩 → base64 → extractDraft.vlRecognize 云函数。
 *
 * 隐私红线(#65 V0.4 合同第五项边界,主会话已拍板):照片在用户最终确认保存之前
 * **绝不上传云端**——识别走 callFunction 载荷直传本地压缩图的 base64(与语音链路
 * utils/voice.ts 的 readFile base64 → transcribe 同款先例),不落云存储、不留任何
 * 云端残留;上传只发生在用户确认后的保存流程(photo 页用 prepared.path 经
 * wx.cloud.uploadFile 得 file_id 再走 itemsApi.photoCommit)。
 *
 * 两段式 API:
 * - preparePhotoForVl(tempPath):压缩(长边 ≤1280、JPEG quality 70;失败则原样,
 *   如实)→ 取压缩后实际宽高(img_w/img_h 的唯一来源:识别与确认后上传的是同一张
 *   压缩图,坐标基准才一致)→ 读 base64。产物只存在内存,绝不写全局/存储。
 * - recognizeWithVl(prepared, {mode, region}):调云函数并做响应最小结构校验
 *   (形状非法整体判 bad_response,绝不半带异常件);圈选补识别(屏⑤)复用同一
 *   prepared(base64 不重复读盘),region 为用户圈选框 0-1。
 *
 * 降级(unavailable)路径:服务端 AI_UNAVAILABLE/manual_fallback、网络错、超时
 * → ok:false kind:"unavailable" manualFallback:true(页面 modal「拍照识别暂不可用,
 * 可手动添加」后仍进 photo 页,候选清单为空);INVALID_INPUT(照片太大等)→
 * kind:"invalid_photo"(提示重拍,留在入口)。
 *
 * 全部 wx API 依赖注入(partial 覆盖默认实现),离线测试零 wx。
 * 日志纪律:失败只记动作名与错误码,绝不 log base64/物品名。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.PHOTO_VL_CALL_TIMEOUT_MS = exports.PHOTO_VL_JPEG_QUALITY = exports.PHOTO_VL_LONG_EDGE_MAX = void 0;
exports.preparePhotoForVl = preparePhotoForVl;
exports.recognizeWithVl = recognizeWithVl;
exports.recognizePhotoFile = recognizePhotoFile;
/** 压缩目标:长边 ≤1280(IMPLEMENTATION §4.1/§7.4) */
exports.PHOTO_VL_LONG_EDGE_MAX = 1280;
/** 压缩质量:JPEG quality 70 */
exports.PHOTO_VL_JPEG_QUALITY = 70;
/** 客户端调用超时:70s 严格大于服务端 config 60s(§4.3/§10) */
exports.PHOTO_VL_CALL_TIMEOUT_MS = 70000;
const EXTRACT_DRAFT_FUNCTION = "extractDraft";
function fail(kind, message, manualFallback) {
    return { ok: false, kind, message, manualFallback };
}
// ---------- 默认依赖(wx 实现;测试注入覆盖) ----------
function isRecord(v) {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}
function wxAvailable() {
    return typeof wx !== "undefined" && wx !== null;
}
const defaultDeps = {
    getImageInfo: (src) => new Promise((resolve, reject) => {
        if (!wxAvailable() || typeof wx.getImageInfo !== "function") {
            reject(new Error("wx.getImageInfo unavailable"));
            return;
        }
        wx.getImageInfo({
            src,
            success: (res) => resolve({ width: res.width, height: res.height }),
            fail: (err) => reject(new Error((err && err.errMsg) || "getImageInfo:fail")),
        });
    }),
    compressImage: (src, quality, compressedWidth, compressedHeight) => new Promise((resolve, reject) => {
        if (!wxAvailable() || typeof wx.compressImage !== "function") {
            reject(new Error("wx.compressImage unavailable"));
            return;
        }
        wx.compressImage({
            src,
            quality,
            compressedWidth,
            compressedHeight,
            success: (res) => typeof res.tempFilePath === "string" && res.tempFilePath !== ""
                ? resolve(res.tempFilePath)
                : reject(new Error("compressImage: empty tempFilePath")),
            fail: (err) => reject(new Error((err && err.errMsg) || "compressImage:fail")),
        });
    }),
    readFileBase64: (filePath) => new Promise((resolve, reject) => {
        if (!wxAvailable() ||
            !wx.getFileSystemManager ||
            typeof wx.getFileSystemManager !== "function") {
            reject(new Error("wx.getFileSystemManager unavailable"));
            return;
        }
        wx.getFileSystemManager().readFile({
            filePath,
            encoding: "base64",
            success: (res) => typeof res.data === "string" && res.data !== ""
                ? resolve(res.data)
                : reject(new Error("readFile: empty data")),
            fail: (err) => reject(new Error((err && err.errMsg) || "readFile:fail")),
        });
    }),
    callVl: (event) => new Promise((resolve, reject) => {
        if (!wxAvailable() || !wx.cloud) {
            reject(new Error("cloud unavailable"));
            return;
        }
        let done = false;
        const timer = setTimeout(() => {
            if (done) {
                return;
            }
            done = true;
            reject(new Error("CLIENT_TIMEOUT"));
        }, exports.PHOTO_VL_CALL_TIMEOUT_MS);
        wx.cloud.callFunction({
            name: EXTRACT_DRAFT_FUNCTION,
            data: event,
            success: (res) => {
                if (done) {
                    return;
                }
                done = true;
                clearTimeout(timer);
                resolve(res.result);
            },
            fail: (err) => {
                if (done) {
                    return;
                }
                done = true;
                clearTimeout(timer);
                // 只记函数名与错误码,绝不 log 事件体(base64 在里面)
                console.error("[photo-vl] 云函数调用失败:", EXTRACT_DRAFT_FUNCTION, err && err.errMsg);
                reject(new Error("CLIENT_NETWORK"));
            },
        });
    }),
};
function resolveDeps(partial) {
    return partial === undefined ? defaultDeps : Object.assign({}, defaultDeps, partial);
}
// ---------- 第一步:压缩 + 宽高 + base64 ----------
/**
 * 备好识别输入(全部本地,零上送):
 * 1. wx.getImageInfo 取原尺寸(拿不到 → image_info_failed,没有宽高就没有坐标契约);
 * 2. 目标长边 ≤1280、quality 70 压缩(失败 → 原文件原样,如实,服务端 10MB 门兜底);
 * 3. 对**压缩后的那张**再取实际宽高(img_w/img_h 唯一来源——识别与确认后上传同图,
 *    坐标基准一致;压缩器未必精确命中目标尺寸,以实测为准);
 * 4. readFile 读裸 base64(直传云函数,不落云存储)。
 */
async function preparePhotoForVl(tempPath, deps) {
    const d = resolveDeps(deps);
    let original;
    try {
        original = await d.getImageInfo(tempPath);
    }
    catch (e) {
        return fail("image_info_failed", "照片读取失败,请重拍", false);
    }
    if (!isFinite(original.width) || !isFinite(original.height) || !(original.width > 0) || !(original.height > 0)) {
        return fail("image_info_failed", "照片读取失败,请重拍", false);
    }
    let path = tempPath;
    let compressed = false;
    const scale = Math.min(1, exports.PHOTO_VL_LONG_EDGE_MAX / Math.max(original.width, original.height));
    try {
        path = await d.compressImage(tempPath, exports.PHOTO_VL_JPEG_QUALITY, Math.max(1, Math.round(original.width * scale)), Math.max(1, Math.round(original.height * scale)));
        compressed = true;
    }
    catch (e) {
        path = tempPath; // 压缩失败:原样直传(如实);绝不编造压缩产物
    }
    let actual;
    try {
        actual = await d.getImageInfo(path);
    }
    catch (e) {
        return fail("image_info_failed", "照片读取失败,请重拍", false);
    }
    if (!Number.isInteger(actual.width) || !Number.isInteger(actual.height) || actual.width < 1 || actual.height < 1) {
        return fail("image_info_failed", "照片读取失败,请重拍", false);
    }
    let base64;
    try {
        base64 = await d.readFileBase64(path);
    }
    catch (e) {
        return fail("read_failed", "照片读取失败,请重拍", false);
    }
    return { ok: true, path, imgW: actual.width, imgH: actual.height, base64, compressed };
}
// ---------- 第二步:调云函数 ----------
const CONFIDENCE_KINDS = ["high", "mid", "low"];
/** box 形状门(服务端已保证 0-1 且 x2>x1/y2>y1;客户端防御,违反即契约回归) */
function validBox(v) {
    if (v === null || v === undefined) {
        return null;
    }
    if (!isRecord(v)) {
        return null;
    }
    const keys = ["x1", "y1", "x2", "y2"];
    const out = { x1: 0, y1: 0, x2: 0, y2: 0 };
    for (const k of keys) {
        const n = v[k];
        if (typeof n !== "number" || !isFinite(n) || n < 0 || n > 1) {
            return null;
        }
        out[k] = n;
    }
    if (!(out.x2 > out.x1) || !(out.y2 > out.y1)) {
        return null;
    }
    return out;
}
/** 圈选区域校验(与服务端 validVlRegion 同口径:有限数 ∈[0,1] 且面积 >0) */
function validRegion(v) {
    return validBox(v);
}
/**
 * 调 vlRecognize 并校验响应:
 * - ok:false → INVALID_INPUT 映射 invalid_photo(照片太大,请重拍);AI_UNAVAILABLE
 *   映射 unavailable(manual_fallback 透传语义);其他错误码按 bad_response;
 * - ok:true → items 逐件最小结构校验(name 非空串、confidence 词表外 low、qty_note
 *   容错为空串、box 形状门),任一件硬形状非法 → 整体 bad_response(绝不半带);
 *   超 10 件 = 契约回归 → bad_response;
 * - 网络错/超时 → unavailable(识别没成,与 AI_UNAVAILABLE 同 UX:可手动添加)。
 */
async function recognizeWithVl(prepared, opts, deps) {
    const d = resolveDeps(deps);
    const event = {
        action: "vlRecognize",
        image_base64: prepared.base64,
        img_w: prepared.imgW,
        img_h: prepared.imgH,
    };
    if (opts !== undefined && opts.mode === "region") {
        const region = validRegion(opts.region);
        if (region === null) {
            return fail("invalid_region", "圈选区域无效,请重新圈选", false);
        }
        event.mode = "region";
        event.region = region;
    }
    let res;
    try {
        res = await d.callVl(event);
    }
    catch (e) {
        // 网络错/客户端超时:识别没成,与 AI_UNAVAILABLE 同一降级 UX(可手动添加)
        return fail("unavailable", "拍照识别暂不可用,可手动添加", true);
    }
    if (!isRecord(res)) {
        return fail("bad_response", "服务返回异常,请稍后重试", false);
    }
    if (res.ok === false) {
        const code = typeof res.error === "string" ? res.error : "";
        const message = typeof res.message === "string" && res.message.trim() !== "" ? res.message : "";
        if (code === "INVALID_INPUT") {
            // §7.4 固定文案:合法客户端触发 INVALID_INPUT 的唯一预期原因是 10MB 门(服务端
            // 文案「照片参数不合法」对用户无指引);留在入口重拍,不进 photo 页
            return fail("invalid_photo", "照片太大,请重拍", false);
        }
        if (code === "AI_UNAVAILABLE") {
            return fail("unavailable", message || "拍照识别暂不可用,可手动添加", true);
        }
        return fail("bad_response", message || "服务返回异常,请稍后重试", false);
    }
    if (res.ok !== true || !Array.isArray(res.items)) {
        return fail("bad_response", "服务返回异常,请稍后重试", false);
    }
    if (res.items.length > 10) {
        return fail("bad_response", "服务返回异常,请稍后重试", false);
    }
    const items = [];
    for (const raw of res.items) {
        if (!isRecord(raw) || typeof raw.name !== "string" || raw.name.trim() === "") {
            return fail("bad_response", "服务返回异常,请稍后重试", false);
        }
        const box = raw.box === null || raw.box === undefined ? null : validBox(raw.box);
        if (box === null && raw.box !== null && raw.box !== undefined) {
            return fail("bad_response", "服务返回异常,请稍后重试", false);
        }
        items.push({
            name: raw.name,
            qty_note: typeof raw.qty_note === "string" ? raw.qty_note : "",
            confidence: CONFIDENCE_KINDS.indexOf(raw.confidence) !== -1
                ? raw.confidence
                : "low",
            box,
        });
    }
    return { ok: true, items, imgW: prepared.imgW, imgH: prepared.imgH, truncated: res.truncated === true };
}
/**
 * 一步式:拍照后首次整图识别(prepare + recognize)。
 * 成功时带回 prepared——页面存内存供:屏⑤圈选复用同一 base64、确认保存时上传
 * 同一张压缩图(prepared.path)得 file_id 走 photoCommit(坐标基准全程一致)。
 */
async function recognizePhotoFile(tempPath, deps) {
    const prepared = await preparePhotoForVl(tempPath, deps);
    if (!prepared.ok) {
        return prepared;
    }
    const outcome = await recognizeWithVl(prepared, undefined, deps);
    if (!outcome.ok) {
        return outcome;
    }
    return { ok: true, prepared, items: outcome.items, truncated: outcome.truncated };
}
