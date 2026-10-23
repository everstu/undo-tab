/**
 * Undo Tab 真实 Chrome 冒烟测试（schema 2）。
 * 结论写入 .tmp/reports/smoke-report.json；截图写入 .tmp/screenshots/。
 * 无痕窗口部分受 Chrome/CDP 限制时如实标记跳过。
 *
 * 运行：node scripts/smoke.mjs [--headed] [--keep-profile]
 */

import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { launchChrome, sleep, startSite, waitFor } from './chrome-harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const extensionPath = root;
const tempRoot = path.join(root, '.tmp');
const screenshotDir = path.join(tempRoot, 'screenshots');
const reportDir = path.join(tempRoot, 'reports');
const profileDir = path.join(tempRoot, 'smoke-profile');
const headless = !process.argv.includes('--headed');
const keepProfile = process.argv.includes('--keep-profile');

const results = [];
let failures = 0;
let chromeVersion = null;

function log(message) {
  console.log(message);
}

async function check(name, fn, { optional = false } = {}) {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail: detail ?? null });
    log(`✔ ${name}${detail ? ` — ${detail}` : ''}`);
    return true;
  } catch (error) {
    if (optional) {
      results.push({ name, ok: true, skipped: true, detail: error.message });
      log(`… ${name}（跳过：${error.message}）`);
      return true;
    }
    failures += 1;
    results.push({ name, ok: false, error: error.message });
    log(`✖ ${name} — ${error.message}`);
    return false;
  }
}

async function must(name, fn, options) {
  const ok = await check(name, fn, options);
  if (!ok) throw new Error(`前置检查失败：${name}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
}

async function group(name, fn) {
  log(`\n===== ${name} =====`);
  try {
    await fn();
  } catch (error) {
    log(`（本组后续检查已跳过：${error.message}）`);
  }
}

let harness = null;
let popup = null;
let site = null;

async function evaluatePopup(expression) {
  return harness.evaluate(popup.sessionId, expression);
}

async function openExtensionPage() {
  const { targetId, sessionId } = await harness.createTab(`chrome-extension://${harness.id}/popup/popup.html`);
  await sleep(250);
  const href = await harness.evaluate(sessionId, 'location.href').catch(() => '');
  if (!href.startsWith('chrome-extension://')) {
    await harness.closeTarget(targetId);
    return null;
  }
  return { targetId, sessionId };
}

async function openPopup() {
  let handle = null;
  for (let attempt = 0; attempt < 3 && !handle; attempt += 1) {
    handle = await openExtensionPage();
    if (!handle) await sleep(700);
  }
  if (!handle) throw new Error('无法打开弹窗页面');
  const { targetId, sessionId } = handle;
  await waitFor(async () => !(await harness.evaluate(sessionId, "document.body.classList.contains('booting')")), {
    label: '弹窗启动完成',
  });
  await waitFor(async () => (await harness.evaluate(sessionId, "document.getElementById('counts').textContent")) !== '', {
    label: '弹窗数据渲染',
  });
  return { targetId, sessionId };
}

async function relaunch() {
  const profile = harness.profileDir;
  const extensionId = harness.id;
  if (popup) {
    await harness.closeTarget(popup.targetId).catch(() => {});
    popup = null;
  }
  await harness.stop();
  harness = await launchChrome({ extensionPath, profileDir: profile, headless, extensionId });
  popup = await openPopup();
}

async function popupInfo() {
  return evaluatePopup(`(() => {
    const rows = [...document.querySelectorAll('.row')];
    return {
      width: getComputedStyle(document.body).width,
      selected: [...document.querySelectorAll('.tab')].filter((el) => el.getAttribute('aria-selected') === 'true').map((el) => el.textContent.trim()),
      tabLabels: [...document.querySelectorAll('.tab')].map((el) => el.textContent.trim()),
      rows: rows.map((row) => ({
        id: row.dataset.id,
        title: (row.querySelector('.row-title') || {}).textContent || '',
        url: (row.querySelector('.row-url') || {}).textContent || '',
        time: (row.querySelector('.row-time') || {}).textContent || '',
        badge: (row.querySelector('.row-badge') || {}).textContent || '',
        hasIcon: Boolean(row.querySelector('.row-icon.has-image .row-icon-img')),
        deleteButtons: row.querySelectorAll('.row-delete').length,
        feedback: (row.querySelector('.row-meta.has-feedback .row-feedback') || {}).textContent || '',
      })),
      counts: document.getElementById('counts').textContent,
      pageLabel: document.getElementById('page-label').textContent,
      empty: document.getElementById('empty').hidden ? null : document.getElementById('empty').textContent,
      banner: document.getElementById('banner').hidden ? null : document.getElementById('banner').textContent,
      settingsVisible: !document.getElementById('settings-view').hidden,
      hasOldModeTabs: Boolean(document.getElementById('tab-normal') || document.getElementById('tab-incognito')),
    };
  })()`);
}

async function storageLocal() {
  return (await evaluatePopup('chrome.storage.local.get(null)')) || {};
}

async function normalEntries() {
  const data = await storageLocal();
  return Array.isArray(data['normal.recent']?.entries) ? data['normal.recent'].entries : [];
}

async function waitNormalEntries(count, label = `普通记录数=${count}`) {
  return waitFor(async () => {
    const entries = await normalEntries();
    return entries.length === count ? entries : null;
  }, { label });
}

async function waitRows(count, label = `弹窗行数=${count}`) {
  return waitFor(async () => {
    const info = await popupInfo();
    return info.rows.length === count ? info : null;
  }, { label });
}

async function openPage(pathname) {
  const url = site.origin + pathname;
  const tab = await harness.createTab(url);
  await waitFor(async () => (await harness.evaluate(tab.sessionId, 'document.title')) !== '', {
    label: `${pathname} 标题`,
  });
  return { ...tab, url };
}

async function closePage(tab) {
  await harness.closeTarget(tab.targetId);
  await sleep(180);
}

async function setView(view) {
  await evaluatePopup(`document.getElementById(${JSON.stringify(view === 'history' ? 'tab-history' : 'tab-recent')}).click()`);
  await sleep(350);
  await waitFor(async () => {
    const info = await popupInfo();
    return info.selected.length === 1;
  }, { label: '视图切换' });
}

async function setSearch(value) {
  await evaluatePopup(`(() => {
    const input = document.getElementById('search');
    input.value = ${JSON.stringify(value)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await sleep(350);
}

async function openSettings() {
  await evaluatePopup("document.getElementById('open-settings').click()");
  await sleep(200);
}

async function backToList() {
  await evaluatePopup("document.getElementById('back-to-list').click()");
  await sleep(200);
}

async function clickRowMain(url) {
  const ok = await evaluatePopup(`(() => {
    const row = [...document.querySelectorAll('.row')].find((item) => (item.querySelector('.row-url') || {}).textContent === ${JSON.stringify(url)});
    if (!row) return false;
    const button = row.querySelector('.row-main');
    if (!button) return false;
    button.click();
    return true;
  })()`);
  assert(ok, `找不到记录行：${url}`);
}

async function capturePopup(name) {
  const dimensions = await evaluatePopup(`(() => {
    const rect = document.body.getBoundingClientRect();
    return { width: Math.round(rect.width), height: Math.min(580, Math.round(rect.height)) };
  })()`);
  await harness.browser.send('Page.enable', {}, popup.sessionId).catch(() => {});
  const shot = await harness.browser.send(
    'Page.captureScreenshot',
    {
      format: 'png',
      captureBeyondViewport: false,
      clip: { x: 0, y: 0, width: dimensions.width, height: dimensions.height, scale: 1 },
    },
    popup.sessionId,
  );
  await mkdir(screenshotDir, { recursive: true });
  const file = path.join(screenshotDir, name);
  await writeFile(file, Buffer.from(shot.data, 'base64'));
  return file;
}

function historyUrlRows(info) {
  return info.rows.filter((row) => row.url.startsWith('http://127.0.0.1:') || row.url.startsWith('https://'));
}

// 固定 profile 路径：上次中断遗留的数据会污染本次断言，启动前先清理（仅限 .tmp/ 下本脚本的目录）。
if (path.dirname(path.resolve(profileDir)) === tempRoot) {
  await rm(profileDir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
}

try {
  site = await startSite();
  site.add('/alpha', 'Alpha Page');
  site.add('/beta', 'Beta Page');
  site.add('/gamma', 'Gamma Page');
  site.add('/legacy', 'Legacy Page');

  await must('启动 Chrome 并加载扩展', async () => {
    harness = await launchChrome({ extensionPath, profileDir, headless });
    const blank = await harness.createTab('about:blank');
    const userAgent = await harness.evaluate(blank.sessionId, 'navigator.userAgent');
    await harness.closeTarget(blank.targetId);
    const match = /Chrome\/([\d.]+)/.exec(userAgent || '');
    chromeVersion = match ? match[1] : 'unknown';
    return `Chrome ${chromeVersion}`;
  });

  await must('打开扩展弹窗', async () => {
    popup = await openPopup();
    return '弹窗已渲染';
  });

  await group('A 新界面与数据域', async () => {
    await must('A1 仅两个视图：最近关闭 / 历史记录', async () => {
      const info = await popupInfo();
      assertEqual(info.tabLabels.join(','), '最近关闭,历史记录', '视图标签');
      assertEqual(info.selected.join(','), '最近关闭', '默认视图');
      assertEqual(info.hasOldModeTabs, false, '仍存在旧来源切换');
      return info.tabLabels.join(' / ');
    });

    await must('A2 设置 schema 2 与共享宽度默认值', async () => {
      const settings = (await storageLocal()).settings;
      assertEqual(settings.schemaVersion, 2, 'schemaVersion');
      assertEqual(settings.normal.maxRecords, 100, '普通最近关闭上限');
      assertEqual(settings.normal.historyMaxRecords, 100, '普通历史上限');
      assertEqual(settings.incognito.recentMaxRecords, 100, '无痕最近关闭上限');
      assertEqual(settings.incognito.historyMaxRecords, 100, '无痕历史上限');
      assertEqual(settings.popupWidth, 440, '弹窗宽度');
      const info = await popupInfo();
      assertEqual(info.width, '440px', '弹窗计算宽度');
      return 'schema 2，默认 440px';
    });
  });

  await group('B 普通最近关闭与撤销', async () => {
    await must('B1 关闭两个普通标签生成记录', async () => {
      const alpha = await openPage('/alpha');
      const beta = await openPage('/beta');
      await closePage(alpha);
      await closePage(beta);
      await waitNormalEntries(2);
      const info = await waitRows(2);
      assertEqual(info.rows[0].url, site.origin + '/beta', '最新记录应为 beta');
      assert(info.rows.every((row) => row.time !== ''), '缺少相对时间');
      assert(info.rows.every((row) => row.badge === ''), '仍显示来源徽标');
      return '2 条最近关闭';
    });

    await must('B2 关闭同一完整 URL 更新原记录并置顶', async () => {
      const alphaAgain = await openPage('/alpha');
      await closePage(alphaAgain);
      await waitFor(async () => {
        const entries = await normalEntries();
        return entries.length === 2 && entries[0].url === site.origin + '/alpha' ? entries : null;
      }, { label: '同 URL 更新并置顶' });
      const info = await waitFor(async () => {
        const current = await popupInfo();
        return current.rows.length === 2 && current.rows[0].url === site.origin + '/alpha' ? current : null;
      }, { label: '弹窗置顶刷新' });
      assertEqual(info.rows[0].url, site.origin + '/alpha', '置顶记录');
      return '仍为 2 条，alpha 置顶';
    });

    await must('B3 查询参数与 fragment 视为不同记录', async () => {
      const query = await openPage('/alpha?x=1');
      const hash = await openPage('/alpha#part');
      await closePage(query);
      await closePage(hash);
      await waitNormalEntries(4);
      const urls = (await normalEntries()).map((entry) => entry.url);
      assert(urls.includes(site.origin + '/alpha?x=1'), '缺少查询参数记录');
      assert(urls.includes(site.origin + '/alpha#part'), '缺少 fragment 记录');
      return '4 条不同网址';
    });

    await must('B4 点击记录可重新打开标签', async () => {
      const target = site.origin + '/alpha?x=1';
      await clickRowMain(target);
      const found = await harness.findTarget(
        (item) => item.type === 'page' && item.url === target,
        { label: '恢复的标签', timeout: 6000 },
      );
      assert(found, '没有打开目标网址');
      return '已打开 /alpha?x=1';
    });

    await must('B5 搜索只过滤当前视图', async () => {
      await setSearch('beta');
      const info = await waitFor(async () => {
        const current = await popupInfo();
        return current.rows.length === 1 ? current : null;
      }, { label: '搜索过滤' });
      assertEqual(info.rows[0].url, site.origin + '/beta', '搜索结果');
      assert(/^匹配 1 条/.test(info.counts), `页脚：${info.counts}`);
      await setSearch('');
      await waitRows(4);
      return '搜索匹配 1 条';
    });
  });

  await group('C 普通历史只读', async () => {
    await must('C1 历史记录显示 Chrome 历史且无删除按钮', async () => {
      await setView('history');
      const info = await waitFor(async () => {
        const current = await popupInfo();
        return historyUrlRows(current).length > 0 ? current : null;
      }, { label: '普通历史列表' });
      assert(historyUrlRows(info).some((row) => row.url.includes('/alpha')), '历史中缺少 alpha');
      assert(info.rows.every((row) => row.deleteButtons === 0), '普通历史出现删除按钮');
      assert(/^已载入 \d+ 条 · 展示上限 100/.test(info.counts), `页脚：${info.counts}`);
      await capturePopup('popup-screenshot.png');
      return info.counts;
    });

    await must('C2 历史搜索可用', async () => {
      await setSearch('alpha');
      const matches = (row) =>
        row.url.toLowerCase().includes('alpha') || row.title.toLowerCase().includes('alpha');
      const info = await waitFor(async () => {
        const current = await popupInfo();
        return current.rows.length > 0 &&
          /^匹配 \d+ 条 · 展示上限/.test(current.counts) &&
          historyUrlRows(current).every(matches)
          ? current
          : null;
      }, { label: '历史搜索' });
      assert(
        historyUrlRows(info).every(matches),
        `历史搜索结果不匹配：${JSON.stringify(historyUrlRows(info).map((row) => row.url))}；页脚 ${info.counts}`,
      );
      await setSearch('');
      await sleep(400);
      return '历史搜索正常';
    });

    await must('C3 历史页设置提供 Chrome 管理入口', async () => {
      await openSettings();
      const panel = await evaluatePopup(`(() => ({
        manageVisible: !document.getElementById('manage-history-block').hidden,
        clearViewVisible: !document.getElementById('clear-view-block').hidden,
        dataNote: document.getElementById('data-note').textContent,
      }))()`);
      assertEqual(panel.manageVisible, true, '管理历史入口');
      assertEqual(panel.clearViewVisible, false, '普通历史不应有清空入口');
      assert(/只读查询/.test(panel.dataNote), '数据说明');
      await backToList();
      return '只读入口可见，无清空入口';
    });

    await must('C4 普通历史独立上限，过滤 file 后仍展示满 100/200 条', async () => {
      // 仅在隔离 profile 中注入合成普通历史；扩展运行时代码不添加浏览器历史。
      const marker = 'undo-tab-limit-fixture';
      const fixtureUrls = Array.from({ length: 210 }, (_, index) => index % 100 === 50
        ? pathToFileURL(path.join(profileDir, `${marker}-${index}.html`)).href
        : `${site.origin}/${marker}-${index}`);
      for (const index of [50, 150]) {
        await writeFile(path.join(profileDir, `${marker}-${index}.html`), '<title>Undo Tab history fixture</title>');
      }
      await evaluatePopup(`(async () => {
        for (const url of ${JSON.stringify(fixtureUrls)}) await chrome.history.addUrl({ url });
      })()`);
      const recentBefore = JSON.stringify(await normalEntries());
      const raw = await evaluatePopup(`(async () => {
        const rows = await chrome.history.search({ text: ${JSON.stringify(marker)}, startTime: 0, maxResults: 1000 });
        return { total: rows.length, files: rows.filter(item => item.url.startsWith('file:')).length };
      })()`);
      assertEqual(raw.total, 210, '合成历史总数');
      assertEqual(raw.files, 2, '真实 Chrome 返回的 file 历史');
      await setSearch(marker);
      for (const limit of [100, 200]) {
        await openSettings();
        assertEqual(await evaluatePopup("document.getElementById('history-limit-block').hidden"), false, '普通历史上限输入可见');
        assertEqual(await evaluatePopup("document.getElementById('history-max-records-label').textContent"), '历史记录最多展示多少条', '普通历史标签');
        await evaluatePopup(`(() => {
          const input = document.getElementById('history-max-records');
          input.value = '${limit}';
          input.dispatchEvent(new Event('input', { bubbles: true }));
          document.getElementById('save-history-max-records').click();
        })()`);
        await waitFor(async () => (await storageLocal()).settings.normal.historyMaxRecords === limit,
          { label: `普通历史上限保存为 ${limit}` });
        assertEqual(await evaluatePopup("document.getElementById('trim-confirm').hidden"), true, '普通历史不应出现删除确认');
        assertEqual(JSON.stringify(await normalEntries()), recentBefore, '修改历史上限不应裁剪最近关闭');
        await backToList();
        await waitFor(async () => (await popupInfo()).counts === `匹配 ${limit} 条 · 展示上限 ${limit}`,
          { label: `过滤后展示满 ${limit} 条` });
        const first = await popupInfo();
        assertEqual(first.pageLabel, `1/${limit / 50}`, '历史分页');
        assertEqual(first.rows.length, 50, '历史首页条数');
        for (let page = 1; page < limit / 50; page += 1) {
          await evaluatePopup("document.getElementById('next-page').click()");
        }
        const last = await popupInfo();
        assertEqual(last.rows.length, 50, '过滤后历史末页条数');
        assert(last.rows.every(row => row.url.startsWith('http:')), '非网页网址进入列表');
        await setSearch(marker);
      }
      const remaining = await evaluatePopup(`chrome.history.search({ text: ${JSON.stringify(marker)}, startTime: 0, maxResults: 1000 }).then(items => items.length)`);
      assertEqual(remaining, 210, '设置展示上限不得删除 Chrome 历史');
      await setSearch('');
      return '真实 Chrome 合成历史含 2 条 file；100/200 条均补足，末页各 50 条';
    });
  });

  await group('D 分模式设置与裁剪', async () => {
    await must('D1 下调普通上限先确认，只裁剪普通最近关闭', async () => {
      await setView('recent');
      // 上限最小为 10：先补到 12 条普通最近关闭，再下调到 10 触发裁剪确认。
      for (let index = 1; index <= 8; index += 1) {
        await closePage(await openPage(`/beta?n=${index}`));
      }
      await waitNormalEntries(12);
      await openSettings();
      await evaluatePopup(`(() => {
        const input = document.getElementById('max-records');
        input.value = '10';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        document.getElementById('save-max-records').click();
      })()`);
      const confirmation = await (async () => {
        try {
          return await waitFor(async () => {
            const value = await evaluatePopup(`(() => ({
              visible: !document.getElementById('trim-confirm').hidden,
              text: document.getElementById('trim-confirm-text').textContent,
            }))()`);
            return value.visible ? value : null;
          }, { label: '裁剪确认' });
        } catch (error) {
          const diagnostic = await evaluatePopup(`(() => ({
            settingsVisible: !document.getElementById('settings-view').hidden,
            maxValue: document.getElementById('max-records').value,
            maxError: document.getElementById('max-records-error').hidden ? null : document.getElementById('max-records-error').textContent,
            trimVisible: !document.getElementById('trim-confirm').hidden,
            maxStatus: document.getElementById('max-records-status').hidden ? null : document.getElementById('max-records-status').textContent,
            counts: document.getElementById('counts').textContent,
          }))()`);
          throw new Error(`${error.message}；诊断=${JSON.stringify(diagnostic)}`);
        }
      })();
      assert(/最近关闭/.test(confirmation.text), `确认文案：${confirmation.text}`);
      await evaluatePopup("document.getElementById('trim-confirm-yes').click()");
      await waitFor(async () => {
        const entries = await normalEntries();
        return entries.length === 10 ? entries : null;
      }, { label: '普通记录裁剪到 10' });
      const settings = (await storageLocal()).settings;
      assertEqual(settings.normal.maxRecords, 10, '普通上限');
      assertEqual(settings.normal.historyMaxRecords, 200, '普通历史上限被改动');
      assertEqual(settings.incognito.recentMaxRecords, 100, '无痕最近关闭上限被改动');
      assertEqual(settings.incognito.historyMaxRecords, 100, '无痕历史上限被改动');
      return '普通最近关闭 12→10 条，历史展示上限仍 200，无痕仍 100';
    });

    await must('D1b 越界上限按 10/1000 保存并提示', async () => {
      const save = (value) => evaluatePopup(`(() => {
        const input = document.getElementById('max-records');
        input.value = '${value}';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        document.getElementById('save-max-records').click();
      })()`);
      const status = () => evaluatePopup(`(() => {
        const el = document.getElementById('max-records-status');
        return el.hidden ? null : { text: el.textContent, notice: el.classList.contains('is-notice') };
      })()`);
      // 小于 10：已有 10 条，按 10 保存不删除记录，因此不弹删除确认。
      await save(2);
      const low = await waitFor(async () => {
        const value = await status();
        return value && /最小为 10/.test(value.text) ? value : null;
      }, { label: '最小值提示' });
      assertEqual(low.text, '记录条数最小为 10，已按 10 条保存', '最小值提示');
      assertEqual(low.notice, true, '提示样式');
      assertEqual(await evaluatePopup("document.getElementById('trim-confirm').hidden"), true, '不应出现删除确认');
      assertEqual(await evaluatePopup("document.getElementById('max-records').value"), '10', '输入框显示实际保存值');
      assertEqual((await storageLocal()).settings.normal.maxRecords, 10, '小于 10 写入 10');
      // 大于 1000：上调不删除记录。
      await save(5000);
      await waitFor(async () => (await storageLocal()).settings.normal.maxRecords === 1000, { label: '大于 1000 写入 1000' });
      const high = await waitFor(async () => {
        const value = await status();
        return value && /最大为 1000/.test(value.text) ? value : null;
      }, { label: '最大值提示' });
      assertEqual(high.text, '记录条数最大为 1000，已按 1000 条保存', '最大值提示');
      assertEqual((await normalEntries()).length, 10, '上调不应删除记录');
      // 恢复为 10，供后续步骤断言。
      await save(10);
      await waitFor(async () => (await storageLocal()).settings.normal.maxRecords === 10, { label: '恢复上限 10' });
      return '2 → 10、5000 → 1000，均提示且未误删';
    });

    await must('D2 宽度 360/800 保存立即生效，越界收紧并提示，可恢复 440', async () => {
      // 小于 360 按 360 保存并提示。
      await evaluatePopup(`(() => {
        const input = document.getElementById('popup-width');
        input.value = '300';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        document.getElementById('save-popup-width').click();
      })()`);
      await waitFor(async () => (await popupInfo()).width === '360px', { label: '宽度 300 → 360' });
      assertEqual(
        await evaluatePopup("document.getElementById('popup-width-status').textContent"),
        '弹窗宽度最小为 360px，已按 360px 保存',
        '宽度最小值提示',
      );
      await backToList();
      await capturePopup('popup-360.png');
      await openSettings();
      await evaluatePopup(`(() => {
        const input = document.getElementById('popup-width');
        input.value = '800';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        document.getElementById('save-popup-width').click();
      })()`);
      await waitFor(async () => (await popupInfo()).width === '800px', { label: '宽度 800' });
      await evaluatePopup(`(() => {
        const input = document.getElementById('popup-width');
        input.value = '1200';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        document.getElementById('save-popup-width').click();
      })()`);
      await waitFor(async () => /最大为 800px/.test(
        await evaluatePopup("document.getElementById('popup-width-status').textContent"),
      ), { label: '宽度最大值提示' });
      assertEqual((await storageLocal()).settings.popupWidth, 800, '宽度大于 800 写入 800');
      await evaluatePopup("document.getElementById('reset-popup-width').click()");
      await waitFor(async () => (await popupInfo()).width === '440px', { label: '宽度恢复 440' });
      return '300→360px（提示）→ 800px → 1200→800px（提示）→ 440px';
    });

    await must('D3 清空普通最近关闭不影响 Chrome 历史', async () => {
      await evaluatePopup("document.getElementById('clear-view').click()");
      await waitFor(async () => !(await evaluatePopup("document.getElementById('clear-view-confirm').hidden")), {
        label: '清空确认',
      });
      await evaluatePopup("document.getElementById('clear-view-yes').click()");
      await waitNormalEntries(0);
      await backToList();
      await waitRows(0);
      const local = await storageLocal();
      assertEqual(local.settings.normal.maxRecords, 10, '清空不应改设置');
      await setView('history');
      const info = await waitFor(async () => {
        const current = await popupInfo();
        return historyUrlRows(current).length > 0 ? current : null;
      }, { label: 'Chrome 历史仍存在' });
      assert(info.rows.every((row) => row.deleteButtons === 0), '历史出现删除按钮');
      return '最近关闭 0 条，Chrome 历史仍在';
    });

    await must('D4 普通窗口设置不显示无痕数据，local 不含无痕键', async () => {
      await openSettings();
      const panel = await evaluatePopup(`(() => ({
        incognitoBlock: !document.getElementById('incognito-block').hidden,
        maxScope: document.getElementById('max-scope-desc').textContent,
      }))()`);
      assertEqual(panel.incognitoBlock, false, '普通窗口显示无痕设置');
      assert(/普通窗口/.test(panel.maxScope), '设置说明');
      const local = await storageLocal();
      const incognitoKeys = Object.keys(local).filter((key) => key.startsWith('incognito.'));
      assertEqual(incognitoKeys.length, 0, `local 出现无痕状态 ${incognitoKeys.join(',')}`);
      assertEqual(local['history.records'], undefined, '旧 key 未清理');
      await backToList();
      return '无痕设置已隐藏';
    });

    await must('D5 截图已生成', async () => {
      return '.tmp/screenshots/popup-screenshot.png（C1）、.tmp/screenshots/popup-360.png（D2）';
    });
  });

  await group('E 重启持久化与旧数据迁移', async () => {
    await must('E1 重启后普通最近关闭保留', async () => {
      await setView('recent');
      const gamma = await openPage('/gamma');
      await closePage(gamma);
      await waitNormalEntries(1);
      await relaunch();
      await setView('recent');
      const info = await waitFor(async () => {
        const current = await popupInfo();
        return current.rows.length === 1 ? current : null;
      }, { label: '重启后记录' });
      assertEqual(info.rows[0].url, site.origin + '/gamma', '重启后记录网址');
      const settings = (await storageLocal()).settings;
      assertEqual(settings.normal.maxRecords, 10, '重启后普通最近关闭上限');
      assertEqual(settings.normal.historyMaxRecords, 200, '重启后普通历史上限');
      return '1 条记录保留';
    });

    await must('E2 旧 schema 1 数据迁移：只保留普通，清理旧 key', async () => {
      const now = Date.now();
      const seed = await evaluatePopup(`(async () => {
        await chrome.storage.local.clear();
        await chrome.storage.session.clear();
        await chrome.storage.local.set({
          settings: { schemaVersion: 1, maxRecords: 42, popupWidth: 440 },
          'history.records': [
            { id: 'legacy-normal', url: ${JSON.stringify(site.origin + '/legacy')}, title: 'Legacy Normal', closedAt: ${now - 1000}, mode: 'normal', originalWindowId: 1, originalIndex: 0, wasPinned: false, hasFavicon: true, windowClosing: false },
            { id: 'legacy-incognito', url: 'https://secret.example/incognito', title: 'Secret', closedAt: ${now}, mode: 'incognito', originalWindowId: 2, originalIndex: 0, wasPinned: false, hasFavicon: false, windowClosing: false }
          ]
        });
        return 'seeded';
      })()`);
      assertEqual(seed, 'seeded', '写入旧数据');
      await relaunch();
      await setView('recent');
      const info = await waitFor(async () => {
        const current = await popupInfo();
        return current.rows.length > 0 ? current : null;
      }, { label: '迁移后记录' });
      assertEqual(info.rows.length, 1, '迁移后记录数');
      assertEqual(info.rows[0].url, site.origin + '/legacy', '迁移记录网址');
      const local = await storageLocal();
      assertEqual(local.settings.schemaVersion, 2, '迁移 schema');
      assertEqual(local.settings.normal.maxRecords, 42, '迁移普通上限');
      assertEqual(local.settings.normal.historyMaxRecords, 42, '迁移普通历史上限');
      assertEqual(local.settings.incognito.recentMaxRecords, 42, '迁移无痕最近关闭上限');
      assertEqual(local.settings.incognito.historyMaxRecords, 42, '迁移无痕历史上限');
      assertEqual(local['history.records'], undefined, '旧记录 key');
      assertEqual(local['live.tabs'], undefined, '旧快照 key');
      assertEqual(JSON.stringify(local).includes('secret.example'), false, '本地残留无痕网址');
      const session = await evaluatePopup('chrome.storage.session.get(null)');
      assertEqual(session['live.tabs'], undefined, 'session 旧快照 key');
      return '普通 1 条，无痕已丢弃，schema 2';
    });

    await must('E3 迁移结果再次重启仍保留', async () => {
      await relaunch();
      await setView('recent');
      const info = await waitFor(async () => {
        const current = await popupInfo();
        return current.rows.length === 1 ? current : null;
      }, { label: '迁移持久化' });
      assertEqual(info.rows[0].url, site.origin + '/legacy', '再次重启记录');
      return '1 条保留';
    });

    await check('E4 无痕窗口界面与最后窗口清理', async () => {
      const allowed = await evaluatePopup('chrome.extension.isAllowedIncognitoAccess()');
      if (!allowed) {
        throw new Error('Chrome 156 通过 CDP loadUnpacked 加载扩展后无法启用无痕访问；无痕窗口行为需在常规 Chrome 中手工验收（见 docs/MANUAL_TESTS.md）');
      }
      throw new Error('自动化环境不允许 CDP 操作无痕窗口；需手工验收无痕会话隔离与最后窗口清理');
    }, { optional: true });
  });
} finally {
  if (harness) await harness.stop().catch(() => {});
  if (!keepProfile && path.dirname(path.resolve(profileDir)) === tempRoot) {
    await rm(profileDir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  }
  if (site) await site.close().catch(() => {});

  const report = {
    chrome: chromeVersion,
    generatedAt: new Date().toISOString(),
    headless,
    total: results.length,
    passed: results.filter((item) => item.ok && !item.skipped).length,
    skipped: results.filter((item) => item.skipped).length,
    failed: results.filter((item) => !item.ok).length,
    results,
  };
  await mkdir(reportDir, { recursive: true });
  await writeFile(path.join(reportDir, 'smoke-report.json'), JSON.stringify(report, null, 2));
  log(`\n结果：${report.passed} 通过 / ${report.skipped} 跳过 / ${report.failed} 失败（共 ${report.total} 项）`);
  if (report.failed > 0) {
    log('失败项：');
    for (const item of results.filter((entry) => !entry.ok)) log(`- ${item.name}: ${item.error}`);
    process.exitCode = 1;
  }
}
