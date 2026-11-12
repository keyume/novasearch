import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlayer, formatTime, SPEEDS } from '../../listen/js/player.js';
import { createStore } from '../../listen/js/store.js';
import { dateKey } from '../../listen/js/feeds.js';

class FakeAudio extends EventTarget {
  constructor() {
    super();
    this.currentTime = 0;
    this.duration = NaN;
    this.playbackRate = 1;
    this.defaultPlaybackRate = 1;
    this.src = '';
    this.paused = true;
    this.playCalls = 0;
    this.playResult = () => Promise.resolve();
  }
  play() {
    this.playCalls += 1;
    this.paused = false; // 浏览器里 paused 是同步变化的，事件稍后才派发
    const result = this.playResult();
    result.then(
      () => this.fire('play'),
      () => {
        this.paused = true;
      }
    );
    return result;
  }
  pause() {
    if (this.paused) return;
    this.paused = true;
    this.fire('pause');
  }
  fire(type) {
    this.dispatchEvent(new Event(type));
  }
  loaded(duration) {
    this.duration = duration;
    this.fire('loadedmetadata');
  }
  tick(time) {
    this.currentTime = time;
    this.fire('timeupdate');
  }
}

const BASE = new Date(2026, 10, 12, 12, 0, 0).getTime();
const TODAY = dateKey(new Date(BASE));

const ep = (n, extra = {}) => ({
  id: `e${n}`,
  showId: 's',
  showTitle: 'Show',
  title: `Episode ${n}`,
  audioUrl: `https://cdn.test/${n}.mp3`,
  pubDate: null,
  duration: 600,
  image: 'https://img.test/c.jpg',
  link: null,
  transcriptUrl: null,
  descriptionHtml: '',
  ...extra,
});

function setup({ mediaSession = null } = {}) {
  const clock = { t: BASE };
  const store = createStore(null, { now: () => clock.t });
  const audio = new FakeAudio();
  const player = createPlayer({ audio, store, now: () => clock.t, mediaSession });
  const queue = [ep(1), ep(2), ep(3)];
  // 等 play() 的 Promise 落定
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  return { clock, store, audio, player, queue, settle };
}

test('load 设置 src、应用已保存的倍速、记入最近在听并开始播放', async () => {
  const { store, audio, player, queue, settle } = setup();
  store.setSetting('speed', 1.5);
  const p2 = createPlayer({ audio, store });
  p2.load(queue, 1);
  await settle();
  assert.equal(audio.src, 'https://cdn.test/2.mp3');
  assert.equal(audio.playbackRate, 1.5);
  assert.equal(p2.state.speed, 1.5);
  assert.equal(p2.state.episode.id, 'e2');
  assert.equal(p2.state.index, 1);
  assert.equal(p2.state.playing, true);
  assert.equal(store.state.recent[0].id, 'e2');
  assert.ok(player);
});

test('load 的 autoplay 为 false 时不播放', async () => {
  const { audio, player, queue, settle } = setup();
  player.load(queue, 0, { autoplay: false });
  await settle();
  assert.equal(audio.playCalls, 0);
  assert.equal(player.state.playing, false);
  assert.equal(player.state.episode.id, 'e1');
});

test('从保存的位置继续：元数据加载后才跳转', async () => {
  const { store, audio, player, queue } = setup();
  store.setProgress('e1', { pos: 123, dur: 600, done: false });
  player.load(queue, 0, { autoplay: false });
  assert.equal(player.state.pos, 123);
  assert.equal(audio.currentTime, 0);
  audio.loaded(600);
  assert.equal(audio.currentTime, 123);
  assert.equal(player.state.dur, 600);
});

test('已听完的单集从头开始而不是从末尾继续', () => {
  const { store, audio, player, queue } = setup();
  store.setProgress('e1', { pos: 598, dur: 600, done: true });
  player.load(queue, 0, { autoplay: false });
  audio.loaded(600);
  assert.equal(player.state.pos, 0);
  assert.equal(audio.currentTime, 0);
});

test('标记已听但还没到结尾的单集仍从保存的位置继续', () => {
  const { store, audio, player, queue } = setup();
  store.setProgress('e1', { pos: 575, dur: 600, done: true });
  player.load(queue, 0, { autoplay: false });
  audio.loaded(600);
  assert.equal(audio.currentTime, 575);
});

test('元数据加载后重新应用倍速', () => {
  const { audio, player, queue } = setup();
  player.setSpeed(2);
  player.load(queue, 0, { autoplay: false });
  audio.playbackRate = 1; // 浏览器在换 src 时会重置
  audio.loaded(600);
  assert.equal(audio.playbackRate, 2);
});

test('skip：-10 不小于 0；+15 不超过时长', () => {
  const { audio, player, queue } = setup();
  player.load(queue, 0, { autoplay: false });
  audio.loaded(600);
  audio.tick(4);
  player.skip(-10);
  assert.equal(audio.currentTime, 0);
  audio.tick(100);
  player.skip(15);
  assert.equal(audio.currentTime, 115);
  audio.tick(595);
  player.skip(15);
  assert.equal(audio.currentTime, 600);
  assert.equal(player.state.pos, 600);
});

test('seek 忽略非法值', () => {
  const { audio, player, queue } = setup();
  player.load(queue, 0, { autoplay: false });
  audio.loaded(600);
  player.seek(50);
  player.seek(NaN);
  player.seek(undefined);
  assert.equal(audio.currentTime, 50);
  player.seek(-5);
  assert.equal(audio.currentTime, 0);
  player.seek(9999);
  assert.equal(audio.currentTime, 600);
});

test('cycleSpeed 按档位循环并写入设置', () => {
  const { store, audio, player } = setup();
  assert.deepEqual(SPEEDS, [0.5, 0.75, 1, 1.25, 1.5, 2]);
  assert.equal(player.cycleSpeed(), 1.25);
  assert.equal(audio.playbackRate, 1.25);
  assert.equal(store.state.settings.speed, 1.25);
  assert.equal(player.cycleSpeed(), 1.5);
  assert.equal(player.cycleSpeed(), 2);
  assert.equal(player.cycleSpeed(), 0.5);
});

test('setSpeed 拒绝档位之外的值', () => {
  const { audio, player } = setup();
  player.setSpeed(3);
  assert.equal(player.state.speed, 1);
  assert.equal(audio.playbackRate, 1);
});

test('toggleAB：a → ab → off', () => {
  const { audio, player, queue } = setup();
  player.load(queue, 0, { autoplay: false });
  audio.loaded(600);
  audio.tick(10);
  assert.equal(player.toggleAB(), 'a');
  assert.deepEqual(player.state.ab, { a: 10, b: null });
  audio.tick(15);
  assert.equal(player.toggleAB(), 'ab');
  assert.deepEqual(player.state.ab, { a: 10, b: 15 });
  assert.equal(audio.currentTime, 10);
  assert.equal(player.toggleAB(), 'off');
  assert.equal(player.state.ab, null);
});

test('toggleAB：B 距 A 不足 1 秒时不设置 B，状态保持 a', () => {
  const { audio, player, queue } = setup();
  player.load(queue, 0, { autoplay: false });
  audio.loaded(600);
  audio.tick(10);
  player.toggleAB();
  audio.tick(10.5);
  assert.equal(player.toggleAB(), 'a');
  assert.deepEqual(player.state.ab, { a: 10, b: null });
  audio.tick(9);
  assert.equal(player.toggleAB(), 'a');
});

test('AB 生效时播放到 B 跳回 A', () => {
  const { audio, player, queue } = setup();
  player.load(queue, 0, { autoplay: false });
  audio.loaded(600);
  audio.tick(10);
  player.toggleAB();
  audio.tick(15);
  player.toggleAB();
  audio.tick(14.9);
  assert.equal(audio.currentTime, 14.9);
  audio.tick(15.1);
  assert.equal(audio.currentTime, 10);
});

test('切换单集时清除 AB', async () => {
  const { audio, player, queue, settle } = setup();
  player.load(queue, 0, { autoplay: false });
  audio.loaded(600);
  audio.tick(10);
  player.toggleAB();
  assert.equal(player.next(), true);
  await settle();
  assert.equal(player.state.ab, null);
  assert.equal(player.state.episode.id, 'e2');
});

test('next / prev 在队列两端返回 false', async () => {
  const { player, queue, settle } = setup();
  player.load(queue, 0, { autoplay: false });
  assert.equal(player.prev(), false);
  assert.equal(player.next(), true);
  assert.equal(player.next(), true);
  assert.equal(player.next(), false);
  assert.equal(player.state.episode.id, 'e3');
  assert.equal(player.prev(), true);
  await settle();
  assert.equal(player.state.episode.id, 'e2');
});

test('播放中每 5 秒保存一次进度；暂停时立即保存', async () => {
  const { clock, store, audio, player, queue, settle } = setup();
  let saves = 0;
  const original = store.setProgress;
  store.setProgress = (...args) => {
    saves += 1;
    return original(...args);
  };
  player.load(queue, 0);
  await settle();
  audio.loaded(600);
  for (let s = 1; s <= 4; s += 1) {
    clock.t += 1000;
    audio.tick(s);
  }
  assert.equal(saves, 0);
  clock.t += 1000;
  audio.tick(5);
  assert.equal(saves, 1);
  assert.equal(store.state.progress.e1.pos, 5);
  clock.t += 1000;
  audio.tick(6);
  assert.equal(saves, 1);
  player.pause();
  assert.equal(saves, 2);
  assert.deepEqual(
    { pos: store.state.progress.e1.pos, dur: store.state.progress.e1.dur, done: store.state.progress.e1.done },
    { pos: 6, dur: 600, done: false }
  );
});

test('切换单集前保存上一集的进度', async () => {
  const { store, audio, player, queue, settle } = setup();
  player.load(queue, 0);
  await settle();
  audio.loaded(600);
  audio.tick(42);
  player.load(queue, 1);
  assert.equal(store.state.progress.e1.pos, 42);
});

test('到 95% 记为已听', async () => {
  const { store, audio, player, queue, settle } = setup();
  player.load(queue, 0);
  await settle();
  audio.loaded(600);
  audio.tick(569);
  player.flush();
  assert.equal(store.state.progress.e1.done, false);
  audio.tick(570);
  player.flush();
  assert.equal(store.state.progress.e1.done, true);
});

test('ended 且 autoNext 开启 → 播下一集；队列末尾则停止', async () => {
  const { store, audio, player, queue, settle } = setup();
  player.load(queue, 1);
  await settle();
  audio.loaded(600);
  audio.tick(600);
  audio.paused = true;
  audio.fire('ended');
  await settle();
  assert.equal(store.state.progress.e2.done, true);
  assert.equal(player.state.episode.id, 'e3');
  assert.equal(player.state.playing, true);

  audio.loaded(600);
  audio.tick(600);
  audio.paused = true;
  audio.fire('ended');
  await settle();
  assert.equal(player.state.episode.id, 'e3');
  assert.equal(player.state.playing, false);
});

test('autoNext 关闭时 ended 后停止', async () => {
  const { store, audio, player, queue, settle } = setup();
  store.setSetting('autoNext', false);
  player.load(queue, 0);
  await settle();
  audio.loaded(600);
  audio.tick(600);
  audio.paused = true;
  audio.fire('ended');
  await settle();
  assert.equal(player.state.episode.id, 'e1');
  assert.equal(player.state.playing, false);
});

test('error 事件 → state.error 有值、停留在当前单集', async () => {
  const { audio, player, queue, settle } = setup();
  player.load(queue, 0);
  await settle();
  audio.paused = true;
  audio.fire('error');
  assert.equal(typeof player.state.error, 'string');
  assert.ok(player.state.error.length > 0);
  assert.equal(player.state.episode.id, 'e1');
  assert.equal(player.state.playing, false);
  player.load(queue, 1, { autoplay: false });
  assert.equal(player.state.error, null);
});

test('play() 被浏览器拒绝时不报错、不处于播放状态', async () => {
  const { audio, player, queue, settle } = setup();
  audio.playResult = () => Promise.reject(Object.assign(new Error('blocked'), { name: 'NotAllowedError' }));
  player.load(queue, 0);
  await settle();
  assert.equal(player.state.playing, false);
  assert.equal(player.state.error, null);
});

test('toggle 在播放与暂停之间切换；没有单集时什么也不做', async () => {
  const { audio, player, queue, settle } = setup();
  player.toggle();
  assert.equal(audio.playCalls, 0);
  player.load(queue, 0, { autoplay: false });
  player.toggle();
  await settle();
  assert.equal(player.state.playing, true);
  player.toggle();
  assert.equal(player.state.playing, false);
});

test('听力时长按墙上时间累计；seek 造成的跳变不计；单次最多计 2 秒；暂停期间不计', async () => {
  const { clock, store, audio, player, queue, settle } = setup();
  player.load(queue, 0);
  await settle();
  audio.loaded(600);
  clock.t += 250;
  audio.tick(0.25);
  clock.t += 250;
  audio.tick(0.5);
  player.seek(300);
  clock.t += 250;
  audio.tick(300.25); // 进度跳了 300 秒，只过了 0.25 秒
  clock.t += 60000;
  audio.tick(301); // 例如电脑休眠后恢复：最多计 2 秒
  player.pause();
  assert.equal(store.state.stats[TODAY], 2.75);

  clock.t += 30000; // 暂停 30 秒
  player.play();
  await settle();
  clock.t += 500;
  audio.tick(301.5);
  player.pause();
  assert.equal(store.state.stats[TODAY], 3.25);
});

test('时长为 NaN / Infinity：dur 为 null、不记已听、skip 与 toggleAB 不产生 NaN', async () => {
  for (const duration of [NaN, Infinity]) {
    const { store, audio, player, settle } = setup();
    player.load([ep(9, { duration: null })], 0);
    await settle();
    audio.loaded(duration);
    assert.equal(player.state.dur, null);
    audio.tick(100);
    player.skip(15);
    assert.equal(audio.currentTime, 115);
    player.skip(-500);
    assert.equal(audio.currentTime, 0);
    audio.tick(50);
    assert.equal(player.toggleAB(), 'a');
    audio.tick(60);
    assert.equal(player.toggleAB(), 'ab');
    assert.deepEqual(player.state.ab, { a: 50, b: 60 });
    audio.tick(1e6);
    player.flush();
    assert.equal(store.state.progress.e9.done, false);
    assert.equal(store.state.progress.e9.dur, null);
    assert.ok(Number.isFinite(store.state.progress.e9.pos));
  }
});

test('元数据未知时长时退回节目源提供的时长用于显示', () => {
  const { player, queue } = setup();
  player.load(queue, 0, { autoplay: false });
  assert.equal(player.state.dur, 600);
});

test('on：状态变化时通知，返回的函数可取消', () => {
  const { audio, player, queue } = setup();
  let count = 0;
  const off = player.on(() => (count += 1));
  player.load(queue, 0, { autoplay: false });
  audio.loaded(600);
  audio.tick(3);
  assert.ok(count >= 3);
  const before = count;
  off();
  audio.tick(4);
  assert.equal(count, before);
});

test('formatTime', () => {
  assert.equal(formatTime(0), '0:00');
  assert.equal(formatTime(65), '1:05');
  assert.equal(formatTime(599.9), '9:59');
  assert.equal(formatTime(3725), '1:02:05');
  assert.equal(formatTime(NaN), '--:--');
  assert.equal(formatTime(Infinity), '--:--');
  assert.equal(formatTime(null), '--:--');
  assert.equal(formatTime(undefined), '--:--');
  assert.equal(formatTime(-3), '0:00');
});

test('mediaSession 收到 metadata 与 6 个动作处理函数', async () => {
  const handlers = {};
  const mediaSession = {
    metadata: null,
    setActionHandler(name, fn) {
      handlers[name] = fn;
    },
  };
  const { audio, player, queue, settle } = setup({ mediaSession });
  assert.deepEqual(Object.keys(handlers).sort(), [
    'nexttrack', 'pause', 'play', 'previoustrack', 'seekbackward', 'seekforward',
  ]);
  player.load(queue, 0, { autoplay: false });
  audio.loaded(600);
  assert.equal(mediaSession.metadata.title, 'Episode 1');
  assert.equal(mediaSession.metadata.artist, 'Show');
  assert.equal(mediaSession.metadata.artwork[0].src, 'https://img.test/c.jpg');

  audio.tick(100);
  handlers.seekbackward({});
  assert.equal(audio.currentTime, 90);
  handlers.seekforward({});
  assert.equal(audio.currentTime, 105);
  handlers.nexttrack();
  await settle();
  assert.equal(player.state.episode.id, 'e2');
  handlers.play();
  await settle();
  assert.equal(player.state.playing, true);
  handlers.pause();
  assert.equal(player.state.playing, false);
});

test('不支持某个动作的 mediaSession 不会导致初始化失败', () => {
  const mediaSession = {
    metadata: null,
    setActionHandler(name) {
      if (name === 'seekforward') throw new TypeError('unsupported');
    },
  };
  assert.doesNotThrow(() => setup({ mediaSession }));
});

test('retry：出错后重新加载当前单集并回到出错前的位置', async () => {
  const { audio, player, queue, settle } = setup();
  player.load(queue, 0);
  await settle();
  audio.loaded(600);
  audio.tick(200);
  audio.paused = true;
  audio.fire('error');
  audio.src = '';
  audio.currentTime = 0;
  player.retry();
  await settle();
  assert.equal(player.state.error, null);
  assert.equal(audio.src, 'https://cdn.test/1.mp3');
  assert.equal(player.state.pos, 200);
  audio.loaded(600);
  assert.equal(audio.currentTime, 200);
  assert.equal(player.state.episode.id, 'e1');
});

test('toggle 依据 audio.paused 而不是滞后的事件：快速连按两次会暂停再继续', async () => {
  const { audio, player, queue, settle } = setup();
  player.load(queue, 0);
  await settle();
  assert.equal(audio.playCalls, 1);
  // 模拟浏览器：pause() 同步改变 paused，但 pause 事件还没派发
  audio.pause = function pause() {
    this.paused = true;
  };
  player.toggle();
  assert.equal(audio.paused, true);
  player.toggle();
  assert.equal(audio.playCalls, 2);
  assert.equal(audio.paused, false);
});
