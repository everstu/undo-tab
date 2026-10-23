import { STORAGE_KEYS } from '../shared/constants.js';
import { createQueue } from '../shared/queue.js';
import { urlKey } from '../shared/urls.js';
import {
  applyRecentClose,
  compareClosedDesc,
  normalizeDeletedMarkers,
  normalizeRecentEntry,
  pruneDeletedMarkers,
  serializeEntries,
} from './recent-entries.js';

export class StorageFailureError extends Error {
  constructor(cause) {
    super('storage-error');
    this.name = 'StorageFailureError';
    this.code = 'storage-error';
    this.cause = cause;
  }
}

export function normalizeNormalState(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const entries = Array.isArray(source.entries) ? source.entries.map(normalizeRecentEntry).filter(Boolean) : [];
  entries.sort(compareClosedDesc);
  return {
    generation: Number.isInteger(source.generation) && source.generation >= 0 ? source.generation : 0,
    lastOrder: Number.isFinite(source.lastOrder) ? source.lastOrder : 0,
    deleted: normalizeDeletedMarkers(source.deleted),
    entries,
  };
}

/** 写入 local 的普通集合（条目省略可推导的 urlKey）。 */
export function serializeNormalState(state) {
  return { ...state, entries: serializeEntries(state.entries) };
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
  state.entries.sort(compareClosedDesc);
  const removed = Math.max(0, state.entries.length - limit);
  if (removed > 0) state.entries = state.entries.slice(0, limit);
  return removed;
}

/** 普通最近关闭只校验清空代次；去重、置顶与删除标记规则见 applyRecentClose。 */
function applyCloseEvent(state, event, uuid) {
  if (event.generation !== state.generation) return { applied: false, reason: 'stale' };
  const result = applyRecentClose(state.entries, event, uuid, state.deleted);
  if (result.applied) state.lastOrder = Math.max(state.lastOrder || 0, event.order);
  return result;
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
  const writeState = (state) => writeLocal({ [STORAGE_KEYS.normalRecent]: serializeNormalState(state) });
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
            // 队列内 pending 只由本 store 修改，沿用上面读到的列表即可。
            await writePending(pending.filter((item) => item.eventId !== event.eventId));
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
        // pending 已落盘，此后才能安全移除不再挡住任何事件的删除标记。
        if (pruneDeletedMarkers(state.deleted, remaining) > 0) {
          await writeState(state).catch(() => {});
        }
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

        let pending = null;
        try {
          pending = await readPending();
        } catch (error) {
          pending = null; // 无法确认是否有旧事件，按“有”处理。
        }
        const hasBlocking = !pending || pending.some((item) => item.urlKey === entry.urlKey);
        if (!hasBlocking) {
          // 没有同 URL 的待补写：无需删除标记，顺带移除其他已无作用的标记。
          pruneDeletedMarkers(state.deleted, pending);
          await writeState(state);
          return { removed: true, total: state.entries.length };
        }

        // 有旧事件：删除标记与条目删除同一次 local 写入；即使随后的 session pending
        // 清理失败，旧事件补写时也会被删除标记挡住。
        state.deleted[entry.urlKey] = now();
        await writeState(state);
        try {
          const nextPending = pending.filter((item) => item.urlKey !== entry.urlKey);
          await writePending(nextPending);
          // pending 已取消，标记不再需要；移除失败时留待补写或下次启动清理。
          if (pruneDeletedMarkers(state.deleted, nextPending) > 0) await writeState(state);
        } catch (error) {
          // 删除标记已持久化，补写不会复活。
        }
        return { removed: true, total: state.entries.length };
      });
    },

    /**
     * worker 初始化维护，合并为一次读写：
     * - 按当前上限裁剪（如升级后上限收紧到 1000，超出的最旧记录立即删除）；
     * - 清理已无作用的删除标记：浏览器重启后 session 中的 pending 已不存在，
     *   只保留仍挡住某个待补写事件的标记。pending 读取失败时跳过清理，仍完成裁剪。
     */
    startupMaintenance(maxRecords) {
      return enqueue(async () => {
        const state = await readState();
        const trimmed = trimEntries(state, maxRecords);
        let prunedMarkers = 0;
        if (Object.keys(state.deleted).length > 0) {
          try {
            prunedMarkers = pruneDeletedMarkers(state.deleted, await readPending());
          } catch (error) {
            prunedMarkers = 0;
          }
        }
        if (trimmed > 0 || prunedMarkers > 0) await writeState(state);
        return { trimmed, prunedMarkers };
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
        await writeLocal({
          [STORAGE_KEYS.settings]: settings,
          [STORAGE_KEYS.normalRecent]: serializeNormalState(state),
        });
        return { settings, trimmed, total: state.entries.length };
      });
    },
  };
}
