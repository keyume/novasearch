// 我的：听力记录、最近在听、收藏。
import { h, replace } from '../dom.js';
import { formatDay, formatDuration, formatWeekday } from '../format.js';
import { summarize } from '../stats.js';
import { bindRows, episodeRow, watchRows } from './rows.js';

export function mount(root, ctx) {
  const { store } = ctx;
  let recent = [];
  let favorites = [];
  let unwatch = () => {};

  const stats = h('section', { class: 'group', 'data-section': 'stats' });
  const recentSection = h('section', { class: 'group', 'data-section': 'recent' });
  const favoriteSection = h('section', { class: 'group', 'data-section': 'favorites' });
  const lists = h('div', {}, recentSection, favoriteSection);

  replace(root, h('header', { class: 'page-head' }, h('h1', {}, '我的')), stats, lists);

  function renderStats() {
    const now = new Date();
    const summary = summarize(store.state.stats, now);
    const peak = Math.max(60, ...summary.last7.map((day) => day.sec));
    replace(
      stats,
      h('h2', { class: 'group-title' }, '听力记录'),
      h(
        'dl',
        { class: 'figures' },
        h('div', {}, h('dt', {}, '今天'), h('dd', {}, formatDuration(summary.todaySec))),
        h('div', {}, h('dt', {}, '连续'), h('dd', {}, `${summary.streak} 天`)),
        h('div', {}, h('dt', {}, '累计'), h('dd', {}, formatDuration(summary.totalSec)))
      ),
      h(
        'ol',
        { class: 'week', 'aria-label': '最近 7 天每天的听力时长' },
        summary.last7.map((day) => {
          const [year, month, date] = day.key.split('-').map(Number);
          const bar = h('span', { class: 'week-bar' });
          bar.style.height = `${Math.round((day.sec / peak) * 100)}%`;
          return h(
            'li',
            { 'data-met': day.sec >= 60 ? 'true' : 'false' },
            h('span', { class: 'week-track' }, bar),
            h('span', { class: 'week-day' }, formatWeekday(new Date(year, month - 1, date))),
            h('span', { class: 'visually-hidden' }, `${formatDuration(day.sec)}`)
          );
        })
      ),
      h('p', { class: 'hint' }, '某天听满 1 分钟算打卡。时长按实际播放时间计，不乘倍速。')
    );
  }

  function renderLists() {
    recent = store.state.recent.filter((episode) => {
      const progress = store.state.progress[episode.id];
      return !(progress && progress.done);
    });
    favorites = Object.values(store.state.favorites).sort((a, b) => (b.favoritedAt || 0) - (a.favoritedAt || 0));

    replace(
      recentSection,
      h('h2', { class: 'group-title' }, '最近在听'),
      recent.length === 0
        ? h('p', { class: 'hint' }, '没有听到一半的单集。')
        : h(
            'ul',
            { class: 'ep-list' },
            recent.map((episode) => episodeRow(episode, { lead: formatDay(episode.pubDate) }))
          )
    );
    replace(
      favoriteSection,
      h('h2', { class: 'group-title' }, '收藏'),
      favorites.length === 0
        ? h('p', { class: 'hint' }, '点单集右侧的星标，可以把想反复听的收在这里。')
        : h(
            'ul',
            { class: 'ep-list' },
            favorites.map((episode) => episodeRow(episode, { lead: formatDay(episode.pubDate) }))
          )
    );
    unwatch();
    unwatch = watchRows(lists, ctx);
  }

  const unbind = bindRows(
    lists,
    (row) => (row.closest('[data-section]').getAttribute('data-section') === 'recent' ? recent : favorites),
    ctx
  );

  const offStore = store.on((topic) => {
    if (topic === 'stats') renderStats();
    if (topic === 'favorites' || topic === 'recent') renderLists();
  });

  renderStats();
  renderLists();

  return () => {
    unwatch();
    unbind();
    offStore();
  };
}
