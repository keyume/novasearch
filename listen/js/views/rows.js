// 单集列表行：今日、节目详情、收藏、最近在听共用。
import { h, icon } from '../dom.js';
import { formatDuration } from '../format.js';

// lead：行首那一列显示的文字（今日页是发布时间，其他页是日期）。
export function episodeRow(episode, { lead = '', showName = true } = {}) {
  return h(
    'li',
    { class: 'ep', 'data-episode': episode.id, 'data-show': episode.showId },
    h(
      'button',
      { class: 'ep-main', type: 'button', 'data-action': 'play-episode' },
      h('span', { class: 'ep-lead' }, lead),
      h(
        'span',
        { class: 'ep-body' },
        showName ? h('span', { class: 'ep-show' }, episode.showTitle || '') : null,
        h('span', { class: 'ep-title' }, episode.title),
        h(
          'span',
          { class: 'ep-meta' },
          h('span', { class: 'ep-length' }, formatDuration(episode.duration)),
          h('span', { class: 'ep-state' })
        ),
        h('span', { class: 'ep-progress', hidden: true }, h('span', { class: 'ep-progress-fill' }))
      )
    ),
    h(
      'button',
      { class: 'ep-fav', type: 'button', 'data-action': 'fav', 'aria-pressed': 'false', 'aria-label': '收藏' },
      icon('star')
    )
  );
}

// 按存储与播放器的当前状态更新每一行：正在播放、已听、进度条、收藏。
export function syncRows(root, { store, player }) {
  const playingId = player.state.episode ? player.state.episode.id : null;
  for (const row of root.querySelectorAll('[data-episode]')) {
    const id = row.getAttribute('data-episode');
    const progress = store.state.progress[id];
    const isCurrent = id === playingId;

    row.toggleAttribute('data-current', isCurrent);
    row.toggleAttribute('data-done', Boolean(progress && progress.done));

    const state = row.querySelector('.ep-state');
    state.textContent = isCurrent
      ? player.state.playing
        ? '正在播放'
        : '已暂停'
      : progress && progress.done
        ? '已听'
        : '';

    const bar = row.querySelector('.ep-progress');
    const started = progress && !progress.done && progress.pos > 0 && progress.dur > 0;
    bar.hidden = !started;
    if (started) {
      const percent = Math.min(100, Math.max(0, (progress.pos / progress.dur) * 100));
      bar.firstElementChild.style.width = `${percent}%`;
    }

    const fav = row.querySelector('[data-action="fav"]');
    const favorited = Boolean(store.state.favorites[id]);
    fav.setAttribute('aria-pressed', String(favorited));
    fav.setAttribute('aria-label', favorited ? '取消收藏' : '收藏');
  }
}

// 列表上的点击：播放某一集、收藏某一集。
// getQueue(row) 返回该行所在列表的全部单集，作为播放队列。
export function bindRows(root, getQueue, ctx) {
  const onClick = (event) => {
    const button = event.target.closest('[data-action]');
    const row = event.target.closest('[data-episode]');
    if (!button || !row || !root.contains(row)) return;
    const queue = getQueue(row);
    const index = queue.findIndex((episode) => episode.id === row.getAttribute('data-episode'));
    if (index === -1) return;
    const action = button.getAttribute('data-action');
    if (action === 'fav') {
      ctx.store.toggleFavorite(queue[index]);
    } else if (action === 'play-episode') {
      const current = ctx.player.state.episode;
      if (current && current.id === queue[index].id) ctx.player.toggle();
      else ctx.play(queue, index);
    }
  };
  root.addEventListener('click', onClick);
  return () => root.removeEventListener('click', onClick);
}

// 订阅存储与播放器，在相关状态变化时刷新行。返回取消订阅的函数。
export function watchRows(root, ctx) {
  let lastId = null;
  let lastPlaying = false;
  const sync = () => syncRows(root, ctx);
  const offStore = ctx.store.on((topic) => {
    if (topic === 'progress' || topic === 'favorites') sync();
  });
  const offPlayer = ctx.player.on((state) => {
    const id = state.episode ? state.episode.id : null;
    if (id === lastId && state.playing === lastPlaying) return;
    lastId = id;
    lastPlaying = state.playing;
    sync();
  });
  sync();
  return () => {
    offStore();
    offPlayer();
  };
}
