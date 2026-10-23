"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/** 组属性运行时守卫:Object 属性缺省为 null,非对象一律视为无组 */
function groupOf(data) {
    const g = data.group;
    if (g === null || g === undefined || typeof g !== "object")
        return null;
    return g;
}
function datasetObsId(e) {
    const ds = e.currentTarget && e.currentTarget.dataset;
    return String((ds && ds.obsId) || "");
}
Component({
    properties: {
        group: Object,
        busy: Boolean,
    },
    data: {
        expanded: false,
        checkedIds: [],
        checkedMap: {},
        currentKey: "",
    },
    observers: {
        group(next) {
            // wx:for 复用组件实例换组时:清组内勾选(勾选是交互态,不跨组携带)
            const view = groupOf({ group: next });
            const key = view !== null && typeof view.nameKey === "string" ? view.nameKey : "";
            if (key !== this.data.currentKey) {
                this.setData({ currentKey: key, checkedIds: [], checkedMap: {} });
            }
        },
    },
    methods: {
        /** 点组卡头:切换展开;展开可浏览全部观察原图、框、时间点(规则 1) */
        onExpandToggle() {
            const group = groupOf(this.data);
            if (group === null)
                return;
            this.setData({ expanded: !this.data.expanded });
            this.triggerEvent("expand", { nameKey: group.nameKey });
        },
        /** 折叠卡代表帧缩略图:预览 current=代表帧,urls=组内全部帧(§3.2) */
        onRepFrameTap() {
            const group = groupOf(this.data);
            if (group === null)
                return;
            this.triggerEvent("obsPreview", { obsId: group.repFrame.obsId });
        },
        /** 行级勾选:已归属行不可勾(§2.4);选中上报 obsId,取消只改组内态不上报 */
        onObsToggle(e) {
            const obsId = datasetObsId(e);
            if (obsId === "")
                return;
            const group = groupOf(this.data);
            if (group !== null) {
                for (const row of group.observations) {
                    if (row.obsId === obsId && row.claimed)
                        return;
                }
            }
            const ids = (this.data.checkedIds || []).slice();
            const at = ids.indexOf(obsId);
            if (at === -1)
                ids.push(obsId);
            else
                ids.splice(at, 1);
            const map = {};
            for (const id of ids)
                map[id] = true;
            this.setData({ checkedIds: ids, checkedMap: map });
            if (at === -1)
                this.triggerEvent("obsToggle", { obsId });
        },
        /** 行缩略图:catchtap 只预览,不触发行勾选 */
        onObsImageTap(e) {
            const obsId = datasetObsId(e);
            if (obsId === "")
                return;
            this.triggerEvent("obsPreview", { obsId });
        },
        /** 就 1 件:obsIds=当前勾选(空=整组未归属,由页面 confirmSingleSet 解释);
         * 全组已归属时确认集为空,按钮无效(§2.1) */
        onConfirmSingleTap() {
            if (this.data.busy)
                return;
            const group = groupOf(this.data);
            if (group === null || group.remainingCount === 0)
                return;
            this.triggerEvent("confirmSingle", { nameKey: group.nameKey, obsIds: (this.data.checkedIds || []).slice() });
        },
        /** 有多件或需拆开:进入逐条模式(展开+行级勾选),不产生任何草稿(§2.2) */
        onConfirmMultiTap() {
            if (this.data.busy)
                return;
            const group = groupOf(this.data);
            if (group === null)
                return;
            this.setData({ expanded: true });
            this.triggerEvent("confirmMulti", { nameKey: group.nameKey });
        },
        /** 暂不确定:折叠该组卡,零数据变更(§2.3) */
        onDeferTap() {
            if (this.data.busy)
                return;
            const group = groupOf(this.data);
            if (group === null)
                return;
            this.setData({ expanded: false });
            this.triggerEvent("defer", { nameKey: group.nameKey });
        },
        /** 逐条模式生成:勾选线索各成一件(mergeSameName:false 语义在页面) */
        onGeneratePerObsTap() {
            if (this.data.busy)
                return;
            const group = groupOf(this.data);
            if (group === null)
                return;
            this.triggerEvent("generatePerObs", { nameKey: group.nameKey, obsIds: (this.data.checkedIds || []).slice() });
        },
    },
});
