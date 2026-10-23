/** 后台与弹窗共用的列表条目工具。 */

/** 按标题或网址做不区分大小写的子串匹配；needle 需已小写。 */
export function matchesQuery(entry, needle) {
  if (!needle) return true;
  return (
    String(entry.title || '').toLowerCase().includes(needle) ||
    String(entry.url || '').toLowerCase().includes(needle)
  );
}

/** 列表首条签名：用于弹窗判断存储变化后是否需要刷新。 */
export function entrySignature(entry) {
  if (!entry) return '';
  return `${entry.lastEventId || entry.id}:${entry.lastVisitedAt || entry.closedAt || ''}:${entry.title || ''}`;
}
