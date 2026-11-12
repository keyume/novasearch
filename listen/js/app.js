// 启动：创建存储与播放器，按地址栏的 hash 切换视图。
import { createStore } from './store.js';
import { createPlayer } from './player.js';
import { mountPlayer } from './views/player.js';
import { mount as mountToday } from './views/today.js';
import { mount as mountShows } from './views/shows.js';
import { mount as mountShow } from './views/show.js';
import { mount as mountMe } from './views/me.js';

const store = createStore();
const audio = document.getElementById('audio');
const player = createPlayer({
  audio,
  store,
  mediaSession: 'mediaSession' in navigator ? navigator.mediaSession : null,
});

const ctx = {
  store,
  player,
  navigate(hash) {
    window.location.hash = hash;
  },
  play(queue, index) {
    player.load(queue, index);
  },
};

mountPlayer({
  mini: document.getElementById('mini-player'),
  sheet: document.getElementById('player-sheet'),
  ctx,
});

// ---- 路由 ----
const view = document.getElementById('view');
const tabs = [...document.querySelectorAll('[data-tab]')];
const TITLES = { today: '今日', shows: '节目', me: '我的' };
let unmount = () => {};

function parseRoute() {
  const parts = window.location.hash.replace(/^#\/?/, '').split('/');
  if (parts[0] === 'show' && parts[1]) {
    let id = parts[1];
    try {
      id = decodeURIComponent(parts[1]);
    } catch {
      // 保留原样，视图会提示找不到节目
    }
    return { tab: 'shows', mount: (root) => mountShow(root, ctx, id) };
  }
  if (parts[0] === 'shows') return { tab: 'shows', mount: (root) => mountShows(root, ctx) };
  if (parts[0] === 'me') return { tab: 'me', mount: (root) => mountMe(root, ctx) };
  return { tab: 'today', mount: (root) => mountToday(root, ctx) };
}

function render() {
  const route = parseRoute();
  unmount();
  view.replaceChildren();
  for (const tab of tabs) {
    if (tab.getAttribute('data-tab') === route.tab) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
  }
  document.title = `每日听力 - ${TITLES[route.tab]}`;
  unmount = route.mount(view);
  window.scrollTo(0, 0);
}

window.addEventListener('hashchange', render);
render();

// ---- 恢复上次在听的单集（不自动播放）----
const last = store.state.recent[0];
if (last) player.load([last], 0, { autoplay: false });

// ---- 离开页面前保存进度 ----
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') player.flush();
});
window.addEventListener('pagehide', () => player.flush());

// ---- 键盘：空格播放/暂停，左右方向键后退/前进 ----
document.addEventListener('keydown', (event) => {
  if (!player.state.episode || event.altKey || event.ctrlKey || event.metaKey) return;
  const target = event.target;
  const tag = target && target.tagName ? target.tagName.toLowerCase() : '';
  if (tag === 'input' || tag === 'textarea' || tag === 'select' || (target && target.isContentEditable)) return;

  if (event.key === ' ' || event.code === 'Space') {
    // 焦点在按钮或链接上时，空格本来就会触发它
    if (tag === 'button' || tag === 'a') return;
    event.preventDefault();
    player.toggle();
  } else if (event.key === 'ArrowLeft') {
    event.preventDefault();
    player.skip(-10);
  } else if (event.key === 'ArrowRight') {
    event.preventDefault();
    player.skip(15);
  }
});
