import { MODES, STORAGE_KEYS } from '../shared/constants.js';
import { fallbackTitle, isRestorableUrl } from '../shared/urls.js';

const SESSION_STALE_MS = 24 * 60 * 60 * 1000;

/**
 * 标签跟踪。普通与无痕快照分域保存；关闭事件按模式交给对应数据域。
 * 所有 Chrome 事件由 service-worker 串行调度。
 */
export function createTabTracker({
  chromeApi,
  sessionArea,
  normalStore,
  incognitoSession,
  getSettings,
  now = () => Date.now(),
  uuid = () => crypto.randomUUID(),
  logger = console,
}) {
  if (!chromeApi || !sessionArea || !normalStore || !incognitoSession || !getSettings) {
    throw new Error('createTabTracker 缺少依赖');
  }

  const normalSnapshots = new Map();
  const incognitoSnapshots = new Map();
  const pendingRemovals = new Set();
  let initialized = false;
  let initPromise = null;
  let lastOrder = 0;

  function nextOrder(timestamp) {
    const base = Math.floor(timestamp * 1000);
    lastOrder = base > lastOrder ? base : lastOrder + 1;
    return lastOrder;
  }

  function hasTabFavicon(tab) {
    return Boolean(tab && typeof tab.favIconUrl === 'string' && tab.favIconUrl !== '');
  }

  function snapshotFromTab(tab, prev, sessionId) {
    const base = prev
      ? { ...prev }
      : {
          captureId: uuid(),
          tabId: tab.id,
          windowId: Number.isInteger(tab.windowId) ? tab.windowId : -1,
          mode: tab.incognito === true ? MODES.incognito : MODES.normal,
          sessionId: tab.incognito === true ? sessionId || '' : '',
          url: '',
          title: '',
          index: Number.isInteger(tab.index) ? tab.index : 0,
          pinned: tab.pinned === true,
          hasFavicon: false,
          updatedAt: now(),
        };

    base.tabId = tab.id;
    if (Number.isInteger(tab.windowId)) base.windowId = tab.windowId;
    if (typeof tab.incognito === 'boolean') {
      base.mode = tab.incognito ? MODES.incognito : MODES.normal;
    }
    if (base.mode === MODES.incognito) base.sessionId = sessionId || prev?.sessionId || '';

    if (typeof tab.url === 'string' && tab.url !== '') {
      if (isRestorableUrl(tab.url)) {
        if (base.url !== tab.url) {
          base.url = tab.url;
          base.title = typeof tab.title === 'string' ? tab.title : '';
          base.hasFavicon = hasTabFavicon(tab);
        } else {
          if (typeof tab.title === 'string' && tab.title.trim() !== '') base.title = tab.title;
          if (hasTabFavicon(tab)) base.hasFavicon = true;
        }
      } else {
        base.url = '';
        base.title = '';
        base.hasFavicon = false;
      }
    }
    if (Number.isInteger(tab.index)) base.index = tab.index;
    if (typeof tab.pinned === 'boolean') base.pinned = tab.pinned;
    base.updatedAt = now();
    return base;
  }

  function normalizeStoredSnapshot(raw, mode, sessionId) {
    if (!raw || typeof raw !== 'object') return null;
    if (!Number.isInteger(raw.tabId) || typeof raw.captureId !== 'string' || raw.captureId === '') return null;
    if (!isRestorableUrl(raw.url)) return null;
    return {
      captureId: raw.captureId,
      tabId: raw.tabId,
      windowId: Number.isInteger(raw.windowId) ? raw.windowId : -1,
      mode,
      sessionId: mode === MODES.incognito ? sessionId || '' : '',
      url: raw.url,
      title: typeof raw.title === 'string' ? raw.title : '',
      index: Number.isInteger(raw.index) ? raw.index : 0,
      pinned: raw.pinned === true,
      hasFavicon: raw.hasFavicon === true,
      updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : 0,
    };
  }

  async function readNormalStored() {
    try {
      const result = await sessionArea.get(STORAGE_KEYS.normalLiveTabs);
      const list = result ? result[STORAGE_KEYS.normalLiveTabs] : [];
      return Array.isArray(list) ? list : [];
    } catch (error) {
      logger.warn('undo-tab: 无法读取普通活动标签快照');
      return [];
    }
  }

  async function persistNormal() {
    try {
      await sessionArea.set({ [STORAGE_KEYS.normalLiveTabs]: [...normalSnapshots.values()] });
    } catch (error) {
      logger.warn('undo-tab: 无法保存普通活动标签快照');
    }
  }

  async function persistIncognito() {
    const context = incognitoSession.peekContext();
    const sessionId = context && context.active ? context.sessionId : null;
    const list = [];
    for (const [tabId, snapshot] of incognitoSnapshots) {
      if (!sessionId || snapshot.sessionId !== sessionId) {
        incognitoSnapshots.delete(tabId);
        continue;
      }
      list.push(snapshot);
    }
    try {
      await incognitoSession.setLiveTabs(list);
    } catch (error) {
      logger.warn('undo-tab: 无法保存无痕活动标签快照');
    }
  }

  async function persistAll() {
    await Promise.all([persistNormal(), persistIncognito()]);
  }

  async function init() {
    if (initPromise) return initPromise;
    initPromise = (async () => {
      const normalStored = new Map();
      for (const item of await readNormalStored()) {
        const snapshot = normalizeStoredSnapshot(item, MODES.normal, null);
        if (snapshot) normalStored.set(snapshot.tabId, snapshot);
      }

      const info = await incognitoSession.getInfo();
      const incognitoStored = new Map();
      if (info.active) {
        for (const item of await incognitoSession.getLiveTabs()) {
          const snapshot = normalizeStoredSnapshot(item, MODES.incognito, info.sessionId);
          if (snapshot) incognitoStored.set(snapshot.tabId, snapshot);
        }
      }

      let tabs = [];
      try {
        tabs = await chromeApi.tabs.query({});
      } catch (error) {
        tabs = [];
        logger.warn('undo-tab: 无法枚举当前标签');
      }

      const mergedNormal = new Map(normalStored);
      const mergedIncognito = new Map(incognitoStored);
      for (const tab of tabs) {
        if (!tab || !Number.isInteger(tab.id)) continue;
        if (pendingRemovals.has(tab.id)) {
          const prev = normalStored.get(tab.id) || incognitoStored.get(tab.id);
          if (prev) {
            if (prev.mode === MODES.incognito) mergedIncognito.set(tab.id, prev);
            else mergedNormal.set(tab.id, prev);
          }
          continue;
        }
        if (tab.incognito === true) {
          if (!info.active) continue;
          if (!Number.isInteger(tab.windowId) || !info.windows.includes(tab.windowId)) continue;
          mergedIncognito.set(tab.id, snapshotFromTab(tab, incognitoStored.get(tab.id), info.sessionId));
        } else {
          mergedNormal.set(tab.id, snapshotFromTab(tab, normalStored.get(tab.id), null));
        }
      }

      const cutoff = now() - SESSION_STALE_MS;
      for (const [tabId, snapshot] of [...mergedNormal]) {
        if (tabs.some((tab) => tab.id === tabId)) continue;
        if (!Number.isFinite(snapshot.updatedAt) || snapshot.updatedAt < cutoff) mergedNormal.delete(tabId);
      }
      for (const [tabId, snapshot] of [...mergedIncognito]) {
        if (!info.active || snapshot.sessionId !== info.sessionId) mergedIncognito.delete(tabId);
      }

      normalSnapshots.clear();
      for (const [tabId, snapshot] of mergedNormal) normalSnapshots.set(tabId, snapshot);
      incognitoSnapshots.clear();
      for (const [tabId, snapshot] of mergedIncognito) incognitoSnapshots.set(tabId, snapshot);

      initialized = true;
      await persistAll();
    })().catch((error) => {
      initPromise = null;
      throw error;
    });
    return initPromise;
  }

  async function ensureReady() {
    if (!initialized) await init();
  }

  function noteTabRemoved(tabId) {
    if (!Number.isInteger(tabId)) return;
    pendingRemovals.add(tabId);
    if (pendingRemovals.size > 512) {
      const first = pendingRemovals.values().next().value;
      pendingRemovals.delete(first);
    }
  }

  function findSnapshot(tabId) {
    if (normalSnapshots.has(tabId)) return { mode: MODES.normal, snapshot: normalSnapshots.get(tabId) };
    if (incognitoSnapshots.has(tabId)) return { mode: MODES.incognito, snapshot: incognitoSnapshots.get(tabId) };
    return null;
  }

  function resolveContext(capturedContext) {
    const current = incognitoSession.peekContext();
    if (!capturedContext || !capturedContext.active) return current;
    if (!current) return capturedContext;
    if (capturedContext.sessionId === current.sessionId) {
      if (!current.active) {
        return { ...capturedContext, active: false, windows: current.windows || [] };
      }
      // 同一会话内窗口集合可能在事件入队后才同步（例如新开无痕窗口）。
      // 使用处理时的最新窗口集合，但保留事件入口的 sessionId/代次。
      return { ...capturedContext, active: true, windows: current.windows };
    }
    // 已切换到新会话：旧事件必须失效，不能借用新会话。
    return { ...capturedContext, active: false };
  }

  function contextAllowsWindow(context, windowId) {
    return Boolean(
      context &&
        context.active &&
        context.sessionId &&
        Number.isInteger(windowId) &&
        Array.isArray(context.windows) &&
        context.windows.includes(windowId),
    );
  }

  async function handleTabCreated(tab, capturedContext = null) {
    await ensureReady();
    if (!tab || !Number.isInteger(tab.id)) return;
    const context = resolveContext(capturedContext);
    if (normalSnapshots.has(tab.id)) return;
    if (incognitoSnapshots.has(tab.id)) {
      const existing = incognitoSnapshots.get(tab.id);
      if (context && context.active && existing.sessionId === context.sessionId) return;
      incognitoSnapshots.delete(tab.id);
      await persistIncognito();
    }

    let resolved = tab;
    if (typeof resolved.incognito !== 'boolean' && typeof chromeApi.tabs.get === 'function') {
      try {
        resolved = { ...tab, ...(await chromeApi.tabs.get(tab.id)) };
      } catch (error) {
        // 标签可能在读取前关闭
      }
    }
    if (typeof resolved.incognito !== 'boolean') return;
    if (resolved.incognito) {
      // 旧窗口的迟到事件不能挂到当前会话；窗口必须仍属于本次会话集合。
      if (!contextAllowsWindow(context, resolved.windowId)) return;
      incognitoSnapshots.set(resolved.id, snapshotFromTab(resolved, null, context.sessionId));
      await persistIncognito();
    } else {
      normalSnapshots.set(resolved.id, snapshotFromTab(resolved, null, null));
      await persistNormal();
    }
  }

  async function handleTabUpdated(tabId, changeInfo = {}, tab = null, capturedContext = null) {
    await ensureReady();
    if (!Number.isInteger(tabId)) return;
    const context = resolveContext(capturedContext);
    const incomingIncognito = tab && typeof tab.incognito === 'boolean' ? tab.incognito : null;
    let found = findSnapshot(tabId);

    if (found) {
      if (found.mode === MODES.incognito) {
        const stillValid =
          context &&
          context.active &&
          found.snapshot.sessionId === context.sessionId &&
          contextAllowsWindow(context, found.snapshot.windowId) &&
          incomingIncognito !== false;
        if (!stillValid) {
          incognitoSnapshots.delete(tabId);
          found = null;
          await persistIncognito();
        }
      } else if (incomingIncognito === true) {
        // 普通快照绝不能升级为无痕快照并沿用普通元数据。
        normalSnapshots.delete(tabId);
        found = null;
        await persistNormal();
      }
    }

    if (!found) {
      if (!tab || !Number.isInteger(tab.id)) return;
      const url = typeof changeInfo.url === 'string' && changeInfo.url !== '' ? changeInfo.url : tab.url;
      if (tab.incognito === true) {
        if (!contextAllowsWindow(context, tab.windowId)) return;
        incognitoSnapshots.set(tabId, snapshotFromTab({ ...tab, url }, null, context.sessionId));
        await persistIncognito();
      } else if (tab.incognito === false) {
        normalSnapshots.set(tabId, snapshotFromTab({ ...tab, url }, null, null));
        await persistNormal();
      }
      return;
    }

    const map = found.mode === MODES.incognito ? incognitoSnapshots : normalSnapshots;
    const next = { ...found.snapshot, updatedAt: now() };
    if (typeof changeInfo.url === 'string' && changeInfo.url !== '') {
      if (isRestorableUrl(changeInfo.url)) {
        next.url = changeInfo.url;
        next.title = typeof changeInfo.title === 'string' ? changeInfo.title.trim() : '';
        next.hasFavicon = false;
      } else {
        next.url = '';
        next.title = '';
        next.hasFavicon = false;
      }
    } else if (typeof changeInfo.title === 'string') {
      next.title = changeInfo.title.trim();
    }
    if (typeof changeInfo.favIconUrl === 'string' && changeInfo.favIconUrl !== '') next.hasFavicon = true;
    if (tab) {
      if (Number.isInteger(tab.index)) next.index = tab.index;
      if (Number.isInteger(tab.windowId)) next.windowId = tab.windowId;
      if (typeof tab.pinned === 'boolean') next.pinned = tab.pinned;
    }

    if (found.mode === MODES.incognito) {
      if (!contextAllowsWindow(context, next.windowId)) {
        incognitoSnapshots.delete(tabId);
        await persistIncognito();
        return;
      }
      next.sessionId = context.sessionId;
      next.mode = MODES.incognito;
    } else {
      next.mode = MODES.normal;
      next.sessionId = '';
    }
    map.set(tabId, next);

    if (next.mode === MODES.incognito && next.url) {
      await incognitoSession.updateTitle({
        url: next.url,
        title: typeof changeInfo.title === 'string' ? changeInfo.title : next.title,
        favIconUrl: typeof changeInfo.favIconUrl === 'string' ? changeInfo.favIconUrl : '',
        sessionId: context.sessionId,
        tabId: next.tabId,
      });
    }

    if (next.mode === MODES.incognito) await persistIncognito();
    else await persistNormal();
  }

  async function handleTabMoved(tabId, moveInfo = {}, capturedContext = null) {
    await ensureReady();
    const found = findSnapshot(tabId);
    if (!found) return;
    if (found.mode === MODES.incognito) {
      const context = resolveContext(capturedContext);
      const windowId = Number.isInteger(moveInfo.windowId) ? moveInfo.windowId : found.snapshot.windowId;
      if (
        !context ||
        !context.active ||
        found.snapshot.sessionId !== context.sessionId ||
        !contextAllowsWindow(context, windowId)
      ) {
        incognitoSnapshots.delete(tabId);
        await persistIncognito();
        return;
      }
    }
    const map = found.mode === MODES.incognito ? incognitoSnapshots : normalSnapshots;
    const next = { ...found.snapshot, updatedAt: now() };
    if (Number.isInteger(moveInfo.toIndex)) next.index = moveInfo.toIndex;
    if (Number.isInteger(moveInfo.windowId)) next.windowId = moveInfo.windowId;
    map.set(tabId, next);
    if (found.mode === MODES.incognito) await persistIncognito();
    else await persistNormal();
  }

  async function handleTabAttached(tabId, attachInfo = {}, capturedContext = null) {
    await ensureReady();
    const found = findSnapshot(tabId);
    if (!found) return;
    if (found.mode === MODES.incognito) {
      const context = resolveContext(capturedContext);
      const windowId = Number.isInteger(attachInfo.newWindowId)
        ? attachInfo.newWindowId
        : found.snapshot.windowId;
      if (
        !context ||
        !context.active ||
        found.snapshot.sessionId !== context.sessionId ||
        !contextAllowsWindow(context, windowId)
      ) {
        incognitoSnapshots.delete(tabId);
        await persistIncognito();
        return;
      }
    }
    const map = found.mode === MODES.incognito ? incognitoSnapshots : normalSnapshots;
    const next = { ...found.snapshot, updatedAt: now() };
    if (Number.isInteger(attachInfo.newWindowId)) next.windowId = attachInfo.newWindowId;
    if (Number.isInteger(attachInfo.newPosition)) next.index = attachInfo.newPosition;
    map.set(tabId, next);
    if (found.mode === MODES.incognito) await persistIncognito();
    else await persistNormal();
  }

  async function handleTabDetached(tabId, detachInfo = {}, capturedContext = null) {
    await ensureReady();
    const found = findSnapshot(tabId);
    if (!found) return;
    if (found.mode === MODES.incognito) {
      const context = resolveContext(capturedContext);
      const windowId = Number.isInteger(detachInfo.oldWindowId)
        ? detachInfo.oldWindowId
        : found.snapshot.windowId;
      if (
        !context ||
        !context.active ||
        found.snapshot.sessionId !== context.sessionId ||
        !contextAllowsWindow(context, windowId)
      ) {
        incognitoSnapshots.delete(tabId);
        await persistIncognito();
        return;
      }
    }
    const map = found.mode === MODES.incognito ? incognitoSnapshots : normalSnapshots;
    const next = { ...found.snapshot, updatedAt: now() };
    if (Number.isInteger(detachInfo.oldWindowId)) next.windowId = detachInfo.oldWindowId;
    if (Number.isInteger(detachInfo.oldPosition)) next.index = detachInfo.oldPosition;
    map.set(tabId, next);
    if (found.mode === MODES.incognito) await persistIncognito();
    else await persistNormal();
  }

  async function handleTabReplaced(addedTabId, removedTabId, capturedContext = null) {
    await ensureReady();
    normalSnapshots.delete(removedTabId);
    incognitoSnapshots.delete(removedTabId);
    let tab = null;
    if (Number.isInteger(addedTabId)) {
      try {
        tab = await chromeApi.tabs.get(addedTabId);
      } catch (error) {
        tab = null;
      }
    }
    if (tab) {
      if (tab.incognito === true) {
        const context = resolveContext(capturedContext);
        if (contextAllowsWindow(context, tab.windowId)) {
          incognitoSnapshots.set(addedTabId, snapshotFromTab(tab, null, context.sessionId));
        }
      } else {
        normalSnapshots.set(addedTabId, snapshotFromTab(tab, null, null));
      }
    }
    await persistAll();
  }

  async function handleTabRemoved(tabId, removeInfo = {}, capturedContext = null) {
    await ensureReady();
    if (!Number.isInteger(tabId)) return { recorded: false, reason: 'invalid-tab' };
    const found = findSnapshot(tabId);
    normalSnapshots.delete(tabId);
    incognitoSnapshots.delete(tabId);
    pendingRemovals.delete(tabId);
    await persistAll();

    if (!found) return { recorded: false, reason: 'no-snapshot' };
    const snapshot = found.snapshot;
    if (!isRestorableUrl(snapshot.url)) return { recorded: false, reason: 'unsupported-url' };

    const closedAt = now();
    const event = {
      eventId: snapshot.captureId,
      url: snapshot.url,
      title: (typeof snapshot.title === 'string' ? snapshot.title.trim() : '') || fallbackTitle(snapshot.url),
      closedAt,
      order: nextOrder(closedAt),
      originalWindowId: Number.isInteger(removeInfo.windowId) ? removeInfo.windowId : snapshot.windowId,
      originalIndex: Number.isInteger(snapshot.index) ? snapshot.index : 0,
      wasPinned: snapshot.pinned === true,
      hasFavicon: snapshot.hasFavicon === true,
      windowClosing: removeInfo.isWindowClosing === true,
    };

    let settings;
    try {
      settings = await getSettings();
    } catch (error) {
      return { recorded: false, reason: 'storage-error' };
    }

    if (found.mode === MODES.normal) {
      try {
        const result = await normalStore.recordClose(event, settings.normal.maxRecords);
        return { recorded: result.applied === true, reason: result.reason || null };
      } catch (error) {
        logger.warn('undo-tab: 普通关闭记录写入失败', error && error.name ? error.name : 'error');
        return { recorded: false, reason: 'storage-error' };
      }
    }

    const context = resolveContext(capturedContext);
    if (!context || !context.active || context.sessionId !== snapshot.sessionId) {
      return { recorded: false, reason: 'session-ended' };
    }
    event.sessionId = context.sessionId;
    event.generation = context.recentGeneration;
    try {
      const result = await incognitoSession.recordClose(event, settings.incognito.recentMaxRecords);
      return { recorded: result.applied === true, reason: result.reason || null };
    } catch (error) {
      logger.warn('undo-tab: 无痕关闭记录写入失败', error && error.name ? error.name : 'error');
      return { recorded: false, reason: 'storage-error' };
    }
  }

  async function flushPendingCloses() {
    const settings = await getSettings();
    const normal = await normalStore.retryPending(settings.normal.maxRecords);
    const incognito = await incognitoSession.retryPending(settings.incognito);
    return { normal, incognito };
  }

  function resetIncognito() {
    incognitoSnapshots.clear();
  }

  return {
    init,
    noteTabRemoved,
    handleTabCreated,
    handleTabUpdated,
    handleTabMoved,
    handleTabAttached,
    handleTabDetached,
    handleTabReplaced,
    handleTabRemoved,
    flushPendingCloses,
    resetIncognito,
  };
}
