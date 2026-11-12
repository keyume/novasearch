import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../../listen/js/store.js';
import { CATALOG } from '../../listen/js/catalog.js';

// 假的 localStorage；limit 用来模拟容量上限（按单个值的长度）。
function fakeStorage(initial = {}, { limit = Infinity } = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => {
      if (String(v).length > limit) throw new Error('QuotaExceededError');
      map.set(k, String(v));
    },
    removeItem: (k) => map.delete(k),
  };
}

const ep = (id, extra = {}) => ({
  id,
  showId: 's',
  showTitle: 'Show',
  title: `Episode ${id}`,
  audioUrl: `https://cdn.test/${id}.mp3`,
  pubDate: '2026-11-12T10:00:00.000Z',
  duration: 600,
  image: null,
  link: null,
  transcriptUrl: null,
  descriptionHtml: '<p>notes</p>',
  ...extra,
});

const defaultIds = CATALOG.filter((s) => s.default).map((s) => s.id).sort();

test('首次启动订阅默认节目', () => {
  const store = createStore(fakeStorage());
  assert.deepEqual(Object.keys(store.state.subs).sort(), defaultIds);
  assert.deepEqual(store.state.settings, { speed: 1, autoNext: true, todayDays: 3 });
  assert.deepEqual(store.shows().map((s) => s.id).sort(), defaultIds);
});

test('保存后重新加载得到相同数据', () => {
  const storage = fakeStorage();
  const a = createStore(storage);
  a.setSubscribed(defaultIds[0], false);
  a.setSetting('speed', 1.5);
  a.toggleFavorite(ep('e1'));
  const b = createStore(storage);
  assert.equal(b.state.subs[defaultIds[0]], undefined);
  assert.equal(b.state.settings.speed, 1.5);
  assert.equal(b.state.favorites.e1.title, 'Episode e1');
});

test('用户取消全部订阅后不会被重新订阅默认节目', () => {
  const storage = fakeStorage();
  const a = createStore(storage);
  for (const id of defaultIds) a.setSubscribed(id, false);
  assert.deepEqual(createStore(storage).shows(), []);
});

test('损坏的 JSON 回到默认状态', () => {
  const store = createStore(fakeStorage({ 'listen.v1': '{oops', 'listen.cache.v1': 'nope' }));
  assert.deepEqual(Object.keys(store.state.subs).sort(), defaultIds);
  assert.equal(store.getFeedCache('https://a.test/'), null);
});

test('旧结构或类型不对的字段被默认值替换，其余保留', () => {
  const stored = JSON.stringify({
    subs: [],
    custom: 'x',
    progress: 'x',
    favorites: null,
    recent: {},
    stats: { '2026-11-11': 120, bad: 'x' },
    settings: { speed: 'fast', autoNext: 'yes', todayDays: 99 },
  });
  const store = createStore(fakeStorage({ 'listen.v1': stored }));
  assert.deepEqual(Object.keys(store.state.subs).sort(), defaultIds);
  assert.deepEqual(store.state.custom, []);
  assert.deepEqual(store.state.progress, {});
  assert.deepEqual(store.state.favorites, {});
  assert.deepEqual(store.state.recent, []);
  assert.deepEqual(store.state.stats, { '2026-11-11': 120 });
  assert.deepEqual(store.state.settings, { speed: 1, autoNext: true, todayDays: 3 });
});

test('存储内容不是对象时回到默认状态', () => {
  for (const raw of ['null', '[]', '42', '"x"']) {
    const store = createStore(fakeStorage({ 'listen.v1': raw }));
    assert.deepEqual(Object.keys(store.state.subs).sort(), defaultIds, raw);
  }
});

test('storage 抛异常时不崩溃', () => {
  const broken = {
    getItem() {
      throw new Error('SecurityError');
    },
    setItem() {
      throw new Error('SecurityError');
    },
    removeItem() {
      throw new Error('SecurityError');
    },
  };
  const store = createStore(broken);
  store.setProgress('e1', { pos: 10, dur: 100, done: false });
  store.pushRecent(ep('e1'));
  store.addListened('2026-11-12', 30);
  store.setFeedCache('https://a.test/', { episodes: [] }, 1000);
  assert.equal(store.toggleFavorite(ep('e1')), true);
  assert.equal(store.state.progress.e1.pos, 10);
  assert.equal(store.state.stats['2026-11-12'], 30);
  assert.equal(store.getFeedCache('https://a.test/').at, 1000);
});

test('没有 storage 时也能工作', () => {
  const store = createStore(null);
  store.setSetting('autoNext', false);
  assert.equal(store.state.settings.autoNext, false);
});

test('setProgress 记录时间；超过 500 条时按 at 淘汰最旧的', () => {
  let clock = 0;
  const store = createStore(fakeStorage(), { now: () => (clock += 1) });
  for (let i = 0; i < 505; i += 1) store.setProgress(`e${i}`, { pos: i, dur: 1000, done: false });
  const ids = Object.keys(store.state.progress);
  assert.equal(ids.length, 500);
  assert.equal(store.state.progress.e0, undefined);
  assert.equal(store.state.progress.e4, undefined);
  assert.deepEqual(store.state.progress.e5, { pos: 5, dur: 1000, done: false, at: 6 });
  assert.ok(store.state.progress.e504);
});

test('recent 去重、最新在前、最多 30 条', () => {
  const store = createStore(fakeStorage());
  for (let i = 0; i < 35; i += 1) store.pushRecent(ep(`e${i}`));
  store.pushRecent(ep('e10'));
  assert.equal(store.state.recent.length, 30);
  assert.equal(store.state.recent[0].id, 'e10');
  assert.equal(store.state.recent.filter((e) => e.id === 'e10').length, 1);
  assert.equal(store.state.recent[1].id, 'e34');
});

test('toggleFavorite 往返', () => {
  const store = createStore(fakeStorage());
  assert.equal(store.toggleFavorite(ep('e1')), true);
  assert.equal(store.state.favorites.e1.audioUrl, 'https://cdn.test/e1.mp3');
  assert.equal(store.toggleFavorite(ep('e1')), false);
  assert.equal(store.state.favorites.e1, undefined);
});

test('addListened 累加并忽略无效值', () => {
  const store = createStore(fakeStorage());
  store.addListened('2026-11-12', 10);
  store.addListened('2026-11-12', 5.5);
  store.addListened('2026-11-12', NaN);
  store.addListened('2026-11-12', -3);
  assert.equal(store.state.stats['2026-11-12'], 15.5);
});

test('setSubscribed 与 shows：内置在前、自定义在后', () => {
  const store = createStore(fakeStorage());
  const extra = CATALOG.find((s) => !s.default);
  store.setSubscribed(extra.id, true);
  const custom = store.addCustom({ title: 'Mine', feedUrl: 'https://mine.test/rss' });
  const shows = store.shows();
  assert.ok(shows.some((s) => s.id === extra.id));
  assert.equal(shows[shows.length - 1].id, custom.id);
  assert.equal(shows[shows.length - 1].custom, true);
  store.setSubscribed('no-such-show', true);
  assert.equal(store.shows().length, shows.length);
});

test('addCustom 规范化地址', () => {
  const store = createStore(fakeStorage());
  assert.equal(store.addCustom({ title: 'A', feedUrl: '  https://a.test/rss  ' }).feedUrl, 'https://a.test/rss');
  assert.equal(store.addCustom({ title: 'B', feedUrl: 'feed://b.test/rss' }).feedUrl, 'https://b.test/rss');
  assert.equal(store.addCustom({ title: 'C', feedUrl: 'feed:https://c.test/rss' }).feedUrl, 'https://c.test/rss');
  assert.equal(store.addCustom({ title: 'D', feedUrl: 'd.test/rss' }).feedUrl, 'https://d.test/rss');
  assert.equal(store.addCustom({ title: 'E', feedUrl: 'http://e.test/rss' }).feedUrl, 'http://e.test/rss');
});

test('addCustom：重复地址不重复添加；标题为空时用主机名', () => {
  const store = createStore(fakeStorage());
  const first = store.addCustom({ title: '', feedUrl: 'https://a.test/rss' });
  const again = store.addCustom({ title: 'Other', feedUrl: 'feed://a.test/rss' });
  assert.equal(first.title, 'a.test');
  assert.equal(again.id, first.id);
  assert.equal(store.state.custom.length, 1);
});

test('addCustom：地址属于内置节目时改为订阅该节目', () => {
  const store = createStore(fakeStorage());
  const builtin = CATALOG.find((s) => !s.default);
  const result = store.addCustom({ title: 'x', feedUrl: builtin.feedUrl });
  assert.equal(result.id, builtin.id);
  assert.equal(store.state.custom.length, 0);
  assert.equal(store.state.subs[builtin.id], true);
});

test('addCustom：不合法的地址抛错', () => {
  const store = createStore(fakeStorage());
  for (const bad of ['', '   ', 'javascript:alert(1)', 'ftp://a.test/x', 'http://']) {
    assert.throws(() => store.addCustom({ title: 'x', feedUrl: bad }), /地址/, bad);
  }
  assert.equal(store.state.custom.length, 0);
});

test('removeCustom', () => {
  const store = createStore(fakeStorage());
  const show = store.addCustom({ title: 'A', feedUrl: 'https://a.test/rss' });
  store.removeCustom(show.id);
  assert.deepEqual(store.state.custom, []);
});

test('setSetting 只接受合法值', () => {
  const store = createStore(fakeStorage());
  store.setSetting('speed', 1.25);
  store.setSetting('todayDays', 7);
  store.setSetting('autoNext', false);
  store.setSetting('speed', 'fast');
  store.setSetting('todayDays', 5);
  store.setSetting('unknown', 1);
  assert.deepEqual(store.state.settings, { speed: 1.25, autoNext: false, todayDays: 7 });
});

test('on：变更时通知主题，返回的函数可取消订阅', () => {
  const store = createStore(fakeStorage());
  const topics = [];
  const off = store.on((topic) => topics.push(topic));
  store.setSetting('speed', 2);
  store.toggleFavorite(ep('e1'));
  store.setProgress('e1', { pos: 1, dur: 2, done: false });
  off();
  store.setSetting('speed', 1);
  assert.deepEqual(topics, ['settings', 'favorites', 'progress']);
});

test('节目缓存：读写与持久化', () => {
  const storage = fakeStorage();
  const a = createStore(storage);
  a.setFeedCache('https://a.test/', { title: 'A', episodes: [] }, 5000);
  assert.deepEqual(a.getFeedCache('https://a.test/'), { at: 5000, data: { title: 'A', episodes: [] } });
  assert.equal(a.getFeedCache('https://other.test/'), null);
  assert.deepEqual(createStore(storage).getFeedCache('https://a.test/').data.title, 'A');
});

test('缓存写入超出容量时，持久化的副本丢弃最旧的条目', () => {
  const storage = fakeStorage({}, { limit: 400 });
  const store = createStore(storage);
  const data = (n) => ({ title: n, pad: 'x'.repeat(120), episodes: [] });
  store.setFeedCache('https://1.test/', data('one'), 1000);
  store.setFeedCache('https://2.test/', data('two'), 2000);
  assert.equal(Object.keys(JSON.parse(storage.map.get('listen.cache.v1'))).length, 2);
  store.setFeedCache('https://3.test/', data('three'), 3000);
  const persisted = JSON.parse(storage.map.get('listen.cache.v1'));
  assert.deepEqual(Object.keys(persisted).sort(), ['https://2.test/', 'https://3.test/']);
  // 内存里的副本不受影响，本次会话仍然可用
  assert.equal(store.getFeedCache('https://1.test/').data.title, 'one');
  assert.equal(store.getFeedCache('https://3.test/').data.title, 'three');
});

test('reload：重新读取其他标签页写入的数据，之后的保存不会覆盖它', () => {
  const storage = fakeStorage();
  const a = createStore(storage);
  const b = createStore(storage);
  const topics = [];
  a.on((topic) => topics.push(topic));
  b.toggleFavorite(ep('e1'));
  b.addListened('2026-11-12', 90);
  const stateBefore = a.state;
  a.reload();
  assert.equal(a.state, stateBefore);
  assert.equal(a.state.favorites.e1.title, 'Episode e1');
  assert.ok(topics.includes('favorites') && topics.includes('stats'));
  a.setSetting('speed', 2);
  const fresh = createStore(storage);
  assert.equal(fresh.state.favorites.e1.title, 'Episode e1');
  assert.equal(fresh.state.stats['2026-11-12'], 90);
  assert.equal(fresh.state.settings.speed, 2);
});

test('节目缓存：结构不对的条目在加载时被丢弃', () => {
  const stored = JSON.stringify({
    'https://old.test/': { at: 1, data: { title: 'no episodes field' } },
    'https://bad.test/': { at: 1, data: { episodes: 'x' } },
    'https://ok.test/': { at: 1, data: { title: 'ok', episodes: [] } },
  });
  const store = createStore(fakeStorage({ 'listen.cache.v1': stored }));
  assert.equal(store.getFeedCache('https://old.test/'), null);
  assert.equal(store.getFeedCache('https://bad.test/'), null);
  assert.equal(store.getFeedCache('https://ok.test/').data.title, 'ok');
});
