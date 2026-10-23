import test from 'node:test';
import assert from 'node:assert/strict';

import { migrateLegacyData } from '../background/migrator.js';
import { createMockChrome } from './helpers/mock-chrome.js';

function legacyRecord(id, url, closedAt, mode, title = '') {
  return {
    id,
    url,
    title,
    closedAt,
    mode,
    originalWindowId: 1,
    originalIndex: 0,
    wasPinned: false,
    hasFavicon: false,
    windowClosing: false,
  };
}

test('迁移只保留普通记录、按 URL 去重并清理旧 key', async () => {
  const chrome = createMockChrome();
  chrome.storage.local.data.settings = { schemaVersion: 1, maxRecords: 42, popupWidth: 600 };
  chrome.storage.local.data['history.records'] = [
    legacyRecord('a1', 'https://example.com/a', 1000, 'normal', '旧'),
    legacyRecord('a2', 'https://example.com/a', 3000, 'normal', '新'),
    legacyRecord('b1', 'https://example.com/b', 2000, 'normal', 'B'),
    legacyRecord('i1', 'https://secret.example/incognito', 4000, 'incognito', '无痕'),
  ];
  chrome.storage.session.data['live.tabs'] = [
    {
      captureId: 'pending-1',
      tabId: 7,
      windowId: 1,
      mode: 'normal',
      url: 'https://example.com/pending',
      title: '待写',
      index: 0,
      pinned: false,
      hasFavicon: true,
      pendingClose: { closedAt: 5000, windowClosing: true },
    },
    {
      captureId: 'incognito-snapshot',
      tabId: 8,
      windowId: 2,
      mode: 'incognito',
      url: 'https://secret.example/tab',
      title: '无痕',
      index: 0,
      pendingClose: { closedAt: 6000, windowClosing: false },
    },
  ];

  const result = await migrateLegacyData({
    localArea: chrome.storage.local,
    sessionArea: chrome.storage.session,
    uuid: (() => {
      let index = 0;
      return () => `migrated-${++index}`;
    })(),
    logger: { warn() {} },
  });

  assert.equal(result.migrated, true);
  assert.equal(result.normal, 2);
  assert.equal(result.pending, 1);

  const settings = chrome.storage.local.data.settings;
  assert.equal(settings.schemaVersion, 2);
  assert.equal(settings.popupWidth, 600);
  assert.equal(settings.normal.maxRecords, 42);
  assert.equal(settings.normal.historyMaxRecords, 42);
  assert.deepEqual(settings.incognito, { recentMaxRecords: 42, historyMaxRecords: 42 });

  const recent = chrome.storage.local.data['normal.recent'];
  assert.deepEqual(recent.entries.map((entry) => entry.url), [
    'https://example.com/a',
    'https://example.com/b',
  ]);
  assert.equal(recent.entries[0].title, '新');
  assert.equal(
    recent.entries.some((entry) => entry.url.includes('secret')),
    false,
  );
  assert.equal(chrome.storage.local.data['history.records'], undefined);
  assert.equal(chrome.storage.session.data['live.tabs'], undefined);
  assert.equal(JSON.stringify(chrome.storage.local.data).includes('secret.example'), false);

  const pending = chrome.storage.session.data['normal.pendingCloses'];
  assert.equal(pending.length, 1);
  assert.equal(pending[0].url, 'https://example.com/pending');
  assert.equal(pending[0].windowClosing, true);
  assert.equal(pending[0].generation, recent.generation);
});

test('迁移可重复执行，不覆盖已有新集合', async () => {
  const chrome = createMockChrome();
  chrome.storage.local.data.settings = { schemaVersion: 2, popupWidth: 440, normal: { maxRecords: 500 }, incognito: { maxRecords: 500 } };
  chrome.storage.local.data['normal.recent'] = {
    generation: 2,
    lastOrder: 2000000,
    entries: [
      {
        id: 'existing',
        url: 'https://example.com/existing',
        urlKey: 'https://example.com/existing',
        title: 'Existing',
        closedAt: 2000,
        order: 2000000,
        originalWindowId: 1,
        originalIndex: 0,
        wasPinned: false,
        hasFavicon: false,
        windowClosing: false,
        lastEventId: 'existing',
      },
    ],
  };
  chrome.storage.local.data['history.records'] = [
    legacyRecord('old', 'https://example.com/old', 1000, 'normal'),
  ];
  chrome.storage.session.data['live.tabs'] = [];

  await migrateLegacyData({
    localArea: chrome.storage.local,
    sessionArea: chrome.storage.session,
    uuid: () => 'new-id',
    logger: { warn() {} },
  });
  const once = chrome.storage.local.data['normal.recent'];
  assert.deepEqual(once.entries.map((entry) => entry.url).sort(), [
    'https://example.com/existing',
    'https://example.com/old',
  ]);
  assert.equal(once.generation, 2);

  const second = await migrateLegacyData({
    localArea: chrome.storage.local,
    sessionArea: chrome.storage.session,
    uuid: () => 'new-id',
    logger: { warn() {} },
  });
  assert.equal(second.migrated, false);
  assert.deepEqual(chrome.storage.local.data['normal.recent'].entries, once.entries);
});

test('迁移后旧 key 不存在且 schema 已为 2 时快速返回', async () => {
  const chrome = createMockChrome();
  chrome.storage.local.data.settings = {
    schemaVersion: 2,
    popupWidth: 440,
    normal: { maxRecords: 500, historyMaxRecords: 500 },
    incognito: { recentMaxRecords: 500, historyMaxRecords: 500 },
  };
  const result = await migrateLegacyData({
    localArea: chrome.storage.local,
    sessionArea: chrome.storage.session,
    logger: { warn() {} },
  });
  assert.equal(result.migrated, false);
});
