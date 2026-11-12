// 播放控制器：封装一个 <audio> 元素，不含界面。
// 负责播放队列、变速、跳转、A-B 复读、断点保存、听力时长统计和系统媒体控制，
// 通过 on() 把状态变化通知给界面。
import { dateKey } from './feeds.js';

export const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];

const SKIP_BACK = 10;
const SKIP_FORWARD = 15;
const SAVE_INTERVAL_MS = 5000;
const DONE_RATIO = 0.95;
const AB_MIN_GAP = 1;
const RESUME_TAIL = 5; // 离结尾不到这么多秒就从头播
const MAX_TICK_SECONDS = 2; // 单次计时上限，防止休眠恢复后把整段休眠算进去

const finiteOrNull = (value) => (Number.isFinite(value) && value > 0 ? value : null);

export function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return '--:--';
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

export function createPlayer({ audio, store, now = Date.now, mediaSession = null }) {
  const listeners = new Set();
  const initialSpeed = store.state.settings.speed;
  const state = {
    episode: null,
    queue: [],
    index: -1,
    playing: false,
    pos: 0,
    dur: null,
    speed: SPEEDS.includes(initialSpeed) ? initialSpeed : 1,
    ab: null,
    error: null,
  };

  let metaLoaded = false;
  let pendingSeek = null; // 元数据加载后要跳到的位置
  let done = false;
  let lastSave = now();
  let lastTick = now();
  let pendingListen = 0;

  const emit = () => {
    for (const listener of listeners) listener(state);
  };

  function applySpeed() {
    audio.defaultPlaybackRate = state.speed;
    audio.playbackRate = state.speed;
  }

  function saveProgress() {
    if (!state.episode) return;
    store.setProgress(state.episode.id, { pos: state.pos, dur: state.dur, done });
    if (pendingListen > 0) {
      store.addListened(dateKey(new Date(now())), pendingListen);
      pendingListen = 0;
    }
    lastSave = now();
  }

  function setMetadata(episode) {
    if (!mediaSession) return;
    const data = {
      title: episode.title,
      artist: episode.showTitle || '',
      album: '每日听力',
      artwork: episode.image ? [{ src: episode.image }] : [],
    };
    try {
      mediaSession.metadata = typeof MediaMetadata === 'function' ? new MediaMetadata(data) : data;
    } catch {
      // 封面地址不被接受等情况：不影响播放
    }
  }

  function start(queue, index, { autoplay, position }) {
    const episode = queue[index];
    if (!episode) return;
    saveProgress();

    state.queue = queue;
    state.index = index;
    state.episode = episode;
    state.ab = null;
    state.error = null;
    state.playing = false;
    state.pos = position;
    state.dur = finiteOrNull(episode.duration);
    metaLoaded = false;
    pendingSeek = position > 0 ? position : null;
    done = Boolean(store.state.progress[episode.id]?.done);
    lastSave = now();

    audio.src = episode.audioUrl;
    applySpeed();
    store.pushRecent(episode);
    setMetadata(episode);
    emit();
    if (autoplay) play();
  }

  function load(queue, index, { autoplay = true } = {}) {
    const episode = queue[index];
    if (!episode) return;
    const saved = store.state.progress[episode.id];
    const savedDur = saved ? finiteOrNull(saved.dur) : null;
    const resumable =
      saved && saved.pos > 0 && (savedDur === null || saved.pos < savedDur - RESUME_TAIL);
    start(queue, index, { autoplay, position: resumable ? saved.pos : 0 });
  }

  function retry() {
    if (!state.episode) return;
    start(state.queue, state.index, { autoplay: true, position: state.pos });
  }

  function play() {
    if (!state.episode) return;
    const result = audio.play();
    // 被浏览器拦截自动播放、或被新的加载打断时会拒绝；真正的加载失败由 error 事件处理。
    if (result && typeof result.catch === 'function') result.catch(() => {});
  }

  function pause() {
    audio.pause();
  }

  function toggle() {
    if (!state.episode) return;
    // 以 audio.paused 为准：state.playing 要等事件派发后才更新，快速连按时会滞后。
    if (audio.paused) play();
    else pause();
  }

  function seek(seconds) {
    if (!state.episode || !Number.isFinite(seconds)) return;
    const target = Math.min(Math.max(0, seconds), state.dur === null ? Infinity : state.dur);
    state.pos = target;
    if (metaLoaded) audio.currentTime = target;
    else pendingSeek = target;
    emit();
  }

  function skip(delta) {
    seek(state.pos + delta);
  }

  function step(offset) {
    const index = state.index + offset;
    if (index < 0 || index >= state.queue.length) return false;
    load(state.queue, index);
    return true;
  }

  function setSpeed(rate) {
    if (!SPEEDS.includes(rate)) return;
    state.speed = rate;
    applySpeed();
    store.setSetting('speed', rate);
    emit();
  }

  function cycleSpeed() {
    setSpeed(SPEEDS[(SPEEDS.indexOf(state.speed) + 1) % SPEEDS.length]);
    return state.speed;
  }

  function toggleAB() {
    if (!state.episode || !Number.isFinite(state.pos)) return 'off';
    if (!state.ab) {
      state.ab = { a: state.pos, b: null };
    } else if (state.ab.b === null) {
      if (state.pos - state.ab.a >= AB_MIN_GAP) {
        state.ab = { a: state.ab.a, b: state.pos };
        seek(state.ab.a);
      }
    } else {
      state.ab = null;
    }
    emit();
    return !state.ab ? 'off' : state.ab.b === null ? 'a' : 'ab';
  }

  audio.addEventListener('loadedmetadata', () => {
    if (!state.episode) return;
    metaLoaded = true;
    state.dur = finiteOrNull(audio.duration);
    applySpeed();
    if (pendingSeek !== null) {
      audio.currentTime = state.dur === null ? pendingSeek : Math.min(pendingSeek, state.dur);
      pendingSeek = null;
    }
    emit();
  });

  audio.addEventListener('timeupdate', () => {
    if (!state.episode || !metaLoaded) return;
    const current = audio.currentTime;
    if (!Number.isFinite(current)) return;
    state.pos = current;

    if (state.ab && state.ab.b !== null && current >= state.ab.b) {
      audio.currentTime = state.ab.a;
      state.pos = state.ab.a;
    }
    if (state.dur !== null && state.pos >= state.dur * DONE_RATIO) done = true;

    const time = now();
    if (state.playing) {
      const elapsed = (time - lastTick) / 1000;
      if (elapsed > 0) pendingListen += Math.min(elapsed, MAX_TICK_SECONDS);
    }
    lastTick = time;
    if (time - lastSave >= SAVE_INTERVAL_MS) saveProgress();
    emit();
  });

  audio.addEventListener('play', () => {
    if (!state.episode) return;
    state.playing = true;
    lastTick = now();
    emit();
  });

  audio.addEventListener('pause', () => {
    if (!state.episode) return;
    state.playing = false;
    saveProgress();
    emit();
  });

  audio.addEventListener('ended', () => {
    if (!state.episode) return;
    state.playing = false;
    done = true;
    saveProgress();
    if (!(store.state.settings.autoNext && step(1))) emit();
  });

  audio.addEventListener('error', () => {
    if (!state.episode) return;
    state.playing = false;
    state.error = '音频加载失败，请检查网络后重试';
    emit();
  });

  if (mediaSession) {
    const actions = {
      play,
      pause,
      seekbackward: (details) => skip(-((details && details.seekOffset) || SKIP_BACK)),
      seekforward: (details) => skip((details && details.seekOffset) || SKIP_FORWARD),
      previoustrack: () => step(-1),
      nexttrack: () => step(1),
    };
    for (const [name, handler] of Object.entries(actions)) {
      try {
        mediaSession.setActionHandler(name, handler);
      } catch {
        // 这个浏览器不支持该动作
      }
    }
  }

  return {
    state,
    on(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    load,
    retry,
    play,
    pause,
    toggle,
    seek,
    skip,
    next: () => step(1),
    prev: () => step(-1),
    setSpeed,
    cycleSpeed,
    toggleAB,
    flush: saveProgress,
  };
}
