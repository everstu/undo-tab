import test from 'node:test';
import assert from 'node:assert/strict';

import { createUndoTabWorker } from '../background/worker.js';
import { createIncognitoSession } from '../background/incognito-session.js';
import { createSettingsStore } from '../background/settings-store.js';
import { createMockChrome } from './helpers/mock-chrome.js';

// 上限范围 10–1000；两个无痕上限取不同值，便于区分各自裁剪。
const limits = { recentMaxRecords: 12, historyMaxRecords: 14 };
const PAGES = 16;

function send(chrome, message) {
  const sender = { id: chrome.runtime.id, url: chrome.runtime.getURL('popup/popup.html') };
  return new Promise((resolve) => chrome.runtime.onMessage.emit(message, sender, resolve));
}

function range(from, to) {
  const list = [];
  for (let i = from; i >= to; i -= 1) list.push(`https://example.com/${i}`);
  return list;
}

async function setup() {
  const chrome = createMockChrome({ windows: [{ id: 1, incognito: false }, { id: 2, incognito: true }] });
  chrome.storage.local.data.settings = {
    schemaVersion: 2,
    popupWidth: 600,
    normal: { maxRecords: 14 },
    incognito: { ...limits },
  };
  const worker = createUndoTabWorker({ chrome, logger: { warn() {} } });
  await worker.ensureReady();
  for (let i = 1; i <= PAGES; i += 1) {
    const tab = chrome.__test.addTab({ windowId: 2, incognito: true, url: `https://example.com/${i}`, title: `Page ${i}` });
    chrome.webNavigation.onCommitted.emit({
      tabId: tab.id, frameId: 0, documentId: `doc-${i}`, documentLifecycle: 'active',
      url: tab.url, timeStamp: 1000 + i,
    });
    await worker.queue(async () => {});
    chrome.__test.removeTab(tab.id);
    await worker.queue(async () => {});
  }
  const query = (view) => send(chrome, { type: 'undoTab:queryView', windowId: 2, view, query: '' });
  return { chrome, worker, query };
}

test('真实 worker 接线分别使用关闭与访问上限，查询返回各自的上限', async () => {
  const { query, worker } = await setup();
  const recent = await query('recent');
  const history = await query('history');
  assert.equal(recent.ok, true);
  assert.equal(history.ok, true);
  assert.equal(recent.data.limit, 12);
  assert.equal(history.data.limit, 14);
  assert.deepEqual(recent.data.entries.map((x) => x.url), range(16, 5));
  assert.deepEqual(history.data.entries.map((x) => x.url), range(16, 3));
  assert.equal((await worker.stores.normalStore.getEntries()).length, 0);
});

test('保存与裁剪预览只影响指定的无痕列表，修改后持久保留', async () => {
  const { chrome, query, worker } = await setup();
  const previewRecent = await send(chrome, { type: 'undoTab:getTrimPreview', windowId: 2, view: 'recent', maxRecords: 10 });
  assert.equal(previewRecent.data.recent, 2);
  assert.equal(previewRecent.data.history, 0);
  const recentSaved = await send(chrome, { type: 'undoTab:updateSettings', windowId: 2, view: 'recent', patch: { maxRecords: 10 } });
  assert.equal(recentSaved.ok, true);
  assert.equal((await query('recent')).data.total, 10);
  assert.equal((await query('history')).data.total, 14);

  const previewHistory = await send(chrome, { type: 'undoTab:getTrimPreview', windowId: 2, view: 'history', maxRecords: 11 });
  assert.equal(previewHistory.data.recent, 0);
  assert.equal(previewHistory.data.history, 3);
  const historySaved = await send(chrome, { type: 'undoTab:updateSettings', windowId: 2, view: 'history', patch: { maxRecords: 11 } });
  assert.equal(historySaved.ok, true);
  assert.equal((await query('recent')).data.total, 10);
  assert.equal((await query('history')).data.total, 11);
  const reopened = createSettingsStore({ localArea: chrome.storage.local });
  assert.deepEqual(await reopened.get(), {
    schemaVersion: 2, popupWidth: 600, normal: { maxRecords: 14, historyMaxRecords: 14 },
    incognito: { recentMaxRecords: 10, historyMaxRecords: 11 },
  });

  // 空值、小数、非数字被拒绝，设置不变；缺少视图也被拒绝。
  const snapshot = await chrome.storage.local.get(null);
  for (const view of ['recent', 'history']) {
    for (const maxRecords of [1.5, '', 'abc']) {
      const failed = await send(chrome, { type: 'undoTab:updateSettings', windowId: 2, view, patch: { maxRecords } });
      assert.equal(failed.ok, false);
    }
  }
  const missingView = await send(chrome, { type: 'undoTab:updateSettings', windowId: 2, patch: { maxRecords: 50 } });
  assert.equal(missingView.ok, false);
  assert.deepEqual(await chrome.storage.local.get(null), snapshot);

  // 越界整数收紧到边界后保存：后台同样收紧，不依赖弹窗。
  const preview = await send(chrome, { type: 'undoTab:getTrimPreview', windowId: 2, view: 'history', maxRecords: 3 });
  assert.equal(preview.data.limit, 10);
  assert.equal(preview.data.history, 1);
  const low = await send(chrome, { type: 'undoTab:updateSettings', windowId: 2, view: 'history', patch: { maxRecords: 3 } });
  assert.equal(low.ok, true);
  assert.equal(low.data.settings.incognito.historyMaxRecords, 10);
  assert.equal((await query('history')).data.total, 10);
  const high = await send(chrome, { type: 'undoTab:updateSettings', windowId: 2, view: 'recent', patch: { maxRecords: 10001 } });
  assert.equal(high.ok, true);
  assert.equal(high.data.settings.incognito.recentMaxRecords, 1000);
  assert.equal((await query('recent')).data.total, 10);

  // 原有无痕清理行为不受两个上限的拆分影响。
  chrome.__test.closeWindow(2);
  chrome.windows.onRemoved.emit(2);
  await worker.queue(async () => {});
  assert.equal((await worker.stores.incognitoSession.query('recent', '')).total, 0);
  assert.equal((await worker.stores.incognitoSession.query('history', '')).total, 0);
});

test('旧无痕上限升级后两个值分别持久保存且不删除历史', async () => {
  const chrome = createMockChrome({ windows: [{ id: 1, incognito: false }] });
  chrome.storage.local.data.settings = {
    schemaVersion: 2, popupWidth: 700, normal: { maxRecords: 14 }, incognito: { maxRecords: 42 },
  };
  const existing = {
    generation: 0, lastOrder: 1000, deleted: {},
    entries: [{ id: 'kept', url: 'https://example.com/kept', urlKey: 'https://example.com/kept', title: 'Kept', closedAt: 1, order: 1000 }],
  };
  chrome.storage.local.data['normal.recent'] = existing;
  const worker = createUndoTabWorker({ chrome, logger: { warn() {} } });
  await worker.ensureReady();
  assert.deepEqual(chrome.storage.local.data.settings.incognito, { recentMaxRecords: 42, historyMaxRecords: 42 });
  assert.equal(chrome.storage.local.data.settings.popupWidth, 700);
  assert.deepEqual(chrome.storage.local.data.settings.normal, { maxRecords: 14, historyMaxRecords: 14 });
  assert.equal((await worker.stores.normalStore.getEntries())[0].url, 'https://example.com/kept');
  const writes = chrome.storage.local.control.writes;
  await createSettingsStore({ localArea: chrome.storage.local }).ensure();
  assert.equal(chrome.storage.local.control.writes, writes);
});

test('升级后越界的已保存上限收紧到 10–1000，超出的普通最近关闭在启动时裁剪', async () => {
  const chrome = createMockChrome({ windows: [{ id: 1, incognito: false }] });
  chrome.storage.local.data.settings = {
    schemaVersion: 2, popupWidth: 900,
    normal: { maxRecords: 5000, historyMaxRecords: 4 },
    incognito: { recentMaxRecords: 2, historyMaxRecords: 20000 },
  };
  const entries = Array.from({ length: 1005 }, (_, index) => ({
    id: `e${index}`,
    url: `https://example.com/old-${index}`,
    title: `Old ${index}`,
    closedAt: 100000 - index,
    order: (100000 - index) * 1000,
  }));
  chrome.storage.local.data['normal.recent'] = { generation: 0, lastOrder: 0, deleted: {}, entries };
  const worker = createUndoTabWorker({ chrome, logger: { warn() {} } });
  await worker.ensureReady();

  assert.deepEqual(chrome.storage.local.data.settings, {
    schemaVersion: 2,
    popupWidth: 800,
    normal: { maxRecords: 1000, historyMaxRecords: 10 },
    incognito: { recentMaxRecords: 10, historyMaxRecords: 1000 },
  });
  const kept = await worker.stores.normalStore.getEntries();
  assert.equal(kept.length, 1000);
  // 保留最新的 1000 条，删除最旧的 5 条。
  assert.equal(kept[0].url, 'https://example.com/old-0');
  assert.equal(kept[999].url, 'https://example.com/old-999');
  const recent = await send(chrome, { type: 'undoTab:queryView', windowId: 1, view: 'recent', query: '' });
  assert.equal(recent.data.total, 1000);
  assert.equal(recent.data.limit, 1000);

  // 再次初始化幂等：不再写入。
  const writes = chrome.storage.local.control.writes;
  await worker.stores.normalStore.startupMaintenance(1000);
  await createSettingsStore({ localArea: chrome.storage.local }).ensure();
  assert.equal(chrome.storage.local.control.writes, writes);
});

test('普通 worker 的最近关闭与历史独立设置，历史上限只限制展示并补足过滤缺口', async () => {
  const chrome = createMockChrome({ windows: [{ id: 1, incognito: false }] });
  chrome.storage.local.data.settings = {
    schemaVersion: 2, popupWidth: 600,
    normal: { maxRecords: 12, historyMaxRecords: 11 }, incognito: { ...limits },
  };
  // 210 条中 index 0/100/200 为 file 历史，有效网页共 207 条。
  const history = Array.from({ length: 210 }, (_, index) => ({
    url: index % 100 === 0 ? `file:///test-${index}` : `https://example.com/history-${index}`,
    title: 'History', lastVisitTime: 10000 - index,
  }));
  chrome.__test.setHistory(history);
  const worker = createUndoTabWorker({ chrome, logger: { warn() {} } });
  await worker.ensureReady();
  for (let index = 0; index < 15; index += 1) {
    const tab = chrome.__test.addTab({ windowId: 1, url: `https://example.com/recent-${index}` });
    chrome.__test.removeTab(tab.id);
    await worker.queue(async () => {});
  }
  const query = (view) => send(chrome, { type: 'undoTab:queryView', windowId: 1, view, query: '' });
  const recent = await query('recent');
  assert.equal(recent.data.total, 12);
  assert.equal(recent.data.limit, 12);
  assert.equal((await query('history')).data.loaded, 11);
  const before = structuredClone(chrome.storage.local.data['normal.recent']);
  const preview = await send(chrome, { type: 'undoTab:getTrimPreview', windowId: 1, view: 'history', maxRecords: 10 });
  assert.equal(preview.data.recent, 0);
  assert.equal(preview.data.history, 0);
  const saved = await send(chrome, { type: 'undoTab:updateSettings', windowId: 1, view: 'history', patch: { maxRecords: 10 } });
  assert.equal(saved.ok, true);
  assert.deepEqual(saved.data.settings.normal, { maxRecords: 12, historyMaxRecords: 10 });
  assert.deepEqual(chrome.storage.local.data['normal.recent'], before);
  assert.equal((await query('history')).data.loaded, 10);

  await send(chrome, { type: 'undoTab:updateSettings', windowId: 1, view: 'recent', patch: { maxRecords: 10 } });
  assert.equal((await query('recent')).data.total, 10);
  assert.equal((await query('history')).data.limit, 10);
  await send(chrome, { type: 'undoTab:updateSettings', windowId: 1, view: 'history', patch: { maxRecords: 200 } });
  const expanded = await query('history');
  assert.equal(expanded.data.loaded, 200);
  assert.equal(expanded.data.limitReached, true);
  assert.deepEqual((await createSettingsStore({ localArea: chrome.storage.local }).get()).normal,
    { maxRecords: 10, historyMaxRecords: 200 });
  assert.deepEqual(chrome.storage.local.data.settings.incognito, limits);
  assert.equal(chrome.storage.local.data.settings.popupWidth, 600);
  assert.equal((await chrome.history.search({ text: '', startTime: 0, maxResults: 1000 })).length, history.length);
  const snapshot = await chrome.storage.local.get(null);
  assert.equal(JSON.stringify(snapshot).includes('history-1'), false);
  for (const maxRecords of [1.5, '', 'abc']) {
    const failed = await send(chrome, { type: 'undoTab:updateSettings', windowId: 1, view: 'history', patch: { maxRecords } });
    assert.equal(failed.ok, false);
  }
  const invalidView = await send(chrome, { type: 'undoTab:updateSettings', windowId: 1, view: 'invalid', patch: { maxRecords: 50 } });
  assert.equal(invalidView.ok, false);
  assert.deepEqual(await chrome.storage.local.get(null), snapshot);

  // 越界上调收紧为 1000：有效匹配只有 207 条时展示实际条数，不宣称达到上限。
  const clamped = await send(chrome, { type: 'undoTab:updateSettings', windowId: 1, view: 'history', patch: { maxRecords: 10001 } });
  assert.equal(clamped.data.settings.normal.historyMaxRecords, 1000);
  const all = await query('history');
  assert.equal(all.data.loaded, 207);
  assert.equal(all.data.limit, 1000);
  assert.equal(all.data.limitReached, false);
});

test('worker 重建后补写混合 pending 时分别按两个上限裁剪', async () => {
  const chrome = createMockChrome();
  const session = createIncognitoSession({ sessionArea: chrome.storage.session });
  const info = await session.syncWindows([2]);
  const state = chrome.storage.session.data['incognito.meta'];
  for (let i = 1; i <= PAGES; i += 1) {
    const common = { sessionId: info.sessionId, generation: 0, url: `https://example.com/${i}`, urlKey: `https://example.com/${i}`, order: 1000 + i };
    state.pending.push({ ...common, kind: 'close', eventId: `c${i}`, closedAt: 1000 + i });
    state.pending.push({ ...common, kind: 'visit', eventId: `v${i}`, visitedAt: 1000 + i });
  }
  const rebuilt = createIncognitoSession({ sessionArea: chrome.storage.session });
  const retried = await rebuilt.retryPending(limits);
  assert.equal(retried.applied, PAGES * 2);
  assert.equal(retried.pending, 0);
  assert.equal((await rebuilt.query('recent', '')).total, 12);
  assert.equal((await rebuilt.query('history', '')).total, 14);
});
