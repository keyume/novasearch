// GET /api/feed?url=<RSS 地址> → 解析后的节目与单集 JSON
const { createTextHandler, publicError } = require('./_lib/handler.js');
const { parseFeed } = require('./_lib/rss.js');
const { safeFetchText } = require('./_lib/safe-fetch.js');

const create = createTextHandler({
  maxBytes: 5 * 1024 * 1024,
  cacheControl: 's-maxage=900, stale-while-revalidate=3600',
  failureMessage: '无法获取节目源',
  transform({ text }) {
    try {
      return parseFeed(text);
    } catch (err) {
      if (err && err.code === 'NOT_A_FEED') throw publicError(502, '这个地址不是可识别的播客 RSS');
      throw err;
    }
  },
});

module.exports = create(safeFetchText);
module.exports.create = create;
