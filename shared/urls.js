/** 第一版只记录、只恢复 http: 与 https: 页面。 */

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

export function parseRestorableUrl(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) return null;
  if (!parsed.hostname) return null;
  return parsed;
}

export function isRestorableUrl(value) {
  return parseRestorableUrl(value) !== null;
}

/**
 * 最近关闭与无痕访问的统一去重键：new URL(url).href。
 * 保留路径、全部查询参数及顺序、#fragment。
 */
export function urlKey(value) {
  const parsed = parseRestorableUrl(value);
  return parsed ? parsed.href : null;
}

/** 没有标题时回退为域名，域名不可用时回退为原始网址。 */
export function fallbackTitle(value) {
  const parsed = parseRestorableUrl(value);
  if (parsed && parsed.hostname) return parsed.hostname;
  return typeof value === 'string' ? value : '';
}

export function recordTitle(record) {
  const title = record && typeof record.title === 'string' ? record.title.trim() : '';
  return title || fallbackTitle(record && record.url);
}

/** 列表左侧图标位置使用的首字母：域名首字，IP/localhost 时改用标题首字。 */
export function initialForRecord(record) {
  const title = recordTitle(record);
  const parsed = parseRestorableUrl(record && record.url);
  const host = parsed && parsed.hostname ? parsed.hostname : '';
  const isAddress = host === 'localhost' || /^[0-9.]+$/.test(host) || host.includes(':');
  const source = !isAddress && host ? host.replace(/^www\./i, '') : title;
  const first = source.trim().charAt(0);
  return first ? first.toUpperCase() : '?';
}
