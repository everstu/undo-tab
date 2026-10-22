import { MODES, SCHEMA_VERSION, STORAGE_KEYS } from '../shared/constants.js';
import { normalizeSettings, settingsEqual } from '../shared/settings.js';
import { fallbackTitle, urlKey } from '../shared/urls.js';
import { StorageFailureError, normalizeCloseEvent, normalizeNormalState } from './normal-store.js';

function legacyEntry(record, index, uuid) {
  const key = urlKey(record && record.url);
  if (!key) return null;
  if (!Number.isFinite(record.closedAt)) return null;
  return {
    id: typeof record.id === 'string' && record.id ? record.id : uuid(),
    url: record.url,
    urlKey: key,
    title: typeof record.title === 'string' && record.title.trim() ? record.title.trim() : fallbackTitle(record.url),
    closedAt: record.closedAt,
    order: record.closedAt * 1000 + index,
    originalWindowId: Number.isInteger(record.originalWindowId) ? record.originalWindowId : -1,
    originalIndex: Number.isInteger(record.originalIndex) ? record.originalIndex : 0,
    wasPinned: record.wasPinned === true,
    hasFavicon: record.hasFavicon === true,
    windowClosing: record.windowClosing === true,
    lastEventId: typeof record.id === 'string' && record.id ? record.id : '',
  };
}

function mergeEntries(...lists) {
  const map = new Map();
  for (const list of lists) {
    for (const entry of list) {
      const current = map.get(entry.urlKey);
      if (
        !current ||
        entry.closedAt > current.closedAt ||
        (entry.closedAt === current.closedAt && entry.order > current.order)
      ) {
        map.set(entry.urlKey, entry);
      }
    }
  }
  return [...map.values()].sort(
    (a, b) => b.closedAt - a.closedAt || (b.order || 0) - (a.order || 0),
  );
}

function migratePending(rawPending, legacyLiveTabs, generation, uuid) {
  const map = new Map();
  for (const raw of Array.isArray(rawPending) ? rawPending : []) {
    const event = normalizeCloseEvent(raw);
    if (!event) continue;
    event.generation = Number.isInteger(event.generation) ? event.generation : generation;
    if (!map.has(event.eventId)) map.set(event.eventId, event);
  }
  for (const snapshot of Array.isArray(legacyLiveTabs) ? legacyLiveTabs : []) {
    if (!snapshot || snapshot.mode !== MODES.normal) continue;
    if (!snapshot.pendingClose) continue;
    const key = urlKey(snapshot.url);
    if (!key) continue;
    const closedAt = snapshot.pendingClose.closedAt;
    if (!Number.isFinite(closedAt)) continue;
    const eventId = typeof snapshot.captureId === 'string' && snapshot.captureId ? snapshot.captureId : uuid();
    if (map.has(eventId)) continue;
    map.set(eventId, {
      eventId,
      url: snapshot.url,
      urlKey: key,
      title: typeof snapshot.title === 'string' ? snapshot.title : '',
      closedAt,
      order: closedAt * 1000,
      originalWindowId: Number.isInteger(snapshot.pendingClose.windowId)
        ? snapshot.pendingClose.windowId
        : Number.isInteger(snapshot.windowId)
          ? snapshot.windowId
          : -1,
      originalIndex: Number.isInteger(snapshot.index) ? snapshot.index : 0,
      wasPinned: snapshot.pinned === true,
      hasFavicon: snapshot.hasFavicon === true,
      windowClosing: snapshot.pendingClose.windowClosing === true,
      generation,
    });
  }
  return [...map.values()];
}

/**
 * schema 1 → 2 迁移。只保留普通记录，丢弃旧持久无痕数据；
 * 迁移可重复执行，失败后再次运行不会把已有新集合覆盖为空。
 */
export async function migrateLegacyData({
  localArea,
  sessionArea,
  uuid = () => crypto.randomUUID(),
  logger = console,
}) {
  let rawSettings = null;
  let rawRecords;
  let rawLiveTabs;
  let rawNormal;
  let rawPending;
  try {
    const local = await localArea.get([
      STORAGE_KEYS.settings,
      STORAGE_KEYS.legacyRecords,
      STORAGE_KEYS.normalRecent,
    ]);
    const session = await sessionArea.get([
      STORAGE_KEYS.legacyLiveTabs,
      STORAGE_KEYS.normalPendingCloses,
    ]);
    rawSettings = local ? local[STORAGE_KEYS.settings] : null;
    rawRecords = local ? local[STORAGE_KEYS.legacyRecords] : undefined;
    rawNormal = local ? local[STORAGE_KEYS.normalRecent] : undefined;
    rawLiveTabs = session ? session[STORAGE_KEYS.legacyLiveTabs] : undefined;
    rawPending = session ? session[STORAGE_KEYS.normalPendingCloses] : undefined;
  } catch (error) {
    throw new StorageFailureError(error);
  }

  const legacyPresent = rawRecords !== undefined || rawLiveTabs !== undefined;
  const settings = normalizeSettings(rawSettings);
  if (!legacyPresent && settingsEqual(rawSettings, settings)) {
    return { migrated: false, normal: 0, pending: 0 };
  }

  const existing = normalizeNormalState(rawNormal);
  const legacyEntries = [];
  if (Array.isArray(rawRecords)) {
    rawRecords.forEach((record, index) => {
      if (!record || record.mode !== MODES.normal) return;
      const entry = legacyEntry(record, index, uuid);
      if (entry) legacyEntries.push(entry);
    });
  }

  const entries = mergeEntries(existing.entries, legacyEntries).slice(0, settings.normal.maxRecords);
  const lastOrder = entries.reduce(
    (max, entry) => Math.max(max, Number.isFinite(entry.order) ? entry.order : 0),
    existing.lastOrder || 0,
  );
  const normalState = {
    generation: existing.generation,
    lastOrder,
    deleted: existing.deleted,
    entries,
  };
  const pending = migratePending(rawPending, rawLiveTabs, normalState.generation, uuid);

  try {
    await localArea.set({ [STORAGE_KEYS.normalRecent]: normalState });
    await sessionArea.set({ [STORAGE_KEYS.normalPendingCloses]: pending });
    // local 与 session 分开清理，避免旧混合历史/无痕快照残留。
    if (rawRecords !== undefined) await localArea.remove([STORAGE_KEYS.legacyRecords]);
    if (rawLiveTabs !== undefined) await sessionArea.remove([STORAGE_KEYS.legacyLiveTabs]);
    await localArea.set({ [STORAGE_KEYS.settings]: { ...settings, schemaVersion: SCHEMA_VERSION } });
  } catch (error) {
    throw new StorageFailureError(error);
  }

  logger.warn?.(`undo-tab: 已迁移 ${entries.length} 条普通最近关闭、${pending.length} 条待写事件`);
  return { migrated: true, normal: entries.length, pending: pending.length };
}
