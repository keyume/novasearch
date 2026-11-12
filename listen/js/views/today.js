// 今日：汇总已订阅节目近几天的新单集，按日期分组，排成节目单。
import { h, replace } from '../dom.js';
import { buildToday, cachedEpisodes, loadShows } from '../feeds.js';
import { formatClock, formatDuration, formatWeekday } from '../format.js';
import { summarize } from '../stats.js';
import { bindRows, episodeRow, watchRows } from './rows.js';

export function mount(root, ctx) {
  const { store } = ctx;
  let episodes = [];
  let queue = [];
  let failed = [];
  let loading = false;
  let alive = true;
  let run = 0;

  const now = new Date();
  const summary = h('p', { class: 'masthead-sub' });
  const daysToggle = h(
    'div',
    { class: 'segmented', role: 'group', 'aria-label': '显示范围' },
    [3, 7].map((days) =>
      h('button', { type: 'button', 'data-action': 'days', 'data-days': days }, `近 ${days} 天`)
    )
  );
  const notice = h('div', { id: 'notice', class: 'notice', role: 'status', hidden: true });
  const list = h('div', { class: 'groups' });

  replace(
    root,
    h(
      'header',
      { class: 'masthead' },
      h(
        'h1',
        { class: 'masthead-date' },
        `${now.getMonth() + 1}月${now.getDate()}日`,
        h('span', { class: 'masthead-weekday' }, formatWeekday(now))
      ),
      summary,
      daysToggle
    ),
    notice,
    list
  );

  function renderSummary() {
    const stats = summarize(store.state.stats, new Date());
    const minutes = Math.floor(stats.todaySec / 60);
    const parts = [minutes > 0 ? `今天已听 ${formatDuration(stats.todaySec)}` : '今天还没开始听'];
    if (stats.streak > 0) parts.push(`连续 ${stats.streak} 天`);
    summary.textContent = parts.join('，');
  }

  function renderNotice() {
    notice.hidden = failed.length === 0;
    if (failed.length === 0) return;
    replace(
      notice,
      h('span', {}, `${failed.length} 个节目加载失败：${failed.map((show) => show.title).join('、')}`),
      h('button', { type: 'button', 'data-action': 'retry' }, '重试')
    );
  }

  function renderList() {
    const days = store.state.settings.todayDays;
    for (const button of daysToggle.querySelectorAll('button')) {
      button.setAttribute('aria-pressed', String(Number(button.getAttribute('data-days')) === days));
    }

    const groups = buildToday(episodes, { now: new Date(), days });
    queue = groups.flatMap((group) => group.episodes);

    if (store.shows().length === 0) {
      replace(list, h('p', { class: 'empty' }, '还没有订阅节目。到「节目」里挑几个，这里每天会列出它们的新单集。'));
    } else if (groups.length === 0 && loading) {
      replace(list, h('p', { class: 'empty' }, '正在获取节目…'));
    } else if (groups.length === 0) {
      replace(
        list,
        h(
          'p',
          { class: 'empty' },
          days === 3
            ? '最近 3 天没有新单集。可以切换到近 7 天，或到「节目」里多订阅几个。'
            : '最近 7 天没有新单集。到「节目」里多订阅几个试试。'
        )
      );
    } else {
      replace(
        list,
        groups.map((group) =>
          h(
            'section',
            { class: 'group', 'data-group': group.key },
            h(
              'h2',
              { class: 'group-title' },
              group.label,
              h('span', { class: 'group-count' }, `${group.episodes.length} 集`)
            ),
            h(
              'ul',
              { class: 'ep-list' },
              group.episodes.map((episode) => episodeRow(episode, { lead: formatClock(episode.pubDate) }))
            )
          )
        )
      );
    }
    list.setAttribute('aria-busy', String(loading));
    unwatch();
    unwatch = watchRows(list, ctx);
  }

  async function refresh(force) {
    const shows = store.shows();
    const mine = (run += 1);
    const cached = cachedEpisodes(shows, { store, now: Date.now() });
    episodes = cached.episodes;
    failed = [];
    loading = shows.length > 0 && (force || !cached.fresh);
    renderNotice();
    renderList();
    if (!loading) return;

    const result = await loadShows(shows, { store, now: Date.now(), force });
    if (!alive || mine !== run) return;
    episodes = result.episodes;
    failed = result.failed;
    loading = false;
    renderNotice();
    renderList();
  }

  let unwatch = () => {};
  const unbind = bindRows(list, () => queue, ctx);

  const onClick = (event) => {
    const button = event.target.closest('[data-action]');
    if (!button) return;
    const action = button.getAttribute('data-action');
    if (action === 'days') store.setSetting('todayDays', Number(button.getAttribute('data-days')));
    if (action === 'retry') refresh(true);
  };
  root.addEventListener('click', onClick);

  const offStore = store.on((topic) => {
    if (topic === 'settings') renderList();
    if (topic === 'stats') renderSummary();
  });

  renderSummary();
  refresh(false);

  return () => {
    alive = false;
    unwatch();
    unbind();
    offStore();
    root.removeEventListener('click', onClick);
  };
}
