import test from 'node:test';
import assert from 'node:assert/strict';
import { episodeId, dateKey, loadShow, loadShows, buildToday } from '../../listen/js/feeds.js';
import { createStore } from '../../listen/js/store.js';

const show = (id, extra = {}) => ({ id, title: `Show ${id}`, feedUrl: `https://${id}.test/rss`, ...extra });
const raw = (n, extra = {}) => ({
  guid: `g${n}`,
  title: `Ep ${n}`,
  pubDate: '2026-11-12T10:00:00.000Z',
  audioUrl: `https://cdn.test/${n}.mp3`,
  duration: 600,
  descriptionHtml: '',
  link: null,
  transcriptUrl: null,
  ...extra,
});
const feedData = (...episodes) => ({ title: 'Feed Title', image: 'https://img.test/c.jpg', link: null, description: '', episodes });

// 假的 fetch：按节目地址返回数据或失败，并记录调用。
function fakeFetch(routes) {
  const calls = [];
  let active = 0;
  let peak = 0;
  const impl = async (url) => {
    calls.push(url);
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    const feedUrl = new URL(url, 'http://localhost').searchParams.get('url');
    const route = routes[feedUrl];
    if (route === undefined) return { ok: false, status: 502, json: async () => ({ error: '无法获取节目源' }) };
    if (route instanceof Error) throw route;
    return { ok: true, status: 200, json: async () => route };
  };
  return { impl, calls, peak: () => peak };
}

test('episodeId：同一输入稳定', () => {
  assert.equal(episodeId('https://a.test/rss', raw(1)), episodeId('https://a.test/rss', raw(1)));
  assert.match(episodeId('https://a.test/rss', raw(1)), /^[0-9a-z]+$/);
});

test('episodeId：不同节目相同 guid 不同', () => {
  assert.notEqual(episodeId('https://a.test/rss', raw(1)), episodeId('https://b.test/rss', raw(1)));
});

test('episodeId：无 guid 时用 audioUrl 区分', () => {
  const a = episodeId('https://a.test/rss', raw(1, { guid: null }));
  const b = episodeId('https://a.test/rss', raw(2, { guid: null }));
  assert.notEqual(a, b);
  assert.equal(a, episodeId('https://a.test/rss', raw(1, { guid: null, title: 'renamed' })));
});

test('dateKey 用本地日期', () => {
  assert.equal(dateKey(new Date(2026, 10, 12, 23, 59)), '2026-11-12');
  assert.equal(dateKey(new Date(2026, 0, 5, 0, 0)), '2026-01-05');
});

const NOW = new Date(2026, 10, 12, 15, 0, 0); // 本地时间 11 月 12 日 15:00
const at = (daysAgo, hour = 9) => new Date(2026, 10, 12 - daysAgo, hour, 0, 0).toISOString();
const client = (id, pubDate) => ({ id, title: id, pubDate });

test('buildToday：分组标签为 今天 / 昨天 / M月D日，组内倒序', () => {
  const groups = buildToday(
    [client('a', at(0, 8)), client('b', at(1)), client('c', at(0, 14)), client('d', at(2))],
    { now: NOW, days: 3 }
  );
  assert.deepEqual(groups.map((g) => g.label), ['今天', '昨天', '11月10日']);
  assert.deepEqual(groups.map((g) => g.key), ['2026-11-12', '2026-11-11', '2026-11-10']);
  assert.deepEqual(groups[0].episodes.map((e) => e.id), ['c', 'a']);
});

test('buildToday：超出 days 的与 pubDate 为 null 的不出现', () => {
  const episodes = [client('a', at(0)), client('old', at(3)), client('nodate', null), client('bad', 'garbage')];
  const three = buildToday(episodes, { now: NOW, days: 3 });
  assert.deepEqual(three.flatMap((g) => g.episodes.map((e) => e.id)), ['a']);
  const seven = buildToday(episodes, { now: NOW, days: 7 });
  assert.deepEqual(seven.flatMap((g) => g.episodes.map((e) => e.id)), ['a', 'old']);
});

test('buildToday：days 按自然日计算，包含起始日凌晨', () => {
  const groups = buildToday([client('edge', new Date(2026, 10, 10, 0, 0, 1).toISOString())], { now: NOW, days: 3 });
  assert.equal(groups.length, 1);
  assert.equal(buildToday([client('out', new Date(2026, 10, 9, 23, 59, 59).toISOString())], { now: NOW, days: 3 }).length, 0);
});

test('buildToday：未来时间的单集归到今天', () => {
  const groups = buildToday([client('future', at(-2))], { now: NOW, days: 3 });
  assert.deepEqual(groups.map((g) => g.label), ['今天']);
});

test('buildToday：空输入', () => {
  assert.deepEqual(buildToday([], { now: NOW, days: 3 }), []);
});

test('loadShow：请求 /api/feed 并补全单集字段', async () => {
  const store = createStore(null);
  const { impl, calls } = fakeFetch({ 'https://a.test/rss': feedData(raw(1), raw(2)) });
  const out = await loadShow(show('a'), { store, fetchImpl: impl, now: 1000 });
  assert.equal(calls[0], `/api/feed?url=${encodeURIComponent('https://a.test/rss')}`);
  assert.equal(out.stale, false);
  assert.equal(out.episodes.length, 2);
  const first = out.episodes[0];
  assert.equal(first.id, episodeId('https://a.test/rss', raw(1)));
  assert.equal(first.showId, 'a');
  assert.equal(first.showTitle, 'Show a');
  assert.equal(first.image, 'https://img.test/c.jpg');
  assert.equal(first.audioUrl, 'https://cdn.test/1.mp3');
});

test('loadShow：30 分钟内用缓存不请求；过期后请求并更新；force 强制请求', async () => {
  const store = createStore(null);
  const { impl, calls } = fakeFetch({ 'https://a.test/rss': feedData(raw(1)) });
  const opts = { store, fetchImpl: impl };
  await loadShow(show('a'), { ...opts, now: 0 });
  await loadShow(show('a'), { ...opts, now: 29 * 60 * 1000 });
  assert.equal(calls.length, 1);
  await loadShow(show('a'), { ...opts, now: 31 * 60 * 1000 });
  assert.equal(calls.length, 2);
  assert.equal(store.getFeedCache('https://a.test/rss').at, 31 * 60 * 1000);
  await loadShow(show('a'), { ...opts, now: 32 * 60 * 1000, force: true });
  assert.equal(calls.length, 3);
});

test('loadShow：请求失败但有缓存 → 返回缓存且 stale 为 true', async () => {
  const store = createStore(null);
  store.setFeedCache('https://a.test/rss', feedData(raw(1)), 0);
  const { impl } = fakeFetch({});
  const out = await loadShow(show('a'), { store, fetchImpl: impl, now: 99 * 60 * 1000 });
  assert.equal(out.stale, true);
  assert.equal(out.episodes.length, 1);
});

test('loadShow：请求失败且无缓存 → 抛出带服务端说明的错误', async () => {
  const { impl } = fakeFetch({});
  await assert.rejects(loadShow(show('a'), { store: createStore(null), fetchImpl: impl, now: 0 }), /无法获取节目源/);
});

test('loadShow：网络异常也视为失败', async () => {
  const { impl } = fakeFetch({ 'https://a.test/rss': new TypeError('Failed to fetch') });
  await assert.rejects(loadShow(show('a'), { store: createStore(null), fetchImpl: impl, now: 0 }));
});

test('loadShow：返回的数据结构不对视为失败', async () => {
  const { impl } = fakeFetch({ 'https://a.test/rss': { nope: true } });
  await assert.rejects(loadShow(show('a'), { store: createStore(null), fetchImpl: impl, now: 0 }));
});

test('loadShows：一个失败不影响其他，失败的进 failed', async () => {
  const { impl } = fakeFetch({
    'https://a.test/rss': feedData(raw(1)),
    'https://c.test/rss': feedData(raw(1), raw(2)),
  });
  const out = await loadShows([show('a'), show('b'), show('c')], { store: createStore(null), fetchImpl: impl, now: 0 });
  assert.equal(out.episodes.length, 3);
  assert.deepEqual(out.failed.map((s) => s.id), ['b']);
});

test('loadShows：刷新失败但有缓存的节目同时出现在 episodes 与 failed', async () => {
  const store = createStore(null);
  store.setFeedCache('https://a.test/rss', feedData(raw(1)), 0);
  const { impl } = fakeFetch({});
  const out = await loadShows([show('a')], { store, fetchImpl: impl, now: 99 * 60 * 1000 });
  assert.equal(out.episodes.length, 1);
  assert.deepEqual(out.failed.map((s) => s.id), ['a']);
});

test('loadShows：同时进行的请求不超过 4 个', async () => {
  const routes = {};
  const shows = [];
  for (let i = 0; i < 10; i += 1) {
    shows.push(show(`s${i}`));
    routes[`https://s${i}.test/rss`] = feedData(raw(1));
  }
  const fake = fakeFetch(routes);
  const out = await loadShows(shows, { store: createStore(null), fetchImpl: fake.impl, now: 0 });
  assert.equal(out.episodes.length, 10);
  assert.equal(fake.calls.length, 10);
  assert.ok(fake.peak() <= 4, `peak ${fake.peak()}`);
  assert.ok(fake.peak() >= 2);
});

test('loadShows：空列表', async () => {
  assert.deepEqual(await loadShows([], { store: createStore(null), fetchImpl: fakeFetch({}).impl, now: 0 }), {
    episodes: [],
    failed: [],
  });
});

test('cachedEpisodes：只读缓存、不发请求，并报告缺缓存或已过期的节目', async () => {
  const { cachedEpisodes } = await import('../../listen/js/feeds.js');
  const store = createStore(null);
  store.setFeedCache('https://a.test/rss', feedData(raw(1), raw(2)), 0);
  store.setFeedCache('https://b.test/rss', feedData(raw(3)), 50 * 60 * 1000);
  const out = cachedEpisodes([show('a'), show('b'), show('c')], { store, now: 60 * 60 * 1000 });
  assert.equal(out.episodes.length, 3);
  assert.equal(out.episodes[0].showId, 'a');
  assert.equal(out.episodes[2].id, episodeId('https://b.test/rss', raw(3)));
  assert.equal(out.fresh, false);
  assert.equal(cachedEpisodes([show('b')], { store, now: 60 * 60 * 1000 }).fresh, true);
  assert.deepEqual(cachedEpisodes([], { store, now: 0 }), { episodes: [], fresh: true });
});
