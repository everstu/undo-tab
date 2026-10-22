import test from 'node:test';
import assert from 'node:assert/strict';

import { createIncognitoSession } from '../background/incognito-session.js';
import { createIncognitoWindowSync } from '../background/incognito-windows.js';
import { createMockChrome } from './helpers/mock-chrome.js';

async function setup() {
  const chrome = createMockChrome({
    windows: [{ id: 2, incognito: true, focused: false }],
    tabs: [],
  });
  const incognitoSession = createIncognitoSession({
    sessionArea: chrome.storage.session,
    logger: { warn() {} },
  });
  await incognitoSession.syncWindows([2]);
  await incognitoSession.recordVisit(
    { eventId: 'v1', url: 'https://example.com/a', visitedAt: 1000, order: 1000000 },
    500,
  );
  const windows = createIncognitoWindowSync({
    chromeApi: chrome,
    incognitoSession,
    logger: { warn() {} },
  });
  return { chrome, incognitoSession, windows };
}

test('窗口枚举失败时保留活动会话，恢复后继续保留', async () => {
  const { chrome, incognitoSession, windows } = await setup();
  const originalGetAll = chrome.windows.getAll;

  chrome.windows.getAll = async () => {
    throw new Error('enumeration failed');
  };
  const failed = await windows.sync();
  assert.equal(failed.uncertain, true);
  assert.equal(failed.active, true);
  assert.equal((await incognitoSession.getInfo()).active, true);
  assert.equal((await incognitoSession.query('history', '')).total, 1);

  chrome.windows.getAll = originalGetAll;
  const recovered = await windows.sync();
  assert.equal(recovered.uncertain, false);
  assert.equal(recovered.active, true);
  assert.equal((await incognitoSession.query('history', '')).total, 1);
});

test('权限查询失败也视为未知，不清理', async () => {
  const { chrome, incognitoSession, windows } = await setup();
  const original = chrome.extension.isAllowedIncognitoAccess;
  chrome.extension.isAllowedIncognitoAccess = async () => {
    throw new Error('access check failed');
  };
  const result = await windows.sync();
  assert.equal(result.uncertain, true);
  assert.equal(result.active, true);
  assert.equal((await incognitoSession.query('history', '')).total, 1);
  chrome.extension.isAllowedIncognitoAccess = original;
});

test('只有枚举成功且为空才结束会话', async () => {
  const { chrome, incognitoSession, windows } = await setup();
  chrome.__test.closeWindow(2);
  const result = await windows.sync();
  assert.equal(result.uncertain, false);
  assert.equal(result.active, false);
  assert.equal((await incognitoSession.getInfo()).active, false);
  assert.equal((await incognitoSession.query('history', '')).total, 0);
});

test('权限已明确撤销时结束会话', async () => {
  const { chrome, incognitoSession, windows } = await setup();
  chrome.__test.setIncognitoAllowed(false);
  const result = await windows.sync();
  assert.equal(result.accessRevoked, true);
  assert.equal(result.active, false);
  assert.equal((await incognitoSession.getInfo()).active, false);
  assert.equal((await incognitoSession.query('history', '')).total, 0);
});
