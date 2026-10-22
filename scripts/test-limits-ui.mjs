/**
 * 在真实 Chrome 中运行生产 popup DOM，以内存 Chrome mock 模拟无痕上下文和后台。
 * 验证独立上限的界面操作，不代表真实无痕权限/窗口生命周期验收。
 * 运行：node scripts/test-limits-ui.mjs
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome, waitFor } from './chrome-harness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempRoot = path.join(root, '.tmp');
await mkdir(tempRoot, { recursive: true });
const profileDir = await mkdtemp(path.join(tempRoot, 'limits-ui-'));
let harness;
try {
  harness = await launchChrome({ extensionPath: root, profileDir });
  assert.ok(harness.id, harness.loadError || '扩展未加载');
  const tab = await harness.createTab('about:blank');
  const prefix = `chrome-extension://${harness.id}`;
  const source = `
    // 本页使用内存后台，不接收真实普通扩展后台的 storage 通知。
    chrome.storage.onChanged.addListener = () => {};
    globalThis.__limitsReady = (async () => {
      const [{ createMockChrome }, { createUndoTabWorker }] = await Promise.all([
        import(${JSON.stringify(prefix + '/tests/helpers/mock-chrome.js')}),
        import(${JSON.stringify(prefix + '/background/worker.js')})
      ]);
      const mock = createMockChrome({
        extensionId: chrome.runtime.id,
        windows: [{ id: 1, incognito: false }, { id: 2, incognito: true }]
      });
      mock.storage.local.data.settings = {
        schemaVersion: 2, popupWidth: 440, normal: { maxRecords: 7 }, incognito: { maxRecords: 9 }
      };
      const worker = createUndoTabWorker({ chrome: mock, logger: { warn() {} } });
      await worker.ensureReady();
      for (let i = 1; i <= 6; i++) {
        await worker.stores.incognitoSession.recordVisit({
          eventId: 'visit-' + i, url: 'https://example.com/history/' + i,
          title: 'History ' + i, visitedAt: 1000 + i, order: 1000 + i
        }, 9);
        if (i <= 4) await worker.stores.incognitoSession.recordClose({
          eventId: 'close-' + i, url: 'https://example.com/recent/' + i,
          title: 'Recent ' + i, closedAt: 1000 + i, order: 1000 + i
        }, 9);
      }
      return { mock, worker };
    })();
    chrome.windows.getCurrent = async () => { await globalThis.__limitsReady; return { id: 2, incognito: true }; };
    chrome.runtime.sendMessage = async (message) => {
      const { mock } = await globalThis.__limitsReady;
      return new Promise(resolve => mock.runtime.onMessage.emit(message,
        { id: mock.runtime.id, url: mock.runtime.getURL('popup/popup.html') }, resolve));
    };
  `;
  await harness.browser.send('Page.enable', {}, tab.sessionId);
  await harness.browser.send('Page.addScriptToEvaluateOnNewDocument', { source }, tab.sessionId);
  await harness.navigate(tab.sessionId, `${prefix}/popup/popup.html`);
  const evaluate = (expression) => harness.evaluate(tab.sessionId, expression);
  const click = (id) => evaluate(`document.getElementById(${JSON.stringify(id)}).click()`);
  const input = (id, value) => evaluate(`(() => {
    const input = document.getElementById(${JSON.stringify(id)});
    input.value = ${JSON.stringify(String(value))};
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  const readState = () => evaluate(`(async () => {
    const { worker } = await globalThis.__limitsReady;
    return {
      settings: await worker.stores.settingsStore.get(),
      recent: (await worker.stores.incognitoSession.query('recent', '')).total,
      history: (await worker.stores.incognitoSession.query('history', '')).total
    };
  })()`);
  await waitFor(() => evaluate("!document.body.classList.contains('booting') && document.querySelectorAll('.row').length === 4"));
  await click('open-settings');
  assert.equal(await evaluate("document.getElementById('history-limit-block').hidden"), false);
  assert.equal(await evaluate("document.getElementById('max-records').value"), '9');
  assert.equal(await evaluate("document.getElementById('history-max-records').value"), '9');

  await input('max-records', 2);
  await click('save-max-records');
  await waitFor(() => evaluate("!document.getElementById('trim-confirm').hidden"));
  assert.match(await evaluate("document.getElementById('trim-confirm-text').textContent"), /2 条最近关闭记录.*历史记录不受影响/);
  await click('trim-confirm-no');
  assert.deepEqual((await readState()).settings.incognito, { recentMaxRecords: 9, historyMaxRecords: 9 });
  await input('max-records', 2);
  await click('save-max-records');
  await waitFor(() => evaluate("!document.getElementById('trim-confirm').hidden"));
  await click('trim-confirm-yes');
  await waitFor(async () => (await readState()).recent === 2);
  assert.equal((await readState()).history, 6);

  await input('history-max-records', 3);
  await click('save-history-max-records');
  await waitFor(() => evaluate("!document.getElementById('trim-confirm').hidden"));
  assert.match(await evaluate("document.getElementById('trim-confirm-text').textContent"), /3 条历史记录.*最近关闭不受影响/);
  await click('trim-confirm-yes');
  await waitFor(async () => (await readState()).history === 3);
  assert.equal((await readState()).recent, 2);
  assert.deepEqual((await readState()).settings.incognito, { recentMaxRecords: 2, historyMaxRecords: 3 });
  assert.equal((await readState()).settings.normal.maxRecords, 7);

  await input('history-max-records', 0);
  await click('save-history-max-records');
  await waitFor(() => evaluate("!document.getElementById('history-max-records-error').hidden"));
  assert.equal((await readState()).settings.incognito.historyMaxRecords, 3);
  await click('back-to-list');
  await click('tab-history');
  await waitFor(() => evaluate("document.getElementById('counts').textContent.includes('上限 3')"));
  await click('tab-recent');
  await waitFor(() => evaluate("document.getElementById('counts').textContent.includes('上限 2')"));
  await click('open-settings');
  await input('popup-width', 360);
  await click('save-popup-width');
  await waitFor(() => evaluate("getComputedStyle(document.body).width === '360px'"));
  assert.equal(await evaluate('document.body.scrollWidth <= document.body.clientWidth'), true);
  const shot = await harness.browser.send('Page.captureScreenshot', {
    format: 'png', clip: { x: 0, y: 0, width: 360, height: 580, scale: 1 },
  }, tab.sessionId);
  await writeFile(path.join(root, 'docs', 'independent-limits-settings.png'), Buffer.from(shot.data, 'base64'));
  console.log('通过：模拟无痕上下文中的双输入框、迁移初值、取消、独立保存/裁剪、非法值、页脚上限与 360px 布局。');
} finally {
  // 仅删除本脚本创建、且已确认位于任务临时目录内的独立 profile。
  if (harness && path.dirname(path.resolve(harness.profileDir)) === tempRoot) await harness.dispose();
}
