"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const locations_api_1 = require("../../utils/locations-api");
const api_1 = require("../../utils/api");
/** 中断恢复:提交前写入 storage 的完整请求(operation_id 原样复用,收敛式重放) */
const PENDING_KEY = "location_scan_pending";
Page({
    data: {
        phase: "loading",
        scanError: "",
        truncatedTip: "",
        scannedText: "",
        treeRows: [],
        synonymRows: [],
        mountRows: [],
        mountCountText: "",
        skipRows: [],
        submitError: "",
        pendingRetry: false,
        resultBranchText: "",
        resultRows: [],
    },
    draftTree: [],
    draftMounts: [],
    synonymGroups: [],
    pendingRequest: null,
    dirty: false,
    uidSeq: 0,
    onLoad() {
        this.resumeOrStart();
    },
    /** 中断恢复:有未清除的提交记录时先问用户(继续 = 同 operation_id 重放) */
    resumeOrStart() {
        let pending = null;
        try {
            const raw = wx.getStorageSync(PENDING_KEY);
            if (raw && raw.operation_id) {
                pending = raw;
            }
        }
        catch (e) {
            pending = null;
        }
        if (pending) {
            this.pendingRequest = pending;
            wx.showModal({
                title: "有未完成的挂载",
                content: "上次生成空间树时有一笔提交没有完成,继续完成吗?(已完成的件不会重复处理)",
                confirmText: "继续",
                cancelText: "放弃",
                success: (r) => {
                    if (r.confirm && this.pendingRequest) {
                        void this.submit(this.pendingRequest);
                    }
                    else {
                        // 放弃:只清本地记录,已完成的件保持(不做假回滚)
                        try {
                            wx.removeStorageSync(PENDING_KEY);
                        }
                        catch (e) {
                            /* 清理失败不影响主流程 */
                        }
                        this.pendingRequest = null;
                        void this.startScan();
                    }
                },
            });
            return;
        }
        void this.startScan();
    },
    /** 进入即扫描(增量池 = 未挂载物品);AI_UNAVAILABLE → 错误态 + 手动兜底引导 */
    async startScan() {
        this.setData({ phase: "loading", scanError: "" });
        try {
            const res = await (0, locations_api_1.callLocationsApi)({ action: "scanHousehold" });
            const scan = res.scan;
            if (scan.mounts.length === 0 && scan.skipped.length === 0) {
                this.setData({ phase: "empty" });
                return;
            }
            this.buildDrafts(scan);
            this.setData({
                phase: "confirm",
                truncatedTip: scan.truncated
                    ? "未归位共 " + scan.unmounted_total + " 件,本次扫描最近 " + scan.scanned + " 件"
                    : "",
                scannedText: "本次扫描 " + scan.scanned + " 件,解析出 " + scan.mounts.length + " 件可归位",
                skipRows: scan.skipped.map((s) => ({
                    item_id: s.item_id,
                    name: s.name,
                    reasonText: s.reason === "位置为空"
                        ? "没记过位置——去详情页补一句,下次扫描就能归位"
                        : "这次没解析出位置,可去详情页手动挂到空间",
                })),
                synonymRows: scan.synonym_groups.map((g, i) => ({
                    key: "syn" + i,
                    namesText: g.names.map((n) => "「" + n + "」").join(" 与 "),
                    levelText: "第 " + (g.level + 1) + " 层:",
                    status: "pending",
                    keptName: "",
                })),
            });
            this.synonymGroups = scan.synonym_groups.map((g) => ({
                level: g.level,
                names: g.names.slice(),
            }));
            this.refreshConfirmView();
        }
        catch (e) {
            this.setData({ phase: "error", scanError: (0, api_1.errorMessage)(e) });
        }
    },
    /** 候选树 → 草案结构(分配 uid);mounts 逐段对齐到树节点 */
    buildDrafts(scan) {
        this.uidSeq = 0;
        const tree = [];
        const ingest = (nodes, level) => {
            for (const c of nodes) {
                const d = {
                    uid: "n" + this.uidSeq++,
                    name: c.name,
                    confidence: c.confidence,
                    needConfirm: c.need_confirm,
                    hintName: c.merge_hints && c.merge_hints.length > 0
                        ? c.merge_hints[0].existing_name
                        : "",
                    checked: !c.need_confirm,
                    children: [],
                };
                level.push(d);
                ingest(c.children, d.children);
            }
        };
        ingest(scan.candidate_tree, tree);
        this.draftTree = tree;
        this.draftMounts = scan.mounts.map((m) => {
            let level = tree;
            const uids = [];
            let aligned = true;
            for (const seg of m.path) {
                const hit = level.find((n) => n.name === seg);
                if (!hit) {
                    aligned = false;
                    break;
                }
                uids.push(hit.uid);
                level = hit.children;
            }
            return {
                item_id: m.item_id,
                name: m.name,
                locationText: m.location_text,
                version: m.version,
                needConfirm: m.need_confirm,
                orderViolation: m.order_violation,
                uids: aligned ? uids : [],
                origPath: m.path.slice(),
                checked: !m.need_confirm,
            };
        });
        this.dirty = false;
    },
    findNode(uid, nodes) {
        const list = nodes || this.draftTree;
        for (const n of list) {
            if (n.uid === uid) {
                return n;
            }
            const hit = this.findNode(uid, n.children);
            if (hit) {
                return hit;
            }
        }
        return undefined;
    },
    /** 该件当前确认路径:优先树节点当前名(用户改名后跟随),对齐失败回退原始分段 */
    pathNamesOf(mount) {
        if (mount.uids.length > 0) {
            const names = [];
            for (const uid of mount.uids) {
                const node = this.findNode(uid);
                if (!node) {
                    return mount.origPath;
                }
                names.push(node.name);
            }
            return names;
        }
        return mount.origPath;
    },
    flattenTree() {
        const rows = [];
        const walk = (nodes, depth) => {
            for (const n of nodes) {
                rows.push({
                    uid: n.uid,
                    depth,
                    name: n.name,
                    confidenceText: Math.round(n.confidence * 100) + "%",
                    needConfirm: n.needConfirm,
                    hintName: n.hintName,
                    checked: n.checked,
                });
                walk(n.children, depth + 1);
            }
        };
        walk(this.draftTree, 0);
        return rows;
    },
    flattenMounts() {
        return this.draftMounts.map((m) => ({
            item_id: m.item_id,
            name: m.name,
            pathText: this.pathNamesOf(m).join(" / "),
            needConfirm: m.needConfirm,
            orderViolation: m.orderViolation,
            checked: m.checked,
        }));
    },
    refreshConfirmView() {
        const rows = this.flattenMounts();
        const checkedCount = rows.filter((r) => r.checked).length;
        this.setData({
            treeRows: this.flattenTree(),
            mountRows: rows,
            mountCountText: "已勾选 " + checkedCount + " / " + rows.length + " 件",
        });
    },
    /** 同层同名归并(改名/近义合并后调用):保留先出现者,children 合并;返回旧 uid → 保留 uid 映射 */
    coalesce(nodes, map) {
        const seen = new Map();
        const out = [];
        for (const n of nodes) {
            n.children = this.coalesce(n.children, map);
            const existing = seen.get(n.name);
            if (existing) {
                existing.children = existing.children.concat(n.children);
                existing.children = this.coalesce(existing.children, map);
                if (n.needConfirm) {
                    existing.needConfirm = true;
                }
                if (n.checked) {
                    existing.checked = true;
                }
                if (!existing.hintName && n.hintName) {
                    existing.hintName = n.hintName;
                }
                map.set(n.uid, existing.uid);
            }
            else {
                seen.set(n.name, n);
                out.push(n);
            }
        }
        return out;
    },
    remapMounts(map) {
        if (map.size === 0) {
            return;
        }
        this.draftMounts = this.draftMounts.map((m) => ({
            ...m,
            uids: m.uids.map((uid) => (map.has(uid) ? map.get(uid) : uid)),
        }));
    },
    applyTreeEdits() {
        const map = new Map();
        this.draftTree = this.coalesce(this.draftTree, map);
        this.remapMounts(map);
        this.refreshConfirmView();
    },
    markDirty() {
        this.dirty = true;
        this.setData({ pendingRetry: false });
    },
    setSubtreeChecked(node, value) {
        node.checked = value;
        for (const c of node.children) {
            this.setSubtreeChecked(c, value);
        }
    },
    /** 勾选/取消整条分支(级联全部后代) */
    onTreeToggle(e) {
        const uid = String(e.currentTarget.dataset.uid || "");
        const node = this.findNode(uid);
        if (!node) {
            return;
        }
        this.setSubtreeChecked(node, !node.checked);
        this.markDirty();
        this.refreshConfirmView();
    },
    /** 节点改名(只影响本草案;改名成与兄弟同名会自动归并) */
    onTreeRename(e) {
        const uid = String(e.currentTarget.dataset.uid || "");
        const node = this.findNode(uid);
        if (!node) {
            return;
        }
        wx.showModal({
            title: "改分支名",
            editable: true,
            placeholderText: node.name,
            success: (r) => {
                if (!r.confirm) {
                    return;
                }
                const name = (r.content || "").trim();
                if (!name) {
                    wx.showToast({ title: "名称不能为空", icon: "none" });
                    return;
                }
                if (name === node.name) {
                    return;
                }
                node.name = name;
                this.markDirty();
                this.applyTreeEdits();
            },
        });
    },
    renameAtLevel(nodes, depth, names, keep) {
        if (depth <= 0) {
            for (const n of nodes) {
                if (n.name !== keep && names.indexOf(n.name) !== -1) {
                    n.name = keep;
                }
            }
            return;
        }
        for (const n of nodes) {
            this.renameAtLevel(n.children, depth - 1, names, keep);
        }
    },
    onMountToggle(e) {
        const index = Number(e.currentTarget.dataset.index);
        const mount = this.draftMounts[index];
        if (!mount) {
            return;
        }
        mount.checked = !mount.checked;
        this.markDirty();
        this.refreshConfirmView();
    },
    /** 近义组「合并」:用户选保留名,其余改名归并(合不合并永远用户裁决) */
    onSynonymMerge(e) {
        const index = Number(e.currentTarget.dataset.index);
        const group = this.synonymGroups[index];
        if (!group || group.names.length < 2) {
            return;
        }
        wx.showActionSheet({
            itemList: group.names.map((n) => "保留「" + n + "」"),
            success: (r) => {
                const keep = group.names[r.tapIndex];
                if (!keep) {
                    return;
                }
                this.renameAtLevel(this.draftTree, group.level + 1, group.names, keep);
                this.markDirty();
                this.applyTreeEdits();
                this.setSynonymStatus(index, "merged", keep);
            },
            fail: () => { },
        });
    },
    onSynonymDismiss(e) {
        const index = Number(e.currentTarget.dataset.index);
        this.setSynonymStatus(index, "dismissed", "");
    },
    setSynonymStatus(index, status, keptName) {
        const rows = this.data.synonymRows.slice();
        if (!rows[index]) {
            return;
        }
        rows[index] = { ...rows[index], status, keptName };
        this.setData({ synonymRows: rows });
    },
    /** 勾选树分支的路径集合:去重 + 前缀消除(深层路径已覆盖浅层) */
    collectBranches() {
        const paths = [];
        const walk = (nodes, prefix) => {
            for (const n of nodes) {
                const p = prefix.concat([n.name]);
                if (n.checked) {
                    paths.push(p);
                }
                walk(n.children, p);
            }
        };
        walk(this.draftTree, []);
        const keys = paths.map((p) => p.join("/"));
        const kept = [];
        const seen = [];
        for (let i = 0; i < paths.length; i++) {
            const key = keys[i];
            const covered = keys.some((other, j) => i !== j && (other === key || other.indexOf(key + "/") === 0));
            if (!covered && seen.indexOf(key) === -1) {
                seen.push(key);
                kept.push({ path: paths[i] });
            }
        }
        return kept;
    },
    collectMounts() {
        return this.draftMounts
            .filter((m) => m.checked)
            .map((m) => ({
            item_id: m.item_id,
            expected_version: m.version,
            path: this.pathNamesOf(m),
        }));
    },
    buildRequest() {
        const mounts = this.collectMounts();
        const names = {};
        for (const m of this.draftMounts) {
            names[m.item_id] = m.name;
        }
        return {
            operation_id: (0, api_1.uuid)(),
            branches: this.collectBranches(),
            mounts,
            names,
        };
    },
    /** 确认入库:一次 applyScan;提交前写 storage,成功后清除(中断恢复用) */
    onSubmitTap() {
        if (this.data.phase === "submitting") {
            return;
        }
        // 上次提交失败且草案未被编辑:同 operation_id 同参数重放(服务端收敛式完成剩余件)
        const request = this.pendingRequest && !this.dirty ? this.pendingRequest : this.buildRequest();
        if (request.branches.length === 0 && request.mounts.length === 0) {
            wx.showToast({ title: "至少勾选一条分支或一件物品", icon: "none" });
            return;
        }
        void this.submit(request);
    },
    async submit(request) {
        this.pendingRequest = request;
        this.setData({ phase: "submitting", submitError: "" });
        try {
            wx.setStorageSync(PENDING_KEY, request);
        }
        catch (e) {
            // storage 写入失败不阻断提交(只影响中断恢复)
        }
        try {
            const res = await (0, locations_api_1.callLocationsApi)({
                action: "applyScan",
                operation_id: request.operation_id,
                branches: request.branches,
                mounts: request.mounts,
            });
            try {
                wx.removeStorageSync(PENDING_KEY);
            }
            catch (e) {
                /* 清理失败不影响主流程 */
            }
            this.pendingRequest = null;
            this.dirty = false;
            this.renderResult(res.result, request.names);
        }
        catch (e) {
            // 失败不放弃:pending 保留,回到确认页由用户重试(同 operation_id 收敛)
            this.setData({
                phase: "confirm",
                submitError: (0, api_1.errorMessage)(e),
                pendingRetry: true,
            });
        }
    },
    renderResult(result, names) {
        let created = 0;
        let reused = 0;
        for (const b of result.branches) {
            for (const c of b.created) {
                if (c) {
                    created += 1;
                }
                else {
                    reused += 1;
                }
            }
        }
        const rows = result.mounts.map((m) => {
            let statusText = "";
            let statusClass = "";
            let canOpen = false;
            if (m.status === "mounted") {
                statusText = "已挂载";
            }
            else if (m.status === "already") {
                statusText = "上次已完成,没有重复处理";
            }
            else if (m.status === "conflict") {
                statusText = "内容已变化,这次没挂上——去详情页重新挂载";
                statusClass = "result-warn";
                canOpen = true;
            }
            else {
                statusText = "物品已删除,无法挂载";
                statusClass = "result-dim";
            }
            return {
                item_id: m.item_id,
                name: names[m.item_id] || m.item_id,
                statusText,
                statusClass,
                canOpen,
            };
        });
        this.setData({
            phase: "done",
            resultBranchText: "位置:新建 " + created + " 个,复用已有 " + reused + " 个;物品 " + rows.length + " 件:",
            resultRows: rows,
        });
    },
    onRetryScan() {
        void this.startScan();
    },
    /** AI 不可用时的手动兜底:回「我的家」手动建房间 */
    onManualBuild() {
        wx.navigateBack({
            fail: () => {
                wx.reLaunch({ url: "/pages/locations/locations" });
            },
        });
    },
    onItemOpen(e) {
        const itemId = String(e.currentTarget.dataset.itemId || "");
        if (!itemId) {
            return;
        }
        wx.navigateTo({
            url: "/pages/item/item?item_id=" + encodeURIComponent(itemId),
            fail: () => {
                wx.showToast({ title: "页面打开失败,请重试", icon: "none" });
            },
        });
    },
    onDone() {
        wx.navigateBack({
            fail: () => {
                wx.reLaunch({ url: "/pages/locations/locations" });
            },
        });
    },
});
