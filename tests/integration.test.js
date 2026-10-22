import test from 'node:test';
import assert from 'node:assert/strict';

import { createIncognitoSession } from '../background/incognito-session.js';
import { createNavigationTracker } from '../background/navigation-tracker.js';
import { createNormalStore } from '../background/normal-store.js';
import { createSettingsStore } from '../background/settings-store.js';
import { createTabTracker } from '../background/tab-tracker.js';
import { createMockChrome } from './helpers/mock-chrome.js';

async function setup() {
  const chrome = createMockChrome({
    windows: [
      { id: 1, incognito: false, focused: true },
      { id: 2, incognito: true, focused: false },
    ],
    tabs: [
      { id: 11, windowId: 1, incognito: false, url: 'https://normal.example/a', title: 'A' },
      { id: 21, windowId: 2, incognito: true, url: 'https://inc.example/a', title: 'Inc' },
    ],
  });
  const settingsStore = createSettingsStore({ localArea: chrome.storage.local });
  await settingsStore.ensure();
  const normalStore = createNormalStore({
    localArea: chrome.storage.local,
    sessionArea: chrome.storage.session,
    uuid: (() => {
      let index = 0;
      return () => `entry-${++index}`;
    })(),
  });
  const incognitoSession = createIncognitoSession({
    sessionArea: chrome.storage.session,
    uuid: (() => {
      let index = 0;
      return () => `session-${++index}`;
    })(),
    logger: { warn() {} },
  });
  await incognitoSession.syncWindows([2]);
  const tracker = createTabTracker({
    chromeApi: chrome,
    sessionArea: chrome.storage.session,
    normalStore,
    incognitoSession,
    getSettings: () => settingsStore.get(),
    now: (() => {
      let clock = 1000;
      return () => (clock += 100);
    })(),
    uuid: (() => {
      let index = 0;
      return () => `capture-${++index}`;
    })(),
    logger: { warn() {} },
  });
  await tracker.init();
  const navigation = createNavigationTracker({
    chromeApi: chrome,
    incognitoSession,
    getSettings: () => settingsStore.get(),
    now: () => 5000,
    logger: { warn() {} },
  });
  return { chrome, normalStore, incognitoSession, tracker, navigation };
}

test('普通标签关闭记录按完整 URL 更新，不同 URL 分开保存', async () => {
  const { chrome, normalStore, tracker } = await setup();
  chrome.__test.removeTab(11);
  await tracker.handleTabRemoved(11, { windowId: 1, isWindowClosing: false });
  let entries = await normalStore.getEntries();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].url, 'https://normal.example/a');

  const duplicate = chrome.__test.addTab({
    windowId: 1,
    url: 'https://normal.example/a',
    title: 'A 新标题',
  });
  await tracker.handleTabCreated(duplicate);
  chrome.__test.removeTab(duplicate.id);
  await tracker.handleTabRemoved(duplicate.id, { windowId: 1, isWindowClosing: false });
  entries = await normalStore.getEntries();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].title, 'A 新标题');

  const hash = chrome.__test.addTab({
    windowId: 1,
    url: 'https://normal.example/a#part',
    title: 'Hash',
  });
  await tracker.handleTabCreated(hash);
  chrome.__test.removeTab(hash.id);
  await tracker.handleTabRemoved(hash.id, { windowId: 1, isWindowClosing: false });

  const query = chrome.__test.addTab({
    windowId: 1,
    url: 'https://normal.example/a?x=1',
    title: 'Query',
  });
  await tracker.handleTabCreated(query);
  chrome.__test.removeTab(query.id);
  await tracker.handleTabRemoved(query.id, { windowId: 1, isWindowClosing: false });

  entries = await normalStore.getEntries();
  assert.equal(entries.length, 3);
  assert.deepEqual(entries.map((entry) => entry.url).sort(), [
    'https://normal.example/a',
    'https://normal.example/a#part',
    'https://normal.example/a?x=1',
  ]);
});

test('无痕关闭与访问只进入无痕会话，最后一个窗口关闭后清空', async () => {
  const { chrome, normalStore, incognitoSession, tracker, navigation } = await setup();
  chrome.__test.removeTab(21);
  await tracker.handleTabRemoved(21, { windowId: 2, isWindowClosing: false });
  assert.equal((await incognitoSession.query('recent', '')).total, 1);

  const incognitoTab = chrome.__test.addTab({
    windowId: 2,
    incognito: true,
    url: 'https://inc.example/history',
    title: 'Inc History',
  });
  await tracker.handleTabCreated(incognitoTab);
  await navigation.handle({
    frameId: 0,
    tabId: incognitoTab.id,
    url: 'https://inc.example/history',
    documentId: 'doc-1',
    timeStamp: 5000,
    documentLifecycle: 'active',
  });
  assert.equal((await incognitoSession.query('history', '')).total, 1);

  const pendingClose = chrome.__test.addTab({
    windowId: 2,
    incognito: true,
    url: 'https://inc.example/pending',
    title: 'Pending',
  });
  await tracker.handleTabCreated(pendingClose);

  const ended = await incognitoSession.syncWindows([]);
  assert.equal(ended.active, false);
  tracker.resetIncognito();

  chrome.__test.removeTab(pendingClose.id);
  const late = await tracker.handleTabRemoved(pendingClose.id, { windowId: 2, isWindowClosing: true });
  assert.equal(late.recorded, false);
  assert.equal((await incognitoSession.query('recent', '')).total, 0);
  assert.equal((await incognitoSession.query('history', '')).total, 0);

  assert.equal((await normalStore.getEntries()).length, 0);
  assert.equal(JSON.stringify(chrome.storage.local.data).includes('inc.example'), false);
});

test('新会话建立后，旧标签的迟到更新与关闭不进入新会话', async () => {
  const { chrome, incognitoSession, tracker } = await setup();
  await incognitoSession.syncWindows([]);
  tracker.resetIncognito();
  const started = await incognitoSession.syncWindows([3]);
  assert.equal(started.active, true);
  const context = incognitoSession.peekContext();
  assert.deepEqual(context.windows, [3]);

  await tracker.handleTabUpdated(
    21,
    { title: '迟到的旧标题' },
    { id: 21, windowId: 2, incognito: true, url: 'https://inc.example/old-session' },
    context,
  );
  const lateClose = await tracker.handleTabRemoved(
    21,
    { windowId: 2, isWindowClosing: true },
    context,
  );
  assert.equal(lateClose.recorded, false);
  assert.equal((await incognitoSession.query('recent', '')).total, 0);
  assert.equal((await incognitoSession.query('history', '')).total, 0);
  assert.equal(JSON.stringify(chrome.storage.session.data).includes('old-session'), false);

  const newTab = chrome.__test.addTab({
    windowId: 3,
    incognito: true,
    url: 'https://inc.example/new-session',
    title: 'New',
  });
  await tracker.handleTabCreated(newTab, context);
  const recorded = await tracker.handleTabRemoved(
    newTab.id,
    { windowId: 3, isWindowClosing: false },
    context,
  );
  assert.equal(recorded.recorded, true);
  const recent = await incognitoSession.query('recent', '');
  assert.equal(recent.total, 1);
  assert.equal(recent.entries[0].url, 'https://inc.example/new-session');
});

test('普通与无痕快照分别存放', async () => {
  const { chrome, incognitoSession } = await setup();
  const normalSnapshots = chrome.storage.session.data['normal.liveTabs'];
  const incognitoState = chrome.storage.session.data['incognito.state'];
  assert.ok(Array.isArray(normalSnapshots));
  assert.ok(normalSnapshots.some((snapshot) => snapshot.url === 'https://normal.example/a'));
  assert.ok(Array.isArray(incognitoState.liveTabs));
  assert.ok(incognitoState.liveTabs.some((snapshot) => snapshot.url === 'https://inc.example/a'));
  assert.equal(incognitoState.liveTabs[0].sessionId, (await incognitoSession.getInfo()).sessionId);
});
