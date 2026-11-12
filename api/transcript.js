// GET /api/transcript?url=<文稿地址> → { paragraphs: string[] }
const { createTextHandler, publicError } = require('./_lib/handler.js');
const { parseTranscript } = require('./_lib/transcript.js');
const { safeFetchText } = require('./_lib/safe-fetch.js');

const create = createTextHandler({
  maxBytes: 1024 * 1024,
  cacheControl: 's-maxage=86400, stale-while-revalidate=604800',
  failureMessage: '无法获取文稿',
  transform({ text, contentType, finalUrl }) {
    const paragraphs = parseTranscript(text, contentType, finalUrl);
    if (paragraphs.length === 0) throw publicError(502, '无法获取文稿');
    return { paragraphs };
  },
});

module.exports = create(safeFetchText);
module.exports.create = create;
