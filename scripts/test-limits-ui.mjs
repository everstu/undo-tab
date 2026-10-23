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
const screenshotDir = path.join(tempRoot, 'screenshots');
await mkdir(tempRoot, { recursive: true });
const profileDir = await mkdtemp(path.join(tempRoot, 'limits-ui-'));
let harness;
try {
  harness = await launchChrome({ extensionPath: root, profileDir });
  assert.ok(harness.id, harness.loadError || '扩展未加载');
  const tab = await harness.createTab('about:blank');
  const prefix = `chrome-extension://${harness.id}`;
  // 上限范围 10–1000：旧版无痕共用上限 15 回填两个字段；访问 15 条、关闭 13 条。
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
        schemaVersion: 2, popupWidth: 440, normal: { maxRecords: 14 }, incognito: { maxRecords: 15 }
      };
      const worker = createUndoTabWorker({ chrome: mock, logger: { warn() {} } });
      await worker.ensureReady();
      for (let i = 1; i <= 15; i++) {
        await worker.stores.incognitoSession.recordVisit({
          eventId: 'visit-' + i, url: 'https://example.com/history/' + i,
          title: 'History ' + i, visitedAt: 1000 + i, order: 1000 + i
        }, 15);
        if (i <= 13) await worker.stores.incognitoSession.recordClose({
          eventId: 'close-' + i, url: 'https://example.com/recent/' + i,
          title: 'Recent ' + i, closedAt: 1000 + i, order: 1000 + i
        }, 15);
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
  const text = (id) => evaluate(`document.getElementById(${JSON.stringify(id)}).textContent`);
  const visible = (id) => evaluate(`!document.getElementById(${JSON.stringify(id)}).hidden`);
  const readState = () => evaluate(`(async () => {
    const { worker } = await globalThis.__limitsReady;
    return {
      settings: await worker.stores.settingsStore.get(),
      recent: (await worker.stores.incognitoSession.query('recent', '')).total,
      history: (await worker.stores.incognitoSession.query('history', '')).total
    };
  })()`);
  await waitFor(() => evaluate("!document.body.classList.contains('booting') && document.querySelectorAll('.row').length === 13"));
  await click('open-settings');
  assert.equal(await evaluate("document.getElementById('history-limit-block').hidden"), false);
  assert.equal(await evaluate("document.getElementById('max-records').value"), '15');
  assert.equal(await evaluate("document.getElementById('history-max-records').value"), '15');
  assert.match(await text('max-scope-desc'), /10–1000 条，超出时按 10 或 1000 条保存/);
  assert.equal(await visible('incognito-usage'), true);
  assert.match(await text('incognito-usage'), /约占 .+ MB \/ 10 MB/);

  // 下调最近关闭：先确认；取消不保存，确认后只裁剪最近关闭。
  await input('max-records', 11);
  await click('save-max-records');
  await waitFor(() => visible('trim-confirm'));
  assert.match(await text('trim-confirm-text'), /2 条最近关闭记录.*历史记录不受影响/);
  await click('trim-confirm-no');
  assert.deepEqual((await readState()).settings.incognito, { recentMaxRecords: 15, historyMaxRecords: 15 });
  await input('max-records', 11);
  await click('save-max-records');
  await waitFor(() => visible('trim-confirm'));
  await click('trim-confirm-yes');
  await waitFor(async () => (await readState()).recent === 11);
  assert.equal((await readState()).history, 15);

  await input('history-max-records', 12);
  await click('save-history-max-records');
  await waitFor(() => visible('trim-confirm'));
  assert.match(await text('trim-confirm-text'), /3 条历史记录.*最近关闭不受影响/);
  await click('trim-confirm-yes');
  await waitFor(async () => (await readState()).history === 12);
  assert.equal((await readState()).recent, 11);
  assert.deepEqual((await readState()).settings.incognito, { recentMaxRecords: 11, historyMaxRecords: 12 });
  assert.equal((await readState()).settings.normal.maxRecords, 14);

  // 小于 10：输入框改为 10，确认框先说明将按 10 条保存，保存后以提醒色提示。
  await input('history-max-records', 3);
  await click('save-history-max-records');
  await waitFor(() => visible('trim-confirm'));
  assert.equal(await evaluate("document.getElementById('history-max-records').value"), '10');
  assert.match(await text('trim-confirm-text'), /记录条数最小为 10，将按 10 条保存。.*2 条历史记录/);
  await click('trim-confirm-yes');
  await waitFor(async () => (await readState()).history === 10);
  await waitFor(() => visible('history-max-records-status'));
  assert.equal(await text('history-max-records-status'), '记录条数最小为 10，已按 10 条保存，删除了访问历史 2 条');
  assert.equal(await evaluate("document.getElementById('history-max-records-status').classList.contains('is-notice')"), true);
  assert.equal((await readState()).settings.incognito.historyMaxRecords, 10);

  // 大于 1000：上调不删除记录，无需确认，直接按 1000 保存并提示。
  await input('max-records', 5000);
  await click('save-max-records');
  await waitFor(async () => (await readState()).settings.incognito.recentMaxRecords === 1000);
  await waitFor(() => visible('max-records-status'));
  assert.equal(await text('max-records-status'), '记录条数最大为 1000，已按 1000 条保存');
  assert.equal(await visible('trim-confirm'), false);
  assert.equal(await evaluate("document.getElementById('max-records').value"), '1000');
  assert.equal((await readState()).recent, 11);

  // 配额提示：把模拟 session 配额调小，上调上限时先确认并显示占用估算；取消则不保存。
  const setQuota = (bytes) => evaluate(`(async () => {
    const { mock } = await globalThis.__limitsReady;
    mock.storage.session.QUOTA_BYTES = ${bytes};
  })()`);
  await setQuota(10000);
  await input('history-max-records', 50);
  await click('save-history-max-records');
  await waitFor(() => visible('trim-confirm'));
  assert.match(await text('trim-confirm-text'), /两个列表都存满时约占/);
  await click('trim-confirm-no');
  assert.equal((await readState()).settings.incognito.historyMaxRecords, 10);
  await setQuota('undefined');

  // 小数与空值仍被拒绝，设置不变。
  for (const value of ['1.5', '']) {
    await input('history-max-records', value);
    await click('save-history-max-records');
    await waitFor(() => visible('history-max-records-error'));
    assert.equal((await readState()).settings.incognito.historyMaxRecords, 10);
  }
  await click('back-to-list');
  await click('tab-history');
  await waitFor(() => evaluate("document.getElementById('counts').textContent.includes('上限 10')"));
  await click('tab-recent');
  await waitFor(() => evaluate("document.getElementById('counts').textContent.includes('上限 1000')"));

  // 宽度小于 360：按 360 保存并提示。
  await click('open-settings');
  await input('popup-width', 300);
  await click('save-popup-width');
  await waitFor(() => evaluate("getComputedStyle(document.body).width === '360px'"));
  assert.equal(await evaluate("document.getElementById('popup-width').value"), '360');
  assert.equal(await text('popup-width-status'), '弹窗宽度最小为 360px，已按 360px 保存');
  assert.equal((await readState()).settings.popupWidth, 360);
  assert.equal(await evaluate('document.body.scrollWidth <= document.body.clientWidth'), true);
  const shot = await harness.browser.send('Page.captureScreenshot', {
    format: 'png', clip: { x: 0, y: 0, width: 360, height: 580, scale: 1 },
  }, tab.sessionId);
  await mkdir(screenshotDir, { recursive: true });
  await writeFile(path.join(screenshotDir, 'independent-limits-settings.png'), Buffer.from(shot.data, 'base64'));
  console.log('通过：模拟无痕上下文中的双输入框、迁移初值、取消、独立保存/裁剪、越界收紧提示（条数 10/1000、宽度 360）、配额提示与占用显示、非法值、页脚上限与 360px 布局。');
} finally {
  // 仅删除本脚本创建、且已确认位于任务临时目录内的独立 profile。
  if (harness && path.dirname(path.resolve(harness.profileDir)) === tempRoot) await harness.dispose();
}
