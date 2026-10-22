import test from 'node:test';
import assert from 'node:assert/strict';

import {
  fallbackTitle,
  initialForRecord,
  isRestorableUrl,
  parseRestorableUrl,
  recordTitle,
  urlKey,
} from '../shared/urls.js';

test('只接受 http/https', () => {
  assert.equal(isRestorableUrl('http://example.com'), true);
  assert.equal(isRestorableUrl('https://example.com/a?b=1#c'), true);
  assert.equal(isRestorableUrl('chrome://extensions'), false);
  assert.equal(isRestorableUrl('file:///C:/tmp/a.html'), false);
  assert.equal(isRestorableUrl('javascript:alert(1)'), false);
  assert.equal(isRestorableUrl('https://'), false);
  assert.equal(isRestorableUrl(''), false);
  assert.equal(isRestorableUrl(null), false);
});

test('urlKey 用完整 href 去重，保留查询参数顺序与 fragment', () => {
  assert.equal(urlKey('https://example.com/a'), 'https://example.com/a');
  assert.equal(urlKey('https://example.com/a?x=1&y=2'), 'https://example.com/a?x=1&y=2');
  assert.equal(urlKey('https://example.com/a?y=2&x=1'), 'https://example.com/a?y=2&x=1');
  assert.equal(urlKey('https://example.com/a#one'), 'https://example.com/a#one');
  assert.equal(urlKey('https://example.com/a#two'), 'https://example.com/a#two');
  assert.notEqual(urlKey('https://example.com/a'), urlKey('https://example.com/a?x=1'));
  assert.notEqual(urlKey('https://example.com/a#one'), urlKey('https://example.com/a#two'));
  assert.equal(urlKey('chrome://settings'), null);
  assert.equal(urlKey('not a url'), null);
});

test('网址解析与标题回退', () => {
  const parsed = parseRestorableUrl('  https://www.example.com/path  ');
  assert.equal(parsed.hostname, 'www.example.com');
  assert.equal(fallbackTitle('https://www.example.com/path'), 'www.example.com');
  assert.equal(recordTitle({ url: 'https://example.com/', title: '  ' }), 'example.com');
  assert.equal(recordTitle({ url: 'https://example.com/', title: '标题' }), '标题');
});

test('图标首字母：域名优先，IP/localhost 用标题', () => {
  assert.equal(initialForRecord({ url: 'https://z.org/register', title: '' }), 'Z');
  assert.equal(initialForRecord({ url: 'https://example.com/', title: '示例' }), 'E');
  assert.equal(initialForRecord({ url: 'http://127.0.0.1:8080/a', title: '本地页面' }), '本');
  assert.equal(initialForRecord({ url: 'http://localhost:3000/', title: 'Dev' }), 'D');
});
