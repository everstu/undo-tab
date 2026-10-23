import {
  APPLIED_VISIT_EVENT_LIMIT,
  ESTIMATED_ENTRY_BYTES,
  SESSION_QUOTA_BYTES,
  STORAGE_KEYS,
} from '../shared/constants.js';
import { entrySignature, matchesQuery } from '../shared/entries.js';
import { createQueue } from '../shared/queue.js';
import { fallbackTitle, urlKey } from '../shared/urls.js';
import { StorageFailureError } from './normal-store.js';
import {
  applyRecentClose,
  compareClosedDesc,
  normalizeRecentEntry,
  serializeEntries,
} from './recent-entries.js';

const ACTIVE = 'active';
const ENDED = 'ended';

/**
 * 无痕状态按用途拆成 4 个 session key，每次只重写变动的部分：
 * 标签更新只写快照，不再整份重写最近关闭与访问历史。
 * 需要同时变动的部分（如删除条目 + 取消 pending）在同一次 set 中写入，保持原子。
 */
const PART_KEYS = Object.freeze({
  meta: STORAGE_KEYS.incognitoMeta,
  recent: STORAGE_KEYS.incognitoRecent,
  history: STORAGE_KEYS.incognitoHistory,
  liveTabs: STORAGE_KEYS.incognitoLiveTabs,
});
const ALL_PARTS = Object.freeze(Object.keys(PART_KEYS));

function emptyState() {
  return {
    sessionId: null,
    status: ENDED,
    needsClear: false,
    windows: [],
    clearGeneration: { recent: 0, history: 0 },
    recent: [],
    history: [],
    liveTabs: [],
    pending: [],
    appliedVisitEvents: [],
    lastOrder: 0,
    updatedAt: 0,
  };
}

function compareVisitedDesc(a, b) {
  return (b.lastVisitedAt - a.lastVisitedAt) || ((b.order || 0) - (a.order || 0));
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

/** 规范化合并后的无痕状态：{ ...meta, recent, history, liveTabs }。 */
export function normalizeIncognitoState(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const recent = (Array.isArray(source.recent) ? source.recent : []).map(normalizeRecentEntry).filter(Boolean);
  recent.sort(compareClosedDesc);
  const history = (Array.isArray(source.history) ? source.history : []).map(normalizeHistoryEntry).filter(Boolean);
  history.sort(compareVisitedDesc);
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
    liveTabs: (Array.isArray(source.liveTabs) ? source.liveTabs : []).map(normalizeSnapshot).filter(Boolean),
    pending: normalizePending(source.pending),
    appliedVisitEvents: Array.isArray(source.appliedVisitEvents)
      ? source.appliedVisitEvents.filter((id) => typeof id === 'string').slice(-APPLIED_VISIT_EVENT_LIMIT)
      : [],
    lastOrder: Number.isFinite(source.lastOrder) ? source.lastOrder : 0,
    updatedAt: Number.isFinite(source.updatedAt) ? source.updatedAt : 0,
  };
}

function serializePart(state, part) {
  switch (part) {
    case 'recent':
      return serializeEntries(state.recent);
    case 'history':
      return serializeEntries(state.history);
    case 'liveTabs':
      return state.liveTabs;
    default:
      return {
        sessionId: state.sessionId,
        status: state.status,
        needsClear: state.needsClear,
        windows: state.windows,
        clearGeneration: state.clearGeneration,
        pending: state.pending,
        appliedVisitEvents: state.appliedVisitEvents,
        lastOrder: state.lastOrder,
        updatedAt: state.updatedAt,
      };
  }
}

function isQuotaError(error) {
  return /quota/i.test(String(error && error.message));
}

const encoder = new TextEncoder();

/** Chrome 按“key 长度 + 值的 JSON 长度”计配额；这里用 UTF-8 字节数估算，偏保守。 */
function itemBytes(key, value) {
  return encoder.encode(key).length + encoder.encode(JSON.stringify(value)).length;
}

/** 补写时已有确定结论、不再保留 pending 的结果。 */
const SETTLED_RETRY_REASONS = new Set([
  'duplicate',
  'older',
  'stale-session',
  'stale-generation',
  'session-ended',
]);

function trimList(list, maxRecords) {
  const limit = Number.isInteger(maxRecords) && maxRecords > 0 ? maxRecords : 0;
  const removed = Math.max(0, list.length - limit);
  if (removed > 0) list.length = limit;
  return removed;
}

/**
 * 无痕不需要删除标记：删除条目与取消同 URL 的 pending 在同一次写入中完成，
 * 不会出现“条目已删、旧 pending 仍在”的存储状态。
 */
function applyCloseEntry(state, event, uuid) {
  if (state.status !== ACTIVE || !state.sessionId) return { applied: false, reason: 'session-ended' };
  if (event.sessionId !== state.sessionId) return { applied: false, reason: 'stale-session' };
  if (event.generation !== state.clearGeneration.recent) return { applied: false, reason: 'stale-generation' };
  const result = applyRecentClose(state.recent, event, uuid);
  if (result.applied) state.lastOrder = Math.max(state.lastOrder || 0, event.order);
  return result;
}

function applyVisitEntry(state, event, uuid) {
  if (state.status !== ACTIVE || !state.sessionId) return { applied: false, reason: 'session-ended' };
  if (event.sessionId !== state.sessionId) return { applied: false, reason: 'stale-session' };
  if (event.generation !== state.clearGeneration.history) return { applied: false, reason: 'stale-generation' };
  if (state.appliedVisitEvents.includes(event.eventId)) return { applied: false, reason: 'duplicate' };

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
  state.history.sort(compareVisitedDesc);
  state.lastOrder = Math.max(state.lastOrder || 0, event.order);
  state.appliedVisitEvents.push(event.eventId);
  if (state.appliedVisitEvents.length > APPLIED_VISIT_EVENT_LIMIT) {
    state.appliedVisitEvents.splice(0, state.appliedVisitEvents.length - APPLIED_VISIT_EVENT_LIMIT);
  }
  return { applied: true };
}

function partForView(view) {
  return view === 'history' ? 'history' : 'recent';
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
  /** 内存中已变更、尚未成功写入的部分；写入失败时保留，下次一起重写。 */
  const dirty = new Set();
  /** 各部分序列化后的字节数缓存；该部分变更时失效。 */
  const partBytes = new Map();
  /** 最近一次写入失败的原因：'quota' | 'write-failed' | null。 */
  let storageIssue = null;

  async function readRaw() {
    const keys = [...Object.values(PART_KEYS), STORAGE_KEYS.legacyIncognitoState];
    let result;
    try {
      result = (await sessionArea.get(keys)) || {};
    } catch (error) {
      throw new StorageFailureError(error);
    }
    if (result[STORAGE_KEYS.legacyIncognitoState] !== undefined) {
      // 旧版整份 key：扩展更新时 session 本应已清空，若仍残留则删除、不导入。
      // 该 key 不会再被读取，删除失败只记录，不能因此阻断无痕功能；下次加载再试。
      try {
        await sessionArea.remove(STORAGE_KEYS.legacyIncognitoState);
      } catch (error) {
        logger.warn('undo-tab: 旧无痕状态删除失败，稍后重试');
      }
    }
    const meta = result[PART_KEYS.meta];
    return {
      ...(meta && typeof meta === 'object' && !Array.isArray(meta) ? meta : {}),
      recent: result[PART_KEYS.recent],
      history: result[PART_KEYS.history],
      liveTabs: result[PART_KEYS.liveTabs],
    };
  }

  /** 写入指定部分以及之前写失败的部分。 */
  async function persist(parts = ALL_PARTS) {
    for (const part of parts) {
      dirty.add(part);
      partBytes.delete(part);
    }
    if (dirty.size === 0) return;
    const items = {};
    for (const part of dirty) items[PART_KEYS[part]] = serializePart(state, part);
    try {
      await sessionArea.set(items);
      dirty.clear();
      storageIssue = null;
    } catch (error) {
      storageIssue = isQuotaError(error) ? 'quota' : 'write-failed';
      throw new StorageFailureError(error);
    }
  }

  async function persistIfNeeded() {
    if (dirty.size > 0) await persist([]);
  }

  function partSize(part) {
    if (!partBytes.has(part)) partBytes.set(part, itemBytes(PART_KEYS[part], serializePart(state, part)));
    return partBytes.get(part);
  }

  function quotaBytes() {
    const quota = sessionArea.QUOTA_BYTES;
    return Number.isFinite(quota) && quota > 0 ? quota : SESSION_QUOTA_BYTES;
  }

  async function load() {
    if (state) return state;
    if (!loadPromise) {
      loadPromise = (async () => {
        state = normalizeIncognitoState(await readRaw());
        dirty.clear();
        partBytes.clear();
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
    // 一次写入把全部 incognito.* key 覆盖为空的已结束状态。
    state = { ...emptyState(), updatedAt: now() };
    try {
      await persist();
    } catch (error) {
      // 内存中已是空的已结束状态；needsClear 与 dirty 保证下次写入或唤醒时继续清理。
      state.needsClear = true;
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
      await persist(['meta']);
    }
    return { active: true, sessionId: state.sessionId };
  }

  function requireActive() {
    return state && state.status === ACTIVE && Boolean(state.sessionId);
  }

  function addPending(event) {
    if (!state.pending.some((item) => item.eventId === event.eventId)) state.pending.push(event);
  }

  /**
   * 条目与 pending 在同一次 set 中写入，成功时已应用的事件无需进入 pending。
   * 已应用的事件写入失败时记为 pending（弹窗据此提示未保存），dirty 保证后续重写。
   * 重复/较旧事件没有改动数据，只重试之前写失败的部分，失败也不计入未保存。
   * （会话或代次不符的事件在调用前已返回，这里只会是 applied / duplicate / older。）
   */
  async function persistEvent(event, result, part) {
    try {
      await persist(result.applied ? [part, 'meta'] : []);
    } catch (error) {
      if (result.applied) addPending(event);
      throw error;
    }
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
    const result = applyCloseEntry(state, closeEvent, uuid);
    if (result.applied) trimList(state.recent, maxRecords);
    await persistEvent(closeEvent, result, 'recent');
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
    const result = applyVisitEntry(state, visitEvent, uuid);
    if (result.applied) trimList(state.history, maxRecords);
    await persistEvent(visitEvent, result, 'history');
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
      else if (!SETTLED_RETRY_REASONS.has(result.reason)) remaining.push(event);
    }
    if (applied > 0) {
      // 补写的旧关闭可能已被较新关闭挤出列表，重新插入时位于顶部；
      // 先按关闭时间排序再裁剪，避免旧条目置顶而较新的条目被裁掉。
      state.recent.sort(compareClosedDesc);
      trimList(state.recent, limits.recentMaxRecords);
      trimList(state.history, limits.historyMaxRecords);
    }
    state.pending = remaining;
    await persist(applied > 0 ? ALL_PARTS.filter((part) => part !== 'liveTabs') : ['meta']);
    return { applied, pending: remaining.length };
  }

  /** 按各集合当前平均条目大小，估算两个上限都存满时的总占用。 */
  function estimateBytesInternal({ recentMaxRecords, historyMaxRecords }) {
    const average = (part, list) => (list.length > 0 ? partSize(part) / list.length : ESTIMATED_ENTRY_BYTES);
    const projectedBytes = Math.round(
      average('recent', state.recent) * recentMaxRecords +
        average('history', state.history) * historyMaxRecords +
        partSize('meta') +
        partSize('liveTabs'),
    );
    return { projectedBytes, quotaBytes: quotaBytes() };
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
          await persist(['meta']);
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
        await persist(['liveTabs']);
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
        if (updated) await persist(['history']);
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
        const entries = needle ? source.filter((entry) => matchesQuery(entry, needle)) : [...source];
        return {
          active: true,
          sessionId: state.sessionId,
          entries,
          total: source.length,
          matchCount: entries.length,
          topSignature: entrySignature(source[0]),
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
        const part = partForView(view);
        const entry = state[part].find((item) => item.id === id);
        if (!entry) return { removed: false };
        state[part] = state[part].filter((item) => item.id !== id);
        // 只取消同一集合的同 URL 旧 pending；另一集合的待补写不受影响。
        // 条目与 pending 同一次写入，无需删除标记。
        const kind = part === 'history' ? 'visit' : 'close';
        state.pending = state.pending.filter((item) => item.kind !== kind || item.urlKey !== entry.urlKey);
        state.updatedAt = now();
        await persist([part, 'meta']);
        return { removed: true };
      });
    },

    clearView(view) {
      return enqueue(async () => {
        await load();
        const part = partForView(view);
        const removed = state[part].length;
        state.clearGeneration[part] += 1;
        state[part] = [];
        state.pending = state.pending.filter((item) => item.kind !== (part === 'history' ? 'visit' : 'close'));
        if (part === 'history') state.appliedVisitEvents = [];
        state.updatedAt = now();
        await persist([part, 'meta']);
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
        state.pending = [];
        state.appliedVisitEvents = [];
        state.updatedAt = now();
        await persist(['recent', 'history', 'meta']);
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
        const part = partForView(view);
        const removed = trimList(state[part], maxRecords);
        if (removed > 0) await persist([part]);
        return { recent: part === 'recent' ? removed : 0, history: part === 'history' ? removed : 0 };
      });
    },

    getPendingCount() {
      return enqueue(async () => {
        await load();
        return state.pending.length;
      });
    },

    /** 估算指定上限下的总占用，用于保存设置前提示可能超出配额。 */
    estimateBytes(limits) {
      return enqueue(async () => {
        await load();
        return estimateBytesInternal(limits);
      });
    },

    /** 当前存储状态：最近一次写入问题与本次会话数据的估算占用。 */
    getStorageStatus() {
      return enqueue(async () => {
        await load();
        const bytesInUse = ALL_PARTS.reduce((sum, part) => sum + partSize(part), 0);
        return { issue: storageIssue, bytesInUse, quotaBytes: quotaBytes() };
      });
    },

    /** 不触发加载的轻量读取，供列表查询附带写入问题提示。 */
    peekStorageIssue() {
      return storageIssue;
    },
  };
}
