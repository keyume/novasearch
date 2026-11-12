const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { checkFeeds, formatReport } = require('../../scripts/check-feeds.js');
const { FetchError } = require('../../api/_lib/safe-fetch.js');

const xml = fs.readFileSync(path.join(__dirname, '../fixtures/feeds/basic.xml'), 'utf8');
const shows = [
  { id: 'good', title: 'Good Show', feedUrl: 'https://good.test/rss' },
  { id: 'down', title: 'Down Show', feedUrl: 'https://down.test/rss' },
  { id: 'html', title: 'Not A Feed', feedUrl: 'https://html.test/rss' },
  { id: 'empty', title: 'Empty Show', feedUrl: 'https://empty.test/rss' },
];
const fetchText = async (url) => {
  if (url.includes('down.test')) throw new FetchError('UPSTREAM', '上游返回 404');
  if (url.includes('html.test')) return { text: '<html></html>', contentType: 'text/html', finalUrl: url };
  if (url.includes('empty.test')) {
    return { text: '<rss><channel><title>E</title></channel></rss>', contentType: 'text/xml', finalUrl: url };
  }
  return { text: xml, contentType: 'text/xml', finalUrl: url };
};

test('checkFeeds：逐个检查并保持顺序', async () => {
  const rows = await checkFeeds(shows, fetchText);
  assert.deepEqual(rows.map((r) => r.id), ['good', 'down', 'html', 'empty']);
  assert.deepEqual(rows[0], {
    id: 'good', title: 'Good Show', ok: true, episodes: 4, latest: '2026-11-12', feedTitle: 'Sample Show', error: null,
  });
  assert.equal(rows[1].ok, false);
  assert.match(rows[1].error, /404/);
  assert.equal(rows[2].ok, false);
  assert.match(rows[2].error, /RSS/);
  assert.equal(rows[3].ok, false);
  assert.match(rows[3].error, /没有可播放的单集/);
});

test('formatReport：每个节目一行，并给出汇总', () => {
  const report = formatReport([
    { id: 'good', title: 'Good Show', ok: true, episodes: 4, latest: '2026-11-12', feedTitle: 'Sample Show', error: null },
    { id: 'down', title: 'Down Show', ok: false, episodes: 0, latest: null, feedTitle: null, error: '上游返回 404' },
  ]);
  assert.match(report, /正常\s+good\s+4 集\s+最新 2026-11-12/);
  assert.match(report, /失败\s+down\s+上游返回 404/);
  assert.match(report, /1 个正常，1 个失败/);
});
