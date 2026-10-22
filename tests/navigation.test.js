import test from 'node:test';
import assert from 'node:assert/strict';

import { createIncognitoSession } from '../background/incognito-session.js';
import { createNavigationTracker } from '../background/navigation-tracker.js';
import { normalizeSettings } from '../shared/settings.js';
import { createMockChrome } from './helpers/mock-chrome.js';

function setup() {
  const chrome = createMockChrome();
  const session = createIncognitoSession({ sessionArea: chrome.storage.session, logger: { warn() {} } });
  const settings = normalizeSettings({ incognito: { maxRecords: 500 } });
  const tracker = createNavigationTracker({
    chromeApi: chrome,
    incognitoSession: session,
    getSettings: async () => settings,
    uuid: (() => {
      let index = 0;
      return () => `event-${++index}`;
    })(),
    now: () => 5000,
    logger: { warn() {} },
  });
  return { chrome, session, tracker };
}

async function addIncognitoTab(chrome, partial = {}) {
  const win = chrome.__test.addWindow({ incognito: true });
  const tab = chrome.__test.addTab({
    windowId: win.id,
    incognito: true,
    url: 'https://example.com/a',
    title: 'A',
    ...partial,
  });
  return { win, tab };
}

function details(tabId, url, extra = {}) {
  return {
    frameId: 0,
    tabId,
    url,
    documentId: 'doc-1',
    timeStamp: 1000,
    documentLifecycle: 'active',
    ...extra,
  };
}

test('只采集无痕主框架的 http(s) 导航', async () => {
  const { chrome, session, tracker } = setup();
  await session.syncWindows([1]);
  const { tab } = await addIncognitoTab(chrome);

  assert.equal((await tracker.handle(details(tab.id, 'https://example.com/a', { frameId: 1 }))).recorded, false);
  assert.equal((await tracker.handle(details(tab.id, 'chrome://settings'))).recorded, false);
  assert.equal(
    (await tracker.handle(details(tab.id, 'https://example.com/a', { documentLifecycle: 'prerender' }))).recorded,
    false,
  );

  const result = await tracker.handle(details(tab.id, 'https://example.com/a'));
  assert.equal(result.recorded, true);
  const history = await session.query('history', '');
  assert.equal(history.total, 1);
  assert.equal(history.entries[0].url, 'https://example.com/a');
});

test('普通标签与不存在的标签不采集', async () => {
  const { chrome, session, tracker } = setup();
  await session.syncWindows([1]);
  const normalTab = chrome.__test.addTab({ url: 'https://example.com/normal', incognito: false });
  assert.equal((await tracker.handle(details(normalTab.id, 'https://example.com/normal'))).recorded, false);
  assert.equal((await tracker.handle(details(999999, 'https://example.com/x'))).recorded, false);
  assert.equal((await session.query('history', '')).total, 0);
});

test('会话结束后不再采集', async () => {
  const { chrome, session, tracker } = setup();
  await session.syncWindows([1]);
  const { tab } = await addIncognitoTab(chrome);
  await session.syncWindows([]);
  const result = await tracker.handle(details(tab.id, 'https://example.com/a'));
  assert.equal(result.recorded, false);
  assert.equal(result.reason, 'session-ended');
});

test('同一导航事件重复派发不重复计数', async () => {
  const { chrome, session, tracker } = setup();
  await session.syncWindows([1]);
  const { tab } = await addIncognitoTab(chrome);
  const event = details(tab.id, 'https://example.com/a', { timeStamp: 1234 });
  assert.equal((await tracker.handle(event)).recorded, true);
  assert.equal((await tracker.handle(event)).recorded, false);
  const history = await session.query('history', '');
  assert.equal(history.entries[0].visitCount, 1);
});

test('SPA 与 hash 变化按各自 URL 记录', async () => {
  const { chrome, session, tracker } = setup();
  await session.syncWindows([1]);
  const { tab } = await addIncognitoTab(chrome);
  await tracker.handle(details(tab.id, 'https://example.com/a', { timeStamp: 1000 }));
  await tracker.handle(details(tab.id, 'https://example.com/a?view=2', { timeStamp: 2000 }));
  await tracker.handle(details(tab.id, 'https://example.com/a?view=2#tab', { timeStamp: 3000 }));
  const history = await session.query('history', '');
  assert.equal(history.total, 3);
  assert.deepEqual(history.entries.map((entry) => entry.lastVisitedAt), [3000, 2000, 1000]);
});
