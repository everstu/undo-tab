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

test('空标题回退域名', async () => {
  const chrome = createMockChrome();
  chrome.__test.setHistory([{ url: 'https://example.com/a', title: '', lastVisitTime: 1000 }]);
  const service = createHistoryService({ chromeApi: chrome });
  const result = await service.searchNormal('', 10);
  assert.equal(result.entries[0].title, 'example.com');
});
