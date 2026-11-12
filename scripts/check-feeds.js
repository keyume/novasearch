#!/usr/bin/env node
// 逐个检查内置节目的 RSS 地址还能不能用。
//
//   node scripts/check-feeds.js
//
// 有节目失败时退出码为 1。需要能直接访问外网。
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { parseFeed } = require('../api/_lib/rss.js');
const { safeFetchText } = require('../api/_lib/safe-fetch.js');

const MAX_BYTES = 5 * 1024 * 1024;
const CONCURRENCY = 4;

async function checkOne(show, fetchText) {
  const row = { id: show.id, title: show.title, ok: false, episodes: 0, latest: null, feedTitle: null, error: null };
  try {
    const { text } = await fetchText(show.feedUrl, { maxBytes: MAX_BYTES });
    const feed = parseFeed(text);
    row.feedTitle = feed.title;
    row.episodes = feed.episodes.length;
    const newest = feed.episodes.find((episode) => episode.pubDate);
    row.latest = newest ? newest.pubDate.slice(0, 10) : null;
    if (row.episodes === 0) row.error = '没有可播放的单集';
    else row.ok = true;
  } catch (err) {
    row.error = err && err.code === 'NOT_A_FEED' ? '不是可识别的 RSS' : (err && err.message) || String(err);
  }
  return row;
}

async function checkFeeds(shows, fetchText = safeFetchText) {
  const rows = new Array(shows.length);
  let next = 0;
  async function worker() {
    while (next < shows.length) {
      const index = next;
      next += 1;
      rows[index] = await checkOne(shows[index], fetchText);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, shows.length) }, worker));
  return rows;
}

function formatReport(rows) {
  const lines = rows.map((row) =>
    row.ok
      ? `正常  ${row.id.padEnd(26)} ${row.episodes} 集  最新 ${row.latest || '未知'}  ${row.feedTitle}`
      : `失败  ${row.id.padEnd(26)} ${row.error}`
  );
  const good = rows.filter((row) => row.ok).length;
  lines.push('', `${good} 个正常，${rows.length - good} 个失败`);
  return lines.join('\n');
}

module.exports = { checkFeeds, formatReport };

if (require.main === module) {
  (async () => {
    const catalogUrl = pathToFileURL(path.join(__dirname, '../listen/js/catalog.js')).href;
    const { CATALOG } = await import(catalogUrl);
    const rows = await checkFeeds(CATALOG);
    console.log(formatReport(rows));
    process.exitCode = rows.every((row) => row.ok) ? 0 : 1;
  })();
}
