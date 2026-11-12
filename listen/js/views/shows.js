// 节目库：内置节目的订阅开关，以及添加自定义节目。
import { h, replace } from '../dom.js';
import { CATALOG, CATEGORIES } from '../catalog.js';
import { loadShow } from '../feeds.js';
import { normalizeFeedUrl } from '../store.js';

function showRow(show, { subscribed, custom }) {
  return h(
    'li',
    { class: 'show', 'data-show-id': show.id },
    h(
      'button',
      { class: 'show-main', type: 'button', 'data-action': 'open-show' },
      h('span', { class: 'show-title' }, show.title),
      custom
        ? h('span', { class: 'show-meta' }, show.feedUrl)
        : h('span', { class: 'show-meta' }, `${show.source}，每期${show.length}`),
      custom ? null : h('span', { class: 'show-blurb' }, show.blurb)
    ),
    custom
      ? h('button', { class: 'text-button', type: 'button', 'data-action': 'remove-show' }, '移除')
      : h(
          'label',
          { class: 'switch' },
          h('input', {
            type: 'checkbox',
            'data-action': 'subscribe',
            checked: subscribed,
            'aria-label': `订阅 ${show.title}`,
          }),
          h('span', { class: 'switch-track', 'aria-hidden': 'true' })
        )
  );
}

export function mount(root, ctx) {
  const { store } = ctx;
  let alive = true;

  const customList = h('ul', { class: 'show-list', 'data-custom-list': true });
  const customEmpty = h('p', { class: 'hint' }, '内置列表里没有的播客，可以用它的 RSS 地址加进来。');
  const input = h('input', {
    id: 'add-url',
    type: 'url',
    inputmode: 'url',
    autocomplete: 'off',
    autocapitalize: 'off',
    spellcheck: 'false',
    placeholder: '粘贴播客的 RSS 地址',
    'aria-label': '播客的 RSS 地址',
    'aria-describedby': 'add-error',
  });
  const addButton = h('button', { class: 'primary-button', type: 'submit', 'data-action': 'add-show' }, '添加');
  const error = h('p', { id: 'add-error', class: 'form-error', role: 'alert', hidden: true });
  const form = h('form', { class: 'add-form', novalidate: true }, input, addButton);

  function renderCustom() {
    const shows = store.state.custom;
    customEmpty.hidden = shows.length > 0;
    replace(
      customList,
      shows.map((show) => showRow(show, { subscribed: true, custom: true }))
    );
  }

  replace(
    root,
    h('header', { class: 'page-head' }, h('h1', {}, '节目'), h('p', { class: 'page-sub' }, '打开开关的节目，新单集会出现在「今日」。')),
    CATEGORIES.map((category) =>
      h(
        'section',
        { class: 'group' },
        h('h2', { class: 'group-title' }, category),
        h(
          'ul',
          { class: 'show-list' },
          CATALOG.filter((show) => show.category === category).map((show) =>
            showRow(show, { subscribed: Boolean(store.state.subs[show.id]), custom: false })
          )
        )
      )
    ),
    h(
      'section',
      { class: 'group' },
      h('h2', { class: 'group-title' }, '我添加的节目'),
      customEmpty,
      customList,
      form,
      error
    )
  );
  renderCustom();

  function showError(message) {
    error.textContent = message;
    error.hidden = false;
  }

  async function add() {
    error.hidden = true;
    let url;
    try {
      url = normalizeFeedUrl(input.value);
    } catch (err) {
      showError(err.message);
      return;
    }
    addButton.disabled = true;
    addButton.textContent = '正在检查…';
    try {
      // 先确认这个地址真的能解析出单集，再加入列表。
      const probe = { id: 'probe', title: '', feedUrl: url.href };
      const { episodes } = await loadShow(probe, { store, now: Date.now(), force: true });
      if (!alive) return;
      if (episodes.length === 0) throw new Error('这个节目源里没有可播放的单集');
      const cached = store.getFeedCache(url.href);
      store.addCustom({ title: cached ? cached.data.title : '', feedUrl: url.href });
      input.value = '';
      renderCustom();
    } catch (err) {
      if (alive) showError(err.message || '无法获取节目源');
    } finally {
      addButton.disabled = false;
      addButton.textContent = '添加';
    }
  }

  const onSubmit = (event) => {
    event.preventDefault();
    add();
  };
  form.addEventListener('submit', onSubmit);

  const onChange = (event) => {
    const box = event.target.closest('[data-action="subscribe"]');
    if (!box) return;
    store.setSubscribed(box.closest('[data-show-id]').getAttribute('data-show-id'), box.checked);
  };
  root.addEventListener('change', onChange);

  const onClick = (event) => {
    const button = event.target.closest('[data-action]');
    const row = event.target.closest('[data-show-id]');
    if (!button || !row) return;
    const id = row.getAttribute('data-show-id');
    const action = button.getAttribute('data-action');
    if (action === 'open-show') ctx.navigate(`#/show/${encodeURIComponent(id)}`);
    if (action === 'remove-show') {
      store.removeCustom(id);
      renderCustom();
    }
  };
  root.addEventListener('click', onClick);

  return () => {
    alive = false;
    form.removeEventListener('submit', onSubmit);
    root.removeEventListener('change', onChange);
    root.removeEventListener('click', onClick);
  };
}
