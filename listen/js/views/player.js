// 底部迷你播放条与全屏播放页。两者常驻页面，随播放器状态更新。
import { h, icon, replace } from '../dom.js';
import { renderSafeHtml } from '../html.js';
import { formatTime } from '../player.js';

const AB_LABELS = { off: 'A-B 复读', a: '设终点 B', ab: '取消复读' };

export function mountPlayer({ mini, sheet, ctx }) {
  const { store, player } = ctx;
  const transcripts = new Map(); // 单集 id → 段落数组
  let shownId = null;
  let open = false;

  // ---- 迷你播放条 ----
  const miniFill = h('span', {});
  const miniTitle = h('span', { class: 'mini-title' });
  const miniShow = h('span', { class: 'mini-show' });
  const miniExpand = h(
    'button',
    { class: 'mini-main', type: 'button', 'data-action': 'expand', 'aria-label': '展开播放页' },
    miniTitle,
    miniShow
  );
  const miniPlay = h('button', { class: 'mini-play', type: 'button', 'data-action': 'play' });
  replace(mini, h('span', { class: 'mini-progress' }, miniFill), miniExpand, miniPlay);

  // ---- 播放页 ----
  const collapse = h(
    'button',
    { class: 'icon-button', type: 'button', 'data-action': 'collapse', 'aria-label': '收起播放页' },
    icon('down')
  );
  const sheetShow = h('span', { class: 'sheet-show' });
  const cover = h('img', { class: 'sheet-cover', alt: '', referrerpolicy: 'no-referrer', hidden: true });
  const title = h('h2', { class: 'sheet-title' });
  const errorText = h('span', {});
  const errorBox = h(
    'p',
    { class: 'sheet-error', role: 'alert', hidden: true },
    errorText,
    h('button', { class: 'text-button', type: 'button', 'data-action': 'retry-audio' }, '重试')
  );

  const scale = h('span', { class: 'dial-scale' });
  const played = h('span', { class: 'dial-played' });
  const band = h('span', { class: 'dial-ab', hidden: true });
  const needle = h('span', { class: 'dial-needle' });
  const seek = h('input', {
    id: 'seek',
    type: 'range',
    min: 0,
    max: 1000,
    step: 1,
    value: 0,
    'aria-label': '播放进度',
  });
  const timePos = h('span', { id: 'time-pos' }, '0:00');
  const timeDur = h('span', { id: 'time-dur' }, '--:--');

  const playButton = h('button', { class: 'transport-play', type: 'button', 'data-action': 'play' });
  const transportButton = (action, label, content) =>
    h('button', { class: 'transport-button', type: 'button', 'data-action': action, 'aria-label': label }, content);

  const speed = h('button', { class: 'option', type: 'button', 'data-action': 'speed' });
  const ab = h('button', { class: 'option', type: 'button', 'data-action': 'ab', 'data-state': 'off' });
  const favLabel = h('span', {}, '收藏');
  const fav = h(
    'button',
    { class: 'option', type: 'button', 'data-action': 'fav', 'aria-pressed': 'false' },
    icon('star'),
    favLabel
  );
  const autoNext = h('button', { class: 'option', type: 'button', 'data-action': 'autonext' }, '连播');

  const notesTab = h('button', { type: 'button', role: 'tab', 'data-pane-tab': 'notes' }, '简介');
  const transcriptTab = h('button', { type: 'button', role: 'tab', 'data-pane-tab': 'transcript' }, '文稿');
  const notes = h('div', { class: 'pane prose', 'data-pane': 'notes', role: 'tabpanel' });
  const transcript = h('div', { class: 'pane prose', 'data-pane': 'transcript', role: 'tabpanel', hidden: true });

  replace(
    sheet,
    h('div', { class: 'sheet-top' }, collapse, sheetShow),
    h(
      'div',
      { class: 'sheet-body' },
      h('div', { class: 'sheet-head' }, cover, title),
      errorBox,
      h('div', { class: 'dial' }, scale, played, band, needle, seek),
      h('div', { class: 'times' }, timePos, timeDur),
      h(
        'div',
        { class: 'transport' },
        transportButton('prev', '上一集', icon('prev')),
        transportButton('back', '后退 10 秒', h('span', { class: 'jump' }, '−10')),
        playButton,
        transportButton('forward', '前进 15 秒', h('span', { class: 'jump' }, '+15')),
        transportButton('next', '下一集', icon('next'))
      ),
      h('div', { class: 'options' }, speed, ab, fav, autoNext),
      h('div', { class: 'pane-tabs', role: 'tablist' }, notesTab, transcriptTab),
      notes,
      transcript
    )
  );

  cover.addEventListener('error', () => {
    cover.hidden = true;
  });

  function showPane(name) {
    const isNotes = name === 'notes';
    notes.hidden = !isNotes;
    transcript.hidden = isNotes;
    notesTab.setAttribute('aria-selected', String(isNotes));
    transcriptTab.setAttribute('aria-selected', String(!isNotes));
    if (!isNotes) loadTranscript();
  }

  function renderParagraphs(paragraphs) {
    replace(transcript, paragraphs.map((text) => h('p', {}, text)));
  }

  async function loadTranscript() {
    const episode = player.state.episode;
    if (!episode || !episode.transcriptUrl) return;
    if (transcripts.has(episode.id)) {
      renderParagraphs(transcripts.get(episode.id));
      return;
    }
    replace(transcript, h('p', { class: 'pane-status' }, '正在加载文稿…'));
    try {
      const response = await fetch(`/api/transcript?url=${encodeURIComponent(episode.transcriptUrl)}`);
      const body = await response.json().catch(() => null);
      if (!response.ok || !body || !Array.isArray(body.paragraphs)) {
        throw new Error((body && body.error) || '无法获取文稿');
      }
      transcripts.set(episode.id, body.paragraphs);
      if (player.state.episode && player.state.episode.id === episode.id) renderParagraphs(body.paragraphs);
    } catch (err) {
      if (!player.state.episode || player.state.episode.id !== episode.id) return;
      replace(
        transcript,
        h(
          'p',
          { class: 'pane-status' },
          `${err.message || '无法获取文稿'}。`,
          h('button', { class: 'text-button', type: 'button', 'data-action': 'reload-transcript' }, '重试')
        )
      );
    }
  }

  // 单集变化时才重建的部分
  function showEpisode(episode) {
    shownId = episode.id;
    miniTitle.textContent = episode.title;
    miniShow.textContent = episode.showTitle || '';
    title.textContent = episode.title;
    sheetShow.textContent = episode.showTitle || '';
    if (episode.image) {
      cover.hidden = false;
      cover.setAttribute('src', episode.image);
    } else {
      cover.hidden = true;
      cover.removeAttribute('src');
    }
    const body = renderSafeHtml(episode.descriptionHtml || '');
    replace(notes, body.childNodes.length ? body : h('p', { class: 'pane-status' }, '这一集没有提供简介。'));
    if (episode.link) {
      notes.append(
        h('p', {}, h('a', { href: episode.link, target: '_blank', rel: 'noopener noreferrer' }, '在节目网站上查看'))
      );
    }
    replace(transcript);
    transcriptTab.hidden = !episode.transcriptUrl;
    showPane('notes');
  }

  function setText(el, text) {
    if (el.textContent !== text) el.textContent = text;
  }

  function setPlayIcon(button, playing) {
    replace(button, icon(playing ? 'pause' : 'play'));
    button.setAttribute('aria-label', playing ? '暂停' : '播放');
  }

  function update() {
    const state = player.state;
    const episode = state.episode;
    document.body.classList.toggle('has-mini', Boolean(episode) && !open);
    mini.hidden = !episode || open;
    if (!episode) return;
    if (episode.id !== shownId) showEpisode(episode);

    const ratio = state.dur ? Math.min(1, Math.max(0, state.pos / state.dur)) : 0;
    const percent = `${(ratio * 100).toFixed(2)}%`;
    miniFill.style.width = percent;
    played.style.width = percent;
    needle.style.left = percent;
    if (document.activeElement !== seek) seek.value = String(Math.round(ratio * 1000));
    seek.disabled = !state.dur;
    seek.setAttribute('aria-valuetext', `${formatTime(state.pos)}，共 ${formatTime(state.dur)}`);
    timePos.textContent = formatTime(state.pos);
    timeDur.textContent = formatTime(state.dur);

    // 刻度：45 分钟以内每分钟一格，更长的每 5 分钟一格
    if (state.dur) {
      const step = state.dur <= 45 * 60 ? 60 : 300;
      scale.style.setProperty('--ticks', String(Math.max(1, state.dur / step)));
    }

    if (state.ab && state.dur) {
      const start = (state.ab.a / state.dur) * 100;
      const end = state.ab.b === null ? start : (state.ab.b / state.dur) * 100;
      band.hidden = false;
      band.style.left = `${start.toFixed(2)}%`;
      band.style.width = `${Math.max(0, end - start).toFixed(2)}%`;
    } else {
      band.hidden = true;
    }

    if (miniPlay.dataset.playing !== String(state.playing)) {
      miniPlay.dataset.playing = String(state.playing);
      setPlayIcon(miniPlay, state.playing);
      setPlayIcon(playButton, state.playing);
    }

    // 这些每秒会被调用好几次：只在值变了的时候才动 DOM，避免打断正在进行的点击。
    setText(speed, `${state.speed}x`);
    speed.setAttribute('aria-label', `播放速度 ${state.speed} 倍，点击切换`);
    const abState = !state.ab ? 'off' : state.ab.b === null ? 'a' : 'ab';
    ab.setAttribute('data-state', abState);
    setText(ab, AB_LABELS[abState]);

    const favorited = Boolean(store.state.favorites[episode.id]);
    fav.setAttribute('aria-pressed', String(favorited));
    setText(favLabel, favorited ? '已收藏' : '收藏');
    autoNext.setAttribute('aria-pressed', String(store.state.settings.autoNext));

    errorBox.hidden = !state.error;
    errorText.textContent = state.error || '';
  }

  function openSheet() {
    if (!player.state.episode) return;
    open = true;
    sheet.hidden = false;
    document.body.classList.add('sheet-open');
    update();
    collapse.focus();
  }

  function closeSheet() {
    if (!open) return;
    open = false;
    sheet.hidden = true;
    document.body.classList.remove('sheet-open');
    update();
    miniExpand.focus();
  }

  const actions = {
    expand: openSheet,
    collapse: closeSheet,
    play: () => player.toggle(),
    prev: () => player.prev(),
    next: () => player.next(),
    back: () => player.skip(-10),
    forward: () => player.skip(15),
    speed: () => player.cycleSpeed(),
    ab: () => player.toggleAB(),
    fav: () => player.state.episode && store.toggleFavorite(player.state.episode),
    autonext: () => store.setSetting('autoNext', !store.state.settings.autoNext),
    'retry-audio': () => player.retry(),
    'reload-transcript': loadTranscript,
  };

  const onClick = (event) => {
    const tab = event.target.closest('[data-pane-tab]');
    if (tab) {
      showPane(tab.getAttribute('data-pane-tab'));
      return;
    }
    const button = event.target.closest('[data-action]');
    const action = button && actions[button.getAttribute('data-action')];
    if (action) action();
  };
  mini.addEventListener('click', onClick);
  sheet.addEventListener('click', onClick);

  seek.addEventListener('input', () => {
    if (player.state.dur) player.seek((Number(seek.value) / 1000) * player.state.dur);
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && open) closeSheet();
  });

  player.on(update);
  store.on((topic) => {
    if (topic === 'favorites' || topic === 'settings') update();
  });
  setPlayIcon(miniPlay, false);
  setPlayIcon(playButton, false);
  miniPlay.dataset.playing = 'false';
  update();

  return { open: openSheet, close: closeSheet };
}
