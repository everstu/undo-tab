import { STORAGE_KEYS } from '../shared/constants.js';
import { createQueue } from '../shared/queue.js';
import { fallbackTitle, urlKey } from '../shared/urls.js';
import { StorageFailureError } from './normal-store.js';

const ACTIVE = 'active';
const ENDED = 'ended';
const APPLIED_LIMIT = 200;

function emptyState() {
  return {
    sessionId: null,
    status: ENDED,
    needsClear: false,
    windows: [],
    clearGeneration: { recent: 0, history: 0 },
    recent: [],
    history: [],
    deletedRecent: {},
    deletedHistory: {},
    liveTabs: [],
    pending: [],
    appliedVisitEvents: [],
    lastOrder: 0,
    updatedAt: 0,
  };
}

function normalizeDeleted(raw) {
  const result = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return result;
  for (const [key, value] of Object.entries(raw)) {
    if (urlKey(key) === key && Number.isFinite(value) && value >= 0) result[key] = value;
  }
  return result;
}

function normalizeRecentEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const key = urlKey(raw.url);
  if (!key || typeof raw.id !== 'string' || raw.id === '') return null;
  if (!Number.isFinite(raw.closedAt)) return null;
  return {
    id: raw.id,
    url: raw.url,
    urlKey: key,
    title: typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : fallbackTitle(raw.url),
    closedAt: raw.closedAt,
    order: Number.isFinite(raw.order) ? raw.order : raw.closedAt,
    originalWindowId: Number.isInteger(raw.originalWindowId) ? raw.originalWindowId : -1,
    originalIndex: Number.isInteger(raw.originalIndex) ? raw.originalIndex : 0,
    wasPinned: raw.wasPinned === true,
    hasFavicon: raw.hasFavicon === true,
    windowClosing: raw.windowClosing === true,
    lastEventId: typeof raw.lastEventId === 'string' ? raw.lastEventId : '',
  };
}

function normalizeHistoryEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const key = urlKey(raw.url);
  if (!key || typeof raw.id !== 'string' || raw.id === '') return null;
  if (!Number.isFinite(raw.lastVisitedAt)) return null;
  return {
    id: raw.id,
    url: raw.url,
    urlKey: key,
    title: typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : fallbackTitle(raw.url),
    lastVisitedAt: raw.lastVisitedAt,
    order: Number.isFinite(raw.order) ? raw.order : raw.lastVisitedAt,
    visitCount: Number.isInteger(raw.visitCount) && raw.visitCount > 0 ? raw.visitCount : 1,
    hasFavicon: raw.hasFavicon !== false,
    lastTabId: Number.isInteger(raw.lastTabId) ? raw.lastTabId : null,
    lastEventId: typeof raw.lastEventId === 'string' ? raw.lastEventId : '',
  };
}

function normalizeSnapshot(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (!Number.isInteger(raw.tabId) || typeof raw.captureId !== 'string' || raw.captureId === '') return null;
  if (!urlKey(raw.url)) return null;
  return {
    captureId: raw.captureId,
    tabId: raw.tabId,
    windowId: Number.isInteger(raw.windowId) ? raw.windowId : -1,
    mode: 'incognito',
    sessionId: typeof raw.sessionId === 'string' ? raw.sessionId : '',
    url: raw.url,
    title: typeof raw.title === 'string' ? raw.title : '',
    index: Number.isInteger(raw.index) ? raw.index : 0,
    pinned: raw.pinned === true,
    hasFavicon: raw.hasFavicon === true,
    updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : 0,
  };
}

function normalizePending(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.filter((item) => {
    if (!item || typeof item !== 'object') return false;
    if (typeof item.eventId !== 'string' || item.eventId === '') return false;
    if (!urlKey(item.url)) return false;
    if (typeof item.sessionId !== 'string' || item.sessionId === '') return false;
    if (!Number.isInteger(item.generation) || item.generation < 0) return false;
    if (!Number.isFinite(item.order)) return false;
    return item.kind === 'close' || item.kind === 'visit';
  });
}

export function normalizeIncognitoState(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const recent = (Array.isArray(source.recent) ? source.recent : []).map(normalizeRecentEntry).filter(Boolean);
  recent.sort((a, b) => (b.closedAt - a.closedAt) || ((b.order || 0) - (a.order || 0)));
  const history = (Array.isArray(source.history) ? source.history : []).map(normalizeHistoryEntry).filter(Boolean);
  history.sort((a, b) => (b.lastVisitedAt - a.lastVisitedAt) || ((b.order || 0) - (a.order || 0)));
  const sessionId = typeof source.sessionId === 'string' && source.sessionId ? source.sessionId : null;
  const status = source.status === ACTIVE && sessionId ? ACTIVE : ENDED;
  const generation = source.clearGeneration && typeof source.clearGeneration === 'object' ? source.clearGeneration : {};
  return {
    sessionId,
    status,
    needsClear: source.needsClear === true,
    windows: Array.isArray(source.windows) ? [...new Set(source.windows.filter(Number.isInteger))] : [],
    clearGeneration: {
      recent: Number.isInteger(generation.recent) && generation.recent >= 0 ? generation.recent : 0,
      history: Number.isInteger(generation.history) && generation.history >= 0 ? generation.history : 0,
    },
    recent,
    history,
    deletedRecent: normalizeDeleted(source.deletedRecent),
    deletedHistory: normalizeDeleted(source.deletedHistory),
    liveTabs: (Array.isArray(source.liveTabs) ? source.liveTabs : []).map(normalizeSnapshot).filter(Boolean),
    pending: normalizePending(source.pending),
    appliedVisitEvents: Array.isArray(source.appliedVisitEvents)
      ? source.appliedVisitEvents.filter((id) => typeof id === 'string').slice(-APPLIED_LIMIT)
      : [],
    lastOrder: Number.isFinite(source.lastOrder) ? source.lastOrder : 0,
    updatedAt: Number.isFinite(source.updatedAt) ? source.updatedAt : 0,
  };
}

function trimList(list, maxRecords) {
  const limit = Number.isInteger(maxRecords) && maxRecords > 0 ? maxRecords : 0;
  const removed = Math.max(0, list.length - limit);
  if (removed > 0) list.length = limit;
  return removed;
}

function applyCloseEntry(state, event, uuid) {
  if (state.status !== ACTIVE || !state.sessionId) return { applied: false, reason: 'session-ended' };
  if (event.sessionId !== state.sessionId) return { applied: false, reason: 'stale-session' };
  if (event.generation !== state.clearGeneration.recent) return { applied: false, reason: 'stale-generation' };
  const deletedAt = state.deletedRecent[event.urlKey];
  if (Number.isFinite(deletedAt)) {
    if (event.closedAt <= deletedAt) return { applied: false, reason: 'deleted' };
    delete state.deletedRecent[event.urlKey];
  }
  const index = state.recent.findIndex((entry) => entry.urlKey === event.urlKey);
  if (index >= 0) {
    const existing = state.recent[index];
    if (existing.lastEventId && existing.lastEventId === event.eventId) {
      return { applied: false, reason: 'duplicate', entryId: existing.id };
    }
    if (
      event.closedAt < existing.closedAt ||
      (event.closedAt === existing.closedAt && event.order <= existing.order)
    ) {
      return { applied: false, reason: 'older', entryId: existing.id };
    }
    const updated = {
      ...existing,
      title: event.title || existing.title || fallbackTitle(event.url),
      closedAt: event.closedAt,
      order: event.order,
      originalWindowId: event.originalWindowId,
      originalIndex: event.originalIndex,
      wasPinned: event.wasPinned,
      hasFavicon: event.hasFavicon,
      windowClosing: event.windowClosing,
      lastEventId: event.eventId,
    };
    state.recent.splice(index, 1);
    state.recent.unshift(updated);
    state.lastOrder = Math.max(state.lastOrder || 0, event.order);
    return { applied: true, entryId: updated.id };
  }
  const entry = {
    id: uuid(),
    url: event.url,
    urlKey: event.urlKey,
    title: event.title || fallbackTitle(event.url),
    closedAt: event.closedAt,
    order: event.order,
    originalWindowId: event.originalWindowId,
    originalIndex: event.originalIndex,
    wasPinned: event.wasPinned,
    hasFavicon: event.hasFavicon,
    windowClosing: event.windowClosing,
    lastEventId: event.eventId,
  };
  state.recent.unshift(entry);
  state.lastOrder = Math.max(state.lastOrder || 0, event.order);
  return { applied: true, entryId: entry.id };
}

function applyVisitEntry(state, event, uuid) {
  if (state.status !== ACTIVE || !state.sessionId) return { applied: false, reason: 'session-ended' };
  if (event.sessionId !== state.sessionId) return { applied: false, reason: 'stale-session' };
  if (event.generation !== state.clearGeneration.history) return { applied: false, reason: 'stale-generation' };
  if (state.appliedVisitEvents.includes(event.eventId)) return { applied: false, reason: 'duplicate' };

  const deletedAt = state.deletedHistory[event.urlKey];
  if (Number.isFinite(deletedAt)) {
    if (event.visitedAt <= deletedAt) return { applied: false, reason: 'deleted' };
    delete state.deletedHistory[event.urlKey];
  }

  const index = state.history.findIndex((entry) => entry.urlKey === event.urlKey);
  if (index >= 0) {
    const existing = state.history[index];
    const isNewer =
      event.visitedAt > existing.lastVisitedAt ||
      (event.visitedAt === existing.lastVisitedAt && event.order > existing.order);
    const updated = {
      ...existing,
      title: isNewer
        ? event.title || existing.title || fallbackTitle(event.url)
        : existing.title || event.title || fallbackTitle(event.url),
      lastVisitedAt: Math.max(existing.lastVisitedAt, event.visitedAt),
      order: Math.max(existing.order || 0, event.order),
      visitCount: existing.visitCount + 1,
      hasFavicon: existing.hasFavicon || event.hasFavicon === true,
      lastTabId: isNewer && Number.isInteger(event.tabId) ? event.tabId : existing.lastTabId,
      lastEventId: event.eventId,
    };
    state.history.splice(index, 1);
    state.history.push(updated);
  } else {
    state.history.push({
      id: uuid(),
      url: event.url,
      urlKey: event.urlKey,
      title: event.title || fallbackTitle(event.url),
      lastVisitedAt: event.visitedAt,
      order: event.order,
      visitCount: 1,
      hasFavicon: true,
      lastTabId: Number.isInteger(event.tabId) ? event.tabId : null,
      lastEventId: event.eventId,
    });
  }
  state.history.sort((a, b) => (b.lastVisitedAt - a.lastVisitedAt) || ((b.order || 0) - (a.order || 0)));
  state.lastOrder = Math.max(state.lastOrder || 0, event.order);
  state.appliedVisitEvents.push(event.eventId);
  if (state.appliedVisitEvents.length > APPLIED_LIMIT) {
    state.appliedVisitEvents.splice(0, state.appliedVisitEvents.length - APPLIED_LIMIT);
  }
  return { applied: true };
}

export function createIncognitoSession({
  sessionArea,
  uuid = () => crypto.randomUUID(),
  now = () => Date.now(),
  logger = console,
}) {
  if (!sessionArea) throw new Error('createIncognitoSession 缺少 session 存储');
  const enqueue = createQueue();
  let state = null;
  let loadPromise = null;
  let needsSave = false;

  async function readRaw() {
    try {
      const result = await sessionArea.get(STORAGE_KEYS.incognitoState);
      return result ? result[STORAGE_KEYS.incognitoState] : null;
    } catch (error) {
      throw new StorageFailureError(error);
    }
  }

  async function persist() {
    try {
      await sessionArea.set({ [STORAGE_KEYS.incognitoState]: state });
      needsSave = false;
    } catch (error) {
      needsSave = true;
      throw new StorageFailureError(error);
    }
  }

  async function persistIfNeeded() {
    if (needsSave) await persist();
  }

  async function load() {
    if (state) return state;
    if (!loadPromise) {
      loadPromise = (async () => {
        state = normalizeIncognitoState(await readRaw());
        needsSave = false;
        if (state.needsClear) await finalizeClear();
        return state;
      })().catch((error) => {
        loadPromise = null;
        throw error;
      });
    }
    return loadPromise;
  }

  async function finalizeClear() {
    state = { ...emptyState(), updatedAt: now() };
    try {
      await persist();
    } catch (error) {
      state.needsClear = true;
      needsSave = true;
      logger.warn('undo-tab: 无痕会话清理写入失败，稍后重试');
    }
  }

  async function startSessionInternal(windowIds) {
    state = {
      ...emptyState(),
      sessionId: uuid(),
      status: ACTIVE,
      windows: [...new Set(windowIds.filter(Number.isInteger))],
      updatedAt: now(),
    };
    await persist();
    return state.sessionId;
  }

  async function endSessionInternal() {
    const previousSessionId = state.sessionId;
    state = { ...emptyState(), needsClear: true, updatedAt: now() };
    try {
      await persist();
      state = { ...emptyState(), updatedAt: now() };
      await persist();
    } catch (error) {
      state = { ...emptyState(), needsClear: true, updatedAt: now() };
      needsSave = true;
      logger.warn('undo-tab: 无痕会话清理写入失败，稍后重试');
    }
    return { previousSessionId, active: false };
  }

  async function syncWindowsInternal(windowIds, accessAllowed) {
    await load();
    if (!accessAllowed) {
      if (state.status === ACTIVE || state.sessionId || state.recent.length || state.history.length) {
        await endSessionInternal();
        return { active: false, sessionId: null, cleared: true };
      }
      return { active: false, sessionId: null, cleared: false };
    }
    const ids = [...new Set((Array.isArray(windowIds) ? windowIds : []).filter(Number.isInteger))];
    if (ids.length === 0) {
      if (
        state.status === ACTIVE ||
        state.sessionId ||
        state.needsClear ||
        state.recent.length > 0 ||
        state.history.length > 0 ||
        state.liveTabs.length > 0 ||
        state.pending.length > 0
      ) {
        await endSessionInternal();
        return { active: false, sessionId: null, cleared: true };
      }
      return { active: false, sessionId: null, cleared: false };
    }

    if (state.needsClear) await finalizeClear();

    if (state.status !== ACTIVE || !state.sessionId) {
      const sessionId = await startSessionInternal(ids);
      return { active: true, sessionId, newSession: true };
    }

    // 已知窗口与新窗口没有交集，说明旧会话的窗口都已消失；
    // 即使 worker 休眠期间未观察到数量归零，也不能把新窗口接到旧会话上。
    const overlap = state.windows.length > 0 && ids.some((id) => state.windows.includes(id));
    if (!overlap) {
      await endSessionInternal();
      const sessionId = await startSessionInternal(ids);
      return { active: true, sessionId, newSession: true, cleared: true };
    }

    if (ids.length !== state.windows.length || ids.some((id) => !state.windows.includes(id))) {
      state.windows = ids;
      state.updatedAt = now();
      await persist();
    }
    return { active: true, sessionId: state.sessionId };
  }

  function requireActive() {
    return state && state.status === ACTIVE && Boolean(state.sessionId);
  }

  function addPending(stateRef, event) {
    if (!stateRef.pending.some((item) => item.eventId === event.eventId)) stateRef.pending.push(event);
  }

  async function recordCloseInternal(rawEvent, maxRecords) {
    await load();
    const event = rawEvent && typeof rawEvent === 'object' ? { ...rawEvent } : null;
    if (!event || !urlKey(event.url) || typeof event.eventId !== 'string') {
      const error = new Error('invalid-close-event');
      error.code = 'invalid-request';
      throw error;
    }
    if (!requireActive()) return { applied: false, reason: 'session-ended' };
    if (event.sessionId && event.sessionId !== state.sessionId) return { applied: false, reason: 'stale-session' };
    if (Number.isInteger(event.generation) && event.generation !== state.clearGeneration.recent) {
      return { applied: false, reason: 'stale-generation' };
    }
    const closeEvent = {
      ...event,
      kind: 'close',
      sessionId: typeof event.sessionId === 'string' && event.sessionId ? event.sessionId : state.sessionId,
      generation: Number.isInteger(event.generation) ? event.generation : state.clearGeneration.recent,
      urlKey: urlKey(event.url),
    };
    addPending(state, closeEvent);
    const result = applyCloseEntry(state, closeEvent, uuid);
    if (result.applied) trimList(state.recent, maxRecords);
    await persist();
    if (result.applied || result.reason === 'duplicate' || result.reason === 'older' || result.reason === 'deleted') {
      state.pending = state.pending.filter((item) => item.eventId !== closeEvent.eventId);
      await persist();
    }
    return result;
  }

  async function recordVisitInternal(rawEvent, maxRecords) {
    await load();
    const event = rawEvent && typeof rawEvent === 'object' ? { ...rawEvent } : null;
    if (!event || !urlKey(event.url) || typeof event.eventId !== 'string') {
      const error = new Error('invalid-visit-event');
      error.code = 'invalid-request';
      throw error;
    }
    if (!requireActive()) return { applied: false, reason: 'session-ended' };
    if (event.sessionId && event.sessionId !== state.sessionId) return { applied: false, reason: 'stale-session' };
    if (Number.isInteger(event.generation) && event.generation !== state.clearGeneration.history) {
      return { applied: false, reason: 'stale-generation' };
    }
    const visitEvent = {
      ...event,
      kind: 'visit',
      sessionId: typeof event.sessionId === 'string' && event.sessionId ? event.sessionId : state.sessionId,
      generation: Number.isInteger(event.generation) ? event.generation : state.clearGeneration.history,
      urlKey: urlKey(event.url),
      visitedAt: Number.isFinite(event.visitedAt) ? event.visitedAt : now(),
      order: Number.isFinite(event.order) ? event.order : now(),
    };
    if (state.appliedVisitEvents.includes(visitEvent.eventId)) return { applied: false, reason: 'duplicate' };
    addPending(state, visitEvent);
    const result = applyVisitEntry(state, visitEvent, uuid);
    if (result.applied) trimList(state.history, maxRecords);
    await persist();
    if (result.applied || result.reason === 'duplicate' || result.reason === 'deleted') {
      state.pending = state.pending.filter((item) => item.eventId !== visitEvent.eventId);
      await persist();
    }
    return result;
  }

  async function retryPendingInternal(limits) {
    await load();
    await persistIfNeeded();
    if (state.pending.length === 0) return { applied: 0, pending: 0 };
    const remaining = [];
    let applied = 0;
    for (const event of state.pending) {
      const result = event.kind === 'visit'
        ? applyVisitEntry(state, event, uuid)
        : applyCloseEntry(state, event, uuid);
      if (result.applied) applied += 1;
      else if (
        result.reason === 'duplicate' ||
        result.reason === 'older' ||
        result.reason === 'deleted' ||
        result.reason === 'stale-session' ||
        result.reason === 'stale-generation' ||
        result.reason === 'session-ended'
      ) continue;
      else remaining.push(event);
    }
    if (applied > 0) {
      trimList(state.recent, limits.recentMaxRecords);
      trimList(state.history, limits.historyMaxRecords);
      await persist();
    }
    state.pending = remaining;
    await persist();
    return { applied, pending: remaining.length };
  }

  return {
    /** 同步读取当前上下文，供事件入口固定 sessionId/代次。 */
    peekContext() {
      if (!state) return null;
      return {
        sessionId: state.sessionId,
        active: state.status === ACTIVE && Boolean(state.sessionId),
        recentGeneration: state.clearGeneration.recent,
        historyGeneration: state.clearGeneration.history,
        windows: [...state.windows],
      };
    },

    syncWindows(windowIds, { accessAllowed = true } = {}) {
      return enqueue(() => syncWindowsInternal(windowIds, accessAllowed));
    },

    addWindow(windowId) {
      return enqueue(async () => {
        await load();
        if (!Number.isInteger(windowId)) {
          return state
            ? { active: requireActive(), sessionId: state.sessionId, windows: [...state.windows] }
            : null;
        }
        if (!requireActive()) {
          const sessionId = await startSessionInternal([windowId]);
          return { active: true, sessionId, newSession: true };
        }
        if (!state.windows.includes(windowId)) {
          state.windows.push(windowId);
          state.updatedAt = now();
          await persist();
        }
        return { active: true, sessionId: state.sessionId };
      });
    },

    endSession() {
      return enqueue(async () => {
        await load();
        return endSessionInternal();
      });
    },

    getInfo() {
      return enqueue(async () => {
        await load();
        return {
          active: requireActive(),
          sessionId: state.sessionId,
          windows: [...state.windows],
          pendingCount: state.pending.length,
        };
      });
    },

    getLiveTabs() {
      return enqueue(async () => {
        await load();
        return [...state.liveTabs];
      });
    },

    setLiveTabs(snapshots) {
      return enqueue(async () => {
        await load();
        const sessionId = state.sessionId;
        state.liveTabs = (Array.isArray(snapshots) ? snapshots : [])
          .map(normalizeSnapshot)
          .filter((snapshot) => snapshot && snapshot.sessionId === sessionId);
        state.updatedAt = now();
        await persist();
      });
    },

    recordClose(rawEvent, maxRecords) {
      return enqueue(() => recordCloseInternal(rawEvent, maxRecords));
    },

    recordVisit(rawEvent, maxRecords) {
      return enqueue(() => recordVisitInternal(rawEvent, maxRecords));
    },

    retryPending(limits) {
      return enqueue(() => retryPendingInternal(limits));
    },

    updateTitle({ url, title, favIconUrl, sessionId, tabId } = {}) {
      return enqueue(async () => {
        await load();
        if (!requireActive()) return { updated: false };
        if (sessionId && sessionId !== state.sessionId) return { updated: false };
        const key = urlKey(url);
        if (!key) return { updated: false };
        let updated = false;
        // 只补齐访问历史；已关闭条目保持关闭时的标题。校验 tabId 与当前 URL，
        // 防止把下一页面的标题补给上一页面。
        for (const entry of state.history) {
          if (!entry || entry.urlKey !== key) continue;
          if (
            Number.isInteger(tabId) &&
            Number.isInteger(entry.lastTabId) &&
            entry.lastTabId !== tabId
          ) {
            continue;
          }
          if (typeof title === 'string' && title.trim() && title.trim() !== entry.title) {
            entry.title = title.trim();
            updated = true;
          }
          if (typeof favIconUrl === 'string' && favIconUrl && !entry.hasFavicon) {
            entry.hasFavicon = true;
            updated = true;
          }
        }
        if (updated) {
          state.updatedAt = now();
          await persist();
        }
        return { updated };
      });
    },

    query(view, queryText) {
      return enqueue(async () => {
        await load();
        if (!requireActive()) {
          return { active: false, sessionId: null, entries: [], total: 0, matchCount: 0, topSignature: '' };
        }
        const source = view === 'history' ? state.history : state.recent;
        const needle = typeof queryText === 'string' ? queryText.trim().toLowerCase() : '';
        const entries = needle
          ? source.filter(
              (entry) =>
                entry.title.toLowerCase().includes(needle) || entry.url.toLowerCase().includes(needle),
            )
          : [...source];
        return {
          active: true,
          sessionId: state.sessionId,
          entries,
          total: source.length,
          matchCount: entries.length,
          topSignature: source[0]
            ? `${source[0].lastEventId || source[0].id}:${source[0].lastVisitedAt || source[0].closedAt || ''}:${source[0].title || ''}`
            : '',
        };
      });
    },

    getEntry(view, id) {
      return enqueue(async () => {
        await load();
        if (!requireActive()) return null;
        const source = view === 'history' ? state.history : state.recent;
        return source.find((entry) => entry.id === id) || null;
      });
    },

    deleteEntry(view, id) {
      return enqueue(async () => {
        await load();
        if (!requireActive()) return { removed: false };
        const source = view === 'history' ? state.history : state.recent;
        const entry = source.find((item) => item.id === id);
        if (!entry) return { removed: false };
        if (view === 'history') {
          state.history = state.history.filter((item) => item.id !== id);
          state.deletedHistory[entry.urlKey] = now();
        } else {
          state.recent = state.recent.filter((item) => item.id !== id);
          state.deletedRecent[entry.urlKey] = now();
        }
        state.pending = state.pending.filter((item) => item.urlKey !== entry.urlKey);
        state.updatedAt = now();
        await persist();
        return { removed: true };
      });
    },

    clearView(view) {
      return enqueue(async () => {
        await load();
        const target = view === 'history' ? 'history' : 'recent';
        const removed = (target === 'history' ? state.history : state.recent).length;
        state.clearGeneration[target] += 1;
        if (target === 'history') {
          state.history = [];
          state.deletedHistory = {};
        } else {
          state.recent = [];
          state.deletedRecent = {};
        }
        state.pending = state.pending.filter((item) => item.kind !== (target === 'history' ? 'visit' : 'close'));
        if (target === 'history') state.appliedVisitEvents = [];
        state.updatedAt = now();
        await persist();
        return { removed };
      });
    },

    /** 清空本次无痕会话的两个集合与 pending，但保持会话本身有效。 */
    clearData() {
      return enqueue(async () => {
        await load();
        const removed = state.recent.length + state.history.length;
        state.clearGeneration.recent += 1;
        state.clearGeneration.history += 1;
        state.recent = [];
        state.history = [];
        state.deletedRecent = {};
        state.deletedHistory = {};
        state.pending = [];
        state.appliedVisitEvents = [];
        state.updatedAt = now();
        await persist();
        return { removed };
      });
    },

    previewTrim(view, maxRecords) {
      return enqueue(async () => {
        await load();
        return {
          recent: view === 'recent' ? Math.max(0, state.recent.length - maxRecords) : 0,
          history: view === 'history' ? Math.max(0, state.history.length - maxRecords) : 0,
          recentTotal: state.recent.length,
          historyTotal: state.history.length,
        };
      });
    },

    trimView(view, maxRecords) {
      return enqueue(async () => {
        await load();
        const recent = view === 'recent' ? trimList(state.recent, maxRecords) : 0;
        const history = view === 'history' ? trimList(state.history, maxRecords) : 0;
        if (recent > 0 || history > 0) {
          state.updatedAt = now();
          await persist();
        }
        return { recent, history };
      });
    },

    getPendingCount() {
      return enqueue(async () => {
        await load();
        return state.pending.length;
      });
    },
  };
}
