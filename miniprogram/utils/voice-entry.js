"use strict";
/**
 * 语音录入入口共享模块(issue #45 十一轮决策 1:语音条全局可达):
 * 把首页原「语音录入控制器」整条链路抽出,供首页与 voice-bar 组件等多页共用。
 *
 * 为什么是全 App 单例:wx.getRecorderManager() 是全局单例,事件回调只有一份。
 * 若每个页面各建一个控制器,后建的会顶掉先建的回调;且 utils/voice 的控制器
 * 对「无有效会话的迟到启动」会主动 stop 录音——两个控制器并存时会互相杀死
 * 对方的录音。因此整个入口(含录音会话状态机)收敛为本模块单例,各页面/组件
 * 只 attach 一个宿主(渲染 + 回退),同一时刻只有一个按压方(presser)。
 *
 * 覆盖原 index 页的整条链路(语义逐条一致,行为零变化):
 * - 按压会话守卫(授权异步返回窗口:松手/离开/切换后授权才返回 → 不发起录音);
 * - 忙碌门禁(录音中/识别中/提取中不得再次按压);
 * - 录音 → 上传 → 转写 → 有效转写判定(噪音不进提取);
 * - 未完成批次三选门(继续核对上一批 / 放弃上一批 / 中止)+ 放弃二次确认;
 * - 提取(v2 多件 / needs_split 防御 / v1 单草稿兜底)→ 跳确认页。
 *
 * 宿主要务:触摸四事件转 pressStart/pressMove/pressEnd/pressCancel;
 * 页面 onHide/组件所在页 hide 调 invalidate;卸载时 detach;
 * 录音授权被拒选「用文字」经 fallbackToText 回退(首页=切文字模式,
 * 其余页=跳文字确认页)。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.attachVoiceEntry = attachVoiceEntry;
exports.__setVoiceEntryDepsForTest = __setVoiceEntryDepsForTest;
exports.__resetVoiceEntryForTest = __resetVoiceEntryForTest;
const api_1 = require("./api");
const voice_1 = require("./voice");
const draft_session_1 = require("./draft-session");
/** 默认跳确认页(与原 index goToConfirm 一致:失败如实 toast) */
function defaultGoConfirm(url) {
    wx.navigateTo({
        url,
        fail: () => {
            wx.showToast({ title: "页面打开失败,请重试", icon: "none" });
        },
    });
}
/* ---------------- 单例状态(全 App 一份) ---------------- */
let state = {
    voiceState: "idle",
    transcribing: false,
    extracting: false,
    recordSeconds: 0,
    partialText: "",
};
/** 语音控制器(惰性创建一次;全局 recorder 回调只注册这一份) */
let voiceCtrl = null;
/** 本次按住的起点 Y(上滑取消判定) */
let touchStartY = 0;
/** 录音秒数计时器句柄 */
let recordTimer = 0;
/** 按压会话守卫(授权竞态与生命周期失效) */
let sessionGuard = (0, voice_1.createSessionGuard)();
/** 当前录音会话(begin 之后有效) */
let activeVoiceSession = null;
/** 发起本次按压的宿主(授权回退/转写文本只路由给它) */
let presser = null;
/** 在挂宿主集合(状态广播用) */
const hosts = new Set();
/** 语音控制器依赖工厂(默认生产依赖;测试可注入) */
let depsFactory = voice_1.createDefaultVoiceDeps;
/** 状态变更通知(等价于原页面逐次 setData;单宿主异常不殃及其他宿主) */
function patch(next) {
    state = { ...state, ...next };
    for (const host of hosts) {
        try {
            host.onStateChange(state);
        }
        catch (e) {
            // 宿主渲染异常不中断语音链路
        }
    }
}
function clearRecordTimer() {
    if (recordTimer) {
        clearInterval(recordTimer);
        recordTimer = 0;
    }
}
/** 惰性创建语音控制器(全局仅一份,首次按压时建立) */
function ensureVoiceCtrl() {
    if (voiceCtrl !== null) {
        return;
    }
    voiceCtrl = (0, voice_1.createVoiceController)({
        onStart: () => {
            clearRecordTimer();
            patch({ voiceState: "recording", partialText: "", recordSeconds: 0 });
            recordTimer = setInterval(() => {
                patch({ recordSeconds: state.recordSeconds + 1 });
            }, 1000);
        },
        onTranscribing: () => {
            clearRecordTimer();
            patch({ transcribing: true, partialText: "识别中…" });
        },
        onStop: (text) => {
            clearRecordTimer();
            activeVoiceSession = null; // 语音处理结束,释放会话引用
            patch({ voiceState: "idle", transcribing: false, partialText: text });
            // 空结果或纯语气词(环境噪音)不算有效输入:如实提示,不进提取,
            // 避免噪音文本被误报成"AI 不可用"
            if (!text || !(0, voice_1.isMeaningfulTranscript)(text)) {
                wx.showToast({ title: "没听清,请重试或改用文字", icon: "none", duration: 2500 });
                return;
            }
            // 转写完成 → 自动进入既有提取链路(录音→转写→AI提取→确认);
            // 文本回传发起按压的宿主(首页同步 memoText,切「改用文字」输入仍在)
            if (presser !== null && presser.onTranscript) {
                presser.onTranscript(text);
            }
            void actions.extract(text);
        },
        onError: (code, message) => {
            clearRecordTimer();
            activeVoiceSession = null; // 语音处理结束(失败),释放会话引用
            patch({ voiceState: "idle", transcribing: false });
            wx.showToast({ title: message, icon: "none", duration: 2500 });
        },
    }, depsFactory());
}
/**
 * 未完成批次的新建门禁(第四轮评审阻断项):存在未完成会话时直接新建会覆盖
 * 持久化恢复入口,旧批次已保存行的 operation_id 幂等键随之丢失——必须先由
 * 用户明确裁决:继续核对旧的 / 放弃旧的记新的 / 中止(什么都不动)。
 */
function askDraftEntryIntent(count) {
    return new Promise((resolve) => {
        wx.showActionSheet({
            itemList: ["继续核对上一批(共 " + count + " 件)", "放弃上一批,记新的"],
            success: (r) => {
                resolve(r.tapIndex === 0 ? "resume" : "discard");
            },
            fail: () => {
                resolve("abort"); // 点遮罩/取消:保留旧批次,本次不提取
            },
        });
    });
}
/**
 * 放弃旧批次的二次确认(五轮评审):明确「放弃」只是丢掉恢复入口,
 * 不是数据库撤销——已保存的物品不会回滚,结果未知的物品可能已入库。
 */
function confirmDiscardDraft() {
    return new Promise((resolve) => {
        wx.showModal({
            title: "放弃上一批?",
            content: "已保存的物品不会被撤销;结果未知的物品可能已入库,可稍后在「最近记住的」中查看。",
            confirmText: "放弃,记新的",
            cancelText: "返回",
            success: (r) => {
                resolve(r.confirm);
            },
            fail: () => {
                resolve(false);
            },
        });
    });
}
async function extractText(text) {
    const trimmed = text.trim();
    if (!trimmed) {
        wx.showToast({ title: "请先输入一句话", icon: "none" });
        return;
    }
    if (state.extracting) {
        return;
    }
    const unfinished = (0, draft_session_1.getUnfinishedDraftSession)();
    if (unfinished !== null) {
        const choice = await askDraftEntryIntent(unfinished.payload.drafts.length);
        if (choice === "resume") {
            defaultGoConfirm("/pages/confirm/confirm?sid=" + unfinished.sid);
            return;
        }
        if (choice === "abort") {
            return;
        }
        // 放弃:二次确认讲清语义(非数据库撤销),显式清除恢复入口后才开始本次提取
        if (!(await confirmDiscardDraft())) {
            return;
        }
        (0, draft_session_1.clearDraftSession)(unfinished.sid);
    }
    patch({ extracting: true });
    try {
        const res = await (0, api_1.callExtractDraft)(trimmed, { protocol: 2 });
        if ("drafts" in res) {
            // v2:一句话 1-5 件,统一走列表确认页(单件也是 1 行列表)
            const sid = (0, draft_session_1.createDraftSession)(res.original_text, res.drafts, res.truncated);
            defaultGoConfirm("/pages/confirm/confirm?sid=" + sid);
            return;
        }
        if ("needs_split" in res) {
            // 防御:服务端未升级窗口内仍可能返回旧形态
            wx.showToast({
                title: res.message || "一次只记一件物品,请分开说",
                icon: "none",
                duration: 2500,
            });
            return;
        }
        // v1 单草稿兜底:同样入会话走列表页
        const sid = (0, draft_session_1.createDraftSession)(trimmed, [{ ...res.draft, source_quote: trimmed }], false);
        defaultGoConfirm("/pages/confirm/confirm?sid=" + sid);
    }
    catch (e) {
        if (e instanceof api_1.ApiError && e.code === "AI_UNAVAILABLE") {
            // 契约流程:AI 不可用时征得确认后进入手动录入
            wx.showModal({
                title: "AI 暂时不可用",
                content: e.message,
                confirmText: "手动录入",
                cancelText: "取消",
                success: (r) => {
                    if (r.confirm) {
                        defaultGoConfirm("/pages/confirm/confirm?manual=true");
                    }
                },
            });
        }
        else {
            wx.showModal({
                title: "提取失败",
                content: (0, api_1.errorMessage)(e),
                showCancel: false,
            });
        }
    }
    finally {
        patch({ extracting: false });
    }
}
async function startRecording(session) {
    const auth = await (0, voice_1.ensureRecordAuth)();
    if (sessionGuard !== null && !sessionGuard.isCurrent(session)) {
        return; // 松手/切换模式/离开页面后授权才返回:本次按压已作废,不发起录音
    }
    if (auth === "denied") {
        wx.showModal({
            title: "需要录音权限",
            content: "语音记一件需要使用麦克风。可以到设置中开启,或改用文字输入。",
            confirmText: "去设置",
            cancelText: "用文字",
            success: (r) => {
                if (r.confirm) {
                    wx.openSetting({});
                }
                else if (presser !== null) {
                    presser.fallbackToText(actions);
                }
            },
        });
        return;
    }
    if (voiceCtrl === null) {
        // 授权通过后控制器缺失(不应发生):按被拒处理,交回按压宿主回退
        if (presser !== null) {
            presser.fallbackToText(actions);
        }
        return;
    }
    // 发起录音会话(建立会话后,启动/取消/转写回调全部按会话校验)
    activeVoiceSession = voiceCtrl.begin();
}
/** 单例动作集(宿主句柄直接复用同一份) */
const actions = {
    pressStart(clientY) {
        if ((0, voice_1.isVoiceEntryBusy)(state.voiceState, state.transcribing, state.extracting)) {
            return;
        }
        touchStartY = clientY;
        activeVoiceSession = null;
        ensureVoiceCtrl();
        // 页面级会话号只管「授权异步返回」窗口:松手/切换/离开后授权才返回则不发起录音
        const session = sessionGuard !== null ? sessionGuard.begin() : 0;
        void startRecording(session);
    },
    pressMove(clientY) {
        if (state.voiceState === "idle") {
            return;
        }
        // 上滑/滑回仅切换视觉状态;真正作废在松手时按状态决定 stop 或 cancel
        if ((0, voice_1.isSlideUpCancel)(touchStartY, clientY)) {
            if (state.voiceState !== "cancelPending") {
                patch({ voiceState: "cancelPending" });
            }
        }
        else if (state.voiceState === "cancelPending") {
            patch({ voiceState: "recording" });
        }
    },
    pressEnd() {
        // 作废授权窗口(松手早于授权返回时不得再发起录音)
        if (sessionGuard !== null) {
            sessionGuard.invalidate();
        }
        const session = activeVoiceSession;
        if (session === null) {
            return; // 录音会话尚未建立(授权未返回):无事可收尾
        }
        if (voiceCtrl === null) {
            return;
        }
        if (state.voiceState === "cancelPending") {
            voiceCtrl.cancel(session); // 上滑取消:永久作废,立即释放引用
            activeVoiceSession = null;
            patch({ voiceState: "idle", partialText: "" });
        }
        else {
            // 正常松手:停止并进入转写。保留会话引用——"手指松开"不等于
            // "语音处理结束":识别中阶段仍可经 invalidate 取消;
            // 引用在 onStop/onError 回调(处理完成)时释放。
            voiceCtrl.stop(session);
        }
    },
    pressCancel() {
        if (sessionGuard !== null) {
            sessionGuard.invalidate();
        }
        const session = activeVoiceSession;
        activeVoiceSession = null;
        if (session !== null && voiceCtrl !== null) {
            voiceCtrl.cancel(session);
        }
        patch({ voiceState: "idle", partialText: "" });
    },
    invalidate() {
        if (sessionGuard !== null) {
            sessionGuard.invalidate();
        }
        // 永久作废在途录音会话:迟到的启动回调与转写结果均按会话丢弃
        const session = activeVoiceSession;
        activeVoiceSession = null;
        if (session !== null && voiceCtrl !== null) {
            voiceCtrl.cancel(session);
        }
        clearRecordTimer();
        if (state.voiceState !== "idle" || state.transcribing) {
            patch({ voiceState: "idle", transcribing: false, partialText: "" });
        }
    },
    isBusy() {
        return (0, voice_1.isVoiceEntryBusy)(state.voiceState, state.transcribing, state.extracting);
    },
    getState() {
        return state;
    },
    extract: extractText,
};
/**
 * 挂载语音入口宿主(页面或组件):状态变化广播给宿主,回退/转写文本
 * 只路由给发起按压的宿主。返回句柄,卸载时 detach。
 */
function attachVoiceEntry(host) {
    hosts.add(host);
    const handle = {
        pressStart(clientY) {
            presser = host; // 记录按压方:授权回退与转写文本只回它
            actions.pressStart(clientY);
        },
        pressMove: actions.pressMove,
        pressEnd: actions.pressEnd,
        pressCancel: actions.pressCancel,
        invalidate: actions.invalidate,
        isBusy: actions.isBusy,
        getState: actions.getState,
        extract: actions.extract,
        detach() {
            hosts.delete(host);
            if (presser === host) {
                presser = null;
            }
        },
    };
    return handle;
}
/** 测试钩子:注入语音控制器依赖工厂(录音/转写桩),并复位单例 */
function __setVoiceEntryDepsForTest(factory) {
    depsFactory = factory;
    __resetVoiceEntryForTest();
}
/** 测试钩子:复位单例状态(清宿主/计时器/会话;不影响持久草稿会话) */
function __resetVoiceEntryForTest() {
    clearRecordTimer();
    voiceCtrl = null;
    sessionGuard = (0, voice_1.createSessionGuard)();
    activeVoiceSession = null;
    presser = null;
    hosts.clear();
    state = {
        voiceState: "idle",
        transcribing: false,
        extracting: false,
        recordSeconds: 0,
        partialText: "",
    };
}
