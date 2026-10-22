import test from 'node:test';
import assert from 'node:assert/strict';

import { createIncognitoSession } from '../background/incognito-session.js';
import { chooseIncognitoWindow, chooseNormalWindow, openUrl } from '../background/restore-service.js';
import { createMockChrome } from './helpers/mock-chrome.js';

function setup() {
  const chrome = createMockChrome();
  const session = createIncognitoSession({ sessionArea: chrome.storage.session, logger: { warn() {} } });
  return { chrome, session };
}

test('普通记录优先在来源普通窗口打开', async () => {
  const { chrome, session } = setup();
  const win = chrome.__test.addWindow({ incognito: false });
  const result = await openUrl({
    url: 'https://example.com/a',
    mode: 'normal',
    preferredWindowId: win.id,
    chromeApi: chrome,
    incognitoSession: session,
  });
  assert.equal(result.ok, true);
  assert.equal(result.windowId, win.id);
  const tab = chrome.__test.tabs.find((item) => item.id === result.tabId);
  assert.equal(tab.url, 'https://example.com/a');
  assert.equal(tab.incognito, false);
});

test('没有普通窗口时新建普通窗口', async () => {
  const { chrome, session } = setup();
  const result = await openUrl({
    url: 'https://example.com/a',
    mode: 'normal',
    chromeApi: chrome,
    incognitoSession: session,
  });
  assert.equal(result.ok, true);
  assert.equal(result.createdWindow, true);
  assert.equal(chrome.__test.windows[0].incognito, false);
});

test('无痕记录只打开到当前会话仍存在的无痕窗口', async () => {
  const { chrome, session } = setup();
  const win = chrome.__test.addWindow({ incognito: true });
  await session.syncWindows([win.id]);
  const result = await openUrl({
    url: 'https://example.com/a',
    mode: 'incognito',
    preferredWindowId: win.id,
    chromeApi: chrome,
    incognitoSession: session,
  });
  assert.equal(result.ok, true);
  assert.equal(result.mode, 'incognito');
  assert.equal(result.windowId, win.id);
  const tab = chrome.__test.tabs.find((item) => item.id === result.tabId);
  assert.equal(tab.incognito, true);
});

test('没有任何无痕窗口时结束会话并拒绝，不新建无痕窗口', async () => {
  const { chrome, session } = setup();
  await session.syncWindows([1]);
  const result = await openUrl({
    url: 'https://example.com/a',
    mode: 'incognito',
    chromeApi: chrome,
    incognitoSession: session,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'session-ended');
  assert.equal(chrome.__test.windows.length, 0);
  assert.equal((await session.getInfo()).active, false);
});

test('实际窗口不属于当前会话时拒绝打开旧无痕记录', async () => {
  const { chrome, session } = setup();
  const actual = chrome.__test.addWindow({ incognito: true });
  await session.syncWindows([9999]);
  const result = await openUrl({
    url: 'https://example.com/a',
    mode: 'incognito',
    preferredWindowId: actual.id,
    chromeApi: chrome,
    incognitoSession: session,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'session-ended');
  assert.equal(chrome.__test.tabs.length, 0);
  assert.equal((await session.getInfo()).active, false);
});

test('无痕权限查询失败时拒绝恢复，但不清理会话', async () => {
  const { chrome, session } = setup();
  const win = chrome.__test.addWindow({ incognito: true });
  await session.syncWindows([win.id]);
  chrome.extension.isAllowedIncognitoAccess = async () => {
    throw new Error('access check failed');
  };
  const result = await openUrl({
    url: 'https://example.com/a',
    mode: 'incognito',
    preferredWindowId: win.id,
    chromeApi: chrome,
    incognitoSession: session,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'window-unavailable');
  assert.equal((await session.getInfo()).active, true);
});

test('无痕权限关闭时拒绝恢复并结束会话', async () => {
  const { chrome, session } = setup();
  const win = chrome.__test.addWindow({ incognito: true });
  await session.syncWindows([win.id]);
  chrome.__test.setIncognitoAllowed(false);
  const result = await openUrl({
    url: 'https://example.com/a',
    mode: 'incognito',
    preferredWindowId: win.id,
    chromeApi: chrome,
    incognitoSession: session,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'incognito-denied');
  assert.equal((await session.getInfo()).active, false);
});

test('目标窗口在竞态中消失时改选仍然存在的无痕窗口', async () => {
  const { chrome, session } = setup();
  const first = chrome.__test.addWindow({ incognito: true });
  const second = chrome.__test.addWindow({ incognito: true });
  await session.syncWindows([first.id, second.id]);

  const originalCreate = chrome.tabs.create;
  let failed = false;
  chrome.tabs.create = async (options) => {
    if (!failed && options.windowId === first.id) {
      failed = true;
      throw new Error('No window with id: 1');
    }
    return originalCreate(options);
  };

  const result = await openUrl({
    url: 'https://example.com/a',
    mode: 'incognito',
    preferredWindowId: first.id,
    chromeApi: chrome,
    incognitoSession: session,
  });
  assert.equal(result.ok, true);
  assert.equal(result.windowId, second.id);
});

test('窗口选择函数只返回对应模式窗口', () => {
  const windows = [
    { id: 1, incognito: false },
    { id: 2, incognito: true },
    { id: 3, incognito: false },
  ];
  assert.equal(chooseNormalWindow(windows, 99).id, 1);
  assert.equal(chooseNormalWindow(windows, 3).id, 3);
  assert.equal(chooseIncognitoWindow(windows, 99).id, 2);
  assert.equal(chooseIncognitoWindow([{ id: 1, incognito: false }], 1), null);
});

test('非法网址直接拒绝', async () => {
  const { chrome, session } = setup();
  const result = await openUrl({
    url: 'chrome://settings',
    mode: 'normal',
    chromeApi: chrome,
    incognitoSession: session,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'invalid-url');
});
