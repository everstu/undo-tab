import { ERROR_CODES, MAX_QUERY_LENGTH, MESSAGES, MODES, VIEWS } from '../shared/constants.js';
import {
  describeFieldError,
  mergeSettings,
  modeMaxRecords,
  validateMaxRecords,
  validatePopupWidth,
} from '../shared/settings.js';
import { isRestorableUrl } from '../shared/urls.js';
import { RPC_ERROR_MESSAGES, isAllowedIncognitoAccess, openUrl } from './restore-service.js';

const ENTRY_ID_PATTERN = /^[A-Za-z0-9_:.-]{1,256}$/;

function fail(code, message) {
  return {
    ok: false,
    error: { code, message: message || RPC_ERROR_MESSAGES[code] || '操作失败，请重试' },
  };
}

/**
 * 只接受扩展自身界面页面的消息：校验 sender.id 与 sender.url。
 * 不配置 externally_connectable；网页内容脚本的 sender.url 是网页地址，
 * 不会是 chrome-extension://<本扩展>/popup/。
 */
export function isTrustedSender(sender, chromeApi) {
  try {
    if (!sender || sender.id !== chromeApi.runtime.id) return false;
    const popupBase = chromeApi.runtime.getURL('popup/');
    return typeof sender.url === 'string' && sender.url.startsWith(popupBase);
  } catch (error) {
    return false;
  }
}

function sanitizeId(value) {
  return typeof value === 'string' && ENTRY_ID_PATTERN.test(value) ? value : null;
}

function sanitizeQuery(value) {
  return typeof value === 'string' ? value.trim().slice(0, MAX_QUERY_LENGTH) : '';
}

function validateView(value) {
  return value === VIEWS.recent || value === VIEWS.history ? value : null;
}

function matchesQuery(entry, needle) {
  if (!needle) return true;
  return (
    String(entry.title || '').toLowerCase().includes(needle) ||
    String(entry.url || '').toLowerCase().includes(needle)
  );
}

function topSignature(entry) {
  if (!entry) return '';
  return `${entry.lastEventId || entry.id}:${entry.lastVisitedAt || entry.closedAt || ''}:${entry.title || ''}`;
}

/**
 * 后台消息路由。所有查询都从请求中的 windowId 重新确认窗口模式，
 * 只返回该模式的数据，绝不返回另一模式的内容。
 */
export function createMessageHandler({
  settingsStore,
  normalStore,
  incognitoSession,
  historyService,
  chromeApi,
  logger = console,
}) {
  async function resolveContext(windowId) {
    if (!Number.isInteger(windowId)) return null;
    try {
      const win = await chromeApi.windows.get(windowId);
      if (!win || !Number.isInteger(win.id)) return null;
      return {
        windowId: win.id,
        mode: win.incognito === true ? MODES.incognito : MODES.normal,
      };
    } catch (error) {
      return null;
    }
  }

  async function pendingCount(mode) {
    try {
      return mode === MODES.incognito
        ? await incognitoSession.getPendingCount()
        : await normalStore.getPendingCount();
    } catch (error) {
      return 0;
    }
  }

  async function getContext(message) {
    const context = await resolveContext(message.windowId);
    if (!context) return fail(ERROR_CODES.contextLost);
    const settings = await settingsStore.get();
    const incognitoAllowed = await isAllowedIncognitoAccess(chromeApi);
    const info = context.mode === MODES.incognito
      ? await incognitoSession.getInfo()
      : { active: false, sessionId: null, windows: [] };
    return {
      ok: true,
      data: {
        mode: context.mode,
        windowId: context.windowId,
        settings,
        incognitoAllowed,
        session: { active: info.active, sessionId: info.sessionId, windows: info.windows },
        pendingCloseCount: await pendingCount(context.mode),
      },
    };
  }

  async function queryView(message) {
    const context = await resolveContext(message.windowId);
    if (!context) return fail(ERROR_CODES.contextLost);
    const view = validateView(message.view);
    if (!view) return fail(ERROR_CODES.invalidRequest);
    const query = sanitizeQuery(message.query);
    const needle = query.toLowerCase();
    const settings = await settingsStore.get();

    if (context.mode === MODES.normal) {
      if (view === VIEWS.recent) {
        const all = await normalStore.getEntries();
        const entries = needle ? all.filter((entry) => matchesQuery(entry, needle)) : all;
        return {
          ok: true,
          data: {
            mode: MODES.normal,
            view,
            entries,
            total: all.length,
            matchCount: entries.length,
            loaded: null,
            limit: settings.normal.maxRecords,
            limitReached: false,
            sessionId: null,
            sessionActive: false,
            topSignature: topSignature(all[0]),
            pendingCloseCount: await pendingCount(MODES.normal),
          },
        };
      }
      let result;
      try {
        result = await historyService.searchNormal(query, settings.normal.maxRecords);
      } catch (error) {
        return fail(ERROR_CODES.unknown, '无法读取 Chrome 历史，请检查扩展权限');
      }
      return {
        ok: true,
        data: {
          mode: MODES.normal,
          view,
          entries: result.entries,
          total: result.loaded,
          matchCount: result.loaded,
          loaded: result.loaded,
          limit: result.limit,
          limitReached: result.loaded >= result.limit,
          sessionId: null,
          sessionActive: false,
          topSignature: '',
          pendingCloseCount: await pendingCount(MODES.normal),
        },
      };
    }

    const result = await incognitoSession.query(view, query);
    return {
      ok: true,
      data: {
        mode: MODES.incognito,
        view,
        entries: result.entries,
        total: result.total,
        matchCount: result.matchCount,
        loaded: result.total,
        limit: modeMaxRecords(settings, MODES.incognito, view),
        limitReached: false,
        sessionId: result.sessionId || null,
        sessionActive: result.active === true,
        topSignature: result.topSignature || '',
        pendingCloseCount: await pendingCount(MODES.incognito),
      },
    };
  }

  async function openEntry(message) {
    const context = await resolveContext(message.windowId);
    if (!context) return fail(ERROR_CODES.contextLost);
    const view = validateView(message.view);
    if (!view) return fail(ERROR_CODES.invalidRequest);

    let url = null;
    if (context.mode === MODES.normal) {
      if (view === VIEWS.recent) {
        const id = sanitizeId(message.id);
        if (!id) return fail(ERROR_CODES.invalidRequest);
        const entries = await normalStore.getEntries();
        const entry = entries.find((item) => item.id === id);
        if (!entry) return fail(ERROR_CODES.entryNotFound);
        url = entry.url;
      } else {
        url = typeof message.url === 'string' ? message.url : null;
      }
    } else {
      const id = sanitizeId(message.id);
      if (!id) return fail(ERROR_CODES.invalidRequest);
      const info = await incognitoSession.getInfo();
      if (!info.active) return fail(ERROR_CODES.sessionEnded);
      const entry = await incognitoSession.getEntry(view, id);
      if (!entry) return fail(ERROR_CODES.entryNotFound);
      url = entry.url;
    }

    if (!isRestorableUrl(url)) return fail(ERROR_CODES.invalidUrl);
    const result = await openUrl({
      url,
      mode: context.mode,
      preferredWindowId: context.windowId,
      chromeApi,
      incognitoSession,
    });
    if (!result.ok) return fail(result.code, result.message);
    return { ok: true, data: { tabId: result.tabId, windowId: result.windowId, mode: result.mode } };
  }

  async function deleteEntry(message) {
    const context = await resolveContext(message.windowId);
    if (!context) return fail(ERROR_CODES.contextLost);
    const view = validateView(message.view);
    if (!view) return fail(ERROR_CODES.invalidRequest);
    if (context.mode === MODES.normal && view === VIEWS.history) {
      return fail(ERROR_CODES.forbidden, '普通历史由 Chrome 管理，不能在此删除');
    }
    const id = sanitizeId(message.id);
    if (!id) return fail(ERROR_CODES.invalidRequest);

    if (context.mode === MODES.normal) {
      const result = await normalStore.deleteEntry(id);
      return { ok: true, data: result };
    }
    const info = await incognitoSession.getInfo();
    if (!info.active) return fail(ERROR_CODES.sessionEnded);
    const result = await incognitoSession.deleteEntry(view, id);
    return { ok: true, data: result };
  }

  async function clearView(message) {
    if (message.confirm !== true) return fail(ERROR_CODES.invalidRequest, '清空需要确认');
    const context = await resolveContext(message.windowId);
    if (!context) return fail(ERROR_CODES.contextLost);
    const view = validateView(message.view);
    if (!view) return fail(ERROR_CODES.invalidRequest);

    if (context.mode === MODES.normal) {
      if (view !== VIEWS.recent) return fail(ERROR_CODES.forbidden, '普通历史由 Chrome 管理，不能在此清空');
      const result = await normalStore.clear();
      return { ok: true, data: result };
    }
    const info = await incognitoSession.getInfo();
    if (!info.active) return fail(ERROR_CODES.sessionEnded);
    const result = await incognitoSession.clearView(view);
    return { ok: true, data: result };
  }

  async function clearIncognitoData(message) {
    if (message.confirm !== true) return fail(ERROR_CODES.invalidRequest, '清空需要确认');
    const context = await resolveContext(message.windowId);
    if (!context) return fail(ERROR_CODES.contextLost);
    if (context.mode !== MODES.incognito) return fail(ERROR_CODES.forbidden, '只有无痕窗口可以清空本次记录');
    const info = await incognitoSession.getInfo();
    if (!info.active) return fail(ERROR_CODES.sessionEnded);
    const result = await incognitoSession.clearData();
    return { ok: true, data: result };
  }

  async function updateSettings(message) {
    const context = await resolveContext(message.windowId);
    if (!context) return fail(ERROR_CODES.contextLost);
    const patch = message.patch;
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      return fail(ERROR_CODES.invalidRequest);
    }
    const current = await settingsStore.get();
    const settingsPatch = {};
    if (Object.prototype.hasOwnProperty.call(patch, 'popupWidth')) {
      const validation = validatePopupWidth(patch.popupWidth);
      if (!validation.ok) {
        return fail('invalid-settings', describeFieldError('popupWidth', validation.reason));
      }
      settingsPatch.popupWidth = validation.value;
    }
    let maxRecords = null;
    let limitView = null;
    if (Object.prototype.hasOwnProperty.call(patch, 'maxRecords')) {
      limitView = context.mode === MODES.incognito ? validateView(message.view) : VIEWS.recent;
      if (!limitView) return fail(ERROR_CODES.invalidRequest, '请选择要修改的记录上限');
      const validation = validateMaxRecords(patch.maxRecords);
      if (!validation.ok) {
        return fail('invalid-settings', describeFieldError(`${context.mode}.maxRecords`, validation.reason));
      }
      maxRecords = validation.value;
      const field = context.mode === MODES.normal
        ? 'maxRecords'
        : limitView === VIEWS.history ? 'historyMaxRecords' : 'recentMaxRecords';
      settingsPatch[context.mode] = { [field]: maxRecords };
    }
    if (!Object.prototype.hasOwnProperty.call(settingsPatch, 'popupWidth') && maxRecords === null) {
      return fail(ERROR_CODES.invalidRequest);
    }

    const merged = mergeSettings(current, settingsPatch);
    if (merged.errors.length > 0) {
      const first = merged.errors[0];
      return fail('invalid-settings', describeFieldError(first.field, first.reason));
    }

    let trimmed = { recent: 0, history: 0, total: 0 };
    if (context.mode === MODES.normal && maxRecords !== null) {
      const result = await normalStore.updateLimitAndSettings(merged.settings, maxRecords);
      trimmed = { recent: result.trimmed, history: 0, total: result.total };
      return {
        ok: true,
        data: { settings: result.settings, trimmed, total: result.total },
      };
    }

    const settings = await settingsStore.write(merged.settings);
    if (context.mode === MODES.incognito && maxRecords !== null) {
      const removed = await incognitoSession.trimView(limitView, maxRecords);
      trimmed = { recent: removed.recent, history: removed.history, total: 0 };
    }
    return { ok: true, data: { settings, trimmed } };
  }

  async function getTrimPreview(message) {
    const context = await resolveContext(message.windowId);
    if (!context) return fail(ERROR_CODES.contextLost);
    const limitView = context.mode === MODES.incognito ? validateView(message.view) : VIEWS.recent;
    if (!limitView) return fail(ERROR_CODES.invalidRequest, '请选择要修改的记录上限');
    const validation = validateMaxRecords(message.maxRecords);
    if (!validation.ok) {
      return fail('invalid-settings', describeFieldError(`${context.mode}.maxRecords`, validation.reason));
    }
    if (context.mode === MODES.normal) {
      const preview = await normalStore.previewTrim(validation.value);
      return {
        ok: true,
        data: { recent: preview.trimmed, history: 0, recentTotal: preview.total, historyTotal: 0, limit: validation.value },
      };
    }
    const preview = await incognitoSession.previewTrim(limitView, validation.value);
    return { ok: true, data: { ...preview, limit: validation.value } };
  }

  async function dispatch(message) {
    switch (message.type) {
      case MESSAGES.getContext:
        return getContext(message);
      case MESSAGES.queryView:
        return queryView(message);
      case MESSAGES.openEntry:
        return openEntry(message);
      case MESSAGES.deleteEntry:
        return deleteEntry(message);
      case MESSAGES.clearView:
        return clearView(message);
      case MESSAGES.clearIncognitoData:
        return clearIncognitoData(message);
      case MESSAGES.updateSettings:
        return updateSettings(message);
      case MESSAGES.getTrimPreview:
        return getTrimPreview(message);
      default:
        return fail(ERROR_CODES.invalidRequest, '未知操作');
    }
  }

  return async function handleMessage(message, sender) {
    if (!message || typeof message !== 'object' || typeof message.type !== 'string') {
      return fail(ERROR_CODES.invalidRequest);
    }
    if (!isTrustedSender(sender, chromeApi)) {
      return fail(ERROR_CODES.invalidRequest, '请求来源不受信任');
    }
    try {
      return await dispatch(message);
    } catch (error) {
      logger.warn('undo-tab: 后台操作失败', error && error.name ? error.name : 'error');
      return fail(ERROR_CODES.storageFailure);
    }
  };
}
