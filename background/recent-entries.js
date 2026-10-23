import { fallbackTitle, urlKey } from '../shared/urls.js';

/**
 * 普通与无痕“最近关闭”共用的条目规则（各自集合仍独立存储、独立配额）。
 */

export function compareClosedDesc(a, b) {
  if (b.closedAt !== a.closedAt) return b.closedAt - a.closedAt;
  return (b.order || 0) - (a.order || 0);
}

/** 删除标记 { [urlKey]: deletedAt }，过滤非法键值。 */
export function normalizeDeletedMarkers(raw) {
  const result = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return result;
  for (const [key, value] of Object.entries(raw)) {
    if (urlKey(key) === key && Number.isFinite(value) && value >= 0) result[key] = value;
  }
  return result;
}

export function normalizeRecentEntry(raw) {
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

/**
 * 把一次关闭事件应用到最近关闭集合（原地修改 entries / deleted）。
 * 调用方先校验代次、会话等归属条件；deleted 为可选的删除标记。
 * - 删除之前发生的关闭（含清理 pending 失败后补写的事件）失效；之后的真实关闭可重新生成；
 * - 相同 urlKey 更新并置顶，不增加第二条；同一 eventId 幂等；
 * - 较旧事件晚到时忽略，不覆盖较新的数据。
 */
export function applyRecentClose(entries, event, uuid, deleted = null) {
  const deletedAt = deleted ? deleted[event.urlKey] : undefined;
  if (Number.isFinite(deletedAt)) {
    if (event.closedAt <= deletedAt) return { applied: false, reason: 'deleted' };
    delete deleted[event.urlKey];
  }
  const meta = {
    closedAt: event.closedAt,
    order: event.order,
    originalWindowId: event.originalWindowId,
    originalIndex: event.originalIndex,
    wasPinned: event.wasPinned,
    hasFavicon: event.hasFavicon,
    windowClosing: event.windowClosing,
    lastEventId: event.eventId,
  };
  const index = entries.findIndex((entry) => entry.urlKey === event.urlKey);
  if (index >= 0) {
    const existing = entries[index];
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
      ...meta,
      title: event.title || existing.title || fallbackTitle(event.url),
    };
    entries.splice(index, 1);
    entries.unshift(updated);
    return { applied: true, entryId: updated.id };
  }
  const entry = {
    id: uuid(),
    url: event.url,
    urlKey: event.urlKey,
    title: event.title || fallbackTitle(event.url),
    ...meta,
  };
  entries.unshift(entry);
  return { applied: true, entryId: entry.id };
}

/**
 * 删除标记只用来挡住“同 URL、且早于删除时间”的待补写事件。
 * 没有这类 pending 时标记已无作用，原地移除；返回移除数量。
 * 调用方必须确认 pending 已是存储中的真实列表。
 */
export function pruneDeletedMarkers(deleted, pending) {
  let removed = 0;
  for (const [key, deletedAt] of Object.entries(deleted)) {
    const blocking = pending.some((event) => event.urlKey === key && event.closedAt <= deletedAt);
    if (!blocking) {
      delete deleted[key];
      removed += 1;
    }
  }
  return removed;
}

/** 写入存储时省略 urlKey（读取时由 normalizeRecentEntry 从 url 重新计算），减少约四分之一体积。 */
export function serializeEntries(entries) {
  return entries.map(({ urlKey: _derived, ...rest }) => rest);
}
