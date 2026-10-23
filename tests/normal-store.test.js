import test from 'node:test';
import assert from 'node:assert/strict';

import { StorageFailureError, createNormalStore } from '../background/normal-store.js';
import { createMockChrome } from './helpers/mock-chrome.js';

function setup(options = {}) {
  const chrome = createMockChrome();
  const store = createNormalStore({
    localArea: chrome.storage.local,
    sessionArea: chrome.storage.session,
    uuid: (() => {
      let index = 0;
      return () => `id-${++index}`;
    })(),
    ...options,
  });
  return { chrome, store };
}

function closeEvent(eventId, url, closedAt = 1000, extra = {}) {
  return {
    eventId,
    url,
    title: '标题',
    closedAt,
    order: closedAt * 1000,
    originalWindowId: 1,
    originalIndex: 0,
    wasPinned: false,
    hasFavicon: false,
    windowClosing: false,
    ...extra,
  };
}

test('同一完整网址更新原条目并置顶，不产生第二条', async () => {
  const { store } = setup();
  await store.recordClose(closeEvent('e1', 'https://example.com/a', 1000, { title: '旧标题' }), 500);
  await store.recordClose(closeEvent('e2', 'https://example.com/b', 2000, { title: 'B' }), 500);
  await store.recordClose(closeEvent('e3', 'https://example.com/a', 3000, { title: '新标题' }), 500);
  const entries = await store.getEntries();
  assert.equal(entries.length, 2);
  assert.equal(entries[0].url, 'https://example.com/a');
  assert.equal(entries[0].title, '新标题');
  assert.equal(entries[0].closedAt, 3000);
  assert.equal(entries[1].url, 'https://example.com/b');
});

test('查询参数、参数顺序与 fragment 不同均视为不同网址', async () => {
  const { store } = setup();
  const urls = [
    'https://example.com/a',
    'https://example.com/a?x=1',
    'https://example.com/a?y=2&x=1',
    'https://example.com/a?x=1&y=2',
    'https://example.com/a#one',
    'https://example.com/a#two',
  ];
  for (const [index, url] of urls.entries()) {
    await store.recordClose(closeEvent(`e${index}`, url, 1000 + index), 500);
  }
  assert.equal((await store.getEntries()).length, urls.length);
});

test('同一关闭事件重试幂等；较旧事件晚到不覆盖', async () => {
  const { store } = setup();
  await store.recordClose(closeEvent('e2', 'https://example.com/a', 2000, { title: '新' }), 500);
  const duplicate = await store.recordClose(closeEvent('e2', 'https://example.com/a', 2000, { title: '新' }), 500);
  assert.equal(duplicate.applied, false);
  assert.equal(duplicate.reason, 'duplicate');

  const older = await store.recordClose(closeEvent('e1', 'https://example.com/a', 1000, { title: '旧' }), 500);
  assert.equal(older.applied, false);
  assert.equal(older.reason, 'older');
  const [entry] = await store.getEntries();
  assert.equal(entry.title, '新');
  assert.equal(entry.closedAt, 2000);
});

test('按上限裁剪最旧条目', async () => {
  const { store } = setup();
  await store.recordClose(closeEvent('e1', 'https://example.com/1', 1000), 3);
  await store.recordClose(closeEvent('e2', 'https://example.com/2', 2000), 3);
  await store.recordClose(closeEvent('e3', 'https://example.com/3', 3000), 3);
  await store.recordClose(closeEvent('e4', 'https://example.com/4', 4000), 3);
  const entries = await store.getEntries();
  assert.deepEqual(entries.map((entry) => entry.url), [
    'https://example.com/4',
    'https://example.com/3',
    'https://example.com/2',
  ]);
  assert.deepEqual(await store.previewTrim(2), { total: 3, trimmed: 1 });
});

test('存储失败保留 pending，恢复后补写且幂等', async () => {
  const { store, chrome } = setup();
  chrome.storage.local.control.failWrites = true;
  await assert.rejects(
    () => store.recordClose(closeEvent('e1', 'https://example.com/a', 1000), 500),
    StorageFailureError,
  );
  assert.equal(await store.getPendingCount(), 1);
  assert.equal((await store.getEntries()).length, 0);

  chrome.storage.local.control.failWrites = false;
  const result = await store.retryPending(500);
  assert.equal(result.applied, 1);
  assert.equal(result.pending, 0);
  assert.equal((await store.getEntries()).length, 1);
  const again = await store.retryPending(500);
  assert.equal(again.applied, 0);
});

test('清空提升代次并丢弃旧 pending 事件', async () => {
  const { store, chrome } = setup();
  await store.recordClose(closeEvent('e1', 'https://example.com/a', 1000), 500);
  const cleared = await store.clear();
  assert.equal(cleared.removed, 1);

  chrome.storage.session.data['normal.pendingCloses'] = [
    { ...closeEvent('old', 'https://example.com/a', 2000), generation: 0 },
  ];
  const retried = await store.retryPending(500);
  assert.equal(retried.applied, 0);
  assert.equal((await store.getEntries()).length, 0);
});

test('删除条目会取消同一网址的 pending，后续真实关闭仍可写入', async () => {
  const { store, chrome } = setup({ now: () => 2500 });
  await store.recordClose(closeEvent('e1', 'https://example.com/a', 1000), 500);
  const id = (await store.getEntries())[0].id;

  chrome.storage.local.control.failWrites = true;
  await assert.rejects(
    () => store.recordClose(closeEvent('e2', 'https://example.com/a', 2000), 500),
    StorageFailureError,
  );
  chrome.storage.local.control.failWrites = false;

  await store.deleteEntry(id);
  assert.equal((await store.getEntries()).length, 0);
  assert.equal(await store.getPendingCount(), 0);

  await store.recordClose(closeEvent('e3', 'https://example.com/a', 3000), 500);
  assert.equal((await store.getEntries()).length, 1);
});

test('单删时 session 清理失败，旧 pending 也不能复活（新实例重试）', async () => {
  const { store, chrome } = setup({ now: () => 3000 });
  await store.recordClose(closeEvent('e1', 'https://example.com/a', 1000), 500);
  const id = (await store.getEntries())[0].id;

  chrome.storage.local.control.failWrites = true;
  await assert.rejects(
    () => store.recordClose(closeEvent('e2', 'https://example.com/a', 2000), 500),
    StorageFailureError,
  );
  chrome.storage.local.control.failWrites = false;
  assert.equal(await store.getPendingCount(), 1);

  // 条目删除的 local 写入成功，但 session 中的 pending 清理失败。
  chrome.storage.session.control.failWrites = true;
  const deletion = await store.deleteEntry(id);
  assert.equal(deletion.removed, true);
  chrome.storage.session.control.failWrites = false;
  assert.equal((await store.getEntries()).length, 0);
  assert.deepEqual(Object.keys(chrome.storage.local.data['normal.recent'].deleted), ['https://example.com/a']);

  // 模拟 worker 重建：新实例读取同一 local/session，删除标记仍在。
  const rebuilt = createNormalStore({
    localArea: chrome.storage.local,
    sessionArea: chrome.storage.session,
    now: () => 3000,
  });
  const retried = await rebuilt.retryPending(500);
  assert.equal(retried.applied, 0);
  assert.equal(retried.pending, 0);
  assert.equal((await rebuilt.getEntries()).length, 0);
  // 旧 pending 已取消并落盘，删除标记随之清理。
  assert.deepEqual(chrome.storage.local.data['normal.recent'].deleted, {});

  // 删除之后真实发生的新关闭仍然可以写入。
  await rebuilt.recordClose(closeEvent('e3', 'https://example.com/a', 4000), 500);
  const entries = await rebuilt.getEntries();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].closedAt, 4000);
});

test('updateLimitAndSettings 同一次 local 写入设置与裁剪', async () => {
  const { store, chrome } = setup();
  await store.recordClose(closeEvent('e1', 'https://example.com/1', 1000), 500);
  await store.recordClose(closeEvent('e2', 'https://example.com/2', 2000), 500);
  const settings = {
    schemaVersion: 2,
    popupWidth: 440,
    normal: { maxRecords: 1 },
    incognito: { maxRecords: 500 },
  };
  const result = await store.updateLimitAndSettings(settings, 1);
  assert.equal(result.trimmed, 1);
  assert.equal((await store.getEntries()).length, 1);
  assert.equal(chrome.storage.local.data.settings.normal.maxRecords, 1);
});

test('单删时没有同 URL 待补写则不写删除标记；local 条目不存 urlKey', async () => {
  const { store, chrome } = setup({ now: () => 3000 });
  await store.recordClose(closeEvent('e1', 'https://example.com/a', 1000), 500);
  await store.recordClose(closeEvent('e2', 'https://example.com/b', 2000), 500);
  const stored = chrome.storage.local.data['normal.recent'];
  assert.equal('urlKey' in stored.entries[0], false);
  const entries = await store.getEntries();
  assert.equal(entries[0].urlKey, 'https://example.com/b');

  await store.deleteEntry(entries[0].id);
  assert.deepEqual(chrome.storage.local.data['normal.recent'].deleted, {});
  assert.equal((await store.getEntries()).length, 1);
});

test('有同 URL 待补写且 session 清理成功时，删除标记写入后随即移除', async () => {
  const { store, chrome } = setup({ now: () => 3000 });
  await store.recordClose(closeEvent('e1', 'https://example.com/a', 1000), 500);
  chrome.storage.local.control.failWrites = true;
  await assert.rejects(
    () => store.recordClose(closeEvent('e2', 'https://example.com/a', 2000), 500),
    StorageFailureError,
  );
  chrome.storage.local.control.failWrites = false;
  const id = (await store.getEntries())[0].id;
  await store.deleteEntry(id);
  assert.equal(await store.getPendingCount(), 0);
  assert.deepEqual(chrome.storage.local.data['normal.recent'].deleted, {});
  assert.equal((await store.retryPending(500)).applied, 0);
  assert.equal((await store.getEntries()).length, 0);
});

test('启动清理只保留仍挡住待补写事件的删除标记', async () => {
  const { store, chrome } = setup();
  chrome.storage.local.data['normal.recent'] = {
    generation: 0,
    lastOrder: 0,
    entries: [],
    deleted: { 'https://example.com/a': 5000, 'https://example.com/b': 5000, 'https://example.com/c': 5000 },
  };
  chrome.storage.session.data['normal.pendingCloses'] = [
    closeEvent('old-a', 'https://example.com/a', 4000, { generation: 0 }),
    closeEvent('new-b', 'https://example.com/b', 6000, { generation: 0 }),
  ];
  const result = await store.startupMaintenance(500);
  assert.equal(result.prunedMarkers, 2);
  assert.equal(result.trimmed, 0);
  assert.deepEqual(chrome.storage.local.data['normal.recent'].deleted, { 'https://example.com/a': 5000 });

  chrome.storage.session.data['normal.pendingCloses'] = [];
  await store.startupMaintenance(500);
  assert.deepEqual(chrome.storage.local.data['normal.recent'].deleted, {});
});
