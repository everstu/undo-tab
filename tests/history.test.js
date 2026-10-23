import test from 'node:test';
import assert from 'node:assert/strict';

import { createHistoryService } from '../background/history-service.js';
import { createMockChrome } from './helpers/mock-chrome.js';

test('普通历史查询显式使用 startTime: 0 与分模式上限', async () => {
  const chrome = createMockChrome();
  chrome.__test.setHistory([
    { url: 'https://example.com/new', title: 'New', lastVisitTime: 3000, visitCount: 2 },
    { url: 'https://example.com/old', title: 'Old', lastVisitTime: 1000, visitCount: 1 },
  ]);
  const service = createHistoryService({ chromeApi: chrome });
  const result = await service.searchNormal('  example  ', 1);
  assert.deepEqual(chrome.__test.historySearchCalls, [
    { text: 'example', startTime: 0, maxResults: 1 },
  ]);
  assert.equal(result.loaded, 1);
  assert.equal(result.entries[0].url, 'https://example.com/new');
  assert.equal(result.entries[0].visitCount, 2);
});

test('普通历史过滤非 http(s)，按最后访问时间倒序', async () => {
  const chrome = createMockChrome();
  chrome.__test.setHistory([
    { url: 'chrome://settings/', title: 'Settings', lastVisitTime: 5000 },
    { url: 'https://example.com/a', title: 'A', lastVisitTime: 2000 },
    { url: 'https://example.com/b', title: 'B', lastVisitTime: 4000 },
  ]);
  const service = createHistoryService({ chromeApi: chrome });
  const result = await service.searchNormal('', 10);
  assert.deepEqual(result.entries.map((entry) => entry.url), [
    'https://example.com/b',
    'https://example.com/a',
  ]);
  assert.equal(result.entries[0].title, 'B');
});

for (const limit of [100, 200]) {
  test(`普通历史过滤不可打开的网址后仍加载满 ${limit} 条`, async () => {
    const chrome = createMockChrome();
    const items = Array.from({ length: limit + 10 }, (_, index) => ({
      url: index % 100 === 50 ? `file:///test-${index}.html` : `https://example.com/${index}`,
      title: `Page ${index}`,
      lastVisitTime: 10000 - index,
    }));
    chrome.__test.setHistory(items);
    const service = createHistoryService({ chromeApi: chrome });

    const result = await service.searchNormal('', limit);

    assert.equal(result.loaded, limit);
    assert.equal(result.entries.length, limit);
    assert.deepEqual(result.entries.map((entry) => entry.url),
      items.filter((item) => item.url.startsWith('https:')).slice(0, limit).map((item) => item.url));
  });
}

test('空标题回退域名', async () => {
  const chrome = createMockChrome();
  chrome.__test.setHistory([{ url: 'https://example.com/a', title: '', lastVisitTime: 1000 }]);
  const service = createHistoryService({ chromeApi: chrome });
  const result = await service.searchNormal('', 10);
  assert.equal(result.entries[0].title, 'example.com');
});

test('多次补取保留搜索词与相同时间戳，结果仍按展示上限截断', async () => {
  const chrome = createMockChrome();
  chrome.__test.setHistory([
    ...Array.from({ length: 20 }, (_, index) => ({ url: `file:///needle-${index}`, title: 'Needle', lastVisitTime: 1000 })),
    ...Array.from({ length: 5 }, (_, index) => ({ url: `https://example.com/needle-${index}`, title: 'Needle', lastVisitTime: 1000 })),
  ]);
  const result = await createHistoryService({ chromeApi: chrome }).searchNormal('  Needle  ', 3);
  assert.equal(result.loaded, 3);
  assert.deepEqual(result.entries.map((entry) => entry.url),
    ['https://example.com/needle-0', 'https://example.com/needle-1', 'https://example.com/needle-2']);
  assert.ok(chrome.__test.historySearchCalls.length > 2);
  assert.ok(chrome.__test.historySearchCalls.every((call) => call.text === 'Needle' && call.startTime === 0));
});

test('有效历史不足或全被过滤时返回实际条数并结束查询', async () => {
  const chrome = createMockChrome();
  const hidden = Array.from({ length: 6 }, (_, index) => ({ url: `file:///test-${index}`, lastVisitTime: 1000 }));
  chrome.__test.setHistory([...hidden, { url: 'https://example.com/only', lastVisitTime: 1000 }]);
  const service = createHistoryService({ chromeApi: chrome });
  const partial = await service.searchNormal('', 4);
  assert.equal(partial.loaded, 1);
  assert.equal(partial.limit, 4);
  chrome.__test.setHistory(hidden);
  const empty = await service.searchNormal('', 4);
  assert.equal(empty.loaded, 0);
  assert.deepEqual(empty.entries, []);
});

test('普通历史未传上限时默认展示 100 条', async () => {
  const chrome = createMockChrome();
  chrome.__test.setHistory(Array.from({ length: 110 }, (_, index) => ({
    url: `https://example.com/${index}`, lastVisitTime: 1000 - index,
  })));
  const result = await createHistoryService({ chromeApi: chrome }).searchNormal('');
  assert.equal(result.loaded, 100);
  assert.equal(result.limit, 100);
});
