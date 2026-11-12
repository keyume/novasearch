// 各种格式的文稿 → 段落数组。纯函数。
const MAX_PARAGRAPHS = 2000;
const PAUSE_SECONDS = 2; // 相邻字幕间隔达到这个值就另起一段
const LONG_PARAGRAPH = 400; // 段落超过这个长度且句子结束时另起一段

const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(value) {
  return value.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{1,8});/gi, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1].toLowerCase() === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named === undefined ? whole : named;
  });
}

const DROPPED_TAGS = new Set(['script', 'style', 'head', 'noscript']);
const BLOCK_TAGS = new Set([
  'p', 'div', 'br', 'li', 'ul', 'ol', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'tr', 'section', 'article', 'blockquote',
]);

// 去掉标签。只向前扫描、每个字符最多看一遍：输入来自任意网址，
// 用正则回溯的写法会被构造的内容拖成平方级耗时。
// blocks 为 true 时，块级标签处输出换行；注释和 script/style 等连同内容丢弃。
function stripTags(text, { blocks = false } = {}) {
  const lower = blocks ? text.toLowerCase() : text;
  const out = [];
  let i = 0;
  while (i < text.length) {
    const lt = text.indexOf('<', i);
    if (lt === -1) {
      out.push(text.slice(i));
      break;
    }
    out.push(text.slice(i, lt));
    if (blocks && text.startsWith('<!--', lt)) {
      const end = text.indexOf('-->', lt + 4);
      if (end === -1) break;
      i = end + 3;
      continue;
    }
    const gt = text.indexOf('>', lt + 1);
    if (gt === -1) break; // 没有闭合的标签：后面的内容不可信，丢弃
    if (blocks) {
      const name = /^<\/?([a-z][a-z0-9]{0,15})/.exec(lower.slice(lt, lt + 18));
      const tag = name ? name[1] : '';
      if (DROPPED_TAGS.has(tag) && lower[lt + 1] !== '/') {
        const close = lower.indexOf(`</${tag}`, gt + 1);
        if (close === -1) break;
        const closeEnd = text.indexOf('>', close);
        if (closeEnd === -1) break;
        i = closeEnd + 1;
        continue;
      }
      if (BLOCK_TAGS.has(tag)) out.push('\n');
    }
    i = gt + 1;
  }
  return out.join('');
}

const tidy = (value) => decodeEntities(value).replace(/[ \t\n\r\f\v\u00a0]+/g, ' ').trim();
const clean = (value) => tidy(stripTags(value));

function detectFormat(text, contentType, url) {
  const type = String(contentType || '').toLowerCase();
  const pathname = String(url || '').split(/[?#]/)[0].toLowerCase();
  if (/^WEBVTT/.test(text) || type.includes('text/vtt') || pathname.endsWith('.vtt')) return 'cues';
  if (type.includes('srt') || type.includes('subrip') || pathname.endsWith('.srt')) return 'cues';
  if (type.includes('html') || text.startsWith('<')) return 'html';
  return 'plain';
}

// "00:01:02.500"、"01:02,500" → 秒
function toSeconds(stamp) {
  const parts = stamp.replace(',', '.').split(':').map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return null;
  return parts.reduce((total, n) => total * 60 + n, 0);
}

// VTT 与 SRT 结构相同：空行分块，块内有一行时间码，其后是字幕文本。
function fromCues(text) {
  const paragraphs = [];
  let current = '';
  let lastEnd = null;

  for (const block of text.split(/\n{2,}/)) {
    const lines = block.split('\n');
    const timingIndex = lines.findIndex((line) => line.includes('-->'));
    if (timingIndex === -1) continue;

    const [startRaw, endRaw = ''] = lines[timingIndex].split('-->');
    const start = toSeconds(startRaw.trim());
    const end = toSeconds(endRaw.trim().split(/\s+/)[0]);
    const cue = clean(lines.slice(timingIndex + 1).join(' '));
    if (!cue) continue;

    const paused = start !== null && lastEnd !== null && start - lastEnd >= PAUSE_SECONDS;
    const longEnough = current.length > LONG_PARAGRAPH && /[.?!]["')\]]?$/.test(current);
    if (current && (paused || longEnough)) {
      paragraphs.push(current);
      current = '';
    }
    current = current ? `${current} ${cue}` : cue;
    if (end !== null) lastEnd = end;
  }
  if (current) paragraphs.push(current);
  return paragraphs;
}

function fromHtml(text) {
  return stripTags(text, { blocks: true }).split('\n').map(tidy).filter(Boolean);
}

// 按空行分段。逐行处理，不用会回溯的 \n\s*\n。
function fromPlain(text) {
  const paragraphs = [];
  let current = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed) {
      current.push(trimmed);
    } else if (current.length) {
      paragraphs.push(current.join(' '));
      current = [];
    }
  }
  if (current.length) paragraphs.push(current.join(' '));
  return paragraphs.map((paragraph) => paragraph.replace(/[ \t]+/g, ' '));
}

function parseTranscript(input, contentType, url) {
  const text = String(input || '').replace(/^﻿/, '').replace(/\r\n?/g, '\n').trim();
  if (!text) return [];
  const format = detectFormat(text, contentType, url);
  const paragraphs = format === 'cues' ? fromCues(text) : format === 'html' ? fromHtml(text) : fromPlain(text);
  return paragraphs.slice(0, MAX_PARAGRAPHS);
}

module.exports = { parseTranscript };
