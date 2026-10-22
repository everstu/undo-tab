/**
 * 真实 Chrome 冒烟测试用的最小 CDP 工具。
 * 使用 --remote-debugging-pipe + Extensions.loadUnpacked 加载未打包扩展
 * （Chrome 156 已忽略 --load-extension 命令行开关）。
 * 只用于本地验证，不属于扩展运行时文件。
 */

import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const CHROME_PATH =
  process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class BrowserConnection {
  constructor(child) {
    this.child = child;
    this.toBrowser = child.stdio[3];
    this.fromBrowser = child.stdio[4];
    this.nextId = 0;
    this.buffer = '';
    this.pending = new Map();
    this.listeners = new Map();
    this.closed = false;
    this.fromBrowser.on('data', (chunk) => this.#onData(chunk));
    this.child.on('exit', () => {
      this.closed = true;
      for (const entry of this.pending.values()) entry.reject(new Error('Chrome 已退出'));
      this.pending.clear();
    });
  }

  #onData(chunk) {
    this.buffer += chunk.toString('utf8');
    let index;
    while ((index = this.buffer.indexOf('\0')) !== -1) {
      const raw = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      let message;
      try {
        message = JSON.parse(raw);
      } catch {
        continue;
      }
      if (message.id !== undefined) {
        const entry = this.pending.get(message.id);
        if (!entry) continue;
        this.pending.delete(message.id);
        if (message.error) {
          const error = new Error(`${message.error.code || ''} ${message.error.message || ''}`.trim());
          error.cdpError = message.error;
          entry.reject(error);
        } else {
          entry.resolve(message.result);
        }
      } else if (message.method) {
        for (const handler of this.listeners.get(message.method) || []) {
          handler(message.params, message.sessionId);
        }
      }
    }
  }

  on(method, handler) {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set());
    this.listeners.get(method).add(handler);
    return () => this.listeners.get(method).delete(handler);
  }

  send(method, params = {}, sessionId) {
    if (this.closed) return Promise.reject(new Error('Chrome 连接已关闭'));
    const id = ++this.nextId;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.toBrowser.write(`${JSON.stringify(payload)}\0`);
    });
  }
}

/**
 * @param {object} options
 * @param {string} options.extensionPath 扩展目录绝对路径
 * @param {string} [options.profileDir] 复用已有配置目录（用于重启验证）
 * @param {boolean} [options.headless]
 * @param {string[]} [options.args]
 * @param {string} [options.extensionId] 已知扩展 ID（重启用）
 */
export async function launchChrome({
  extensionPath,
  profileDir = null,
  headless = true,
  args = [],
  extensionId = null,
  loadExtension = true,
}) {
  let dir = profileDir;
  if (!dir) {
    await mkdir(path.resolve('.tmp'), { recursive: true });
    dir = await mkdtemp(path.join(tmpdir(), 'undo-tab-chrome-'));
  } else {
    await mkdir(dir, { recursive: true });
  }

  const chromeArgs = [
    `--user-data-dir=${dir}`,
    '--remote-debugging-pipe',
    '--enable-unsafe-extension-debugging',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--window-size=1200,900',
    ...(headless ? ['--headless=new'] : []),
    ...args,
    'about:blank',
  ];

  const child = spawn(CHROME_PATH, chromeArgs, { stdio: ['ignore', 'ignore', 'inherit', 'pipe', 'pipe'] });
  const browser = new BrowserConnection(child);
  await sleep(1200);
  if (browser.closed) throw new Error('Chrome 启动后立即退出');

  let id = extensionId;
  let loadError = null;
  for (let attempt = 0; loadExtension && attempt < 2; attempt += 1) {
    try {
      const loaded = await browser.send('Extensions.loadUnpacked', { path: extensionPath });
      id = loaded.id;
      loadError = null;
      break;
    } catch (error) {
      loadError = error.message;
      await sleep(400);
    }
  }

  const harness = {
    child,
    browser,
    profileDir: dir,
    id,
    loadError,
    async targets() {
      const { targetInfos } = await browser.send('Target.getTargets');
      return targetInfos;
    },
    async attach(targetId) {
      const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
      await browser.send('Runtime.enable', {}, sessionId);
      return sessionId;
    },
    async evaluate(sessionId, expression) {
      const result = await browser.send(
        'Runtime.evaluate',
        { expression, awaitPromise: true, returnByValue: true, userGesture: true },
        sessionId,
      );
      if (result.exceptionDetails) {
        const description = result.exceptionDetails.exception?.description || result.exceptionDetails.text;
        throw new Error(`页面执行失败: ${description}`);
      }
      return result.result?.value;
    },
    async findTarget(predicate, { timeout = 15000, interval = 120 } = {}) {
      const start = Date.now();
      while (Date.now() - start < timeout) {
        const found = (await this.targets()).find(predicate);
        if (found) return found;
        await sleep(interval);
      }
      return null;
    },
    async createTab(url, { waitReady = true, timeout = 15000 } = {}) {
      const { targetId } = await browser.send('Target.createTarget', { url });
      const sessionId = await this.attach(targetId);
      if (waitReady) await waitForDocument(this, sessionId, timeout);
      return { targetId, sessionId };
    },
    async closeTarget(targetId) {
      await browser.send('Target.closeTarget', { targetId }).catch(() => {});
    },
    async navigate(sessionId, url, { timeout = 15000 } = {}) {
      await browser.send('Page.enable', {}, sessionId).catch(() => {});
      await browser.send('Page.navigate', { url }, sessionId);
      await waitForDocument(this, sessionId, timeout);
    },
    async stop() {
      try {
        await browser.send('Browser.close');
      } catch {
        // 忽略
      }
      await sleep(1200);
      child.kill();
      await sleep(400);
    },
    async dispose() {
      await this.stop();
      await rm(dir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
    },
  };

  return harness;
}

async function waitForDocument(harness, sessionId, timeout) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const ready = await harness
      .evaluate(sessionId, 'document.readyState')
      .catch(() => null);
    if (ready === 'complete' || ready === 'interactive') return;
    await sleep(80);
  }
}

/** 等待页面内条件为真。 */
export async function waitFor(check, { timeout = 10000, interval = 150, label = '条件' } = {}) {
  const start = Date.now();
  let lastError = null;
  while (Date.now() - start < timeout) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(interval);
  }
  throw new Error(`等待超时：${label}${lastError ? `（最后一次错误：${lastError.message}）` : ''}`);
}

/** 简单的本地静态站点，避免测试依赖外网。 */
export async function startSite({ favicon = true } = {}) {
  const { createServer } = await import('node:http');
  const pages = new Map();
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname === '/favicon.ico') {
      if (!favicon) {
        response.writeHead(404, { 'Content-Type': 'text/plain' });
        response.end('no favicon');
        return;
      }
      response.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=3600' });
      response.end(FAVICON_PNG);
      return;
    }
    const page = pages.get(url.pathname) || { title: 'Undo Tab Test', body: '<h1>test</h1>' };
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(`<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>${page.title}</title></head><body>${page.body}</body></html>`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    origin: `http://127.0.0.1:${port}`,
    add(pathname, title, body = `<h1>${title}</h1>`) {
      pages.set(pathname, { title, body });
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** 32x32 测试图标，供本地站点作为 favicon 使用。 */
const FAVICON_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAjElEQVR4nO2X3QmAMAyE08MdBB1Tx3BNQafQBfzppQkRzPdYcpdrCqUtw7QdEggim2eAnMAnJtBpROvSX66P8057FeYeuGvcEgTWzdlaWBuyGng0Z7SQYOC1+1oPSDDIAJJH8IDmbmc9IMHgraBlCjVaWBlpNbA2ZGuL5l8Q9iDxAC6uGYAAEgx+H+AEgp0rD9jCCOMAAAAASUVORK5CYII=',
  'base64',
);
