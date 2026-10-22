import { ERROR_CODES, MODES } from '../shared/constants.js';
import { isRestorableUrl } from '../shared/urls.js';

export const RPC_ERROR_MESSAGES = Object.freeze({
  [ERROR_CODES.invalidRequest]: '请求无效',
  [ERROR_CODES.invalidUrl]: '这条记录的网址无法恢复',
  [ERROR_CODES.entryNotFound]: '记录已不存在，请刷新列表',
  [ERROR_CODES.contextLost]: '窗口已关闭，请重新打开弹窗',
  [ERROR_CODES.sessionEnded]: '本次无痕会话已结束，记录已清空',
  [ERROR_CODES.forbidden]: '该操作不被允许',
  [ERROR_CODES.storageFailure]: '保存失败，请检查浏览器存储空间后重试',
  [ERROR_CODES.incognitoDenied]: '未开启无痕权限，无法打开无痕页面',
  [ERROR_CODES.windowUnavailable]: '目标窗口已不可用，请重试',
  [ERROR_CODES.unknown]: '操作失败，请稍后重试',
});

export function errorMessage(code) {
  return RPC_ERROR_MESSAGES[code] || RPC_ERROR_MESSAGES[ERROR_CODES.unknown];
}

function fail(code, message) {
  return { ok: false, code, message: message || errorMessage(code) };
}

export async function checkIncognitoAccess(chromeApi) {
  try {
    if (!chromeApi || !chromeApi.extension || typeof chromeApi.extension.isAllowedIncognitoAccess !== 'function') {
      return { ok: false, allowed: false };
    }
    const allowed = await chromeApi.extension.isAllowedIncognitoAccess();
    return { ok: true, allowed: allowed === true };
  } catch (error) {
    return { ok: false, allowed: false };
  }
}

export async function isAllowedIncognitoAccess(chromeApi) {
  return (await checkIncognitoAccess(chromeApi)).allowed;
}

async function queryWindows(chromeApi) {
  try {
    const windows = await chromeApi.windows.getAll({ populate: false, windowTypes: ['normal'] });
    return Array.isArray(windows) ? windows : [];
  } catch (error) {
    return null;
  }
}

export function chooseNormalWindow(windows, preferredWindowId) {
  const list = (Array.isArray(windows) ? windows : []).filter(
    (win) => win && Number.isInteger(win.id) && win.incognito !== true,
  );
  if (list.length === 0) return null;
  return list.find((win) => win.id === preferredWindowId) || list[0];
}

export function chooseIncognitoWindow(windows, preferredWindowId, sessionWindows = []) {
  const list = (Array.isArray(windows) ? windows : []).filter(
    (win) => win && Number.isInteger(win.id) && win.incognito === true,
  );
  if (list.length === 0) return null;
  return (
    list.find((win) => win.id === preferredWindowId) ||
    list.find((win) => sessionWindows.includes(win.id)) ||
    list[0]
  );
}

/** 恢复旧无痕记录时只能选择仍属于当前会话窗口集合的窗口。 */
function chooseSessionIncognitoWindow(windows, preferredWindowId, sessionWindows) {
  const allowed = new Set(Array.isArray(sessionWindows) ? sessionWindows : []);
  const list = (Array.isArray(windows) ? windows : []).filter(
    (win) => win && Number.isInteger(win.id) && win.incognito === true && allowed.has(win.id),
  );
  if (list.length === 0) return null;
  return list.find((win) => win.id === preferredWindowId) || list[0];
}

function mapCreateError(error, mode) {
  const message = typeof (error && error.message) === 'string' ? error.message : '';
  if (/incognito/i.test(message)) return ERROR_CODES.incognitoDenied;
  if (/window/i.test(message)) return ERROR_CODES.windowUnavailable;
  if (/not allowed|permission|denied/i.test(message)) {
    return mode === MODES.incognito ? ERROR_CODES.incognitoDenied : ERROR_CODES.unknown;
  }
  return ERROR_CODES.unknown;
}

async function createTabInWindow(chromeApi, url, target, mode) {
  let tabCount = null;
  try {
    const tabs = await chromeApi.tabs.query({ windowId: target.id });
    tabCount = Array.isArray(tabs) ? tabs.length : null;
  } catch (error) {
    tabCount = null;
  }
  const options = { windowId: target.id, url, active: true };
  if (Number.isInteger(tabCount)) options.index = tabCount;

  try {
    const tab = await chromeApi.tabs.create(options);
    return { ok: true, tabId: tab && tab.id, windowId: target.id, mode };
  } catch (error) {
    const message = typeof (error && error.message) === 'string' ? error.message : '';
    if (/window/i.test(message)) return fail(ERROR_CODES.windowUnavailable);
    // 位置失败时回退为追加到末尾；窗口失效则交给调用方重新选窗口。
    try {
      const tab = await chromeApi.tabs.create({ windowId: target.id, url, active: true });
      return { ok: true, tabId: tab && tab.id, windowId: target.id, mode };
    } catch (retryError) {
      return fail(mapCreateError(retryError, mode));
    }
  }
}

async function createNormalWindow(chromeApi, url) {
  try {
    const win = await chromeApi.windows.create({ incognito: false, url, focused: true });
    const firstTab = win && Array.isArray(win.tabs) ? win.tabs[0] : null;
    return { ok: true, tabId: firstTab ? firstTab.id : null, windowId: win ? win.id : null, mode: MODES.normal, createdWindow: true };
  } catch (error) {
    return fail(mapCreateError(error, MODES.normal));
  }
}

/**
 * 打开一个网址。
 * - 普通：普通窗口优先，没有则新建普通窗口；
 * - 无痕：只允许当前有效会话里仍然存在的无痕窗口；没有无痕窗口时结束会话并拒绝，
 *   绝不用旧记录新建无痕窗口。
 */
export async function openUrl({ url, mode, preferredWindowId, chromeApi, incognitoSession }) {
  if (!chromeApi || !isRestorableUrl(url)) return fail(ERROR_CODES.invalidUrl);
  if (mode !== MODES.normal && mode !== MODES.incognito) return fail(ERROR_CODES.invalidRequest);

  if (mode === MODES.incognito) {
    const access = await checkIncognitoAccess(chromeApi);
    if (!access.ok) {
      return fail(ERROR_CODES.windowUnavailable, '暂时无法确认无痕权限，请稍后重试');
    }
    if (!access.allowed) {
      if (incognitoSession) await incognitoSession.endSession();
      return fail(ERROR_CODES.incognitoDenied);
    }
    if (!incognitoSession) return fail(ERROR_CODES.sessionEnded);
    const info = await incognitoSession.getInfo();
    if (!info.active) return fail(ERROR_CODES.sessionEnded);

    let windows = await queryWindows(chromeApi);
    if (!windows) return fail(ERROR_CODES.windowUnavailable);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const target = chooseSessionIncognitoWindow(windows, preferredWindowId, info.windows);
      if (!target) {
        await incognitoSession.endSession();
        return fail(ERROR_CODES.sessionEnded);
      }
      const result = await createTabInWindow(chromeApi, url, target, MODES.incognito);
      if (result.ok) return result;
      if (result.code !== ERROR_CODES.windowUnavailable) return result;

      windows = await queryWindows(chromeApi);
      if (!windows) return fail(ERROR_CODES.windowUnavailable);
      windows = windows.filter((win) => win.incognito === true && win.id !== target.id);
      if (windows.length === 0) {
        await incognitoSession.endSession();
        return fail(ERROR_CODES.sessionEnded);
      }
    }
    return fail(ERROR_CODES.windowUnavailable);
  }

  let windows = await queryWindows(chromeApi);
  if (!windows) return fail(ERROR_CODES.windowUnavailable);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const target = chooseNormalWindow(windows, preferredWindowId);
    if (!target) return createNormalWindow(chromeApi, url);
    const result = await createTabInWindow(chromeApi, url, target, MODES.normal);
    if (result.ok) return result;
    if (result.code !== ERROR_CODES.windowUnavailable) return result;

    windows = await queryWindows(chromeApi);
    if (!windows) return fail(ERROR_CODES.windowUnavailable);
    windows = windows.filter((win) => win.incognito !== true && win.id !== target.id);
    if (windows.length === 0) return createNormalWindow(chromeApi, url);
  }
  return createNormalWindow(chromeApi, url);
}
