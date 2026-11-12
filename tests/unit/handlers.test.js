const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const feedHandler = require('../../api/feed.js');
const transcriptHandler = require('../../api/transcript.js');
const { FetchError } = require('../../api/_lib/safe-fetch.js');
const { createDevServer } = require('../../scripts/dev-server.js');

const ROOT = path.join(__dirname, '../..');
const basicXml = fs.readFileSync(path.join(__dirname, '../fixtures/feeds/basic.xml'), 'utf8');

async function call(handler, { method = 'GET', query = {} } = {}) {
  const res = {
    statusCode: 200,
    headers: {},
    body: undefined,
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
  await handler({ method, query }, res);
  return res;
}

const returning = (text, contentType = 'text/xml') => {
  const calls = [];
  const fetchText = async (url, options) => {
    calls.push({ url, options });
    return { text, contentType, finalUrl: url };
  };
  return { fetchText, calls };
};
const failing = (code) => async () => {
  throw new FetchError(code, 'x');
};

// ---- /api/feed ----

test('feed：成功', async () => {
  const { fetchText, calls } = returning(basicXml);
  const res = await call(feedHandler.create(fetchText), { query: { url: ' https://show.test/rss ' } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.title, 'Sample Show');
  assert.equal(res.body.episodes.length, 4);
  assert.equal(res.headers['cache-control'], 's-maxage=900, stale-while-revalidate=3600');
  assert.equal(calls[0].url, 'https://show.test/rss');
});

test('feed：以 maxBytes 5 MB 调用抓取', async () => {
  const { fetchText, calls } = returning(basicXml);
  await call(feedHandler.create(fetchText), { query: { url: 'https://show.test/rss' } });
  assert.equal(calls[0].options.maxBytes, 5 * 1024 * 1024);
});

test('feed：缺 url 或 url 不是单个字符串 → 400', async () => {
  const { fetchText, calls } = returning(basicXml);
  const handler = feedHandler.create(fetchText);
  for (const query of [{}, { url: '' }, { url: '   ' }, { url: ['a', 'b'] }]) {
    const res = await call(handler, { query });
    assert.equal(res.statusCode, 400);
    assert.equal(typeof res.body.error, 'string');
  }
  assert.equal(calls.length, 0);
});

test('feed：BAD_URL → 400', async () => {
  const res = await call(feedHandler.create(failing('BAD_URL')), { query: { url: 'http://127.0.0.1/' } });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, '地址不合法或不被允许');
});

test('feed：TIMEOUT → 504', async () => {
  const res = await call(feedHandler.create(failing('TIMEOUT')), { query: { url: 'https://a.test/' } });
  assert.equal(res.statusCode, 504);
  assert.equal(res.body.error, '节目源响应超时');
});

test('feed：UPSTREAM 与 TOO_LARGE → 502', async () => {
  for (const code of ['UPSTREAM', 'TOO_LARGE']) {
    const res = await call(feedHandler.create(failing(code)), { query: { url: 'https://a.test/' } });
    assert.equal(res.statusCode, 502);
    assert.equal(res.body.error, '无法获取节目源');
  }
});

test('feed：上游不是 RSS → 502', async () => {
  const { fetchText } = returning('<html><body>hello</body></html>', 'text/html');
  const res = await call(feedHandler.create(fetchText), { query: { url: 'https://a.test/' } });
  assert.equal(res.statusCode, 502);
  assert.equal(typeof res.body.error, 'string');
});

test('feed：错误响应不带长缓存头', async () => {
  const res = await call(feedHandler.create(failing('UPSTREAM')), { query: { url: 'https://a.test/' } });
  assert.equal(res.headers['cache-control'], 'no-store');
});

test('feed：非 GET → 405', async () => {
  const { fetchText, calls } = returning(basicXml);
  const res = await call(feedHandler.create(fetchText), { method: 'POST', query: { url: 'https://a.test/' } });
  assert.equal(res.statusCode, 405);
  assert.equal(calls.length, 0);
});

test('feed：默认导出就是处理函数', () => {
  assert.equal(typeof feedHandler, 'function');
  assert.equal(typeof feedHandler.create, 'function');
});

// ---- /api/transcript ----

test('transcript：成功返回 paragraphs；以 maxBytes 1 MB 调用', async () => {
  const { fetchText, calls } = returning('WEBVTT\n\n00:01.000 --> 00:02.000\nHello there', 'text/vtt');
  const res = await call(transcriptHandler.create(fetchText), { query: { url: 'https://t.test/a.vtt' } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { paragraphs: ['Hello there'] });
  assert.equal(calls[0].options.maxBytes, 1024 * 1024);
  assert.equal(res.headers['cache-control'], 's-maxage=86400, stale-while-revalidate=604800');
});

test('transcript：解析结果为空 → 502', async () => {
  const { fetchText } = returning('   ', 'text/plain');
  const res = await call(transcriptHandler.create(fetchText), { query: { url: 'https://t.test/a.txt' } });
  assert.equal(res.statusCode, 502);
  assert.equal(res.body.error, '无法获取文稿');
});

test('transcript：缺 url → 400；BAD_URL → 400；TIMEOUT → 504；非 GET → 405', async () => {
  const ok = returning('hi', 'text/plain').fetchText;
  assert.equal((await call(transcriptHandler.create(ok), {})).statusCode, 400);
  assert.equal((await call(transcriptHandler.create(failing('BAD_URL')), { query: { url: 'x' } })).statusCode, 400);
  assert.equal((await call(transcriptHandler.create(failing('TIMEOUT')), { query: { url: 'https://a.test' } })).statusCode, 504);
  assert.equal((await call(transcriptHandler.create(ok), { method: 'DELETE', query: { url: 'https://a.test' } })).statusCode, 405);
});

// ---- 本地开发服务器（样例模式）----

let server;
let base;

function rawGet(rawPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path: rawPath, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

test.before(async () => {
  server = createDevServer({ root: ROOT, fixtures: true });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  server.closeAllConnections();
  server.close();
});

test('dev-server：fixtures 模式下 /api/feed 返回今天的单集', async () => {
  const res = await rawGet(`/api/feed?url=${encodeURIComponent('https://feeds.example.test/show-a')}`);
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body.toString());
  assert.equal(body.episodes.length, 3);
  const age = Date.now() - Date.parse(body.episodes[0].pubDate);
  assert.ok(age >= 0 && age < 2 * 3600 * 1000);
  assert.ok(Date.now() - Date.parse(body.episodes[2].pubDate) > 4 * 86400 * 1000);
  assert.match(body.episodes[0].title, /feeds\.example\.test/);
  assert.match(body.episodes[0].audioUrl, /^\/__fixtures\/tone\.wav/);
  assert.ok(body.episodes[0].transcriptUrl);
  assert.equal(body.episodes[1].transcriptUrl, null);
  assert.match(body.episodes[0].descriptionHtml, /<script>/);
});

test('dev-server：不同地址的样例节目可以区分', async () => {
  const a = JSON.parse((await rawGet('/api/feed?url=https%3A%2F%2Fa.test%2Fx')).body.toString());
  const b = JSON.parse((await rawGet('/api/feed?url=https%3A%2F%2Fb.test%2Fy')).body.toString());
  assert.notEqual(a.episodes[0].title, b.episodes[0].title);
  assert.notEqual(a.episodes[0].guid, b.episodes[0].guid);
});

test('dev-server：fixtures 模式下 /api/transcript 返回段落', async () => {
  const res = await rawGet(`/api/transcript?url=${encodeURIComponent('https://feeds.example.test/t/1.vtt')}`);
  assert.equal(res.status, 200);
  assert.ok(JSON.parse(res.body.toString()).paragraphs.length >= 2);
});

test('dev-server：bad.test → 502', async () => {
  const res = await rawGet('/api/feed?url=https%3A%2F%2Fbad.test%2Ffeed');
  assert.equal(res.status, 502);
  assert.equal(JSON.parse(res.body.toString()).error, '无法获取节目源');
});

test('dev-server：/__fixtures/tone.wav 是 WAV 且支持 Range', async () => {
  const full = await rawGet('/__fixtures/tone.wav');
  assert.equal(full.status, 200);
  assert.equal(full.headers['content-type'], 'audio/wav');
  assert.equal(full.headers['accept-ranges'], 'bytes');
  assert.equal(full.body.subarray(0, 4).toString(), 'RIFF');
  assert.equal(Number(full.headers['content-length']), full.body.length);

  const part = await rawGet('/__fixtures/tone.wav?e=1', { Range: 'bytes=100-199' });
  assert.equal(part.status, 206);
  assert.equal(part.headers['content-range'], `bytes 100-199/${full.body.length}`);
  assert.equal(part.body.length, 100);
  assert.deepEqual(part.body, full.body.subarray(100, 200));

  const open = await rawGet('/__fixtures/tone.wav', { Range: `bytes=${full.body.length - 10}-` });
  assert.equal(open.status, 206);
  assert.equal(open.body.length, 10);
});

test('dev-server：提供静态文件并带正确的类型', async () => {
  const home = await rawGet('/');
  assert.equal(home.status, 200);
  assert.match(home.headers['content-type'], /text\/html/);
  assert.match(home.body.toString(), /NovaSearch/);
  const js = await rawGet('/scripts/dev-server.js');
  assert.match(js.headers['content-type'], /javascript/);
});

test('dev-server：拒绝越出 root 的路径、隐藏文件与 node_modules', async () => {
  for (const p of [
    '/../../../../etc/passwd',
    '/%2e%2e/%2e%2e/%2e%2e/etc/passwd',
    '/listen/..%2f..%2f..%2f..%2fetc%2fpasswd',
    '/.git/config',
    '/.gitignore',
    '/node_modules/fast-xml-parser/package.json',
    '/%00',
  ]) {
    const res = await rawGet(p);
    assert.ok(res.status === 403 || res.status === 404 || res.status === 400, `${p} → ${res.status}`);
    assert.doesNotMatch(res.body.toString(), /root:|repositoryformatversion|node_modules/);
  }
});

test('dev-server：未知路径 404', async () => {
  assert.equal((await rawGet('/nope.html')).status, 404);
  assert.equal((await rawGet('/api/unknown')).status, 404);
});

test('dev-server：非样例模式不提供 /__fixtures', async () => {
  const real = createDevServer({ root: ROOT });
  await new Promise((resolve) => real.listen(0, '127.0.0.1', resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${real.address().port}/__fixtures/tone.wav`);
    assert.equal(res.status, 404);
    await res.arrayBuffer();
  } finally {
    real.closeAllConnections();
    real.close();
  }
});
