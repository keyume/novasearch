const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseFeed, parseDuration } = require('../../api/_lib/rss.js');

const xml = fs.readFileSync(path.join(__dirname, '../fixtures/feeds/basic.xml'), 'utf8');
const feed = parseFeed(xml);
const eps = feed.episodes;

test('解析频道信息', () => {
  assert.equal(feed.title, 'Sample Show');
  assert.equal(feed.image, 'https://img.test/cover.jpg');
  assert.equal(feed.link, 'https://show.test/');
  assert.equal(feed.description, 'A show about <b>things</b>.');
});

test('丢弃没有音频的条目', () => {
  assert.equal(eps.length, 4);
  assert.ok(!eps.some((e) => e.title === 'Article Without Audio'));
});

test('CDATA 标题与实体', () => {
  assert.equal(eps[0].title, 'Tides & the Moon');
});

test('时长：HH:MM:SS 与纯秒数', () => {
  assert.equal(eps[0].duration, 812);
  assert.equal(eps[1].duration, 812);
  assert.equal(eps[2].duration, null);
});

test('parseDuration', () => {
  assert.equal(parseDuration('13:32'), 812);
  assert.equal(parseDuration('01:02:03'), 3723);
  assert.equal(parseDuration(812), 812);
  assert.equal(parseDuration('812.6'), 813);
  assert.equal(parseDuration(''), null);
  assert.equal(parseDuration('abc'), null);
  assert.equal(parseDuration(undefined), null);
  assert.equal(parseDuration('0'), null);
  assert.equal(parseDuration('-5'), null);
});

test('http 音频地址升级为 https', () => {
  assert.equal(eps[2].audioUrl, 'https://cdn.test/ep-3.mp3');
});

test('缺 guid 为 null；guid 带属性时取文本', () => {
  assert.equal(eps[2].guid, null);
  assert.equal(eps[0].guid, 'ep-1');
});

test('无法解析的 pubDate 为 null 且排在最后', () => {
  assert.equal(eps[3].title, 'Bad Date');
  assert.equal(eps[3].pubDate, null);
});

test('pubDate 输出 ISO', () => {
  assert.equal(eps[0].pubDate, '2026-11-12T10:00:00.000Z');
});

test('取 podcast:transcript，优先 vtt，忽略不支持的类型', () => {
  assert.equal(eps[0].transcriptUrl, 'https://t.test/1.vtt');
  assert.equal(eps[1].transcriptUrl, null);
});

test('简介优先级：content:encoded → description → itunes:summary', () => {
  assert.match(eps[0].descriptionHtml, /<p>Full notes for episode one\.<\/p>/);
  assert.equal(eps[1].descriptionHtml, 'Plain description for ep 2.');
  assert.equal(eps[2].descriptionHtml, 'Summary only.');
  assert.equal(eps[3].descriptionHtml, '');
});

test('简介截断到 5000 字符', () => {
  const long = 'x'.repeat(9000);
  const f = parseFeed(
    `<rss><channel><title>T</title><item><title>a</title><enclosure url="https://c.test/a.mp3"/><description>${long}</description></item></channel></rss>`
  );
  assert.equal(f.episodes[0].descriptionHtml.length, 5000);
});

test('limit', () => {
  assert.equal(parseFeed(xml, { limit: 2 }).episodes.length, 2);
});

test('默认最多 30 集', () => {
  const items = Array.from(
    { length: 40 },
    (_, i) => `<item><title>e${i}</title><enclosure url="https://c.test/${i}.mp3"/></item>`
  ).join('');
  assert.equal(parseFeed(`<rss><channel><title>T</title>${items}</channel></rss>`).episodes.length, 30);
});

test('非 RSS 输入', () => {
  assert.throws(() => parseFeed('<html><body>hi</body></html>'), { code: 'NOT_A_FEED' });
  assert.throws(() => parseFeed(''), { code: 'NOT_A_FEED' });
  assert.throws(() => parseFeed('not xml at all'), { code: 'NOT_A_FEED' });
});

test('单条目（非数组）也能解析', () => {
  const f = parseFeed(
    '<rss><channel><title>One</title><item><title>only</title><enclosure url="https://c.test/1.mp3" type="audio/mpeg"/></item></channel></rss>'
  );
  assert.equal(f.episodes.length, 1);
  assert.equal(f.episodes[0].title, 'only');
  assert.equal(f.image, null);
  assert.equal(f.link, null);
});

test('没有任何条目的频道返回空列表', () => {
  assert.deepEqual(parseFeed('<rss><channel><title>Empty</title></channel></rss>').episodes, []);
});

test('数字标题与数字 guid 转为字符串', () => {
  const f = parseFeed(
    '<rss><channel><title>2026</title><item><title>1984</title><guid>12345</guid><enclosure url="https://c.test/1.mp3"/></item></channel></rss>'
  );
  assert.equal(f.title, '2026');
  assert.equal(f.episodes[0].title, '1984');
  assert.equal(f.episodes[0].guid, '12345');
});

test('非 http(s) 的音频地址被丢弃', () => {
  const f = parseFeed(
    '<rss><channel><title>T</title><item><title>x</title><enclosure url="javascript:alert(1)"/></item></channel></rss>'
  );
  assert.equal(f.episodes.length, 0);
});
