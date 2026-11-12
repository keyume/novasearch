// 各种格式的文稿 → 段落数组。纯函数。
const MAX_PARAGRAPHS = 2000;
const PAUSE_SECONDS = 2; // 相邻字幕间隔达到这个值就另起一段
const LONG_PARAGRAPH = 400; // 段落超过这个长度且句子结束时另起一段

const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(value) {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1].toLowerCase() === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named === undefined ? whole : named;
  });
}

const clean = (value) => decodeEntities(value.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();

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
  return text
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|head|noscript)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<\/?(p|div|br|li|ul|ol|h[1-6]|tr|section|article|blockquote)\b[^>]*>/gi, '\n')
    .split('\n')
    .map(clean)
    .filter(Boolean);
}

function fromPlain(text) {
  return text
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function parseTranscript(input, contentType, url) {
  const text = String(input || '').replace(/^﻿/, '').replace(/\r\n?/g, '\n').trim();
  if (!text) return [];
  const format = detectFormat(text, contentType, url);
  const paragraphs = format === 'cues' ? fromCues(text) : format === 'html' ? fromHtml(text) : fromPlain(text);
  return paragraphs.slice(0, MAX_PARAGRAPHS);
}

module.exports = { parseTranscript };
