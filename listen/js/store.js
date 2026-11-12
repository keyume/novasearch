// 本地数据的唯一读写入口。所有数据在 localStorage 里；
// 读写失败（隐私模式、容量满）时照常工作，只是不保存。
import { CATALOG } from './catalog.js';
import { hashString } from './hash.js';

const KEY = 'listen.v1';
const CACHE_KEY = 'listen.cache.v1';
const MAX_PROGRESS = 500;
const MAX_RECENT = 30;
const TODAY_DAYS = [3, 7];
const EPISODE_FIELDS = [
  'id', 'showId', 'showTitle', 'title', 'audioUrl', 'pubDate', 'duration',
  'image', 'link', 'transcriptUrl', 'descriptionHtml',
];

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isEpisode = (value) => isObject(value) && typeof value.id === 'string' && typeof value.audioUrl === 'string';

function defaultStorage() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

function defaultSubs() {
  return Object.fromEntries(CATALOG.filter((show) => show.default).map((show) => [show.id, true]));
}

function defaultSettings() {
  return { speed: 1, autoNext: true, todayDays: 3 };
}

// 只保留界面与播放需要的字段，避免把无关数据写进存储。
function snapshot(episode) {
  return Object.fromEntries(EPISODE_FIELDS.map((field) => [field, episode[field] ?? null]));
}

// 把读到的任意内容整理成合法的状态；不合法的字段用默认值。
function sanitize(raw) {
  const source = isObject(raw) ? raw : {};
  const settings = isObject(source.settings) ? source.settings : {};
  const defaults = defaultSettings();
  return {
    subs: isObject(source.subs)
      ? Object.fromEntries(Object.entries(source.subs).filter(([, on]) => on === true))
      : defaultSubs(),
    custom: Array.isArray(source.custom)
      ? source.custom.filter(
          (show) =>
            isObject(show) &&
            typeof show.id === 'string' &&
            typeof show.title === 'string' &&
            typeof show.feedUrl === 'string'
        )
      : [],
    progress: isObject(source.progress)
      ? Object.fromEntries(
          Object.entries(source.progress).filter(([, p]) => isObject(p) && Number.isFinite(p.pos))
        )
      : {},
    favorites: isObject(source.favorites)
      ? Object.fromEntries(Object.entries(source.favorites).filter(([, episode]) => isEpisode(episode)))
      : {},
    recent: Array.isArray(source.recent) ? source.recent.filter(isEpisode).slice(0, MAX_RECENT) : [],
    stats: isObject(source.stats)
      ? Object.fromEntries(
          Object.entries(source.stats).filter(
            ([key, sec]) => /^\d{4}-\d{2}-\d{2}$/.test(key) && Number.isFinite(sec) && sec >= 0
          )
        )
      : {},
    settings: {
      speed:
        Number.isFinite(settings.speed) && settings.speed >= 0.25 && settings.speed <= 4
          ? settings.speed
          : defaults.speed,
      autoNext: typeof settings.autoNext === 'boolean' ? settings.autoNext : defaults.autoNext,
      todayDays: TODAY_DAYS.includes(settings.todayDays) ? settings.todayDays : defaults.todayDays,
    },
  };
}

// 用户粘贴的地址：去空白、feed:// 换成 https://、缺协议时补 https://。
export function normalizeFeedUrl(input) {
  let value = String(input || '').trim();
  if (!value) throw new Error('请输入节目的 RSS 地址');
  value = value.replace(/^feed:(?=https?:\/\/)/i, '').replace(/^feed:\/\//i, 'https://');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = `https://${value}`;
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('地址格式不正确');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('地址必须以 http 或 https 开头');
  return url;
}

export function createStore(storage = defaultStorage(), { now = Date.now } = {}) {
  const listeners = new Set();

  function read(key) {
    try {
      const raw = storage ? storage.getItem(key) : null;
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function write(key, value) {
    if (!storage) return false;
    try {
      storage.setItem(key, JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  }

  const state = sanitize(read(KEY));
  const cached = read(CACHE_KEY);
  const cache = isObject(cached)
    ? Object.fromEntries(
        Object.entries(cached).filter(([, entry]) => isObject(entry) && Number.isFinite(entry.at) && isObject(entry.data))
      )
    : {};

  function save(topic) {
    if (!write(KEY, state) && storage) {
      // 多半是容量满了：节目缓存可以重新获取，先让给用户数据。
      try {
        storage.removeItem(CACHE_KEY);
      } catch {
        // 存储不可用，放弃保存
      }
      write(KEY, state);
    }
    for (const listener of listeners) listener(topic);
  }

  // 写不下时从最旧的条目开始丢弃；内存里的副本不动，本次会话仍然可用。
  function persistCache() {
    const copy = { ...cache };
    while (!write(CACHE_KEY, copy)) {
      const keys = Object.keys(copy);
      if (!storage || keys.length <= 1) return;
      const oldest = keys.reduce((a, b) => (copy[a].at <= copy[b].at ? a : b));
      delete copy[oldest];
    }
  }

  return {
    state,

    save,

    on(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    shows() {
      const builtin = CATALOG.filter((show) => state.subs[show.id]);
      const custom = state.custom.map((show) => ({ ...show, category: '自定义', custom: true }));
      return [...builtin, ...custom];
    },

    setSubscribed(id, on) {
      if (!CATALOG.some((show) => show.id === id)) return;
      if (on) state.subs[id] = true;
      else delete state.subs[id];
      save('subs');
    },

    addCustom({ title, feedUrl }) {
      const url = normalizeFeedUrl(feedUrl);
      const builtin = CATALOG.find((show) => show.feedUrl === url.href);
      if (builtin) {
        state.subs[builtin.id] = true;
        save('subs');
        return builtin;
      }
      const existing = state.custom.find((show) => show.feedUrl === url.href);
      if (existing) return existing;
      const show = {
        id: `c-${hashString(url.href)}`,
        title: String(title || '').trim() || url.hostname,
        feedUrl: url.href,
      };
      state.custom.push(show);
      save('subs');
      return show;
    },

    removeCustom(id) {
      state.custom = state.custom.filter((show) => show.id !== id);
      save('subs');
    },

    setProgress(id, { pos, dur, done }) {
      state.progress[id] = { pos, dur, done: Boolean(done), at: now() };
      const ids = Object.keys(state.progress);
      if (ids.length > MAX_PROGRESS) {
        ids
          .sort((a, b) => state.progress[a].at - state.progress[b].at)
          .slice(0, ids.length - MAX_PROGRESS)
          .forEach((old) => delete state.progress[old]);
      }
      save('progress');
    },

    toggleFavorite(episode) {
      const favorited = !state.favorites[episode.id];
      if (favorited) state.favorites[episode.id] = { ...snapshot(episode), favoritedAt: now() };
      else delete state.favorites[episode.id];
      save('favorites');
      return favorited;
    },

    pushRecent(episode) {
      state.recent = [snapshot(episode), ...state.recent.filter((e) => e.id !== episode.id)].slice(0, MAX_RECENT);
      save('recent');
    },

    addListened(dateKey, seconds) {
      if (!Number.isFinite(seconds) || seconds <= 0) return;
      state.stats[dateKey] = (state.stats[dateKey] || 0) + seconds;
      save('stats');
    },

    setSetting(key, value) {
      const next = sanitize({ settings: { ...state.settings, [key]: value } }).settings;
      if (!(key in next) || next[key] !== value) return;
      state.settings[key] = value;
      save('settings');
    },

    getFeedCache(feedUrl) {
      return cache[feedUrl] || null;
    },

    setFeedCache(feedUrl, data, at) {
      cache[feedUrl] = { at, data };
      persistCache();
    },
  };
}
