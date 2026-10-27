'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
let definition, navigation;
globalThis.wx = { getStorageSync: () => '', setStorageSync() { }, removeStorageSync() { }, showToast() { }, showModal() { }, navigateTo: o => { navigation = o; }, pageScrollTo() { } };
globalThis.getCurrentPages = () => [];
globalThis.Page = d => { definition = d; };
require('../miniprogram/pages/item/item.js');
function page() {
    const p = { ...definition, data: structuredClone(definition.data) };
    p.setData = (d, cb) => {
        Object.assign(p.data, d);
        if (cb)
            cb();
    };
    p.original = { name: '棉柔巾', location: '旧位置', note: '原备注' };
    p.quantityOriginal = { quantity: 5, unit: '包' };
    p.data.name = '棉柔巾';
    p.data.recordedName = '棉柔巾';
    p.data.locationText = '旧位置';
    p.data.recordedLocationText = '旧位置';
    p.data.note = '原备注';
    p.data.spacePath = ['卫生间', '收纳柜'];
    p.data.itemId = 'test-item';
    p.remindOriginal = '';
    p.pendingRetry = null;
    p.quantityRetry = null;
    p.locationNodeDraft = null;
    p.locationLinkRetry = null;
    return p;
}
test('detail panels: opening location does not scroll or expose name editing; cancel restores only location', () => { const p = page(); p.onUpdateLocationTap(); assert.equal(p.data.detailPanel, 'location'); p.onLocationInput({ detail: { value: '新位置' } }); p.onPanelClose(); assert.equal(p.data.detailPanel, ''); assert.equal(p.data.locationText, '旧位置'); assert.equal(p.data.recordedLocationText, '旧位置'); });
test('detail panels: selecting classification is a draft, cancelling never calls link', () => { const p = page(); let writes = 0; p.doLinkToNode = async () => { writes++; return true; }; p.onUpdateLocationTap(); p.openLocationPicker(); navigation.events.pickNode({ location_id: 'node-new', path: ['卧室', '衣柜'] }); assert.equal(writes, 0); assert.equal(p.locationNodeDraft.nodeId, 'node-new'); assert.deepEqual(p.data.spacePath, ['卫生间', '收纳柜']); p.onPanelClose(); assert.equal(p.locationNodeDraft, null); assert.equal(writes, 0); });
test('detail panels: unresolved conflict survives closing and reopening', () => { const p = page(); p.data.conflicts = [{ key: 'location', choice: null }]; p.data.conflictPending = true; p.data.locationText = '未裁决草稿'; p.onUpdateLocationTap(); p.onPanelClose(); p.onUpdateLocationTap(); assert.equal(p.data.conflictPending, true); assert.equal(p.data.locationText, '未裁决草稿'); assert.equal(p.mountBlockedByConflict(), true); });
test('detail panels: quantity cancel leaves independent text drafts intact', () => { const p = page(); p.data.note = '尚未保存的备注'; p.onQuantityPanelToggle(); p.onQuantityInput({ detail: { value: '3' } }); p.onPanelClose(); assert.equal(p.data.note, '尚未保存的备注'); assert.equal(p.data.quantitySaving, false); });
test('detail panels: date selection only stages until explicit confirmation', () => { const p = page(); let dates = []; p.onRemindDateChange = async (e) => { dates.push(e.detail.value); }; p.onOpenReminderTap(); p.onReminderDraftChange({ detail: { value: '2026-11-15' } }); assert.deepEqual(dates, []); p.onPanelClose(); assert.deepEqual(dates, []); assert.equal(p.remindOriginal, ''); });
test('detail panels: ordinary media entry does not start playback; closing keeps pending', () => { const p = page(); p.data.videoPending = { ticket: 'pending' }; p.data.videoSelected = null; p.onMediaEntryTap(); assert.equal(p.data.detailPanel, 'media'); assert.equal(p.data.videoOpen, false); p.onPanelClose(); assert.deepEqual(p.data.videoPending, { ticket: 'pending' }); });
test('detail panels: partial position update stays open and reports classification failure', async () => { const p = page(); p.onUpdateLocationTap(); p.onLocationInput({ detail: { value: '新描述' } }); p.locationNodeDraft = { nodeId: 'new-node', path: ['卧室'] }; p.onSaveTap = async () => { p.original.location = '新描述'; p.data.recordedLocationText = '新描述'; }; p.doLinkToNode = async () => false; await p.onSaveLocationTap(); assert.equal(p.data.detailPanel, 'location'); assert.match(p.data.panelError, /描述已保存/); assert.equal(p.data.recordedLocationText, '新描述'); assert.ok(p.locationNodeDraft); });
test('detail panels: position failure prevents classification write', async () => { const p = page(); let links = 0; p.onUpdateLocationTap(); p.onLocationInput({ detail: { value: '未保存描述' } }); p.locationNodeDraft = { nodeId: 'new-node', path: ['卧室'] }; p.onSaveTap = async () => { }; p.doLinkToNode = async () => { links++; return true; }; await p.onSaveLocationTap(); assert.equal(links, 0); assert.equal(p.data.detailPanel, 'location'); });
test('detail panels: reminder confirmation blocks duplicate submit and closing during authorization', async () => { const p = page(); let finish, calls = 0; p.onRemindDateChange = async () => { calls++; await new Promise(resolve => { finish = resolve; }); p.remindOriginal = p.data.reminderDateDraft; p.data.remindAt = p.data.reminderDateDraft; }; p.onOpenReminderTap(); const first = p.onReminderConfirmTap(); assert.equal(p.data.reminderConfirming, true); await p.onReminderConfirmTap(); p.onPanelClose(); assert.equal(p.data.detailPanel, 'reminder'); assert.equal(calls, 1); finish(); await first; assert.equal(p.data.reminderConfirming, false); assert.equal(p.data.detailPanel, ''); });
test('detail panels: scope change during position save prevents subsequent classification write', async () => { const p = page(); let links = 0; p.onUpdateLocationTap(); p.onLocationInput({ detail: { value: '新位置' } }); p.locationNodeDraft = { nodeId: 'new-node', path: ['卧室'] }; p.onSaveTap = async () => { p.original.location = '新位置'; p.locationChoiceScope = -1; }; p.doLinkToNode = async () => { links++; return true; }; await p.onSaveLocationTap(); assert.equal(links, 0); assert.match(p.data.panelError, /家庭已切换/); assert.equal(p.data.detailPanel, 'location'); });
test('detail panels: changed-unit retry retains a visible recount confirmation after reopening', () => { const p = page(); const next = p.data.unitOptions.findIndex(unit => unit !== '包'); p.data.quantityUnitIndex = next; p.data.quantityDraft = '2'; p.quantityRetry = { updateId: 'retry-id', quantity: 2, unit: p.data.unitOptions[next] }; p.onQuantityPanelToggle(); assert.equal(p.data.quantityUnitChanged, true); assert.equal(p.data.quantityUnitVerified, false); assert.equal(p.data.quantityDraft, '2'); p.onPanelClose(); p.onQuantityPanelToggle(); assert.equal(p.data.quantityUnitChanged, true); assert.equal(p.data.unitOptions[p.data.quantityUnitIndex], p.quantityRetry.unit); });
