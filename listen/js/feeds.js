// 取节目数据（带缓存与并发控制），并按日期汇总成「今日」列表。
import { hashString } from './hash.js';

const CACHE_TTL_MS = 30 * 60 * 1000;
const CONCURRENCY = 4;

const pad = (n) => String(n).padStart(2, '0');

// 没有 guid 的节目用音频地址区分；加上节目地址，避免不同节目的 guid 相撞。
export function episodeId(feedUrl, episode) {
  return hashString(`${feedUrl}|${episode.guid || episode.audioUrl}`);
}

export function dateKey(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function normalize(show, data) {
  return data.episodes.map((episode) => ({
    ...episode,
    id: episodeId(show.feedUrl, episode),
    showId: show.id,
    showTitle: show.title || data.title,
    image: data.image || null,
  }));
}

// 只读缓存、不发请求：用来在刷新完成前先把上次的内容显示出来。
// fresh 为 false 表示至少有一个节目没有缓存或缓存已过期。
export function cachedEpisodes(shows, { store, now = Date.now() }) {
  const episodes = [];
  let fresh = true;
  for (const show of shows) {
    const cached = store.getFeedCache(show.feedUrl);
    if (cached) episodes.push(...normalize(show, cached.data));
    if (!cached || now - cached.at >= CACHE_TTL_MS) fresh = false;
  }
  return { episodes, fresh };
}

async function requestFeed(feedUrl, fetchImpl) {
  const response = await fetchImpl(`/api/feed?url=${encodeURIComponent(feedUrl)}`);
  let body = null;
  try {
    body = await response.json();
  } catch {
    // 不是 JSON，按失败处理
  }
  if (!response.ok) throw new Error((body && body.error) || '无法获取节目源');
  if (!body || !Array.isArray(body.episodes)) throw new Error('节目数据格式不正确');
  return body;
}

export async function loadShow(show, { store, fetchImpl = globalThis.fetch, now = Date.now(), force = false }) {
  const cached = store.getFeedCache(show.feedUrl);
  if (cached && !force && now - cached.at < CACHE_TTL_MS) {
    return { episodes: normalize(show, cached.data), stale: false };
  }
  try {
    const data = await requestFeed(show.feedUrl, fetchImpl);
    store.setFeedCache(show.feedUrl, data, now);
    return { episodes: normalize(show, data), stale: false };
  } catch (err) {
    if (cached) return { episodes: normalize(show, cached.data), stale: true };
    throw err;
  }
}

// 同时最多请求 4 个节目。刷新失败的节目进 failed；有旧缓存时仍然返回旧的单集。
export async function loadShows(shows, options) {
  const results = new Array(shows.length);
  let next = 0;
  async function worker() {
    while (next < shows.length) {
      const index = next;
      next += 1;
      try {
        results[index] = await loadShow(shows[index], options);
      } catch {
        results[index] = { episodes: [], stale: true };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, shows.length) }, worker));
  return {
    episodes: results.flatMap((result) => result.episodes),
    failed: shows.filter((_, index) => results[index].stale),
  };
}

export function buildToday(episodes, { now, days }) {
  const today = dateKey(now);
  const yesterday = dateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));
  const cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1)).getTime();

  const groups = new Map();
  for (const episode of episodes) {
    const time = episode.pubDate ? Date.parse(episode.pubDate) : NaN;
    if (Number.isNaN(time) || time < cutoff) continue;
    // 发布时间在未来的（时区或节目方时钟误差）算作今天
    const key = time > now.getTime() ? today : dateKey(new Date(time));
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ episode, time });
  }

  return [...groups.keys()]
    .sort()
    .reverse()
    .map((key) => {
      const [, month, day] = key.split('-').map(Number);
      return {
        key,
        label: key === today ? '今天' : key === yesterday ? '昨天' : `${month}月${day}日`,
        episodes: groups
          .get(key)
          .sort((a, b) => b.time - a.time)
          .map((entry) => entry.episode),
      };
    });
}
