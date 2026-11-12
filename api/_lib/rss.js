// RSS 文本 → 统一的节目与单集结构。纯函数，不做网络请求。
const { XMLParser } = require('fast-xml-parser');

const DEFAULT_LIMIT = 30;
const MAX_DESCRIPTION = 5000;

// 文稿类型的优先级：越靠前越适合显示为纯文本。
const TRANSCRIPT_TYPES = [
  ['text/vtt'],
  ['application/srt', 'application/x-subrip', 'text/srt'],
  ['text/plain'],
  ['text/html'],
];

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  processEntities: true,
  htmlEntities: true,
});

function notAFeed() {
  const err = new Error('Not an RSS feed');
  err.code = 'NOT_A_FEED';
  return err;
}

function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

// 节点可能是字符串，也可能是带属性的对象（文本在 #text 里）。
function text(node) {
  if (node === undefined || node === null) return '';
  if (Array.isArray(node)) return text(node[0]);
  if (typeof node === 'object') return text(node['#text']);
  return String(node).trim();
}

function httpUrl(value, { upgrade = false } = {}) {
  const raw = text(value);
  if (!raw) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (upgrade) url.protocol = 'https:';
  return url.href;
}

function parseDuration(value) {
  const raw = text(value);
  if (!raw) return null;
  const parts = raw.split(':');
  if (parts.length > 3 || parts.some((p) => p === '' || !/^\d+(\.\d+)?$/.test(p))) return null;
  const seconds = parts.reduce((total, p) => total * 60 + Number(p), 0);
  const rounded = Math.round(seconds);
  return rounded > 0 ? rounded : null;
}

function parseDate(value) {
  const raw = text(value);
  if (!raw) return null;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

function pickAudio(item) {
  const enclosures = asArray(item.enclosure);
  const audio =
    enclosures.find((e) => String(e?.['@_type'] || '').startsWith('audio/')) || enclosures[0];
  return audio ? httpUrl(audio['@_url'], { upgrade: true }) : null;
}

function pickTranscript(item) {
  const candidates = asArray(item['podcast:transcript']);
  for (const types of TRANSCRIPT_TYPES) {
    const match = candidates.find((c) =>
      types.includes(String(c?.['@_type'] || '').split(';')[0].trim().toLowerCase())
    );
    const url = match && httpUrl(match['@_url'], { upgrade: true });
    if (url) return url;
  }
  return null;
}

function pickDescription(item) {
  const value =
    text(item['content:encoded']) || text(item.description) || text(item['itunes:summary']);
  return value.slice(0, MAX_DESCRIPTION);
}

function toEpisode(item) {
  const audioUrl = pickAudio(item);
  if (!audioUrl) return null;
  return {
    guid: text(item.guid) || null,
    title: text(item.title) || '(无标题)',
    pubDate: parseDate(item.pubDate),
    audioUrl,
    duration: parseDuration(item['itunes:duration']),
    descriptionHtml: pickDescription(item),
    link: httpUrl(item.link),
    transcriptUrl: pickTranscript(item),
  };
}

function byNewest(a, b) {
  if (a.pubDate === b.pubDate) return 0;
  if (a.pubDate === null) return 1;
  if (b.pubDate === null) return -1;
  return a.pubDate < b.pubDate ? 1 : -1;
}

function parseFeed(xml, { limit = DEFAULT_LIMIT } = {}) {
  let doc;
  try {
    doc = parser.parse(String(xml || ''));
  } catch {
    throw notAFeed();
  }
  const channel = asArray(doc?.rss?.channel)[0];
  if (!channel || typeof channel !== 'object') throw notAFeed();

  const episodes = asArray(channel.item)
    .filter((item) => item && typeof item === 'object')
    .map(toEpisode)
    .filter(Boolean)
    .sort(byNewest)
    .slice(0, limit);

  return {
    title: text(channel.title) || '(未命名节目)',
    image:
      httpUrl(asArray(channel['itunes:image'])[0]?.['@_href'], { upgrade: true }) ||
      httpUrl(asArray(channel.image)[0]?.url, { upgrade: true }),
    link: httpUrl(channel.link),
    description: text(channel.description),
    episodes,
  };
}

module.exports = { parseFeed, parseDuration };
