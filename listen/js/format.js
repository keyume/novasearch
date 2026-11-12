// 时间与时长的显示格式。纯函数。
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const pad = (n) => String(n).padStart(2, '0');

function toDate(iso) {
  if (!iso) return null;
  const time = Date.parse(iso);
  return Number.isNaN(time) ? null : new Date(time);
}

// 812 → "14 分钟"；3900 → "1 小时 5 分钟"；未知 → ""
export function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return '';
  const minutes = Math.max(0, Math.round(seconds / 60));
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${minutes} 分钟`;
  return rest === 0 ? `${hours} 小时` : `${hours} 小时 ${rest} 分钟`;
}

export function formatClock(iso) {
  const date = toDate(iso);
  return date ? `${pad(date.getHours())}:${pad(date.getMinutes())}` : '';
}

export function formatDay(iso) {
  const date = toDate(iso);
  return date ? `${date.getMonth() + 1}月${date.getDate()}日` : '';
}

export function formatWeekday(date) {
  return WEEKDAYS[date.getDay()];
}
