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

function activeIncognitoState(historyEntry) {
  return {
    sessionId: 's1',
    status: 'active',
    needsClear: false,
    windows: [2],
    clearGeneration: { recent: 0, history: 0 },
    recent: [],
    history: historyEntry ? [historyEntry] : [],
    liveTabs: [],
    pending: [],
    appliedVisitEvents: [],
    lastOrder: 1000000,
    updatedAt: 1000,
  };
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
  chrome.storage.session.data['incognito.state'] = activeIncognitoState({
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
