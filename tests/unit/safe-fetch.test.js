const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const zlib = require('node:zlib');
const {
  FetchError,
  isPrivateAddress,
  assertSafeUrl,
  safeFetchText,
  statusFor,
} = require('../../api/_lib/safe-fetch.js');

test('isPrivateAddress：内网、回环、保留地址', () => {
  const blocked = [
    '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1',
    '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255',
    '::1', 'fc00::1', 'fd12:3456::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1',
    '::', 'ff02::1', '64:ff9b::7f00:1',
  ];
  for (const ip of blocked) assert.equal(isPrivateAddress(ip), true, ip);
});

test('isPrivateAddress：公网地址', () => {
  for (const ip of ['8.8.8.8', '172.32.0.1', '1.1.1.1', '2606:4700::1111', '::ffff:8.8.8.8']) {
    assert.equal(isPrivateAddress(ip), false, ip);
  }
});

test('isPrivateAddress：不是 IP 的输入按拦截处理', () => {
  assert.equal(isPrivateAddress('example.com'), true);
  assert.equal(isPrivateAddress(''), true);
});

test('assertSafeUrl：拒绝不合法或指向内网的地址', () => {
  const bad = [
    '', 'not a url', 'ftp://a.test/x', 'file:///etc/passwd', 'http://localhost/',
    'http://app.localhost/', 'http://127.0.0.1/', 'http://[::1]/', 'https://a.test:8080/',
    'javascript:alert(1)', 'http://2130706433/', 'http://0x7f.1/', 'https://user:pw@a.test/',
    'http://169.254.169.254/latest/meta-data/',
  ];
  for (const input of bad) {
    assert.throws(() => assertSafeUrl(input), (err) => err instanceof FetchError && err.code === 'BAD_URL', input);
  }
});

test('assertSafeUrl：接受普通地址并返回 URL', () => {
  assert.equal(assertSafeUrl('https://feeds.example.com/show.xml').hostname, 'feeds.example.com');
  assert.equal(assertSafeUrl('http://example.com:80/x').href, 'http://example.com/x');
  assert.equal(assertSafeUrl(' https://example.com:443/x ').href, 'https://example.com/x');
});

test('statusFor', () => {
  assert.equal(statusFor(new FetchError('BAD_URL', 'x')), 400);
  assert.equal(statusFor(new FetchError('TIMEOUT', 'x')), 504);
  assert.equal(statusFor(new FetchError('UPSTREAM', 'x')), 502);
  assert.equal(statusFor(new FetchError('TOO_LARGE', 'x')), 502);
  assert.equal(statusFor(new Error('boom')), 502);
});

// ---- 集成：本地服务器，通过注入的 lookup 把 feed.test 指到 127.0.0.1 ----

let server;
let port;
let lookups = 0;

const localLookup = (hostname, options, cb) => {
  lookups += 1;
  const address = hostname === 'private.test' ? '10.0.0.1' : '127.0.0.1';
  if (options && options.all) cb(null, [{ address, family: 4 }]);
  else cb(null, address, 4);
};

function opts(extra = {}) {
  return {
    maxBytes: 1024,
    lookup: localLookup,
    ports: [port],
    isBlocked: (ip) => ip === '10.0.0.1',
    ...extra,
  };
}

const url = (p) => `http://feed.test:${port}${p}`;
const rejectsWith = (promise, code) =>
  assert.rejects(promise, (err) => err instanceof FetchError && err.code === code);

test.before(async () => {
  server = http.createServer((req, res) => {
    const path = req.url;
    if (path === '/ok') {
      res.writeHead(200, { 'content-type': 'application/rss+xml; charset=utf-8' });
      res.end('<rss>héllo</rss>');
    } else if (path === '/gzip') {
      res.writeHead(200, { 'content-type': 'text/xml', 'content-encoding': 'gzip' });
      res.end(zlib.gzipSync('<rss>zipped</rss>'));
    } else if (path === '/latin1') {
      res.writeHead(200, { 'content-type': 'text/xml; charset=iso-8859-1' });
      res.end(Buffer.from('caf\xe9', 'latin1'));
    } else if (path === '/redirect') {
      res.writeHead(302, { location: '/ok' });
      res.end();
    } else if (path.startsWith('/hop')) {
      const n = Number(path.slice(4));
      res.writeHead(301, { location: n > 1 ? `/hop${n - 1}` : '/ok' });
      res.end();
    } else if (path === '/to-private-ip') {
      res.writeHead(302, { location: 'http://10.0.0.1/' });
      res.end();
    } else if (path === '/to-private-host') {
      res.writeHead(302, { location: `http://private.test:${port}/ok` });
      res.end();
    } else if (path === '/to-file') {
      res.writeHead(302, { location: 'file:///etc/passwd' });
      res.end();
    } else if (path === '/big') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('x'.repeat(5000));
    } else if (path === '/big-gzip') {
      res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' });
      res.end(zlib.gzipSync('x'.repeat(50000)));
    } else if (path === '/hang') {
      // 永不响应
    } else if (path === '/slow-body') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.write('start');
    } else {
      res.writeHead(404);
      res.end('nope');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});

test.after(() => {
  server.closeAllConnections();
  server.close();
});

test('safeFetchText：返回文本、类型与最终地址', async () => {
  const out = await safeFetchText(url('/ok'), opts());
  assert.equal(out.text, '<rss>héllo</rss>');
  assert.match(out.contentType, /application\/rss\+xml/);
  assert.equal(out.finalUrl, url('/ok'));
});

test('safeFetchText：解压 gzip', async () => {
  const out = await safeFetchText(url('/gzip'), opts());
  assert.equal(out.text, '<rss>zipped</rss>');
});

test('safeFetchText：按响应头的字符集解码', async () => {
  const out = await safeFetchText(url('/latin1'), opts());
  assert.equal(out.text, 'café');
});

test('safeFetchText：跟随重定向', async () => {
  const out = await safeFetchText(url('/redirect'), opts());
  assert.equal(out.text, '<rss>héllo</rss>');
  assert.equal(out.finalUrl, url('/ok'));
});

test('safeFetchText：5 次重定向可以，6 次报 UPSTREAM', async () => {
  assert.equal((await safeFetchText(url('/hop5'), opts())).finalUrl, url('/ok'));
  await rejectsWith(safeFetchText(url('/hop6'), opts()), 'UPSTREAM');
});

test('safeFetchText：重定向到内网 IP → BAD_URL', async () => {
  await rejectsWith(safeFetchText(url('/to-private-ip'), opts({ ports: [port, 80] })), 'BAD_URL');
});

test('safeFetchText：重定向到解析为内网的主机 → BAD_URL', async () => {
  await rejectsWith(safeFetchText(url('/to-private-host'), opts()), 'BAD_URL');
});

test('safeFetchText：重定向到非 http 协议 → BAD_URL', async () => {
  await rejectsWith(safeFetchText(url('/to-file'), opts()), 'BAD_URL');
});

test('safeFetchText：域名解析到被拦截的地址 → BAD_URL，且用的是注入的 lookup', async () => {
  const before = lookups;
  await rejectsWith(safeFetchText(`http://private.test:${port}/ok`, opts()), 'BAD_URL');
  assert.ok(lookups > before);
});

test('safeFetchText：默认规则拦截解析到 127.0.0.1 的域名', async () => {
  await rejectsWith(
    safeFetchText(url('/ok'), { maxBytes: 1024, lookup: localLookup, ports: [port] }),
    'BAD_URL'
  );
});

test('safeFetchText：默认只允许 80/443 端口', async () => {
  await rejectsWith(safeFetchText(url('/ok'), { maxBytes: 1024, lookup: localLookup }), 'BAD_URL');
});

test('safeFetchText：超过 maxBytes → TOO_LARGE', async () => {
  await rejectsWith(safeFetchText(url('/big'), opts()), 'TOO_LARGE');
});

test('safeFetchText：大小按解压后计算', async () => {
  await rejectsWith(safeFetchText(url('/big-gzip'), opts()), 'TOO_LARGE');
});

test('safeFetchText：不响应 → TIMEOUT', async () => {
  await rejectsWith(safeFetchText(url('/hang'), opts({ timeoutMs: 200 })), 'TIMEOUT');
});

test('safeFetchText：响应体迟迟不结束 → TIMEOUT', async () => {
  await rejectsWith(safeFetchText(url('/slow-body'), opts({ timeoutMs: 200 })), 'TIMEOUT');
});

test('safeFetchText：上游 404 → UPSTREAM', async () => {
  await rejectsWith(safeFetchText(url('/missing'), opts()), 'UPSTREAM');
});

test('safeFetchText：连接被拒 → UPSTREAM', async () => {
  await rejectsWith(
    safeFetchText('http://feed.test:1/ok', opts({ ports: [1], timeoutMs: 2000 })),
    'UPSTREAM'
  );
});

test('safeFetchText：超限后立即停止解压，不在后台继续消耗 CPU', async () => {
  // brotli 对全零数据压缩率极高：整个炸弹只有几百字节，一个数据包就全部到达，
  // 所以光断开连接不够，必须把解压器本身停掉。
  const bomb = zlib.brotliCompressSync(Buffer.alloc(512 * 1024 * 1024), {
    params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 1 },
  });
  const bombServer = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'br' });
    res.end(bomb);
  });
  await new Promise((resolve) => bombServer.listen(0, '127.0.0.1', resolve));
  const bombPort = bombServer.address().port;
  try {
    await rejectsWith(
      safeFetchText(`http://feed.test:${bombPort}/`, opts({ ports: [bombPort] })),
      'TOO_LARGE'
    );
    const before = process.cpuUsage();
    await new Promise((resolve) => setTimeout(resolve, 500));
    const used = process.cpuUsage(before);
    const cpuMs = (used.user + used.system) / 1000;
    assert.ok(cpuMs < 200, `still used ${cpuMs.toFixed(0)}ms CPU after rejecting`);
  } finally {
    bombServer.closeAllConnections();
    bombServer.close();
  }
});

test('safeFetchText：重定向后不留下未关闭的连接', async () => {
  await safeFetchText(url('/hop3'), opts());
  await new Promise((resolve) => setTimeout(resolve, 100));
  const open = await new Promise((resolve) => server.getConnections((err, count) => resolve(count)));
  assert.equal(open, 0);
});
