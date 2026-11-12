// 由每日播放秒数计算听力记录。
import { dateKey } from './feeds.js';

const STREAK_MIN_SECONDS = 60;

export function summarize(stats, now) {
  const data = stats && typeof stats === 'object' ? stats : {};
  const secondsOn = (key) => (Number.isFinite(data[key]) ? data[key] : 0);
  const dayBefore = (offset) => new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset);

  const last7 = [];
  for (let offset = 6; offset >= 0; offset -= 1) {
    const key = dateKey(dayBefore(offset));
    last7.push({ key, sec: secondsOn(key) });
  }

  // 今天还没听够不算中断：从昨天开始往回数。
  let offset = secondsOn(dateKey(now)) >= STREAK_MIN_SECONDS ? 0 : 1;
  let streak = 0;
  while (secondsOn(dateKey(dayBefore(offset))) >= STREAK_MIN_SECONDS) {
    streak += 1;
    offset += 1;
  }

  return {
    todaySec: secondsOn(dateKey(now)),
    totalSec: Object.keys(data).reduce((total, key) => total + secondsOn(key), 0),
    streak,
    last7,
  };
}
