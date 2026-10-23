import test from 'node:test';
import assert from 'node:assert/strict';

import { createHistoryService } from '../background/history-service.js';
import { createIncognitoSession } from '../background/incognito-session.js';
import { createMessageHandler } from '../background/messenger.js';
import { createNormalStore } from '../background/normal-store.js';
import { createSettingsStore } from '../background/settings-store.js';
import { normalizeSettings } from '../shared/settings.js';
import { createMockChrome } from './helpers/mock-chrome.js';

function closeEvent(eventId, url, at = 1000, extra = {}) {
  return {
    eventId,
    url,
    title: '标题',
    closedAt: at,
    order: at * 1000,
    originalWindowId: 1,
    originalIndex: 0,
    wasPinned: false,
    hasFavicon: false,
    windowClosing: false,
    ...extra,
  };
}

async function setup() {
  const chrome = createMockChrome();
  const normalWin = chrome.__test.addWindow({ incognito: false });
  const incognitoWin = chrome.__test.addWindow({ incognito: true });
  chrome.__test.setCurrentWindow(normalWin.id);

  const settingsStore = createSettingsStore({ localArea: chrome.storage.local });
  await settingsStore.ensure();
  const normalStore = createNormalStore({
    localArea: chrome.storage.local,
    sessionArea: chrome.storage.session,
  });
  const incognitoSession = createIncognitoSession({
    sessionArea: chrome.storage.session,
    logger: { warn() {} },
  });
  await incognitoSession.syncWindows([incognitoWin.id]);
  const historyService = createHistoryService({ chromeApi: chrome });
  const handler = createMessageHandler({
    settingsStore,
    normalStore,
    incognitoSession,
    historyService,
    chromeApi: chrome,
    logger: { warn() {} },
  });
  const sender = { id: chrome.runtime.id, url: chrome.runtime.getURL('popup/popup.html') };
  return {
    chrome,
    normalWin,
    incognitoWin,
    settingsStore,
    normalStore,
    incognitoSession,
    handler,
    sender,
  };
}

test('拒绝非扩展弹窗来源的消息', async () => {
  const { handler } = await setup();
  const result = await handler(
    { type: 'undoTab:getContext', windowId: 1 },
    { id: 'other', url: 'https://example.com' },
  );
  assert.equal(result.ok, false);
  assert.match(result.error.message, /来源/);
});

test('getContext 由 windowId 重新确认模式', async () => {
  const { handler, sender, normalWin, incognitoWin } = await setup();
  const normal = await handler({ type: 'undoTab:getContext', windowId: normalWin.id }, sender);
  assert.equal(normal.ok, true);
  assert.equal(normal.data.mode, 'normal');
  assert.equal(normal.data.settings.normal.maxRecords, 100);
  assert.equal(normal.data.settings.normal.historyMaxRecords, 100);

  const incognito = await handler({ type: 'undoTab:getContext', windowId: incognitoWin.id }, sender);
  assert.equal(incognito.data.mode, 'incognito');
  assert.equal(incognito.data.session.active, true);
});

test('不存在的窗口返回 context-lost', async () => {
  const { handler, sender } = await setup();
  const result = await handler({ type: 'undoTab:getContext', windowId: 999999 }, sender);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'context-lost');
});

test('普通窗口查询只返回普通最近关闭，不泄露无痕数据', async () => {
  const { handler, sender, normalWin, incognitoWin, normalStore, incognitoSession } = await setup();
  await normalStore.recordClose(closeEvent('n1', 'https://normal.example/a', 1000), 500);
  await incognitoSession.recordClose(closeEvent('i1', 'https://incognito.example/a', 2000), 500);

  const normalView = await handler(
    { type: 'undoTab:queryView', windowId: normalWin.id, view: 'recent', query: '' },
    sender,
  );
  assert.equal(normalView.ok, true);
  assert.equal(normalView.data.mode, 'normal');
  assert.equal(normalView.data.total, 1);
  assert.equal(normalView.data.entries[0].url, 'https://normal.example/a');

  const incognitoView = await handler(
    { type: 'undoTab:queryView', windowId: incognitoWin.id, view: 'recent', query: '' },
    sender,
  );
  assert.equal(incognitoView.data.mode, 'incognito');
  assert.equal(incognitoView.data.total, 1);
  assert.equal(incognitoView.data.entries[0].url, 'https://incognito.example/a');
});

test('普通历史来自 Chrome 只读查询，删除与清空被拒绝', async () => {
  const { handler, sender, normalWin, chrome } = await setup();
  chrome.__test.setHistory([
    { url: 'https://example.com/a', title: 'A', lastVisitTime: 1000 },
  ]);
  const view = await handler(
    { type: 'undoTab:queryView', windowId: normalWin.id, view: 'history', query: '' },
    sender,
  );
  assert.equal(view.ok, true);
  assert.equal(view.data.entries.length, 1);
  assert.equal(view.data.loaded, 1);
  assert.equal(chrome.__test.historySearchCalls[0].startTime, 0);
  assert.equal(chrome.__test.historySearchCalls[0].maxResults, 100);

  const removed = await handler(
    { type: 'undoTab:deleteEntry', windowId: normalWin.id, view: 'history', id: view.data.entries[0].id },
    sender,
  );
  assert.equal(removed.ok, false);
  assert.equal(removed.error.code, 'forbidden');

  const cleared = await handler(
    { type: 'undoTab:clearView', windowId: normalWin.id, view: 'history', confirm: true },
    sender,
  );
  assert.equal(cleared.ok, false);
  assert.equal(cleared.error.code, 'forbidden');
});

test('普通上限只裁剪普通最近关闭，无痕配额不变', async () => {
  const { handler, sender, normalWin, incognitoWin, normalStore, incognitoSession, settingsStore } = await setup();
  for (let i = 1; i <= 12; i += 1) {
    await normalStore.recordClose(closeEvent(`n${i}`, `https://normal.example/${i}`, 1000 * i), 500);
    await incognitoSession.recordClose(closeEvent(`i${i}`, `https://incognito.example/${i}`, 1000 * i), 500);
  }

  const preview = await handler(
    { type: 'undoTab:getTrimPreview', windowId: normalWin.id, maxRecords: 10 },
    sender,
  );
  assert.equal(preview.data.recent, 2);
  assert.equal(preview.data.history, 0);

  const updated = await handler(
    { type: 'undoTab:updateSettings', windowId: normalWin.id, patch: { maxRecords: 10 } },
    sender,
  );
  assert.equal(updated.ok, true);
  assert.equal(updated.data.trimmed.recent, 2);
  assert.equal((await normalStore.getEntries()).length, 10);
  assert.equal((await incognitoSession.query('recent', '')).total, 12);
  assert.deepEqual((await settingsStore.get()).incognito, { recentMaxRecords: 100, historyMaxRecords: 100 });
  assert.equal((await settingsStore.get()).normal.maxRecords, 10);
  assert.equal((await settingsStore.get()).normal.historyMaxRecords, 100);

  const incognitoPreview = await handler(
    { type: 'undoTab:getTrimPreview', windowId: incognitoWin.id, view: 'recent', maxRecords: 10 },
    sender,
  );
  assert.deepEqual(
    { recent: incognitoPreview.data.recent, history: incognitoPreview.data.history },
    { recent: 2, history: 0 },
  );
});

test('无痕设置不影响普通设置，宽度共享', async () => {
  const { handler, sender, incognitoWin, settingsStore } = await setup();
  const updated = await handler(
    {
      type: 'undoTab:updateSettings',
      windowId: incognitoWin.id,
      view: 'recent',
      patch: { maxRecords: 20, popupWidth: 600 },
    },
    sender,
  );
  assert.equal(updated.ok, true);
  const settings = await settingsStore.get();
  assert.equal(settings.incognito.recentMaxRecords, 20);
  assert.equal(settings.incognito.historyMaxRecords, 100);
  assert.equal(settings.normal.maxRecords, 100);
  assert.equal(settings.popupWidth, 600);
});

test('删除普通历史之外的单条记录按当前模式生效', async () => {
  const { handler, sender, normalWin, incognitoWin, normalStore, incognitoSession } = await setup();
  await normalStore.recordClose(closeEvent('n1', 'https://normal.example/a', 1000), 500);
  const normalEntry = (await normalStore.getEntries())[0];
  const removedNormal = await handler(
    { type: 'undoTab:deleteEntry', windowId: normalWin.id, view: 'recent', id: normalEntry.id },
    sender,
  );
  assert.equal(removedNormal.ok, true);
  assert.equal((await normalStore.getEntries()).length, 0);

  await incognitoSession.recordVisit(
    { eventId: 'v1', url: 'https://incognito.example/a', visitedAt: 1000, order: 1000000 },
    500,
  );
  const visit = (await incognitoSession.query('history', '')).entries[0];
  const removedVisit = await handler(
    { type: 'undoTab:deleteEntry', windowId: incognitoWin.id, view: 'history', id: visit.id },
    sender,
  );
  assert.equal(removedVisit.ok, true);
  assert.equal((await incognitoSession.query('history', '')).total, 0);
  assert.equal((await incognitoSession.query('recent', '')).total, 0);
});

test('清空当前视图只清当前模式当前集合', async () => {
  const { handler, sender, normalWin, incognitoWin, normalStore, incognitoSession } = await setup();
  await normalStore.recordClose(closeEvent('n1', 'https://normal.example/a', 1000), 500);
  await incognitoSession.recordClose(closeEvent('i1', 'https://incognito.example/a', 1000), 500);
  await incognitoSession.recordVisit(
    { eventId: 'v1', url: 'https://incognito.example/b', visitedAt: 1000, order: 1000000 },
    500,
  );

  const normalClear = await handler(
    { type: 'undoTab:clearView', windowId: normalWin.id, view: 'recent', confirm: true },
    sender,
  );
  assert.equal(normalClear.ok, true);
  assert.equal((await normalStore.getEntries()).length, 0);
  assert.equal((await incognitoSession.query('recent', '')).total, 1);

  const incognitoClear = await handler(
    { type: 'undoTab:clearView', windowId: incognitoWin.id, view: 'recent', confirm: true },
    sender,
  );
  assert.equal(incognitoClear.ok, true);
  assert.equal((await incognitoSession.query('recent', '')).total, 0);
  assert.equal((await incognitoSession.query('history', '')).total, 1);
});

test('清空本次无痕记录不影响普通数据且保留会话', async () => {
  const { handler, sender, normalWin, incognitoWin, normalStore, incognitoSession } = await setup();
  await normalStore.recordClose(closeEvent('n1', 'https://normal.example/a', 1000), 500);
  await incognitoSession.recordClose(closeEvent('i1', 'https://incognito.example/a', 1000), 500);
  await incognitoSession.recordVisit(
    { eventId: 'v1', url: 'https://incognito.example/b', visitedAt: 1000, order: 1000000 },
    500,
  );
  const result = await handler(
    { type: 'undoTab:clearIncognitoData', windowId: incognitoWin.id, confirm: true },
    sender,
  );
  assert.equal(result.ok, true);
  assert.equal(result.data.removed, 2);
  assert.equal((await incognitoSession.query('recent', '')).total, 0);
  assert.equal((await incognitoSession.query('history', '')).total, 0);
  assert.equal((await incognitoSession.getInfo()).active, true);
  assert.equal((await normalStore.getEntries()).length, 1);

  const wrong = await handler(
    { type: 'undoTab:clearIncognitoData', windowId: normalWin.id, confirm: true },
    sender,
  );
  assert.equal(wrong.error.code, 'forbidden');
});

test('打开普通历史网址与无痕记录使用当前窗口模式', async () => {
  const { handler, sender, normalWin, incognitoWin, incognitoSession, chrome } = await setup();
  const normalOpen = await handler(
    {
      type: 'undoTab:openEntry',
      windowId: normalWin.id,
      view: 'history',
      url: 'https://example.com/history',
    },
    sender,
  );
  assert.equal(normalOpen.ok, true);
  const normalTab = chrome.__test.tabs.find((tab) => tab.id === normalOpen.data.tabId);
  assert.equal(normalTab.incognito, false);

  await incognitoSession.recordClose(closeEvent('i1', 'https://incognito.example/a', 1000), 500);
  const entry = (await incognitoSession.query('recent', '')).entries[0];
  const incognitoOpen = await handler(
    { type: 'undoTab:openEntry', windowId: incognitoWin.id, view: 'recent', id: entry.id },
    sender,
  );
  assert.equal(incognitoOpen.ok, true);
  const incognitoTab = chrome.__test.tabs.find((tab) => tab.id === incognitoOpen.data.tabId);
  assert.equal(incognitoTab.incognito, true);
});

test('无痕会话结束后拒绝打开旧记录', async () => {
  const { handler, sender, incognitoWin, incognitoSession } = await setup();
  await incognitoSession.recordClose(closeEvent('i1', 'https://incognito.example/a', 1000), 500);
  const entry = (await incognitoSession.query('recent', '')).entries[0];
  await incognitoSession.syncWindows([]);
  const result = await handler(
    { type: 'undoTab:openEntry', windowId: incognitoWin.id, view: 'recent', id: entry.id },
    sender,
  );
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'session-ended');
});
