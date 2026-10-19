"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const api_1 = require("../../utils/api");
const households_api_1 = require("../../utils/households-api");
const locations_api_1 = require("../../utils/locations-api");
const household_scope_1 = require("../../utils/household-scope");
const remind_ui_1 = require("../../utils/remind-ui");
const conflict_1 = require("../../utils/conflict");
const evidence_view_1 = require("../../utils/evidence-view");
const video_evidence_1 = require("../../utils/video-evidence");
const video_attach_1 = require("../../utils/video-attach");
const subscribe_1 = require("../../utils/subscribe");
const notify_accepted_1 = require("../../utils/notify-accepted");
/** 页面 query 参数不会自动解码;容错解码(已解码或含非法 % 时原样返回) */
function safeDecode(s) {
    try {
        return decodeURIComponent(s);
    }
    catch {
        return s;
    }
}
/** 记录更新日期短文案(如 10-08,与首页一致;updated_at 不代表位置确认时间);非法时间如实返回空串 */
function shortDate(iso) {
    const t = Date.parse(iso);
    if (Number.isNaN(t)) {
        return "";
    }
    const d = new Date(t);
    const pad = (n) => (n < 10 ? "0" + n : String(n));
    return pad(d.getMonth() + 1) + "-" + pad(d.getDate());
}
/**
 * 解析跳转方带来的空间路径(进入时的容器层 path,JSON 字符串数组)。
 * 只信严格结构:非数组 / 含非字符串 / 超 6 段一律视为没有,不猜。
 */
function parseSpacePath(raw) {
    if (!raw) {
        return [];
    }
    try {
        const p = JSON.parse(safeDecode(raw));
        if (!Array.isArray(p) || p.length === 0 || p.length > 6) {
            return [];
        }
        if (!p.every((seg) => typeof seg === "string" && seg.trim().length > 0)) {
            return [];
        }
        return p.map((seg) => seg.trim());
    }
    catch {
        return [];
    }
}
/** 冲突面板里某字段值的展示口径:提醒换算为「X 到期 / 不带提醒」,文本空值为「(空)」 */
function conflictDisplayText(key, value) {
    if (key === "remind") {
        return value ? (0, remind_ui_1.monthDayText)(value) + " 到期" : "不带提醒";
    }
    return value || "(空)";
}
Page({
    data: {
        itemId: "",
        name: "",
        locationText: "",
        note: "",
        version: 0,
        updatedAtText: "",
        lastConfirmedText: "",
        spacePath: [],
        editPanelOpen: false,
        moreOpen: false,
        familyShared: false,
        saving: false,
        deleting: false,
        mounting: false,
        mountPanelOpen: false,
        mountSegments: [],
        mountNeedConfirm: false,
        mountOrderViolation: false,
        mountSaving: false,
        expire: null,
        remindAt: "",
        remindGeneration: -1,
        today: (0, remind_ui_1.localTodayYmd)(),
        remindBusy: false,
        notifyAccepted: false,
        diagEntryVisible: false,
        wantsNotify: true,
        vagueQuote: "",
        conflicts: [],
        conflictPending: false,
        evidenceReady: false,
        evidenceNoPhoto: false,
        evidenceOpen: false,
        evidenceOlderOpen: false,
        evidence: null,
        videoReady: false,
        videoOpen: false,
        videoEvidence: null,
        videoBusy: false,
        videoPending: null,
        videoPendingText: "",
    },
    /** 最近一次加载到的内容,用于判断是否有修改 */
    original: { name: "", location: "", note: "" },
    remindOriginal: "",
    remindRemoteUnknown: false,
    remoteRemindKind: "下次维护",
    pendingRetry: null,
    onLoad(options) {
        // 空间路径来自进入时的容器层(首页地图 / 空间页点开的条目);
        // 搜索等入口没有路径就不显示,只用原话,不自造
        this.setData({
            spacePath: parseSpacePath(options.path),
            familyShared: (0, household_scope_1.isHouseholdScopeShared)(),
        });
        // 诊断入口仅 develop 显示(预览/开发版);getAccountInfoSync 不在任何 tap
        // 手势链上(onLoad 时调用),不影响订阅手势纪律
        try {
            const acc = wx.getAccountInfoSync();
            this.setData({
                diagEntryVisible: !!acc.miniProgram && acc.miniProgram.envVersion === "develop",
            });
        }
        catch (e) {
            this.setData({ diagEntryVisible: false });
        }
        const rawItemId = options.item_id;
        if (rawItemId) {
            // 按 id 直接打开(生成向导的 skipped 件、结果页跳转):get 单查不受 list 分页影响
            this.setData({ itemId: safeDecode(rawItemId) });
            void this.loadById(safeDecode(rawItemId));
            return;
        }
        const raw = options.data;
        let summary = null;
        if (raw) {
            try {
                const p = JSON.parse(safeDecode(raw));
                if (typeof p.item_id === "string" &&
                    typeof p.name === "string" &&
                    typeof p.location_text === "string" &&
                    typeof p.note === "string" &&
                    typeof p.version === "number" &&
                    typeof p.updated_at === "string") {
                    summary = {
                        item_id: p.item_id,
                        name: p.name,
                        location_text: p.location_text,
                        note: p.note,
                        version: p.version,
                        updated_at: p.updated_at,
                    };
                }
            }
            catch (e) {
                console.error("[item] 详情参数解析失败", e);
            }
        }
        if (!summary) {
            wx.showModal({
                title: "无法打开",
                content: "记录参数缺失或已失效,请返回重试。",
                showCancel: false,
                success: () => {
                    this.goBack();
                },
            });
            return;
        }
        this.applySummary(summary);
    },
    onShow() {
        // 家庭上下文可能切换(创建/加入/退出):「分享给家人」只在共享家庭显示;
        // 订阅入口的本地「已开启」标记按家庭键隔离,回页时一并重读(作用域经
        // 服务端复核后 refreshReminderRow 末尾还会再读一次,双保险)
        this.setData({
            familyShared: (0, household_scope_1.isHouseholdScopeShared)(),
            notifyAccepted: (0, notify_accepted_1.isNotifyAccepted)(),
        });
        // 保质期行(#36):进页/回页时按服务端提醒刷新;加载失败静默不显示(增强露出)。
        // 提醒冲突待选时不刷:面板里「你的修改」是用户正要存的值,回页刷新会把它
        // 悄悄换回服务端值(文字字段没有 onShow 刷新,提醒同口径不搞特殊)。
        // 表单里还有待补写的提醒选择时(冲突刷新那轮提醒远端不可得,选择留在表单
        // 等保存补写)同样不刷:refreshReminderRow 会先清空 remindAt,选择会无痕蒸发
        if (!this.hasRemindConflict() && this.pendingRemindWrite() === null) {
            void this.refreshReminderRow();
        }
        // 照片证据回放卡(#3 §6):进页/回页拉取;applySummary/update 后不自动重拉
        //(onShow 再拉)。失败静默(增强露出,不影响详情主体)
        void this.refreshEvidence();
        // 视频证据:进入详情只拉取并默认折叠;用户点击后才播放(有视频才显示)
        void this.refreshVideoEvidence();
        this.refreshVideoPending();
    },
    onNameInput(e) {
        const value = e.detail && e.detail.value ? e.detail.value : "";
        this.setData({ name: value });
        this.syncConflictFromInput("name", value);
    },
    onLocationInput(e) {
        const value = e.detail && e.detail.value ? e.detail.value : "";
        this.setData({ locationText: value });
        this.syncConflictFromInput("location", value);
    },
    onNoteInput(e) {
        const value = e.detail && e.detail.value ? e.detail.value : "";
        this.setData({ note: value });
        this.syncConflictFromInput("note", value);
    },
    /* ---------------- 冲突面板(issue #6,移植自 PR #12 并扩展提醒字段) ---------------- */
    /**
     * 冲突态下用户直接编辑了冲突字段:仅把面板上的「你的修改」同步为最新输入,
     * 不视为显式选择——门禁要求点选按钮,避免「不看面板、在输入框敲个空格再删掉」
     * 就绕过冲突确认直接覆盖(issue #6:必须知悉对方修改后明确选择)。
     * 输入会撤回该字段已做的选择(既有选择已不再反映输入框内容);
     * 程序 setData 不触发 input 事件,「采用最新记录」按钮写入的值不会被误判为输入。
     */
    syncConflictFromInput(key, value) {
        const idx = this.data.conflicts.findIndex((c) => c.key === key);
        if (idx < 0) {
            return;
        }
        const entry = this.data.conflicts[idx];
        const trimmed = value.trim();
        const patch = {};
        if (entry.localValue !== trimmed) {
            patch["conflicts[" + idx + "].localValue"] = trimmed;
            patch["conflicts[" + idx + "].localDisplay"] = conflictDisplayText(key, trimmed);
        }
        if (entry.choice !== null) {
            patch["conflicts[" + idx + "].choice"] = null;
            patch.conflictPending = true;
        }
        if (Object.keys(patch).length > 0) {
            this.setData(patch);
        }
    },
    /** 冲突面板:显式选择「保留我的修改」或「采用最新记录」 */
    applyConflictChoice(key, choice) {
        const idx = this.data.conflicts.findIndex((c) => c.key === key);
        if (idx < 0) {
            return;
        }
        const entry = this.data.conflicts[idx];
        // 选定值回填表单:文本字段选远端即与最新基准一致(保存时无变化、不自动再写),
        // 选本地则保留用户值,下次保存以最新 expected_version 提交该字段;
        // 提醒字段选远端同样回显即停,选本地的补写口径与 resolveRemindChoice 同源。
        const patch = {};
        if (key === "remind") {
            const resolution = (0, conflict_1.resolveRemindChoice)(entry, choice);
            patch.remindAt = resolution.displayDate;
            patch.expire = resolution.displayDate
                ? {
                    mainText: (0, remind_ui_1.expireMainText)(resolution.displayDate),
                    dueDate: resolution.displayDate,
                    kind: choice === "remote" ? this.remoteRemindKind : "下次维护",
                }
                : null;
        }
        else {
            patch[key === "location" ? "locationText" : key] = (0, conflict_1.chosenValue)(entry, choice);
        }
        this.setData({
            ...patch,
            ["conflicts[" + idx + "].choice"]: choice,
            conflictPending: this.data.conflicts.some((c, i) => i !== idx && !c.choice),
        });
        this.dismissConflictsIfSettled();
    },
    /**
     * 冲突全部选完且表单已与最新基准完全一致(典型:全部采用最新记录且无其他改动)
     * 时收起面板。此时没有任何待提交内容,保留面板只会引导一次
     * 注定「内容没有变化」的保存,让用户找不到出口。
     */
    dismissConflictsIfSettled() {
        if (this.data.conflicts.length === 0) {
            return;
        }
        if ((0, conflict_1.conflictUnresolved)(this.data.conflicts)) {
            return;
        }
        const changes = (0, conflict_1.buildUpdateChanges)(this.original, {
            name: this.data.name.trim(),
            location: this.data.locationText.trim(),
            note: this.data.note.trim(),
        });
        if (Object.keys(changes).length === 0 && this.pendingRemindWrite() === null) {
            this.setData({ conflicts: [], conflictPending: false });
            wx.showToast({ title: "已与最新记录一致", icon: "none" });
        }
    },
    onChooseLocal(e) {
        this.applyConflictChoice(e.currentTarget.dataset.key, "local");
    },
    onChooseRemote(e) {
        this.applyConflictChoice(e.currentTarget.dataset.key, "remote");
    },
    /** 「提醒」是否正处于冲突待选:在冲突面板里时,改日期/清除只更新「你的修改」,不直接落库 */
    hasRemindConflict() {
        return this.data.conflicts.some((c) => c.key === "remind");
    },
    /** 冲突流程中把「你正要存的提醒值」留在表单(到期行同步,便于对照两版) */
    setPendingRemind(date) {
        this.setData({
            remindAt: date,
            expire: date
                ? { mainText: (0, remind_ui_1.expireMainText)(date), dueDate: date, kind: "下次维护" }
                : null,
        });
    },
    /**
     * 待补的提醒写操作:表单提醒日期与最新基准不一致即需要落库——
     * 冲突面板选「保留我的修改」(选中值 ≠ 最新记录),或面板被整理位置等
     * 路径重新对齐后遗留的未落库选择。写法复用既有提醒路径:
     * 有日期 remindSet、清空 remindClear,轮次号用刷新后的最新所见轮次。
     */
    pendingRemindWrite() {
        if (this.data.remindAt === this.remindOriginal) {
            return null; // 表单与最新基准一致(选了远端或本无差异):不写
        }
        const entry = this.data.conflicts.find((c) => c.key === "remind");
        if (entry && entry.choice !== null) {
            const resolution = (0, conflict_1.resolveRemindChoice)(entry, entry.choice);
            if (resolution.writeAction === null) {
                return null;
            }
            return {
                action: resolution.writeAction === "set" ? "remindSet" : "remindClear",
                dueDate: resolution.writeDate,
            };
        }
        return this.data.remindAt === ""
            ? { action: "remindClear", dueDate: "" }
            : { action: "remindSet", dueDate: this.data.remindAt };
    },
    /** 编辑折叠:常态只读,点开才出现表单;保存成功后自动收回 */
    onEditToggle() {
        this.setData({ editPanelOpen: !this.data.editPanelOpen });
    },
    applySummary(s) {
        this.original = {
            name: s.name,
            location: s.location_text,
            note: s.note,
        };
        // PR #48 复审 B2:updated_at 在名称/备注/位置任意修改时都会刷新,不能冒充
        // 「位置确认时间」——文案只如实说明记录更新时间
        const short = shortDate(s.updated_at);
        // vagueQuote(Fix 4)只在 get(详情)响应携带;update 等其余投影不带时
        // 保留现值——编辑内容不会动掉「当时提到时间」的留痕
        const vague = typeof s.remind_vague_quote === "string"
            ? s.remind_vague_quote || ""
            : this.data.vagueQuote;
        this.setData({
            itemId: s.item_id,
            name: s.name,
            locationText: s.location_text,
            note: s.note,
            version: s.version,
            updatedAtText: (0, api_1.formatDateTime)(s.updated_at),
            lastConfirmedText: short
                ? "记录更新于 " + short
                : s.updated_at
                    ? "记录更新于 " + (0, api_1.formatDateTime)(s.updated_at)
                    : "",
            vagueQuote: vague,
            // 新基准落地:冲突面板随之作废(保存成功/重新进页都会走到这里)
            conflicts: [],
            conflictPending: false,
        });
    },
    /**
     * 保存修改:文本字段走 itemsApi update(expected_version 条件更新);
     * 冲突选「保留我的修改」的提醒(或遗留的未落库提醒)按既有 remindSet /
     * remindClear 路径补写(expected_generation 用刷新后的最新所见轮次)。
     * 冲突字段未全部显式选择前,按钮禁用 + 此处再设一道门禁(双保险)。
     */
    async onSaveTap() {
        if (this.data.saving || this.data.deleting) {
            return;
        }
        if (this.data.conflictPending || (0, conflict_1.conflictUnresolved)(this.data.conflicts)) {
            // 冲突字段必须显式选择保留哪一版后才能再次提交(issue #6)
            wx.showToast({ title: "请先为冲突字段选择保留哪一版", icon: "none" });
            return;
        }
        const name = this.data.name.trim();
        const locationText = this.data.locationText.trim();
        const note = this.data.note.trim();
        if (!name) {
            wx.showToast({ title: "请填写物品名称", icon: "none" });
            return;
        }
        if (!locationText) {
            wx.showToast({ title: "位置为必填项,请填写位置", icon: "none" });
            return;
        }
        const changes = (0, conflict_1.buildUpdateChanges)(this.original, {
            name,
            location: locationText,
            note,
        });
        let remindWrite = this.pendingRemindWrite();
        if (Object.keys(changes).length === 0 && remindWrite === null) {
            // 冲突态下走到这里 = 冲突字段全部选了「采用最新记录」且无其他改动:
            // 表单已与最新基准一致,收起面板,不给用户留一个只会空跑的面板。
            if (this.data.conflicts.length > 0) {
                this.setData({ conflicts: [], conflictPending: false });
            }
            wx.showToast({ title: "内容没有变化", icon: "none" });
            return;
        }
        // 同样内容的重试复用同一 update_id:服务端据此把「自己刚写入但响应丢失」的重放
        // 识别为 replayed 成功,而不是误报 VERSION_CONFLICT;内容一变即生成新 update_id。
        const hasTextChanges = Object.keys(changes).length > 0;
        const retry = this.pendingRetry;
        const samePayload = retry !== null &&
            retry.changes.name === changes.name &&
            retry.changes.location_text === changes.location_text &&
            retry.changes.note === changes.note;
        const updateId = samePayload ? retry.updateId : (0, api_1.uuid)();
        // V1.5(#36 到期微信提醒):本次保存会写入到期提醒(remindSet,含冲突选边
        // 「保留我的修改」与遗留待补写)时,在 tap 手势链内同步请求订阅授权
        //(必须先于下方任何 await;清除提醒不请求;拒绝/失败静默降级应用内提醒)
        if (remindWrite !== null && remindWrite.action === "remindSet" && this.data.wantsNotify !== false) {
            // 回执日期=本次写入的到期日(remindSet 的 dueDate);wantsNotify=false
            // =用户在选日期时明确答过「不用了」,本次保存跳过订阅询问
            (0, subscribe_1.requestExpirySubscribe)(undefined, remindWrite.dueDate);
        }
        this.setData({ saving: true });
        try {
            if (hasTextChanges) {
                const res = await (0, api_1.callItemsApi)({
                    action: "update",
                    item_id: this.data.itemId,
                    expected_version: this.data.version,
                    update_id: updateId,
                    ...changes,
                });
                this.pendingRetry = null;
                const it = res.item;
                this.applySummary({
                    item_id: it.item_id,
                    name: it.name,
                    location_text: it.location_text,
                    note: it.note,
                    version: it.version,
                    updated_at: it.updated_at,
                });
            }
            if (remindWrite !== null && this.data.remindGeneration < 0) {
                // F4-B2:轮次未知(未加载/加载失败/冲突刷新远端不可得)绝不退回旧协议
                // 无条件写——先补拉一次(候选保留);补拉后与最新一致则无需再写,
                // 仍读不到轮次则如实说没存上,文本部分已存好,提醒候选留在表单等重试
                const outcome = await this.reloadRemindGeneration();
                if (outcome === "diverged") {
                    // F4-B4:补拉撞见远端已是不同内容且用户从未看过:不得直接写——
                    // 保留候选,进入既有冲突双值面板(远端值 vs 本地候选),显式选边
                    // 保存时以刷新后的最新轮次提交
                    const result = await this.refreshForConflict();
                    if (result === "notfound") {
                        wx.showModal({
                            title: "记录不存在",
                            content: "没有找到这条记录,可能已被删除。",
                            showCancel: false,
                            success: () => {
                                this.goBack();
                            },
                        });
                    }
                    else if (result === "refreshed") {
                        wx.showToast({
                            title: this.data.conflictPending
                                ? "提醒与最新记录冲突,请选择保留哪一版"
                                : this.remindRemoteUnknown && this.pendingRemindWrite() !== null
                                    ? "提醒没存上,你的选择已保留,点保存修改再试"
                                    : "这条提醒刚被家人改过,已刷新",
                            icon: "none",
                            duration: 2500,
                        });
                    }
                    return;
                }
                remindWrite = outcome === "known" ? this.pendingRemindWrite() : remindWrite;
                if (outcome === "unknown") {
                    wx.showToast({
                        title: "提醒没存上,提醒还没加载好,你的选择已保留,稍后再试",
                        icon: "none",
                        duration: 2500,
                    });
                    return;
                }
            }
            if (remindWrite !== null) {
                try {
                    if (remindWrite.action === "remindSet") {
                        // 选「保留我的修改」的提醒以刷新后的最新轮次号重发(既有 remindSet 路径):
                        // 提交瞬间他处又改 → 服务端轮次门禁再次拒绝,重新进入双值对比。
                        // 轮次未知已被上方 F4-B2 门禁拦下,这里必带轮次,绝不省略
                        const r = await (0, api_1.callItemsApi)({
                            action: "remindSet",
                            item_id: this.data.itemId,
                            due_date: remindWrite.dueDate,
                            expected_generation: this.data.remindGeneration,
                        });
                        this.applyReminderRow(r.reminder);
                    }
                    else {
                        await (0, api_1.callItemsApi)({
                            action: "remindClear",
                            item_id: this.data.itemId,
                            expected_generation: this.data.remindGeneration,
                        });
                        this.applyReminderRow(null);
                    }
                }
                catch (e2) {
                    if (e2 instanceof api_1.ApiError && e2.code === "VERSION_CONFLICT") {
                        // 提交瞬间提醒又被他处改过:文本部分已存好,提醒重新比较、再次显式选择;
                        // 提醒行拉取失败时远端不可得:选择留在表单等下次保存补写,如实说没存上
                        const result = await this.refreshForConflict();
                        if (result === "refreshed") {
                            wx.showToast({
                                title: this.data.conflictPending
                                    ? "提醒与最新记录冲突,请选择保留哪一版"
                                    : this.remindRemoteUnknown && this.pendingRemindWrite() !== null
                                        ? "提醒没存上,你的选择已保留,点保存修改再试"
                                        : "这条提醒刚被家人改过,已刷新",
                                icon: "none",
                                duration: 2500,
                            });
                        }
                        return;
                    }
                    // 提醒没存上但文本已保存:如实分开告知,不合并成一句「保存失败」
                    wx.showModal({
                        title: "提醒没存上",
                        content: (0, api_1.errorMessage)(e2),
                        showCancel: false,
                    });
                    this.setData({ conflicts: [], conflictPending: false });
                    return;
                }
            }
            // 全部落库:收回冲突面板与编辑折叠,回到只读答案
            this.setData({ conflicts: [], conflictPending: false, editPanelOpen: false });
            wx.showToast({ title: "已保存", icon: "success" });
        }
        catch (e) {
            // 记录失败的更新供重试复用 update id(仅同样内容且有文本变更的重试)
            if (hasTextChanges) {
                this.pendingRetry = { updateId, changes };
            }
            if (e instanceof api_1.ApiError && e.code === "VERSION_CONFLICT") {
                // 刷新后:无冲突字段则维持原提示(静默三方合并);有冲突字段则进入冲突态,
                // 编辑折叠内逐字段并排「你的修改 / 最新记录」,选择后才允许再次提交。
                const result = await this.refreshForConflict();
                if (result === "notfound") {
                    wx.showModal({
                        title: "记录不存在",
                        content: "没有找到这条记录,可能已被删除。",
                        showCancel: false,
                        success: () => {
                            this.goBack();
                        },
                    });
                }
                else if (result === "refreshed") {
                    wx.showToast({
                        title: this.data.conflictPending
                            ? "部分字段与最新记录冲突,请逐项选择保留哪一版"
                            : "内容已被修改,已更新版本号,请检查后重试",
                        icon: "none",
                        duration: 2500,
                    });
                }
            }
            else {
                wx.showModal({
                    title: "保存失败",
                    content: (0, api_1.errorMessage)(e),
                    showCancel: false,
                });
            }
        }
        finally {
            this.setData({ saving: false });
        }
    },
    /**
     * 冲突态入口(issue #6,四字段版):保存(update)、改提醒(remindSet/remindClear)
     * 或整理位置(linkItem)命中 VERSION_CONFLICT 后,拉服务端最新物品 + 最新提醒,
     * 对名称/位置/备注/提醒逐字段三方比较——
     * - 非冲突字段:静默三方合并(用户改过保留用户值,否则采纳服务端值),既有语义;
     * - 冲突字段(双方都改且互不相同):进入冲突态,编辑折叠内并排两版值,
     *   逐项显式选择后才能再次保存,绝不静默覆盖;
     * - 上一轮未选边的冲突字段跨刷新保留(carryUnresolved):基准对齐远端后,
     *   它们会退化成「仅本机修改」被静默合并,面板与门禁不能就此消失。
     * 提醒行拉取失败或家庭在途切换时不猜远端:该字段本轮不参与比较、基准维持
     * 原值,用户待写的提醒选择留在表单等下次保存补写(见函数内注释)。
     */
    async refreshForConflict() {
        let item;
        try {
            const res = await (0, api_1.callItemsApi)({ action: "get", item_id: this.data.itemId });
            item = res.item;
        }
        catch (e) {
            if (e instanceof api_1.ApiError && e.code === "NOT_FOUND") {
                // 冲突期间记录已被删除:不弹「刷新失败」,交由调用方提示「记录不存在」并返回
                return "notfound";
            }
            wx.showModal({
                title: "刷新失败",
                content: (0, api_1.errorMessage)(e),
                showCancel: false,
            });
            return "error";
        }
        const row = await this.fetchReminderRow();
        // 提醒远端不可得(undefined,拉取失败/在途家庭切换)时不猜远端:本轮按「未变」
        // 参与比较(不判冲突、不改表单),但基准绝不向表单现值对齐——对齐会让用户
        // 待写的提醒选择蒸发(表单与基准一致后,既不随保存补写、也进不了冲突面板)。
        // 基准维持原值,选择留在表单,下次保存按原所见轮次号补写;届时他处若又改过,
        // 服务端轮次门禁会再次拦下、重新进流程
        this.remindRemoteUnknown = row === undefined;
        const remoteRemind = row === undefined ? this.remindOriginal : row ? row.due_date : "";
        const localValues = {
            name: this.data.name.trim(),
            location: this.data.locationText.trim(),
            note: this.data.note.trim(),
            remind: this.data.remindAt,
        };
        const remoteValues = {
            // note 兜底为空串:早期写入的旧文档可能缺该字段,原样透传 undefined
            // 会让冲突比较与表单 .trim() 拿到非字符串(服务端投影已兜底,这里双保险)
            name: item.name,
            location: item.location_text,
            note: item.note || "",
            remind: remoteRemind,
        };
        const outcome = (0, conflict_1.mergeLatest)({ ...this.original, remind: this.remindOriginal }, localValues, remoteValues);
        // 上一轮未选边的冲突字段跨刷新保留:基准已对齐远端,这些字段本轮会退化成
        // 「仅本机修改」被静默合并——面板一收、门禁即失守,对方的修改就被无声覆盖
        const carried = (0, conflict_1.carryUnresolved)(this.data.conflicts, outcome.conflicts, localValues, remoteValues);
        if (row === undefined) {
            // 提醒远端不可得时无从重判:上一轮未选边的提醒条目原样保留
            // (仅把「你的修改」同步为表单现值),门禁不撤
            const prevRemind = this.data.conflicts.find((c) => c.key === "remind" && c.choice === null);
            if (prevRemind &&
                !outcome.conflicts.some((c) => c.key === "remind") &&
                !carried.some((c) => c.key === "remind")) {
                carried.push({
                    key: "remind",
                    label: prevRemind.label,
                    localValue: localValues.remind,
                    remoteValue: prevRemind.remoteValue,
                });
            }
        }
        const entries = outcome.conflicts.concat(carried);
        this.original = {
            name: item.name,
            location: item.location_text,
            note: item.note || "",
        };
        if (row !== undefined) {
            // 只有远端提醒真拿到了才对齐基准;不可得时维持原基准(见上方注释)
            this.remindOriginal = remoteRemind;
        }
        this.remoteRemindKind = row ? row.kind : "下次维护";
        const hasConflicts = entries.length > 0;
        const shown = outcome.merged.remind;
        const remindPatch = row === undefined
            ? {}
            : {
                remindAt: shown,
                expire: shown
                    ? {
                        mainText: (0, remind_ui_1.expireMainText)(shown),
                        dueDate: shown,
                        kind: row && shown === row.due_date ? row.kind : "下次维护",
                    }
                    : null,
                remindGeneration: row
                    ? typeof row.generation === "number"
                        ? row.generation
                        : -1
                    : 0,
            };
        this.setData({
            name: outcome.merged.name,
            locationText: outcome.merged.location,
            note: outcome.merged.note,
            version: item.version,
            updatedAtText: (0, api_1.formatDateTime)(item.updated_at),
            conflicts: entries.map((c) => ({
                ...c,
                choice: null,
                localDisplay: conflictDisplayText(c.key, c.localValue),
                remoteDisplay: conflictDisplayText(c.key, c.remoteValue),
            })),
            conflictPending: hasConflicts,
            // 冲突面板在编辑折叠内:强制展开,保证用户看得见两版值再选
            editPanelOpen: hasConflicts ? true : this.data.editPanelOpen,
            ...remindPatch,
        });
        return "refreshed";
    },
    /* ---------------- 「⋯」次级菜单(编辑/整理/删除都收进这里) ---------------- */
    onMoreTap() {
        this.setData({ moreOpen: true });
    },
    onSheetClose() {
        this.setData({ moreOpen: false });
    },
    /**
     * 分享给家人(仅共享家庭显示):这里如实说明语义——共享家庭里这条记录
     * 本来就人人可见,没有单独分享这个动作,也不假装写入。
     */
    onShareTap() {
        this.setData({ moreOpen: false });
        wx.showModal({
            title: "分享给家人",
            content: "这条记录已经在「我们家」的共享记录里,家里每个人打开就能看到,不用再单独分享。",
            confirmText: "知道了",
            showCancel: false,
        });
    },
    /** 整理位置:收起菜单后走既有 parseLocation → 逐段核对 → ensurePath + linkItem */
    onTidyTap() {
        this.setData({ moreOpen: false });
        void this.onMountTap();
    },
    /** 删除:先收起菜单,再 wx.showModal 二次确认 */
    onDeleteTap() {
        this.setData({ moreOpen: false });
        if (this.data.saving || this.data.deleting) {
            return;
        }
        if (this.data.videoPending !== null) {
            wx.showModal({
                title: "先处理待关联视频",
                content: "这件物品还有一段已上传但未关联成功的视频。请先重试关联或删除待关联视频,再删除物品,避免云端留下无归属的私密视频。",
                showCancel: false,
            });
            return;
        }
        const name = this.data.name.trim() || "这条记录";
        wx.showModal({
            title: "确认删除",
            content: "删除「" + name + "」后无法恢复,确定删除吗?",
            confirmText: "删除",
            confirmColor: "#d93025",
            cancelText: "取消",
            success: (r) => {
                if (!r.confirm) {
                    return;
                }
                this.confirmDelete();
            },
        });
    },
    async confirmDelete() {
        this.setData({ deleting: true });
        try {
            await (0, api_1.callItemsApi)({ action: "delete", item_id: this.data.itemId });
            wx.showToast({ title: "已删除", icon: "success" });
            setTimeout(() => {
                this.goBack();
            }, 800);
        }
        catch (e) {
            wx.showModal({
                title: "删除失败",
                content: (0, api_1.errorMessage)(e),
                showCancel: false,
            });
        }
        finally {
            this.setData({ deleting: false });
        }
    },
    goBack() {
        wx.navigateBack({
            fail: () => {
                wx.reLaunch({ url: "/pages/index/index" });
            },
        });
    },
    async loadById(id) {
        try {
            const res = await (0, api_1.callItemsApi)({ action: "get", item_id: id });
            this.applySummary(res.item);
        }
        catch (e) {
            wx.showModal({
                title: "无法打开",
                content: (0, api_1.errorMessage)(e),
                showCancel: false,
                success: () => {
                    this.goBack();
                },
            });
        }
    },
    /**
     * F4-B3:冲突未裁定时「整理位置」的写入门禁。冲突面板还在(仍有未选边
     * 字段,或已选边但还没保存/收敛——面板只有在表单与最新基准一致时才会收起)
     * 且表单位置仍不同于已确认基准时返回 true:此时挂载会把 location_node_id
     * 指向按本地未裁定文本解析的位置,服务端 location_text 仍是对方值,位置
     * 事实分裂。选边并保存(基准重置、面板收起)或位置收敛后自然放行。
     */
    mountBlockedByConflict() {
        if (this.data.conflicts.length === 0 && !this.data.conflictPending) {
            return false; // 无冲突态:普通编辑照旧可整理(既有行为)
        }
        return this.data.locationText.trim() !== this.original.location;
    },
    /**
     * 整理位置:parseLocation 零写库出候选分段 → 用户逐段核对(可改)→
     * ensurePath + linkItem。AI 不可用时兜底为手动选位置(选择模式)。
     */
    async onMountTap() {
        if (this.data.saving || this.data.deleting || this.data.mounting) {
            return;
        }
        if (this.mountBlockedByConflict()) {
            // F4-B3(架构复审阻断):冲突未裁定且待提交位置仍异于已确认基准时,
            // 挂载会按本地未裁定文本建/指节点,而服务端 location_text 仍是对方值
            // ——位置事实分裂。先逐项选边并保存,再整理位置
            wx.showToast({
                title: "位置冲突还没处理,先选保留哪一版并保存,再整理位置",
                icon: "none",
                duration: 2500,
            });
            return;
        }
        const text = this.data.locationText.trim();
        if (!text) {
            wx.showToast({ title: "这条记录还没有位置描述,先在编辑里补一句", icon: "none" });
            return;
        }
        this.setData({ mounting: true });
        try {
            const res = await (0, locations_api_1.callLocationsApi)({
                action: "parseLocation",
                text,
            });
            const parse = res.parse;
            const hints = new Map();
            for (const s of parse.merge_suggestions) {
                if (!hints.has(s.segment_index)) {
                    hints.set(s.segment_index, s.existing_name);
                }
            }
            this.setData({
                mountPanelOpen: true,
                mountNeedConfirm: parse.need_confirm,
                mountOrderViolation: parse.order_violation,
                mountSegments: parse.segments.map((seg, i) => ({
                    idx: i,
                    name: seg.name,
                    confidenceText: Math.round(seg.confidence * 100) + "%",
                    needConfirm: seg.confidence < 0.8,
                    hintName: hints.get(i) || "",
                })),
            });
        }
        catch (e) {
            if ((0, locations_api_1.isLocationsApiErrorWithCode)(e, "AI_UNAVAILABLE")) {
                wx.showModal({
                    title: "AI 暂时不可用",
                    content: "解析不了这句位置,要改为手动选一个已有位置吗?",
                    confirmText: "手动选位置",
                    cancelText: "取消",
                    success: (r) => {
                        if (r.confirm) {
                            this.openLocationPicker();
                        }
                    },
                });
                return;
            }
            wx.showModal({
                title: "解析失败",
                content: (0, api_1.errorMessage)(e),
                showCancel: false,
            });
        }
        finally {
            this.setData({ mounting: false });
        }
    },
    onMountSegmentInput(e) {
        const index = Number(e.currentTarget.dataset.index);
        const value = e.detail && e.detail.value ? e.detail.value : "";
        const rows = this.data.mountSegments.slice();
        if (!rows[index]) {
            return;
        }
        rows[index] = { ...rows[index], name: value };
        this.setData({ mountSegments: rows });
    },
    /** AI 不可用的手动兜底:进 locations 选择模式,选中后直接 linkItem */
    openLocationPicker() {
        wx.navigateTo({
            url: "/pages/locations/locations?picker=1&title=" +
                encodeURIComponent("把「" + (this.data.name || "这件物品") + "」放到哪个位置…"),
            events: {
                pickNode: (d) => {
                    void this.doLinkToNode(d.location_id, d.path);
                    // 退栈统一由发起页计算(选择器页自身不再逐层退,#29 后续):
                    // 选择器页只叠在本页正上方,一次退掉全部。
                    const pages = getCurrentPages();
                    const idx = pages.indexOf(this);
                    const delta = pages.length - 1 - idx;
                    if (idx !== -1 && delta > 0) {
                        wx.navigateBack({ delta, fail: () => { } });
                    }
                },
            },
            fail: () => {
                wx.showToast({ title: "页面打开失败,请重试", icon: "none" });
            },
        });
    },
    async doLinkToNode(nodeId, path) {
        if (this.mountBlockedByConflict()) {
            // F4-B3:选择器是异步回传,面板在选位置的这段时间里可能已弹出冲突——
            // 写入前再守一次门,与入口同一口径(先选边保存,再整理位置)
            wx.showToast({
                title: "位置冲突还没处理,先选保留哪一版并保存,再整理位置",
                icon: "none",
                duration: 2500,
            });
            return;
        }
        this.setData({ mountSaving: true });
        try {
            const res = await (0, locations_api_1.callLocationsApi)({
                action: "linkItem",
                item_id: this.data.itemId,
                node_id: nodeId,
                expected_version: this.data.version,
                update_id: (0, api_1.uuid)(),
            });
            this.setData({
                version: res.item.version,
                updatedAtText: (0, api_1.formatDateTime)(res.item.updated_at),
                // 刚亲手选定的位置:大卡如实跟进(选择器回传的展示用路径)
                spacePath: Array.isArray(path) ? path : this.data.spacePath,
            });
            wx.showToast({ title: "已记到这个位置", icon: "success" });
        }
        catch (e) {
            if (e instanceof api_1.ApiError && e.code === "VERSION_CONFLICT") {
                // 物品被并发修改:与保存冲突同一口径走四字段冲突刷新——双方都改且不同
                // 的字段进冲突面板显式选边(未选完前保存被门禁拦住,上一轮未选边的
                // 条目也保留),绝不静默覆盖;无冲突字段维持三方合并,对齐版本后重试整理
                const result = await this.refreshForConflict();
                if (result === "notfound") {
                    wx.showModal({
                        title: "记录不存在",
                        content: "没有找到这条记录,可能已被删除。",
                        showCancel: false,
                        success: () => {
                            this.goBack();
                        },
                    });
                    return;
                }
                if (result === "refreshed") {
                    wx.showToast({
                        title: this.data.conflictPending
                            ? "部分字段与最新记录冲突,请逐项选择保留哪一版"
                            : "内容已被修改,已更新版本号,请重试",
                        icon: "none",
                        duration: 2500,
                    });
                }
            }
            else {
                wx.showModal({
                    title: "整理失败",
                    content: (0, api_1.errorMessage)(e),
                    showCancel: false,
                });
            }
        }
        finally {
            this.setData({ mountSaving: false });
        }
    },
    /** 确认候选分段:ensurePath(用户确认后的唯一建节点入口)→ linkItem(版本条件更新) */
    async confirmMount() {
        if (this.data.mountSaving) {
            return;
        }
        if (this.mountBlockedByConflict()) {
            // F4-B3:候选面板是冲突前解析好的,确认时状态可能已变(异步写入前守门);
            // 冲突未裁定且位置异于基准时禁止 ensurePath/linkItem,先选边保存
            wx.showToast({
                title: "位置冲突还没处理,先选保留哪一版并保存,再整理位置",
                icon: "none",
                duration: 2500,
            });
            return;
        }
        const names = this.data.mountSegments
            .map((s) => s.name.trim())
            .filter((n) => n.length > 0);
        if (names.length === 0) {
            wx.showToast({ title: "至少填一段位置", icon: "none" });
            return;
        }
        this.setData({ mountSaving: true });
        try {
            const ensured = await (0, locations_api_1.callLocationsApi)({
                action: "ensurePath",
                path: names,
                created_from: "parse",
            });
            const target = ensured.nodes[ensured.nodes.length - 1];
            if (!target) {
                throw new Error("服务返回异常");
            }
            const res = await (0, locations_api_1.callLocationsApi)({
                action: "linkItem",
                item_id: this.data.itemId,
                node_id: target.location_id,
                expected_version: this.data.version,
                update_id: (0, api_1.uuid)(),
            });
            this.setData({
                version: res.item.version,
                updatedAtText: (0, api_1.formatDateTime)(res.item.updated_at),
                mountPanelOpen: false,
                // 刚确认并记入的位置分段:大卡如实跟进(与 ensurePath 收到的完全一致)
                spacePath: names,
            });
            wx.showToast({ title: "已记到这个位置", icon: "success" });
        }
        catch (e) {
            if (e instanceof api_1.ApiError && e.code === "VERSION_CONFLICT") {
                // 物品被并发修改:与保存冲突同一口径走四字段冲突刷新(冲突面板/门禁
                // 语义同 doLinkToNode 分支),无冲突字段三方合并对齐版本后重试整理
                const result = await this.refreshForConflict();
                if (result === "notfound") {
                    wx.showModal({
                        title: "记录不存在",
                        content: "没有找到这条记录,可能已被删除。",
                        showCancel: false,
                        success: () => {
                            this.goBack();
                        },
                    });
                }
                else if (result === "refreshed") {
                    wx.showToast({
                        title: this.data.conflictPending
                            ? "部分字段与最新记录冲突,请逐项选择保留哪一版"
                            : "内容已被修改,已更新版本号,请重试",
                        icon: "none",
                        duration: 2500,
                    });
                }
            }
            else {
                wx.showModal({
                    title: "整理失败",
                    content: (0, api_1.errorMessage)(e),
                    showCancel: false,
                });
            }
        }
        finally {
            this.setData({ mountSaving: false });
        }
    },
    cancelMount() {
        this.setData({ mountPanelOpen: false, mountSegments: [] });
    },
    /* ---------------- 提醒的查看与处理(#36 三阶段) ---------------- */
    /**
     * 拉当前家庭这件的 active 提醒行(只取数,不上屏):经 households 资格复核
     * (硬门 C,口径同 R1/首页),在途家庭切换(作用域代数变化)或加载失败时
     * 返回 undefined——调用方据此「不猜远端」,绝不把旧家庭/失败当作「无提醒」。
     */
    async fetchReminderRow() {
        await (0, households_api_1.ensureScopeVerified)();
        // 复核可能揭示家庭漂移并递增代数:请求前重新捕获,响应后才校验
        const scopeGen = (0, household_scope_1.captureScopeGeneration)();
        try {
            const res = await (0, api_1.callItemsApi)({ action: "remindList" });
            if (!(0, household_scope_1.isScopeGenerationCurrent)(scopeGen)) {
                // 在途期间家庭已切换(含响应揭示的漂移):旧家庭响应不可用
                return undefined;
            }
            return res.reminders.find((r) => r.item_id === this.data.itemId) || null;
        }
        catch (e) {
            // 静默:提醒不可得,由调用方决定口径(详情主体不受影响)
            return undefined;
        }
    },
    /**
     * F4-B2:轮次未知(-1,未加载/加载失败/冲突刷新远端不可得)时的写前补拉。
     * 表单里的用户候选(remindAt)原样保留——补拉不是刷新展示,是给待发的写
     * 请求取 CAS 条件;拉不到("unknown")就失败关闭,绝不省略
     * expected_generation 退回旧协议无条件写。
     * F4-B4:补拉结果三分支收紧——远端确认无提醒(轮次 0,补录语义)或远端
     * 内容与用户已确认基准(remindOriginal 语义)一致才返回 "known"(对齐轮次
     * 与基准后按轮次正常提交);远端已是不同内容且用户尚未知悉返回 "diverged"
     * 且不做任何对齐:此时直接写会在用户从未看过远端值的情况下覆盖他人修改
     * (CAS 只保证提交瞬间无新变化,不构成知情选择),由调用方保留候选并进入
     * 既有冲突双值面板,显式选边后才能写。diverged 时也不把基准对齐到远端——
     * 对齐会让候选在随后的冲突刷新里退化成「仅本机修改」,绕开双值面板。
     */
    async reloadRemindGeneration() {
        const row = await this.fetchReminderRow();
        if (row === undefined) {
            return "unknown";
        }
        if (row !== null && row.due_date !== this.remindOriginal) {
            return "diverged";
        }
        const candidate = this.data.remindAt;
        this.remindRemoteUnknown = false;
        this.applyReminderRow(row);
        this.setData({ remindAt: candidate });
        return this.data.remindGeneration >= 0 ? "known" : "unknown";
    },
    /**
     * 拉当前家庭 active 提醒,取这件的那一行上屏。展示前先清旧行并经
     * households 资格复核(硬门 C,口径同 R1/首页);家庭切换(作用域代
     * 数变化)后旧家庭响应不上屏。加载失败
     * 静默隐藏保质期行(增强露出,不影响详情主体)。
     */
    async refreshReminderRow() {
        // 先收起旧保质期行:被移除/切换家庭后冷启动,展示前不得残留旧家庭提醒
        this.setData({ expire: null, remindAt: "", remindGeneration: -1 });
        this.remindOriginal = "";
        const row = await this.fetchReminderRow();
        // 家庭作用域此刻刚经服务端复核:重读「已成功开启订阅」本地标记
        // (#36 真机手势规则:显式入口的显示条件之一;键随家庭隔离)
        this.setData({ notifyAccepted: (0, notify_accepted_1.isNotifyAccepted)() });
        if (row === undefined) {
            return; // 失败/在途切换:静默,详情其余照常
        }
        this.applyReminderRow(row);
    },
    applyReminderRow(row) {
        if (row === null) {
            // 已确认这件当前无提醒:轮次号记 0(补录语义的 expected_generation)
            this.remindOriginal = "";
            this.setData({ expire: null, remindAt: "", remindGeneration: 0 });
            return;
        }
        this.remindOriginal = row.due_date;
        // 换算候选标注(三件 A):仅 remind_converted 行携带换算源原话,
        // 详情页保质期行据此小字标注「按『…』换算」;常规行为空串不渲染
        const convertedNote = row.remind_converted === true && typeof row.remind_quote === "string"
            ? row.remind_quote
            : "";
        this.setData({
            expire: {
                mainText: (0, remind_ui_1.expireMainText)(row.due_date),
                dueDate: row.due_date,
                kind: row.kind,
                convertedNote,
            },
            remindAt: row.due_date,
            remindGeneration: typeof row.generation === "number" ? row.generation : -1,
        });
    },
    /** 保质期行「已处理」:二次确认后 remindComplete(不带 period_days;下次提醒到详情里自己选日子) **/
    async onExpireDoneTap() {
        if (this.data.remindBusy) {
            return;
        }
        const expire = this.data.expire;
        if (!expire) {
            return;
        }
        if (this.hasRemindConflict() || this.pendingRemindWrite() !== null) {
            // F4-B1(架构复审阻断):提醒冲突待选或待补写时,到期行显示的是「你正要
            // 存的候选」预览,不是已确认的当前提醒——此时完成会以刷新对齐的远端新
            // 轮次调 remindComplete,可能替家人收掉他刚设的提醒,绕开选边硬门。
            // 失败关闭:先处理冲突(选边保存 / 补写),到期行照常显示候选供对照。
            wx.showToast({
                title: this.hasRemindConflict()
                    ? "提醒冲突还没处理,先选保留哪一版"
                    : "提醒还没存上,先保存修改,再点已处理",
                icon: "none",
                duration: 2500,
            });
            return;
        }
        if (this.data.remindGeneration < 0) {
            // F4-B2:轮次未知(未加载/加载失败/冲突刷新远端不可得)时完成同样是
            // reminder 写——先补拉取轮次,拉不到就失败关闭,绝不省略 expected_generation
            const outcome = await this.reloadRemindGeneration();
            if (outcome === "unknown") {
                wx.showToast({
                    title: "提醒还没加载好,稍后再点已处理",
                    icon: "none",
                    duration: 2500,
                });
                return;
            }
            if (outcome === "diverged") {
                // F4-B4:补拉发现提醒已变成用户没看过的内容:停止原完成动作——
                // 先把最新提醒如实上屏,再由用户经「带新日期的确认框」显式确认这一条,
                // 确认后才按最新轮次完成;取消则不写,屏上已如实显示最新提醒
                await this.refreshReminderRow();
                const latest = this.data.expire;
                if (!latest || this.data.remindGeneration < 0) {
                    wx.showToast({
                        title: "提醒有变化,已刷新,确认后再点已处理",
                        icon: "none",
                        duration: 2500,
                    });
                    return;
                }
                const confirmed = await new Promise((resolve) => {
                    wx.showModal({
                        title: "提醒有变化",
                        content: "这条提醒现在是 " +
                            (0, remind_ui_1.monthDayText)(latest.dueDate) +
                            " 到期,要按这一条处理吗?",
                        confirmText: "按这一条处理",
                        cancelText: "先不处理",
                        success: (r) => {
                            resolve(r.confirm === true);
                        },
                        fail: () => {
                            resolve(false);
                        },
                    });
                });
                if (!confirmed) {
                    return; // 用户不确认最新提醒:不写
                }
                // 已显式确认最新提醒:按 refreshReminderRow 读到的最新轮次继续完成
            }
            else if (!this.data.expire) {
                return; // 补拉发现远端已无提醒:没有可完成的,到期行已如实收起
            }
        }
        const confirmed = await (0, remind_ui_1.askUseUp)(this.data.name);
        if (!confirmed) {
            return; // 用户取消:不动、不写
        }
        this.setData({ remindBusy: true });
        try {
            await (0, api_1.callItemsApi)({
                action: "remindComplete",
                item_id: this.data.itemId,
                // 轮次未知已被上方 F4-B2 门禁拦下,这里必带轮次(≥0),绝不省略
                expected_generation: this.data.remindGeneration,
                // 完成日按用户本地自然日随请求携带(PR #52 Low-3):服务端不靠运行时区猜
                complete_date: (0, remind_ui_1.localTodayYmd)(),
            });
            this.setData({ expire: null, remindAt: "", remindGeneration: 0 });
            this.remindOriginal = "";
            // 0.9.6(#36 用户反馈):已处理=微信提醒关掉——该物品提醒已完成、天然
            // 不再进推送(每日扫描只看 active 提醒);清「已开启」标记,让之后的新
            // 提醒能重新询问/开启订阅(无论记录保留还是删除都一样)
            (0, notify_accepted_1.clearNotifyAccepted)();
            // #36 真机反馈三件 B(用户功能请求):完成后问「记录还保留吗」——
            // 保留(确认/dismiss)= 现状(已处理 toast);删除物品(取消)= itemsApi
            // delete(与 ⋯ 菜单删除先例同款:级联硬删 active 提醒 + 软删物品,api 层
            // 自动拼装作用域双 marker),成功后返回上一页。dismiss=保留(安全默认,
            // 误触删除不可逆;服务端虽软删但客户端无恢复入口)。删除失败:如实 toast
            // 错误文本,物品保留、已处理不回滚(完成已发生),留在本页稍后再删。
            const keep = await (0, remind_ui_1.askKeepAfterDone)(this.data.name);
            if (keep === "delete") {
                try {
                    await (0, api_1.callItemsApi)({ action: "delete", item_id: this.data.itemId });
                    wx.showToast({ title: "已删除", icon: "success" });
                    setTimeout(() => {
                        this.goBack();
                    }, 800);
                }
                catch (delErr) {
                    wx.showToast({
                        title: "没删成:" + (0, api_1.errorMessage)(delErr),
                        icon: "none",
                        duration: 2500,
                    });
                }
                return;
            }
            // 完成后不弹固定周期选项(#36 真机反馈 Fix 2):下次提醒时间由用户到详情里选日子
            wx.showToast({
                title: "已处理。要下次提醒,到详情里选日子",
                icon: "none",
                duration: 2500,
            });
        }
        catch (e) {
            if (e instanceof api_1.ApiError && e.code === "VERSION_CONFLICT") {
                if (e.cleared === true) {
                    // PR #52 R3-1:完成置 done 后、认领前提醒被家人清除——本轮已完成,
                    // 服务端清除栅栏挡住了再生:如实告知,不再生成下一轮
                    wx.showToast({ title: "已处理;提醒已被清除,不再生成下次", icon: "none", duration: 2500 });
                    await this.refreshReminderRow();
                    return;
                }
                if (e.superseded === true) {
                    // PR #52 R4-1:完成置 done 后、认领前提醒被家人重新设置——再生认领
                    // 绑定原完成轮次被原子拒绝:如实告知本轮不再生成,新提醒原样保留
                    wx.showToast({ title: "已处理;提醒刚被重新设置,不再生成下次", icon: "none", duration: 2500 });
                    await this.refreshReminderRow();
                    return;
                }
                // 这轮已被家人处理并换了新提醒(PR #52 B1):刷新看最新,绝不误伤
                wx.showToast({ title: "这条刚被家人处理过,已刷新", icon: "none" });
                await this.refreshReminderRow();
                return;
            }
            wx.showModal({
                title: "没办成",
                content: (0, api_1.errorMessage)(e),
                showCancel: false,
            });
        }
        finally {
            this.setData({ remindBusy: false });
        }
    },
    /**
     * 「到期时微信提醒我 ›」显式订阅入口(#36 真机手势规则,0.9.0 iOS 实测):
     * 微信规定 wx.requestSubscribeMessage 必须在「用户点击手势」的直接回调内
     * 发起,picker 的 bindchange(滚轮选完)回调不算点击手势、必然被拒——
     * 订阅授权入口从 picker 直写路径移到这里,真实按钮点击(官方推荐模式;
     * 入口只在有生效提醒且本地未标记「已开启」时露出,见 wxml 显示条件)。
     * accept 且服务端记录已发起后:写本地标记并收起入口(标记是展示启发式,
     * 权威记录在服务端 remind_subscriptions);reject/fail 静默降级应用内提醒
     * 页,入口保留可再点,绝不阻塞任何流程。
     */
    onNotifyChipTap() {
        if (!this.data.remindAt) {
            return; // 无生效提醒:入口不该在(双保险)
        }
        (0, subscribe_1.requestExpirySubscribe)(() => {
            (0, notify_accepted_1.markNotifyAccepted)();
            this.setData({ notifyAccepted: true });
        }, this.data.remindAt);
    },
    onDiagEntryTap() {
        wx.navigateTo({ url: "/pages/diag-subscribe/diag-subscribe" });
    },
    /**
     * 编辑折叠「提醒」选日子(#36:picker mode=date 弹层,唯一手动日期来源):
     * 没有提醒的物品在这里补录,有提醒的在这里改期——都走 remindSet,把提醒
     * 设为所选的日子(服务端替换该物品的提醒,不堆积)。picker 回填必为合法
     * YYYY-MM-DD,异常值不写;校验与 picker 范围两端一致——今天可设(到期分组
     * 本就有「今天到期」),过去的日子与超 10 年的拒绝(PR #52 Low-3,按用户
     * 本地自然日判定)。请求携带页面所见轮次号(PR #52 B1):这一轮已被家人
     * 换过 → VERSION_CONFLICT,刷新后重选,绝不静默覆盖别人的新提醒
     * (0=页面确认无提醒的补录)。
     */
    async onRemindDateChange(e) {
        if (this.data.remindBusy) {
            return;
        }
        const value = e.detail && typeof e.detail.value === "string" ? e.detail.value : "";
        if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
            return; // picker 形状异常:不写
        }
        if (value === this.data.remindAt) {
            return; // 没变
        }
        const problem = (0, remind_ui_1.pickerDateProblem)(value);
        if (problem !== "") {
            wx.showToast({ title: problem, icon: "none" });
            return;
        }
        // 0.9.6(#36 用户反馈):选完日子先问一句「要不要微信提醒」。此处是
        // picker bindchange,无点击手势,但纯提问的 modal 不受手势限制;答案存
        // wantsNotify。0.9.7:点「提醒我」**立即**尝试授权——骑 modal 确认的
        // 激活窗口(现代基础库保留);picker 本身无手势,若此处被手势拒绝,落回
        // 保存 tap 二次机会与 chip 入口(双兜底)。
        const wantsNotify = await (0, subscribe_1.askNotifyIntent)(value);
        if (wantsNotify) {
            (0, subscribe_1.requestExpirySubscribe)(() => {
                (0, notify_accepted_1.markNotifyAccepted)();
                this.setData({ notifyAccepted: true });
            }, value);
        }
        this.setData({ wantsNotify });
        // #36 真机手势规则(0.9.0 iOS 实测):picker bindchange(滚轮选完)不是
        // 用户点击手势,此处调 wx.requestSubscribeMessage 必然报错
        // 「requestSubscribeMessage:fail can only be invoked by user TAP gesture」
        // (真机 toast 被截断只见「…fail c…」),留着只产生错误 toast 噪音——授权
        // 入口移至保质期行下方的「到期时微信提醒我 ›」显式入口(onNotifyChipTap,
        // 真实 tap);onSaveTap 的真实按钮点击路径照旧请求订阅。
        if (this.hasRemindConflict() || this.pendingRemindWrite() !== null) {
            // 冲突面板已把「提醒」列为待选字段,或冲突刷新后提醒远端不可得、选择还
            // 留在表单等保存补写(F4-B1):改日期只更新「你的修改」/候选并撤回已有
            // 选择,不直接落库——与文本输入框同一门禁口径,必须点按钮显式选边或经
            // 保存修改补写;表单里的是候选,不是已确认的当前提醒
            this.setPendingRemind(value);
            this.syncConflictFromInput("remind", value);
            if (!this.hasRemindConflict()) {
                // 无面板的待补写态:面板不会给出可见反馈,如实告知没存上并引导补写
                wx.showToast({
                    title: "提醒没存上,你的选择已保留,点保存修改再试",
                    icon: "none",
                    duration: 2500,
                });
            }
            return;
        }
        const hadReminder = this.data.remindAt !== "";
        if (this.data.remindGeneration < 0) {
            // F4-B2:轮次未知(未加载/加载失败/冲突刷新远端不可得)不得发 remindSet
            // ——先补拉一次取轮次,拉不到就失败关闭:候选保留在表单,提示稍后重试,
            // 绝不省略 expected_generation 退回旧协议无条件替换
            const outcome = await this.reloadRemindGeneration();
            if (outcome === "unknown") {
                this.setPendingRemind(value);
                wx.showToast({
                    title: "提醒还没存好,你的选择已保留,稍后再试",
                    icon: "none",
                    duration: 2500,
                });
                return;
            }
            if (outcome === "diverged") {
                // F4-B4:补拉撞见远端已是不同内容且用户从未看过:不得直接写——
                // 候选保留,进入既有冲突双值面板(远端值 vs 本地候选),显式选边后
                // 经保存修改按最新轮次提交(与 remindSet 撞 VERSION_CONFLICT 同口径)
                this.setPendingRemind(value);
                const result = await this.refreshForConflict();
                if (result === "notfound") {
                    wx.showModal({
                        title: "记录不存在",
                        content: "没有找到这条记录,可能已被删除。",
                        showCancel: false,
                        success: () => {
                            this.goBack();
                        },
                    });
                    return;
                }
                if (result === "refreshed") {
                    wx.showToast({
                        title: this.data.conflictPending
                            ? "提醒与最新记录冲突,请选择保留哪一版"
                            : this.remindRemoteUnknown && this.pendingRemindWrite() !== null
                                ? "提醒没存上,你的选择已保留,点保存修改再试"
                                : hadReminder
                                    ? "这条提醒刚被家人改过,已刷新"
                                    : "这条刚带上提醒,已刷新",
                        icon: "none",
                        duration: 2500,
                    });
                }
                return;
            }
            if (value === this.remindOriginal) {
                return; // 补拉后远端已是这个日子:无需再写
            }
        }
        this.setData({ remindBusy: true });
        try {
            const res = await (0, api_1.callItemsApi)({
                action: "remindSet",
                item_id: this.data.itemId,
                due_date: value,
                // 轮次未知已被上方 F4-B2 门禁拦下,这里必带轮次(≥0),绝不省略
                expected_generation: this.data.remindGeneration,
            });
            if (res.reminder) {
                this.applyReminderRow(res.reminder);
                if (wantsNotify && !this.data.notifyAccepted) {
                    // 用户想要提醒且「提醒我」的立即授权没有成功(未 accept/被手势拒):
                    // 清「已开启」标记让 chip 露出引导点按(一次性订阅额度随每次发送
                    // 消耗,新提醒需要新的授权),toast 一并指路。notifyAccepted 已为
                    // true = 立即授权已成功,跳过(入口保持收起,不出多余引导)
                    (0, notify_accepted_1.clearNotifyAccepted)();
                    this.setData({ notifyAccepted: false });
                    wx.showToast({
                        title: "提醒已设好;点「到期时微信提醒我」开微信推送",
                        icon: "none",
                        duration: 2500,
                    });
                }
                else if (!wantsNotify) {
                    wx.showToast({
                        title: hadReminder
                            ? "提醒已改到 " + (0, remind_ui_1.monthDayText)(res.reminder.due_date)
                            : "已带上提醒:" + (0, remind_ui_1.monthDayText)(res.reminder.due_date) + " 到期",
                        icon: "none",
                    });
                }
            }
            else {
                // 不应发生(remindSet 必回所设行):回查一次,如实收敛
                await this.refreshReminderRow();
            }
        }
        catch (e) {
            if (e instanceof api_1.ApiError && e.code === "VERSION_CONFLICT") {
                // 他处已改这条提醒:你正要存的日子留在表单,进入四字段双值对比,
                // 显式选择保留哪一版;选「保留我的修改」后按最新轮次号重发(见 onSaveTap)
                this.setPendingRemind(value);
                const result = await this.refreshForConflict();
                if (result === "notfound") {
                    wx.showModal({
                        title: "记录不存在",
                        content: "没有找到这条记录,可能已被删除。",
                        showCancel: false,
                        success: () => {
                            this.goBack();
                        },
                    });
                    return;
                }
                if (result === "refreshed") {
                    wx.showToast({
                        title: this.data.conflictPending
                            ? "提醒与最新记录冲突,请选择保留哪一版"
                            : this.remindRemoteUnknown && this.pendingRemindWrite() !== null
                                ? "提醒没存上,你的选择已保留,点保存修改再试"
                                : hadReminder
                                    ? "这条提醒刚被家人改过,已刷新"
                                    : "这条刚带上提醒,已刷新",
                        icon: "none",
                        duration: 2500,
                    });
                }
                return;
            }
            wx.showModal({
                title: hadReminder ? "提醒没改成" : "提醒没带上",
                content: (0, api_1.errorMessage)(e),
                showCancel: false,
            });
        }
        finally {
            this.setData({ remindBusy: false });
        }
    },
    /** 编辑折叠「提醒」✕:连日期一起清除(remindClear,带所见轮次号);日期唯一作用就是出现在「快到期」,没有「存日期但不提醒」 */
    async onRemindFieldClear() {
        if (this.data.remindBusy || !this.data.remindAt) {
            return;
        }
        if (this.hasRemindConflict() || this.pendingRemindWrite() !== null) {
            // 冲突面板待选期间,或提醒远端不可得、选择还在表单待补写(F4-B1):
            // 清除只更新面板「你的修改」/候选为「不带提醒」并撤回选择,不直接落库
            // ——必须点按钮显式选边,或经保存修改补写
            this.setPendingRemind("");
            this.syncConflictFromInput("remind", "");
            if (!this.hasRemindConflict()) {
                wx.showToast({
                    title: "提醒没存上,你的选择已保留,点保存修改再试",
                    icon: "none",
                    duration: 2500,
                });
            }
            return;
        }
        if (this.data.remindGeneration < 0) {
            // F4-B2:轮次未知时清除同样是 reminder 写——先补拉取轮次,拉不到就
            // 失败关闭:候选(不带提醒)保留在表单,绝不无条件清除家人的提醒
            const outcome = await this.reloadRemindGeneration();
            if (outcome === "unknown") {
                this.setPendingRemind("");
                wx.showToast({
                    title: "还没改成,提醒还没加载好,稍后再试",
                    icon: "none",
                    duration: 2500,
                });
                return;
            }
            if (outcome === "diverged") {
                // F4-B4:补拉撞见远端已是不同内容且用户从未看过:不得直接清——
                // 候选(不带提醒)保留,进入既有冲突双值面板显式选边
                //(与 remindClear 撞 VERSION_CONFLICT 同口径)
                this.setPendingRemind("");
                const result = await this.refreshForConflict();
                if (result === "notfound") {
                    wx.showModal({
                        title: "记录不存在",
                        content: "没有找到这条记录,可能已被删除。",
                        showCancel: false,
                        success: () => {
                            this.goBack();
                        },
                    });
                    return;
                }
                if (result === "refreshed") {
                    wx.showToast({
                        title: this.data.conflictPending
                            ? "提醒与最新记录冲突,请选择保留哪一版"
                            : this.remindRemoteUnknown && this.pendingRemindWrite() !== null
                                ? "提醒没存上,你的选择已保留,点保存修改再试"
                                : "这条提醒刚被家人改过,已刷新",
                        icon: "none",
                        duration: 2500,
                    });
                }
                return;
            }
            if (this.remindOriginal === "") {
                // 补拉确认远端已无提醒:没有可清除的,不发空写,表单对齐远端事实
                this.setData({ remindAt: "" });
                wx.showToast({ title: "已不带提醒", icon: "none" });
                return;
            }
        }
        this.setData({ remindBusy: true });
        try {
            await (0, api_1.callItemsApi)({
                action: "remindClear",
                item_id: this.data.itemId,
                // 轮次未知已被上方 F4-B2 门禁拦下,这里必带轮次(≥0),绝不省略
                expected_generation: this.data.remindGeneration,
            });
            this.setData({ expire: null, remindAt: "", remindGeneration: 0 });
            this.remindOriginal = "";
            wx.showToast({ title: "已不带提醒", icon: "none" });
        }
        catch (e) {
            if (e instanceof api_1.ApiError && e.code === "VERSION_CONFLICT") {
                // 他处已改这条提醒:「不带提醒」的选择留在表单,进入四字段双值对比,
                // 显式选择保留哪一版,绝不静默删掉别人的新提醒
                this.setPendingRemind("");
                const result = await this.refreshForConflict();
                if (result === "notfound") {
                    wx.showModal({
                        title: "记录不存在",
                        content: "没有找到这条记录,可能已被删除。",
                        showCancel: false,
                        success: () => {
                            this.goBack();
                        },
                    });
                    return;
                }
                if (result === "refreshed") {
                    wx.showToast({
                        title: this.data.conflictPending
                            ? "提醒与最新记录冲突,请选择保留哪一版"
                            : this.remindRemoteUnknown && this.pendingRemindWrite() !== null
                                ? "提醒没存上,你的选择已保留,点保存修改再试"
                                : "这条提醒刚被家人改过,已刷新",
                        icon: "none",
                        duration: 2500,
                    });
                }
                return;
            }
            wx.showModal({
                title: "没改成",
                content: (0, api_1.errorMessage)(e),
                showCancel: false,
            });
        }
        finally {
            this.setData({ remindBusy: false });
        }
    },
    /* ---------------- 照片证据回放(#3 §6) ---------------- */
    /**
     * 拉当前家庭这件的照片证据行(只取数,不上屏):经 households 资格复核后
     * 捕获作用域代数,响应回来复核——在途家庭切换时旧家庭证据不上屏;
     * 复核失败或加载失败返回 undefined,调用方静默(证据是增强露出,
     * fetchReminderRow 同款口径:绝不把旧家庭/失败当作「无证据」)。
     */
    async fetchEvidenceRows() {
        if (!this.data.itemId) {
            return undefined;
        }
        try {
            await (0, households_api_1.ensureScopeVerified)();
        }
        catch (e) {
            return undefined; // 复核失败:静默,证据卡不渲染
        }
        const scopeGen = (0, household_scope_1.captureScopeGeneration)();
        try {
            const res = await (0, api_1.callItemsApi)({
                action: "photoEvidenceGet",
                item_ids: [this.data.itemId],
            });
            if (!(0, household_scope_1.isScopeGenerationCurrent)(scopeGen)) {
                return undefined; // 在途期间家庭已切换:旧家庭响应不可用
            }
            return res.evidence;
        }
        catch (e) {
            return undefined; // 静默:详情主体照常
        }
    },
    /**
     * 刷新证据卡:先收起旧卡(家庭切换/换物品后冷启动,展示前不得残留旧
     * 作用域证据),再拉取。有行 → mapEvidenceView 派生渲染视图(「位置已
     * 变更」按当前表单位置文本判定);无行 → 只显「去补拍」;失败 → 整卡
     * 不渲染。文案纪律:照片是历史证据,只说明拍摄当日记录在哪,绝不冒充
     * 当前位置——位置已变更时以文字位置为准,旧照片仅作证据。
     */
    async refreshEvidence() {
        this.setData({
            evidenceReady: false,
            evidenceNoPhoto: false,
            evidenceOpen: false,
            evidenceOlderOpen: false,
            evidence: null,
        });
        const rows = await this.fetchEvidenceRows();
        if (rows === undefined) {
            return;
        }
        if (rows.length === 0) {
            this.setData({ evidenceNoPhoto: true });
            return;
        }
        this.setData({
            evidenceReady: true,
            evidence: (0, evidence_view_1.mapEvidenceView)(rows, this.data.locationText),
        });
    },
    onEvidenceTap() {
        if (this.data.evidence !== null && this.data.evidence.latest.urlFail) {
            // 换链失败(file_id 仍在):点按 = 重新调 photoEvidenceGet 重试
            void this.refreshEvidence();
            return;
        }
        this.setData({ evidenceOpen: !this.data.evidenceOpen });
    },
    onEvidenceOlderToggle() {
        this.setData({ evidenceOlderOpen: !this.data.evidenceOlderOpen });
    },
    onRetakeTap() {
        // 重拍更新 / 去补拍:进拍照页开新一批(不带恢复参数,§6.4)
        wx.navigateTo({
            url: "/pages/photo/photo",
            fail: () => {
                wx.showToast({ title: "页面打开失败,请重试", icon: "none" });
            },
        });
    },
    /* ---------------- 单件视频留证与回放 ---------------- */
    async fetchVideoEvidenceRows() {
        if (this.data.itemId === "")
            return undefined;
        try {
            await (0, households_api_1.ensureScopeVerified)();
        }
        catch (e) {
            return undefined;
        }
        const scopeGen = (0, household_scope_1.captureScopeGeneration)();
        try {
            const res = await (0, api_1.callItemsApi)({ action: "videoEvidenceGet", item_ids: [this.data.itemId] });
            if ((0, household_scope_1.isScopeGenerationCurrent)(scopeGen) === false)
                return undefined;
            return res.evidence;
        }
        catch (e) {
            return undefined;
        }
    },
    async refreshVideoEvidence() {
        this.setData({ videoReady: false, videoEvidence: null, videoOpen: false });
        const rows = await this.fetchVideoEvidenceRows();
        if (rows === undefined || rows.length === 0)
            return;
        const view = (0, video_evidence_1.mapVideoEvidenceView)(rows, this.data.locationText);
        if (view === null)
            return;
        this.setData({ videoReady: true, videoEvidence: view, videoOpen: false });
    },
    refreshVideoPending() {
        const pending = (0, video_attach_1.loadPendingVideo)((0, household_scope_1.householdScopeId)(), this.data.itemId);
        if (pending !== null && pending.itemId === this.data.itemId) {
            this.setData({
                videoPending: pending,
                videoPendingText: "视频已上传,但还没有确认关联到这件物品。可重试关联;不再需要时请删除待关联视频。",
            });
            return;
        }
        this.setData({ videoPending: null, videoPendingText: "" });
    },
    onVideoToggle() {
        if (this.data.videoEvidence !== null && this.data.videoEvidence.latest.urlFail) {
            void this.refreshVideoEvidence();
            return;
        }
        this.setData({ videoOpen: this.data.videoOpen === false });
    },
    onVideoRetry() {
        void this.refreshVideoEvidence();
    },
    onVideoMoreTap() {
        wx.showModal({
            title: "视频留证说明",
            content: "视频只作为这件物品的历史证据,说明拍摄当时东西在哪,不冒充当前位置。视频默认折叠,你点击后才播放;删除这件物品或手动删除视频时,原视频会一起删除。",
            showCancel: false,
        });
    },
    async onAddVideoTap() {
        if (this.data.videoBusy)
            return;
        const itemId = this.data.itemId;
        if (itemId === "")
            return;
        try {
            await (0, households_api_1.ensureScopeVerified)();
        }
        catch (e) {
            wx.showToast({ title: "暂时无法确认当前家庭,请稍后重试", icon: "none" });
            return;
        }
        const consent = await new Promise((resolve) => {
            wx.showModal({
                title: "保存视频留证",
                content: "视频会保存为这件物品的历史证据,仅你和家人可通过云函数换临时链接回放;删除这件物品或手动删除视频时,原视频会一起删除。现在拍摄或选择视频?",
                confirmText: "继续",
                cancelText: "取消",
                success: (r) => resolve(r.confirm === true),
                fail: () => resolve(false),
            });
        });
        if (consent === false)
            return;
        this.setData({ videoBusy: true });
        const file = await (0, video_attach_1.chooseVideoFile)();
        if (file === null) {
            this.setData({ videoBusy: false });
            return;
        }
        const scopeId = (0, household_scope_1.householdScopeId)();
        const outcome = await (0, video_attach_1.attachVideoToItem)({ itemId: itemId, scopeId: scopeId, file: file });
        if (outcome.ok) {
            this.setData({ videoBusy: false, videoPending: null, videoPendingText: "" });
            await this.refreshVideoEvidence();
            wx.showToast({ title: "视频已留证", icon: "success" });
            return;
        }
        this.setData({ videoBusy: false });
        this.refreshVideoPending();
        wx.showModal({
            title: "视频还没关联成功",
            content: outcome.message,
            showCancel: false,
        });
    },
    async onVideoRetakeTap() {
        await this.onAddVideoTap();
    },
    async onVideoDeleteTap() {
        if (this.data.videoEvidence === null || this.data.videoBusy)
            return;
        const confirmed = await new Promise((resolve) => {
            wx.showModal({
                title: "删除视频",
                content: "删除后这件物品的全部视频会从云存储一并删除,不能恢复。确定删除吗?",
                confirmText: "删除",
                confirmColor: "#d93025",
                cancelText: "取消",
                success: (r) => resolve(r.confirm === true),
                fail: () => resolve(false),
            });
        });
        if (confirmed === false)
            return;
        this.setData({ videoBusy: true });
        try {
            await (0, households_api_1.ensureScopeVerified)();
            await (0, api_1.callItemsApi)({ action: "videoEvidenceDelete", item_id: this.data.itemId });
            this.setData({ videoBusy: false });
            await this.refreshVideoEvidence();
            wx.showToast({ title: "已删除视频", icon: "success" });
        }
        catch (e) {
            this.setData({ videoBusy: false });
            wx.showModal({ title: "删除失败", content: (0, api_1.errorMessage)(e), showCancel: false });
        }
    },
    async onVideoPendingRetryTap() {
        if (this.data.videoPending === null || this.data.videoBusy)
            return;
        try {
            await (0, households_api_1.ensureScopeVerified)();
        }
        catch (e) {
            wx.showToast({ title: "暂时无法确认当前家庭,请稍后重试", icon: "none" });
            return;
        }
        this.setData({ videoBusy: true });
        const outcome = await (0, video_attach_1.retryPendingVideo)(this.data.videoPending);
        this.setData({ videoBusy: false });
        if (outcome.ok) {
            this.setData({ videoPending: null, videoPendingText: "" });
            await this.refreshVideoEvidence();
            wx.showToast({ title: "视频已关联", icon: "success" });
            return;
        }
        wx.showModal({ title: "还没关联成功", content: outcome.message, showCancel: false });
    },
    async onVideoPendingDiscardTap() {
        if (this.data.videoPending === null || this.data.videoBusy)
            return;
        const confirmed = await new Promise((resolve) => {
            wx.showModal({
                title: "删除待关联视频",
                content: "会删除已经上传但还没关联成功的原视频。确定删除吗?",
                confirmText: "删除",
                confirmColor: "#d93025",
                cancelText: "取消",
                success: (r) => resolve(r.confirm === true),
                fail: () => resolve(false),
            });
        });
        if (confirmed === false)
            return;
        this.setData({ videoBusy: true });
        const outcome = await (0, video_attach_1.discardPendingVideo)(this.data.videoPending);
        this.setData({ videoBusy: false });
        if (outcome.ok === false) {
            wx.showModal({ title: "删除失败", content: outcome.message, showCancel: false });
            return;
        }
        this.setData({ videoPending: null, videoPendingText: "" });
        wx.showToast({ title: "已删除待关联视频", icon: "success" });
    },
    noop() { },
});
