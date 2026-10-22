import test from 'node:test';
import assert from 'node:assert/strict';

import { StorageFailureError } from '../background/normal-store.js';
import { createIncognitoSession } from '../background/incognito-session.js';
import { createMockChrome } from './helpers/mock-chrome.js';

function setup() {
  const chrome = createMockChrome();
  const session = createIncognitoSession({
    sessionArea: chrome.storage.session,
    uuid: (() => {
      let index = 0;
      return () => `inc-${++index}`;
    })(),
    now: (() => {
      let clock = 10000;
      return () => (clock += 10);
    })(),
    logger: { warn() {} },
  });
  return { chrome, session };
}

function closeEvent(eventId, url, closedAt = 1000, extra = {}) {
  return {
    eventId,
    url,
    title: '关闭标题',
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

function visitEvent(eventId, url, visitedAt = 1000, extra = {}) {
  return {
    eventId,
    url,
    title: '',
    visitedAt,
    order: visitedAt * 1000,
    ...extra,
  };
}

test('多个无痕窗口共享会话，最后一个关闭才清空并生成新会话', async () => {
  const { session } = setup();
  const first = await session.syncWindows([1, 2]);
  assert.equal(first.active, true);
  assert.equal(first.newSession, true);
  const firstId = first.sessionId;

  await session.recordClose(closeEvent('c1', 'https://example.com/a', 1000), 500);
  const kept = await session.syncWindows([2]);
  assert.equal(kept.active, true);
  assert.equal(kept.sessionId, firstId);
  assert.equal((await session.query('recent', '')).total, 1);

  const ended = await session.syncWindows([]);
  assert.equal(ended.active, false);
  assert.equal(ended.cleared, true);
  const info = await session.getInfo();
  assert.equal(info.active, false);
  assert.equal(info.sessionId, null);
  assert.equal((await session.query('recent', '')).total, 0);

  const second = await session.syncWindows([3]);
  assert.equal(second.active, true);
  assert.notEqual(second.sessionId, firstId);
  assert.equal((await session.query('recent', '')).total, 0);
});

test('休眠期间错过最后一个窗口关闭，重新打开的新窗口不得继承旧会话', async () => {
  const { session } = setup();
  const first = await session.syncWindows([1]);
  await session.recordClose(closeEvent('c1', 'https://example.com/a', 1000), 500);
  assert.equal((await session.query('recent', '')).total, 1);

  // worker 未观察到 []，直接看到全新的窗口 ID 2；旧窗口 1 已不存在。
  const reopened = await session.syncWindows([2]);
  assert.equal(reopened.active, true);
  assert.equal(reopened.newSession, true);
  assert.equal(reopened.cleared, true);
  assert.notEqual(reopened.sessionId, first.sessionId);
  assert.equal((await session.query('recent', '')).total, 0);
});

test('无痕权限关闭时即使仍有窗口也结束会话', async () => {
  const { session } = setup();
  await session.syncWindows([1]);
  await session.recordClose(closeEvent('c1', 'https://example.com/a', 1000), 500);
  const result = await session.syncWindows([1], { accessAllowed: false });
  assert.equal(result.active, false);
  assert.equal((await session.query('recent', '')).total, 0);
});

test('无痕最近关闭按完整 URL 更新并置顶，独立裁剪', async () => {
  const { session } = setup();
  await session.syncWindows([1]);
  await session.recordClose(closeEvent('c1', 'https://example.com/a', 1000, { title: '旧' }), 2);
  await session.recordClose(closeEvent('c2', 'https://example.com/b', 2000), 2);
  await session.recordClose(closeEvent('c3', 'https://example.com/a', 3000, { title: '新' }), 2);
  await session.recordClose(closeEvent('c4', 'https://example.com/c', 4000), 2);

  const result = await session.query('recent', '');
  assert.equal(result.total, 2);
  assert.deepEqual(result.entries.map((entry) => entry.url), [
    'https://example.com/c',
    'https://example.com/a',
  ]);
  assert.equal(result.entries[1].title, '新');
});

test('查询参数顺序与 fragment 不同保留为不同记录', async () => {
  const { session } = setup();
  await session.syncWindows([1]);
  const urls = [
    'https://example.com/a',
    'https://example.com/a?x=1&y=2',
    'https://example.com/a?y=2&x=1',
    'https://example.com/a#one',
    'https://example.com/a#two',
  ];
  for (const [index, url] of urls.entries()) {
    await session.recordClose(closeEvent(`c${index}`, url, 1000 + index), 500);
  }
  assert.equal((await session.query('recent', '')).total, urls.length);
});

test('无痕访问历史累计次数、按 URL 去重、同事件幂等', async () => {
  const { session } = setup();
  await session.syncWindows([1]);
  const first = await session.recordVisit(visitEvent('v1', 'https://example.com/a', 1000, { title: 'A' }), 500);
  assert.equal(first.applied, true);
  const duplicate = await session.recordVisit(visitEvent('v1', 'https://example.com/a', 1000), 500);
  assert.equal(duplicate.applied, false);
  assert.equal(duplicate.reason, 'duplicate');

  await session.recordVisit(visitEvent('v2', 'https://example.com/a', 2000), 500);
  const history = await session.query('history', '');
  assert.equal(history.total, 1);
  assert.equal(history.entries[0].visitCount, 2);
  assert.equal(history.entries[0].title, 'A');
  assert.equal(history.entries[0].lastVisitedAt, 2000);
});

test('无痕最近关闭与访问历史各自使用上限，互不占用', async () => {
  const { session } = setup();
  await session.syncWindows([1]);
  for (let index = 0; index < 3; index += 1) {
    await session.recordClose(closeEvent(`c${index}`, `https://example.com/c${index}`, 1000 + index), 2);
  }
  for (let index = 0; index < 3; index += 1) {
    await session.recordVisit(visitEvent(`v${index}`, `https://example.com/v${index}`, 1000 + index), 3);
  }
  const recent = await session.query('recent', '');
  const history = await session.query('history', '');
  assert.equal(recent.total, 2);
  assert.equal(history.total, 3);
  assert.deepEqual(await session.previewTrim('recent', 1), {
    recent: 1,
    history: 0,
    recentTotal: 2,
    historyTotal: 3,
  });
});

test('旧会话与旧代次的迟到事件不会写入新会话', async () => {
  const { session } = setup();
  const first = await session.syncWindows([1]);
  const oldSessionId = first.sessionId;
  await session.clearView('history');
  const staleGeneration = await session.recordVisit(
    visitEvent('v-old', 'https://example.com/old', 500, {
      sessionId: oldSessionId,
      generation: 0,
    }),
    500,
  );
  assert.equal(staleGeneration.applied, false);
  assert.equal(staleGeneration.reason, 'stale-generation');

  await session.syncWindows([]);
  const second = await session.syncWindows([2]);
  assert.notEqual(second.sessionId, oldSessionId);
  const staleSession = await session.recordClose(
    closeEvent('c-old', 'https://example.com/old', 2000, { sessionId: oldSessionId }),
    500,
  );
  assert.equal(staleSession.applied, false);
  assert.equal(staleSession.reason, 'stale-session');
  assert.equal((await session.query('recent', '')).total, 0);
});

test('清空本次记录保留有效会话，并丢弃旧 pending', async () => {
  const { session, chrome } = setup();
  await session.syncWindows([1]);
  await session.recordClose(closeEvent('c1', 'https://example.com/a', 1000), 500);
  await session.recordVisit(visitEvent('v1', 'https://example.com/a', 1000), 500);
  const cleared = await session.clearData();
  assert.equal(cleared.removed, 2);
  const info = await session.getInfo();
  assert.equal(info.active, true);
  assert.equal((await session.query('recent', '')).total, 0);
  assert.equal((await session.query('history', '')).total, 0);

  const stale = await session.recordVisit(visitEvent('v1', 'https://example.com/a', 1000), 500);
  assert.equal(stale.applied, true);
  assert.equal((await session.query('history', '')).total, 1);
  assert.ok(chrome.storage.session.data['incognito.state'].sessionId === info.sessionId);
});

test('单独清空访问历史不影响最近关闭及其上限', async () => {
  const { session } = setup();
  await session.syncWindows([1]);
  await session.recordClose(closeEvent('c1', 'https://example.com/a', 1000), 500);
  await session.recordVisit(visitEvent('v1', 'https://example.com/b', 1000), 500);
  await session.clearView('history');
  assert.equal((await session.query('history', '')).total, 0);
  assert.equal((await session.query('recent', '')).total, 1);
  const info = await session.getInfo();
  assert.equal(info.active, true);
});

test('标题回填只在 URL 与 tabId 匹配时更新', async () => {
  const { session } = setup();
  await session.syncWindows([1]);
  await session.recordVisit(visitEvent('v1', 'https://example.com/a', 1000, { tabId: 7 }), 500);
  const wrongUrl = await session.updateTitle({ url: 'https://example.com/b', title: '错误标题', tabId: 7 });
  assert.equal(wrongUrl.updated, false);
  const wrongTab = await session.updateTitle({ url: 'https://example.com/a', title: '错误标签', tabId: 8 });
  assert.equal(wrongTab.updated, false);
  const right = await session.updateTitle({
    url: 'https://example.com/a',
    title: '正确标题',
    favIconUrl: 'https://example.com/favicon.ico',
    tabId: 7,
  });
  assert.equal(right.updated, true);
  const history = await session.query('history', '');
  assert.equal(history.entries[0].title, '正确标题');
  assert.equal(history.entries[0].hasFavicon, true);
});

test('写入失败保留 pending，恢复后补写', async () => {
  const { session, chrome } = setup();
  await session.syncWindows([1]);
  chrome.storage.session.control.failWrites = true;
  await assert.rejects(
    () => session.recordVisit(visitEvent('v1', 'https://example.com/a', 1000), 500),
    StorageFailureError,
  );
  assert.equal(await session.getPendingCount(), 1);
  chrome.storage.session.control.failWrites = false;
  const result = await session.retryPending({ recentMaxRecords: 500, historyMaxRecords: 500 });
  assert.equal(result.pending, 0);
  assert.equal((await session.query('history', '')).total, 1);
});

test('单删访问历史后旧 pending 不复活，新访问仍可写入', async () => {
  const { session, chrome } = setup();
  await session.syncWindows([1]);
  await session.recordVisit(visitEvent('v1', 'https://example.com/a', 1000), 500);
  const entry = (await session.query('history', '')).entries[0];
  await session.deleteEntry('history', entry.id);
  assert.equal((await session.query('history', '')).total, 0);

  const info = await session.getInfo();
  const state = chrome.storage.session.data['incognito.state'];
  state.pending.push({
    kind: 'visit',
    eventId: 'late-old',
    sessionId: info.sessionId,
    generation: state.clearGeneration.history,
    url: 'https://example.com/a',
    urlKey: 'https://example.com/a',
    title: 'A',
    visitedAt: 1000,
    order: 1000000,
  });
  // 模拟 worker 重建：新实例从 session 读取删除标记与 pending。
  const rebuilt = createIncognitoSession({
    sessionArea: chrome.storage.session,
    logger: { warn() {} },
  });
  const retried = await rebuilt.retryPending({ recentMaxRecords: 500, historyMaxRecords: 500 });
  assert.equal(retried.applied, 0);
  assert.equal((await rebuilt.query('history', '')).total, 0);

  await rebuilt.recordVisit(visitEvent('v2', 'https://example.com/a', 20000), 500);
  const history = await rebuilt.query('history', '');
  assert.equal(history.total, 1);
  assert.equal(history.entries[0].lastVisitedAt, 20000);
});

test('活动快照只保存当前会话', async () => {
  const { session } = setup();
  const first = await session.syncWindows([1]);
  await session.setLiveTabs([
    { captureId: 'a', tabId: 1, windowId: 1, mode: 'incognito', sessionId: first.sessionId, url: 'https://example.com/a' },
    { captureId: 'b', tabId: 2, windowId: 1, mode: 'incognito', sessionId: 'other', url: 'https://example.com/b' },
  ]);
  const tabs = await session.getLiveTabs();
  assert.equal(tabs.length, 1);
  assert.equal(tabs[0].sessionId, first.sessionId);
});
