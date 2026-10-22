import { STORAGE_KEYS } from '../shared/constants.js';
import { createQueue } from '../shared/queue.js';
import { fallbackTitle, urlKey } from '../shared/urls.js';

export class StorageFailureError extends Error {
  constructor(cause) {
    super('storage-error');
    this.name = 'StorageFailureError';
    this.code = 'storage-error';
    this.cause = cause;
  }
}

function compareEntriesDesc(a, b) {
  if (b.closedAt !== a.closedAt) return b.closedAt - a.closedAt;
  return (b.order || 0) - (a.order || 0);
}

function normalizeEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const key = urlKey(raw.url);
  if (!key) return null;
  if (typeof raw.id !== 'string' || raw.id === '') return null;
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

function normalizeDeleted(raw) {
  const result = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return result;
  for (const [key, value] of Object.entries(raw)) {
    if (urlKey(key) === key && Number.isFinite(value) && value >= 0) result[key] = value;
  }
  return result;
}

export function normalizeNormalState(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const entries = Array.isArray(source.entries) ? source.entries.map(normalizeEntry).filter(Boolean) : [];
  entries.sort(compareEntriesDesc);
  return {
    generation: Number.isInteger(source.generation) && source.generation >= 0 ? source.generation : 0,
    lastOrder: Number.isFinite(source.lastOrder) ? source.lastOrder : 0,
    deleted: normalizeDeleted(source.deleted),
    entries,
  };
}

export function normalizeCloseEvent(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const key = urlKey(raw.url);
  if (!key) return null;
  if (typeof raw.eventId !== 'string' || raw.eventId === '') return null;
  if (!Number.isFinite(raw.closedAt)) return null;
  return {
    eventId: raw.eventId,
    url: raw.url,
    urlKey: key,
    title: typeof raw.title === 'string' ? raw.title.trim() : '',
    closedAt: raw.closedAt,
    order: Number.isFinite(raw.order) ? raw.order : raw.closedAt,
    originalWindowId: Number.isInteger(raw.originalWindowId) ? raw.originalWindowId : -1,
    originalIndex: Number.isInteger(raw.originalIndex) ? raw.originalIndex : 0,
    wasPinned: raw.wasPinned === true,
    hasFavicon: raw.hasFavicon === true,
    windowClosing: raw.windowClosing === true,
    generation: Number.isInteger(raw.generation) && raw.generation >= 0 ? raw.generation : null,
  };
}

function normalizePending(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizeCloseEvent).filter(Boolean);
}

function trimEntries(state, maxRecords) {
  const limit = Number.isInteger(maxRecords) && maxRecords > 0 ? maxRecords : 0;
  state.entries.sort(compareEntriesDesc);
  const removed = Math.max(0, state.entries.length - limit);
  if (removed > 0) state.entries = state.entries.slice(0, limit);
  return removed;
}

/**
 * 把一次关闭事件应用到普通最近关闭集合。
 * - 相同 urlKey 更新并置顶，不增加第二条；
 * - 同一 eventId 幂等；
 * - 较旧事件晚到时忽略，不覆盖较新的数据；
 * - 清空后旧代次事件丢弃。
 */
function applyCloseEvent(state, event, uuid) {
  if (event.generation !== state.generation) return { applied: false, reason: 'stale' };
  const deletedAt = state.deleted[event.urlKey];
  if (Number.isFinite(deletedAt)) {
    // 删除之前的关闭事件（包括清理 pending 失败后补写的事件）必须失效；
    // 删除之后真正发生的新关闭仍可重新生成条目。
    if (event.closedAt <= deletedAt) return { applied: false, reason: 'deleted' };
    delete state.deleted[event.urlKey];
  }
  const index = state.entries.findIndex((entry) => entry.urlKey === event.urlKey);
  if (index >= 0) {
    const existing = state.entries[index];
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
    state.entries.splice(index, 1);
    state.entries.unshift(updated);
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
  state.entries.unshift(entry);
  state.lastOrder = Math.max(state.lastOrder || 0, event.order);
  return { applied: true, entryId: entry.id };
}

export function createNormalStore({
  localArea,
  sessionArea,
  uuid = () => crypto.randomUUID(),
  now = () => Date.now(),
}) {
  if (!localArea || !sessionArea) throw new Error('createNormalStore 缺少存储区');
  const enqueue = createQueue();

  async function readLocal(key, fallback) {
    try {
      const result = await localArea.get(key);
      return result && result[key] !== undefined ? result[key] : fallback;
    } catch (error) {
      throw new StorageFailureError(error);
    }
  }

  async function writeLocal(items) {
    try {
      await localArea.set(items);
    } catch (error) {
      throw new StorageFailureError(error);
    }
  }

  async function readSession(key, fallback) {
    try {
      const result = await sessionArea.get(key);
      return result && result[key] !== undefined ? result[key] : fallback;
    } catch (error) {
      throw new StorageFailureError(error);
    }
  }

  async function writeSession(items) {
    try {
      await sessionArea.set(items);
    } catch (error) {
      throw new StorageFailureError(error);
    }
  }

  const readState = async () => normalizeNormalState(await readLocal(STORAGE_KEYS.normalRecent, null));
  const writeState = (state) => writeLocal({ [STORAGE_KEYS.normalRecent]: state });
  const readPending = async () => normalizePending(await readSession(STORAGE_KEYS.normalPendingCloses, []));
  const writePending = (list) => writeSession({ [STORAGE_KEYS.normalPendingCloses]: list });

  return {
    getEntries() {
      return enqueue(async () => (await readState()).entries);
    },

    getPendingCount() {
      return enqueue(async () => (await readPending()).length);
    },

    previewTrim(maxRecords) {
      return enqueue(async () => {
        const state = await readState();
        return { total: state.entries.length, trimmed: Math.max(0, state.entries.length - maxRecords) };
      });
    },

    /** 记录一次普通关闭；失败时事件保留在 pending 中等待补写。 */
    recordClose(rawEvent, maxRecords) {
      return enqueue(async () => {
        const event = normalizeCloseEvent(rawEvent);
        if (!event) {
          const error = new Error('invalid-close-event');
          error.code = 'invalid-request';
          throw error;
        }
        const state = await readState();
        event.generation = event.generation === null ? state.generation : event.generation;

        let pending = await readPending();
        if (!pending.some((item) => item.eventId === event.eventId)) {
          pending = [...pending, event];
          try {
            await writePending(pending);
          } catch (error) {
            // 待写事件写不进去时仍尝试直接落库；成功则无需 pending。
          }
        }

        const result = applyCloseEvent(state, event, uuid);
        if (result.applied) {
          const trimmed = trimEntries(state, maxRecords);
          await writeState(state);
          result.trimmed = trimmed;
        }

        if (
          result.applied ||
          result.reason === 'duplicate' ||
          result.reason === 'older' ||
          result.reason === 'stale' ||
          result.reason === 'deleted'
        ) {
          try {
            await writePending((await readPending()).filter((item) => item.eventId !== event.eventId));
          } catch (error) {
            // 补写成功但清理 pending 失败时，下次会按 eventId / 删除标记幂等。
          }
        }
        return result;
      });
    },

    /** 补写 pending 中的普通关闭事件。 */
    retryPending(maxRecords) {
      return enqueue(async () => {
        const pending = await readPending();
        if (pending.length === 0) return { applied: 0, pending: 0, trimmed: 0 };
        const state = await readState();
        const remaining = [];
        let applied = 0;
        for (const event of pending) {
          const result = applyCloseEvent(state, event, uuid);
          if (result.applied) applied += 1;
          else if (
            result.reason === 'stale' ||
            result.reason === 'older' ||
            result.reason === 'duplicate' ||
            result.reason === 'deleted'
          ) continue;
          else remaining.push(event);
        }
        let trimmed = 0;
        if (applied > 0) {
          trimmed = trimEntries(state, maxRecords);
          await writeState(state);
        }
        await writePending(remaining);
        return { applied, pending: remaining.length, trimmed };
      });
    },

    deleteEntry(id) {
      return enqueue(async () => {
        if (typeof id !== 'string' || id === '') {
          const error = new Error('invalid-id');
          error.code = 'invalid-request';
          throw error;
        }
        const state = await readState();
        const entry = state.entries.find((item) => item.id === id);
        if (!entry) return { removed: false, total: state.entries.length };
        state.entries = state.entries.filter((item) => item.id !== id);
        // 与条目删除同一次 local 写入持久化删除标记；即使随后的 session pending
        // 清理失败，旧事件补写时也会被删除标记挡住。
        state.deleted[entry.urlKey] = now();
        await writeState(state);
        const pending = await readPending();
        const nextPending = pending.filter((item) => item.urlKey !== entry.urlKey);
        if (nextPending.length !== pending.length) {
          try {
            await writePending(nextPending);
          } catch (error) {
            // 删除标记已持久化，补写不会复活。
          }
        }
        return { removed: true, total: state.entries.length };
      });
    },

    /** 清空普通最近关闭：代次 +1，同时取消旧 pending。 */
    clear() {
      return enqueue(async () => {
        const state = await readState();
        const removed = state.entries.length;
        state.generation += 1;
        state.entries = [];
        state.deleted = {};
        await writeState(state);
        try {
          await writePending([]);
        } catch (error) {
          // 旧 pending 代次已过期，重试时会被丢弃。
        }
        return { removed, generation: state.generation };
      });
    },

    /** 上调/下调普通上限；与设置写入合并为一次 local 写，避免半完成状态。 */
    updateLimitAndSettings(settings, maxRecords) {
      return enqueue(async () => {
        const state = await readState();
        const trimmed = trimEntries(state, maxRecords);
        await writeLocal({ [STORAGE_KEYS.settings]: settings, [STORAGE_KEYS.normalRecent]: state });
        return { settings, trimmed, total: state.entries.length };
      });
    },
  };
}
