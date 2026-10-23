const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** 相对时间：刚刚 / N 分钟前 / N 小时前 / N 天前 / YYYY/MM/DD。 */
export function formatRelativeTime(closedAt, now = Date.now()) {
  if (!Number.isFinite(closedAt)) return '';
  const diff = now - closedAt;
  if (diff < MINUTE) return '刚刚';
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)} 分钟前`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)} 小时前`;
  if (diff < 7 * DAY) return `${Math.floor(diff / DAY)} 天前`;
  const date = new Date(closedAt);
  if (Number.isNaN(date.getTime())) return '';
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}/${month}/${day}`;
}

/**
 * 单调递增的事件顺序号：以微秒时间戳为基准，同一毫秒内或时钟回拨时递增。
 * 用于同一时刻多个事件的稳定排序。
 */
export function createOrderClock() {
  let last = 0;
  return function nextOrder(timestamp) {
    const base = Math.floor(timestamp * 1000);
    last = base > last ? base : last + 1;
    return last;
  };
}
