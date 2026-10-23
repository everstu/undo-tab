import test from 'node:test';
import assert from 'node:assert/strict';

import { createUndoTabWorker } from '../background/worker.js';
import { createMockChrome } from './helpers/mock-chrome.js';

function sender(chrome) {
  return { id: chrome.runtime.id, url: chrome.runtime.getURL('popup/popup.html') };
}

function sendMessage(chrome, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('worker 消息超时')), 5000);
    chrome.runtime.onMessage.emit(message, sender(chrome), (response) => {
      clearTimeout(timer);
      resolve(response);
    });
  });
}

function drain(worker) {
  return worker.queue(async () => {});
}

/** 按拆分后的 session key 写入一个有效无痕会话。 */
function seedActiveIncognito(chrome, historyEntry) {
  Object.assign(chrome.storage.session.data, {
    'incognito.meta': {
      sessionId: 's1',
      status: 'active',
      needsClear: false,
      windows: [2],
      clearGeneration: { recent: 0, history: 0 },
      pending: [],
      appliedVisitEvents: [],
      lastOrder: 1000000,
      updatedAt: 1000,
    },
    'incognito.recent': [],
    'incognito.history': historyEntry ? [historyEntry] : [],
    'incognito.liveTabs': [],
  });
}

test('接线：窗口枚举失败不误清空，恢复后按真实窗口保留会话', async () => {
  const chrome = createMockChrome({
    windows: [{ id: 2, incognito: true, focused: false }],
    tabs: [],
  });
  chrome.storage.local.data.settings = {
    schemaVersion: 2,
    popupWidth: 440,
    normal: { maxRecords: 500 },
    incognito: { maxRecords: 500 },
  };
  seedActiveIncognito(chrome, {
    id: 'h1',
    url: 'https://example.com/history',
    urlKey: 'https://example.com/history',
    title: 'History',
    lastVisitedAt: 1000,
    order: 1000000,
    visitCount: 1,
    hasFavicon: true,
    lastEventId: 'v1',
  });

  const originalGetAll = chrome.windows.getAll;
  chrome.windows.getAll = async () => {
    throw new Error('enumeration failed');
  };
  const worker = createUndoTabWorker({ chrome, logger: { warn() {} } });

  const first = await sendMessage(chrome, {
    type: 'undoTab:queryView',
    windowId: 2,
    view: 'history',
    query: '',
  });
  assert.equal(first.ok, true);
  assert.equal(first.data.entries.length, 1);
  assert.equal((await worker.stores.incognitoSession.getInfo()).active, true);

  chrome.windows.getAll = originalGetAll;
  const second = await sendMessage(chrome, {
    type: 'undoTab:queryView',
    windowId: 2,
    view: 'history',
    query: '',
  });
  assert.equal(second.ok, true);
  assert.equal(second.data.entries.length, 1);
  assert.equal(second.data.sessionActive, true);

  chrome.__test.closeWindow(2);
  chrome.windows.onRemoved.emit(2);
  await drain(worker);
  const info = await worker.stores.incognitoSession.getInfo();
  assert.equal(info.active, false);
  assert.equal((await worker.stores.incognitoSession.query('history', '')).total, 0);
});

test('接线：新窗口标签事件紧跟窗口创建入队时仍能建档，不依赖额外等待', async () => {
  const chrome = createMockChrome({
    windows: [{ id: 2, incognito: true, focused: false }],
    tabs: [],
  });
  const worker = createUndoTabWorker({ chrome, logger: { warn() {} } });

  const context = await sendMessage(chrome, { type: 'undoTab:getContext', windowId: 2 });
  assert.equal(context.ok, true);
  assert.equal(context.data.session.active, true);

  // window.onCreated 的同步任务先入队，但在它执行前就连续派发新窗口内的标签事件。
  const newWindow = chrome.__test.addWindow({ incognito: true });
  chrome.windows.onCreated.emit(newWindow);
  const newTab = chrome.__test.addTab({
    windowId: newWindow.id,
    incognito: true,
    url: 'https://example.com/new-window',
    title: 'New Window',
  });
  chrome.tabs.onUpdated.emit(
    newTab.id,
    { status: 'complete', title: 'New Window' },
    { ...newTab, status: 'complete', title: 'New Window' },
  );

  await drain(worker);
  const info = await worker.stores.incognitoSession.getInfo();
  assert.equal(info.active, true);
  assert.deepEqual([...info.windows].sort((a, b) => a - b), [2, newWindow.id].sort((a, b) => a - b));

  chrome.__test.removeTab(newTab.id);
  await drain(worker);
  const recent = await worker.stores.incognitoSession.query('recent', '');
  assert.equal(recent.total, 1);
  assert.equal(recent.entries[0].url, 'https://example.com/new-window');
});

test('接线：新会话建立后，旧标签迟到 onUpdated/onRemoved 不写入新会话', async () => {
  const chrome = createMockChrome({
    windows: [{ id: 2, incognito: true, focused: false }],
    tabs: [
      {
        id: 21,
        windowId: 2,
        incognito: true,
        url: 'https://example.com/old-session',
        title: 'Old',
      },
    ],
  });
  const worker = createUndoTabWorker({ chrome, logger: { warn() {} } });

  const before = await sendMessage(chrome, {
    type: 'undoTab:getContext',
    windowId: 2,
  });
  assert.equal(before.ok, true);
  assert.equal(before.data.session.active, true);

  chrome.__test.closeWindow(2);
  chrome.tabs.onRemoved.emit(21, { windowId: 2, isWindowClosing: true });
  chrome.windows.onRemoved.emit(2);
  await drain(worker);

  const newWindow = chrome.__test.addWindow({ incognito: true });
  chrome.windows.onCreated.emit(newWindow);
  await drain(worker);
  const session = worker.stores.incognitoSession;
  const started = await session.getInfo();
  assert.equal(started.active, true);
  assert.deepEqual(started.windows, [newWindow.id]);
  assert.equal((await session.query('recent', '')).total, 0);

  // 旧窗口 2 的迟到更新与关闭。
  chrome.tabs.onUpdated.emit(
    21,
    { title: '迟到的旧标题' },
    { id: 21, windowId: 2, incognito: true, url: 'https://example.com/old-session' },
  );
  chrome.tabs.onRemoved.emit(21, { windowId: 2, isWindowClosing: true });
  await drain(worker);
  assert.equal((await session.query('recent', '')).total, 0);
  assert.equal(JSON.stringify(chrome.storage.session.data).includes('old-session'), false);

  // 当前会话中的新标签仍能正常记录。
  const newTab = chrome.__test.addTab({
    windowId: newWindow.id,
    incognito: true,
    url: 'https://example.com/new-session',
    title: 'New',
  });
  await drain(worker);
  chrome.__test.removeTab(newTab.id);
  await drain(worker);
  const recent = await session.query('recent', '');
  assert.equal(recent.total, 1);
  assert.equal(recent.entries[0].url, 'https://example.com/new-session');
});

test('接线：移动/挂接后关闭，最近关闭使用最新位置；跨出会话窗口的无痕快照被丢弃', async () => {
  const chrome = createMockChrome({
    windows: [
      { id: 1, incognito: false, focused: true },
      { id: 2, incognito: true, focused: false },
      { id: 3, incognito: true, focused: false },
    ],
    tabs: [
      { id: 11, windowId: 1, incognito: false, url: 'https://example.com/normal', title: 'Normal' },
      { id: 21, windowId: 2, incognito: true, url: 'https://example.com/inc-a', title: 'A' },
      { id: 22, windowId: 2, incognito: true, url: 'https://example.com/inc-b', title: 'B' },
    ],
  });
  const worker = createUndoTabWorker({ chrome, logger: { warn() {} } });
  await worker.ensureReady();

  chrome.__test.moveTab(11, { windowId: 1, toIndex: 4 });
  chrome.__test.detachTab(21, { oldWindowId: 2, oldPosition: 0 });
  chrome.__test.attachTab(21, { newWindowId: 3, newPosition: 2 });
  await drain(worker);

  chrome.__test.removeTab(11);
  chrome.__test.removeTab(21);
  await drain(worker);
  const normal = await worker.stores.normalStore.getEntries();
  assert.equal(normal.length, 1);
  assert.equal(normal[0].originalIndex, 4);
  const recent = await worker.stores.incognitoSession.query('recent', '');
  assert.equal(recent.total, 1);
  assert.equal(recent.entries[0].originalIndex, 2);
  assert.equal(recent.entries[0].originalWindowId, 3);

  // 会话窗口集合被同步为只剩窗口 2 后，挂接到未知窗口 99 的无痕快照不能再记录。
  await worker.stores.incognitoSession.syncWindows([2]);
  chrome.tabs.onAttached.emit(22, { newWindowId: 99, newPosition: 0 });
  await drain(worker);
  chrome.__test.removeTab(22);
  await drain(worker);
  assert.equal((await worker.stores.incognitoSession.query('recent', '')).total, 1);
});

test('接线：只有加载状态变化的 onUpdated 不重写无痕会话存储，标题变化仍会保存', async () => {
  const chrome = createMockChrome({
    windows: [{ id: 2, incognito: true, focused: false }],
    tabs: [{ id: 21, windowId: 2, incognito: true, url: 'https://example.com/page', title: 'Old' }],
  });
  const worker = createUndoTabWorker({ chrome, logger: { warn() {} } });
  await worker.ensureReady();
  await drain(worker);

  const writes = chrome.storage.session.control.writes;
  chrome.__test.updateTab(21, { status: 'loading' });
  chrome.__test.updateTab(21, { status: 'complete' });
  await drain(worker);
  assert.equal(chrome.storage.session.control.writes, writes);

  chrome.__test.updateTab(21, { title: 'New Title' });
  await drain(worker);
  assert.ok(chrome.storage.session.control.writes > writes);
  const stored = chrome.storage.session.data['incognito.liveTabs'].find((tab) => tab.tabId === 21);
  assert.equal(stored.title, 'New Title');

  chrome.__test.removeTab(21);
  await drain(worker);
  const recent = await worker.stores.incognitoSession.query('recent', '');
  assert.equal(recent.entries[0].title, 'New Title');
});

test('接线：worker 初始化时清理已无作用的普通删除标记', async () => {
  const chrome = createMockChrome({ windows: [{ id: 1, incognito: false, focused: true }], tabs: [] });
  chrome.storage.local.data.settings = {
    schemaVersion: 2,
    popupWidth: 440,
    normal: { maxRecords: 100, historyMaxRecords: 100 },
    incognito: { recentMaxRecords: 100, historyMaxRecords: 100 },
  };
  chrome.storage.local.data['normal.recent'] = {
    generation: 0,
    lastOrder: 0,
    entries: [],
    deleted: { 'https://example.com/a': 5000 },
  };
  const worker = createUndoTabWorker({ chrome, logger: { warn() {} } });
  await worker.ensureReady();
  assert.deepEqual(chrome.storage.local.data['normal.recent'].deleted, {});
});

test('接线：无痕设置预览在接近配额时提示，列表查询带出存储问题', async () => {
  const chrome = createMockChrome({
    windows: [{ id: 2, incognito: true, focused: true }],
    tabs: [],
  });
  const worker = createUndoTabWorker({ chrome, logger: { warn() {} } });

  const context = await sendMessage(chrome, { type: 'undoTab:getContext', windowId: 2 });
  assert.equal(context.ok, true);
  assert.equal(context.data.storage.issue, null);
  assert.ok(context.data.storage.bytesInUse > 0);

  // 上限最大 1000：两个列表都存满（约 600 字节/条估算）也远低于 10MB，不提示。
  await sendMessage(chrome, {
    type: 'undoTab:updateSettings', windowId: 2, view: 'history', patch: { maxRecords: 1000 },
  });
  const small = await sendMessage(chrome, {
    type: 'undoTab:getTrimPreview', windowId: 2, view: 'recent', maxRecords: 1000,
  });
  assert.equal(small.ok, true);
  assert.equal(small.data.quotaWarning, null);

  // 配额较小（或网址极长）时，预计超过 90% 配额才提示。
  chrome.storage.session.QUOTA_BYTES = 1024 * 1024;
  const large = await sendMessage(chrome, {
    type: 'undoTab:getTrimPreview', windowId: 2, view: 'recent', maxRecords: 1000,
  });
  assert.equal(large.ok, true);
  assert.equal(large.data.quotaWarning.quotaBytes, 1024 * 1024);
  assert.ok(large.data.quotaWarning.projectedBytes > large.data.quotaWarning.quotaBytes * 0.9);
  delete chrome.storage.session.QUOTA_BYTES;

  // 写入撞配额后，查询结果带出 quota 问题供弹窗提示。
  chrome.storage.session.control.failWrites = true;
  await worker.stores.incognitoSession
    .recordClose({ eventId: 'c1', url: 'https://example.com/q', closedAt: 1000, order: 1 }, 100)
    .catch(() => {});
  chrome.storage.session.control.failWrites = false;
  chrome.storage.session.set = async () => {
    throw new Error('QUOTA_BYTES quota exceeded');
  };
  const view = await sendMessage(chrome, { type: 'undoTab:queryView', windowId: 2, view: 'recent', query: '' });
  assert.equal(view.ok, true);
  assert.equal(view.data.storageIssue, 'quota');
  assert.equal(view.data.entries.length, 1);
});
