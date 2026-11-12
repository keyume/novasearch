// 节目详情：某个节目最新的单集。
import { h, icon, replace } from '../dom.js';
import { CATALOG } from '../catalog.js';
import { loadShow } from '../feeds.js';
import { formatDay } from '../format.js';
import { bindRows, episodeRow, watchRows } from './rows.js';

export function mount(root, ctx, showId) {
  const { store } = ctx;
  const builtin = CATALOG.find((show) => show.id === showId);
  const custom = store.state.custom.find((show) => show.id === showId);
  const show = builtin || custom;
  let alive = true;
  let queue = [];
  let unwatch = () => {};

  root.setAttribute('data-view', 'show');
  const back = h(
    'button',
    { class: 'back-button', type: 'button', 'data-action': 'back-to-shows' },
    icon('back'),
    '节目'
  );
  const list = h('ul', { class: 'ep-list' });
  const status = h('p', { class: 'empty', role: 'status' });

  if (!show) {
    replace(root, back, h('p', { class: 'empty' }, '找不到这个节目，它可能已经被移除。'));
  } else {
    replace(
      root,
      back,
      h(
        'header',
        { class: 'page-head' },
        h('h1', {}, show.title),
        builtin ? h('p', { class: 'page-sub' }, `${show.source}，每期${show.length}`) : null,
        builtin ? h('p', { class: 'page-blurb' }, show.blurb) : null
      ),
      status,
      list
    );
  }

  async function load(force) {
    status.hidden = false;
    replace(status, '正在获取单集…');
    try {
      const result = await loadShow(show, { store, now: Date.now(), force });
      if (!alive) return;
      queue = result.episodes;
      replace(
        list,
        queue.map((episode) => episodeRow(episode, { lead: formatDay(episode.pubDate), showName: false }))
      );
      unwatch();
      unwatch = watchRows(list, ctx);
      if (queue.length === 0) replace(status, '这个节目暂时没有可播放的单集。');
      else if (result.stale) {
        replace(
          status,
          '刷新失败，显示的是上次获取的内容。',
          h('button', { class: 'text-button', type: 'button', 'data-action': 'reload-show' }, '重试')
        );
      } else status.hidden = true;
    } catch (err) {
      if (!alive) return;
      replace(
        status,
        `${err.message || '无法获取节目源'}。`,
        h('button', { class: 'text-button', type: 'button', 'data-action': 'reload-show' }, '重试')
      );
    }
  }

  const unbind = bindRows(list, () => queue, ctx);
  const onClick = (event) => {
    const button = event.target.closest('[data-action]');
    if (!button) return;
    const action = button.getAttribute('data-action');
    if (action === 'back-to-shows') ctx.navigate('#/shows');
    if (action === 'reload-show') load(true);
  };
  root.addEventListener('click', onClick);

  if (show) load(false);

  return () => {
    alive = false;
    unwatch();
    unbind();
    root.removeEventListener('click', onClick);
    root.removeAttribute('data-view');
  };
}
