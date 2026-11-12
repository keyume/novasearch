#!/usr/bin/env node
// 本地开发与测试用的服务器：静态文件 + /api/feed、/api/transcript。
//
//   node scripts/dev-server.js [--port 3000] [--fixtures]
//
// --fixtures：不访问外网。任何节目地址都返回按当前时间生成的样例节目，
// 音频是内存里生成的一段提示音，https://bad.test/… 固定失败。
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const feedHandler = require('../api/feed.js');
const transcriptHandler = require('../api/transcript.js');
const { FetchError } = require('../api/_lib/safe-fetch.js');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.xml': 'text/xml; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
};

const TONE_SECONDS = 120;
const TONE_RATE = 8000;

// 8 位单声道 PCM 的 WAV：一段很轻的 440Hz 提示音。
function buildToneWav() {
  const samples = TONE_SECONDS * TONE_RATE;
  const buffer = Buffer.alloc(44 + samples);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + samples, 4);
  buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // 单声道
  buffer.writeUInt32LE(TONE_RATE, 24);
  buffer.writeUInt32LE(TONE_RATE, 28);
  buffer.writeUInt16LE(1, 32);
  buffer.writeUInt16LE(8, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(samples, 40);
  for (let i = 0; i < samples; i += 1) {
    buffer[44 + i] = 128 + Math.round(10 * Math.sin((2 * Math.PI * 440 * i) / TONE_RATE));
  }
  return buffer;
}

const FIXTURE_VTT = `WEBVTT

00:00:01.000 --> 00:00:04.000
Welcome to the sample episode.

00:00:04.200 --> 00:00:08.000
This transcript is generated for local testing.

00:00:12.000 --> 00:00:16.000
Here is a second paragraph after a pause.
`;

const escapeXml = (value) =>
  value.replace(/[<>&"]/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[ch]));

function buildFixtureFeed(feedUrl, now) {
  const url = new URL(feedUrl);
  const name = `${url.hostname}${url.pathname}`;
  const hours = [1, 26, 120];
  const items = hours.map((ago, index) => {
    const n = index + 1;
    const notes =
      n === 1
        ? `<p>Notes for ${escapeXml(name)}, episode 1.</p><script>window.__xss = 1</script>` +
          '<img src="x" onerror="window.__xss = 2">' +
          '<p><a href="https://example.com/more">Read more</a> <a href="javascript:window.__xss=3">bad link</a></p>'
        : `<p>Notes for ${escapeXml(name)}, episode ${n}.</p>`;
    const transcript =
      n === 1 ? `<podcast:transcript url="https://${url.hostname}/t/1.vtt" type="text/vtt"/>` : '';
    return `<item>
      <title>${escapeXml(name)} · Episode ${n}</title>
      <guid>${escapeXml(feedUrl)}#${n}</guid>
      <pubDate>${new Date(now - ago * 3600 * 1000).toUTCString()}</pubDate>
      <link>https://${url.hostname}/episodes/${n}</link>
      <enclosure url="https://${url.hostname}/audio/${n}.wav" type="audio/wav"/>
      <itunes:duration>${TONE_SECONDS}</itunes:duration>
      <description><![CDATA[${notes}]]></description>
      ${transcript}
    </item>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:podcast="https://podcastindex.org/namespace/1.0">
  <channel>
    <title>Fixture: ${escapeXml(name)}</title>
    <link>https://${url.hostname}/</link>
    <description>Generated sample feed for ${escapeXml(name)}</description>
    ${items.join('\n')}
  </channel>
</rss>`;
}

async function fixtureFetchText(input) {
  const url = new URL(input);
  if (url.hostname === 'bad.test') throw new FetchError('UPSTREAM', 'fixture failure');
  if (url.pathname.endsWith('.vtt')) {
    return { text: FIXTURE_VTT, contentType: 'text/vtt', finalUrl: url.href };
  }
  return { text: buildFixtureFeed(url.href, Date.now()), contentType: 'text/xml', finalUrl: url.href };
}

// 给处理函数提供与 Vercel 相同的 req.query、res.status().json()。
function runHandler(handler, req, res, url, rewrite) {
  const query = {};
  for (const key of new Set(url.searchParams.keys())) {
    const values = url.searchParams.getAll(key);
    query[key] = values.length > 1 ? values : values[0];
  }
  const headers = {};
  let status = 200;
  const shim = {
    setHeader(name, value) {
      headers[name] = value;
    },
    status(code) {
      status = code;
      return shim;
    },
    json(body) {
      const payload = JSON.stringify(rewrite && status === 200 ? rewrite(body) : body);
      res.writeHead(status, { ...headers, 'Content-Type': 'application/json; charset=utf-8' });
      res.end(payload);
      return shim;
    },
  };
  return handler({ method: req.method, query }, shim);
}

function sendRange(req, res, buffer, type) {
  const base = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };
  const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (!match || (match[1] === '' && match[2] === '')) {
    res.writeHead(200, { ...base, 'Content-Length': buffer.length });
    return res.end(req.method === 'HEAD' ? undefined : buffer);
  }
  let start;
  let end;
  if (match[1] === '') {
    start = Math.max(0, buffer.length - Number(match[2]));
    end = buffer.length - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === '' ? buffer.length - 1 : Math.min(Number(match[2]), buffer.length - 1);
  }
  if (start > end || start >= buffer.length) {
    res.writeHead(416, { ...base, 'Content-Range': `bytes */${buffer.length}` });
    return res.end();
  }
  res.writeHead(206, {
    ...base,
    'Content-Range': `bytes ${start}-${end}/${buffer.length}`,
    'Content-Length': end - start + 1,
  });
  return res.end(req.method === 'HEAD' ? undefined : buffer.subarray(start, end + 1));
}

function notFound(res) {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found');
}

function serveStatic(req, res, root, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return notFound(res);
  }
  if (decoded.includes('\0')) return notFound(res);

  const segments = decoded.split(/[\\/]+/).filter(Boolean);
  // 不提供隐藏文件、依赖目录，也不允许 .. 出现在路径里。
  if (segments.some((s) => s === '..' || s.startsWith('.') || s === 'node_modules')) return notFound(res);

  const target = path.join(root, ...segments);
  if (target !== root && !target.startsWith(root + path.sep)) return notFound(res);

  let stat;
  try {
    stat = fs.statSync(target);
  } catch {
    return notFound(res);
  }
  // 与 Vercel 一致：目录带不带结尾斜杠都直接返回 index.html，不做重定向。
  if (stat.isDirectory()) return serveFile(req, res, path.join(target, 'index.html'));
  return serveFile(req, res, target);
}

function serveFile(req, res, file) {
  fs.readFile(file, (err, data) => {
    if (err) return notFound(res);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': 'no-store',
    });
    return res.end(req.method === 'HEAD' ? undefined : data);
  });
}

function createDevServer({ root, fixtures = false }) {
  const base = path.resolve(root);
  const feed = fixtures ? feedHandler.create(fixtureFetchText) : feedHandler;
  const transcript = fixtures ? transcriptHandler.create(fixtureFetchText) : transcriptHandler;
  const tone = fixtures ? buildToneWav() : null;

  // 样例模式下把音频地址指回本服务器，这样浏览器真的能播放。
  const localAudio = (body) => ({
    ...body,
    episodes: body.episodes.map((episode, index) => ({
      ...episode,
      audioUrl: `/__fixtures/tone.wav?e=${index + 1}`,
    })),
  });

  return http.createServer((req, res) => {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      return notFound(res);
    }
    // new URL 会把 /../ 规范化掉，所以静态文件用原始路径来判断。
    const rawPath = req.url.split('?')[0];

    if (url.pathname === '/api/feed') {
      return runHandler(feed, req, res, url, fixtures ? localAudio : null).catch(() => notFound(res));
    }
    if (url.pathname === '/api/transcript') {
      return runHandler(transcript, req, res, url, null).catch(() => notFound(res));
    }
    if (url.pathname.startsWith('/api/')) return notFound(res);
    if (tone && url.pathname === '/__fixtures/tone.wav') return sendRange(req, res, tone, 'audio/wav');
    if (req.method !== 'GET' && req.method !== 'HEAD') return notFound(res);
    return serveStatic(req, res, base, rawPath);
  });
}

module.exports = { createDevServer };

if (require.main === module) {
  const args = process.argv.slice(2);
  const portIndex = args.indexOf('--port');
  const port = portIndex === -1 ? Number(process.env.PORT) || 3000 : Number(args[portIndex + 1]);
  const fixtures = args.includes('--fixtures');
  createDevServer({ root: path.join(__dirname, '..'), fixtures }).listen(port, () => {
    console.log(`http://localhost:${port}/listen/${fixtures ? '  (样例数据)' : ''}`);
  });
}
