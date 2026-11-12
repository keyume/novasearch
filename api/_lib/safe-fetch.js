// 抓取任意外部地址的文本，同时防止被用来访问内网（SSRF）。
//
// 关键点：地址校验放在请求的 lookup 回调里，所以被校验的 IP 就是实际连接的 IP，
// 不存在「先解析检查、再解析连接」之间被换地址的空档。字面量 IP 不经过 lookup，
// 在 assertSafeUrl 里单独检查。
const http = require('node:http');
const https = require('node:https');
const dns = require('node:dns');
const net = require('node:net');
const zlib = require('node:zlib');

const DEFAULT_PORTS = [80, 443];
const DEFAULT_TIMEOUT_MS = 10000;
const MAX_REDIRECTS = 5;
const USER_AGENT = 'Mozilla/5.0 (compatible; listen-feed-reader)';

class FetchError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'FetchError';
    this.code = code;
  }
}

const blockList = new net.BlockList();
[
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
].forEach(([prefix, bits]) => blockList.addSubnet(prefix, bits, 'ipv4'));
[
  ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['2001:db8::', 32],
  ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
].forEach(([prefix, bits]) => blockList.addSubnet(prefix, bits, 'ipv6'));

// ::ffff:a.b.c.d 与 ::ffff:hhhh:hhhh 两种写法都还原成 IPv4。
function mappedIPv4(ip) {
  const dotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (dotted) return dotted[1];
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(ip);
  if (!hex) return null;
  const hi = parseInt(hex[1], 16);
  const lo = parseInt(hex[2], 16);
  return [hi >> 8, hi & 255, lo >> 8, lo & 255].join('.');
}

function isPrivateAddress(ip) {
  const value = String(ip || '');
  const family = net.isIP(value);
  if (family === 4) return blockList.check(value, 'ipv4');
  if (family === 6) {
    const v4 = mappedIPv4(value);
    if (v4) return blockList.check(v4, 'ipv4');
    return blockList.check(value, 'ipv6');
  }
  return true;
}

function assertSafeUrl(input, { ports = DEFAULT_PORTS, isBlocked = isPrivateAddress } = {}) {
  const bad = () => new FetchError('BAD_URL', '地址不合法或不被允许');
  let url;
  try {
    url = new URL(String(input || '').trim());
  } catch {
    throw bad();
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw bad();
  if (url.username || url.password) throw bad();
  if (url.port && !ports.includes(Number(url.port))) throw bad();

  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.localhost')) throw bad();
  if (net.isIP(host) && isBlocked(host)) throw bad();
  return url;
}

function guardedLookup(lookup, isBlocked) {
  return (hostname, options, callback) => {
    lookup(hostname, options, (err, address, family) => {
      if (err) return callback(err);
      const addresses = Array.isArray(address) ? address.map((a) => a.address) : [address];
      if (addresses.length === 0 || addresses.some((ip) => isBlocked(ip))) {
        return callback(new FetchError('BAD_URL', '地址不合法或不被允许'));
      }
      return callback(null, address, family);
    });
  };
}

function decoderFor(encoding) {
  switch (String(encoding || '').trim().toLowerCase()) {
    case 'gzip':
    case 'x-gzip':
      return zlib.createGunzip();
    case 'deflate':
      return zlib.createInflate();
    case 'br':
      return zlib.createBrotliDecompress();
    default:
      return null;
  }
}

function decodeText(buffer, contentType) {
  const match = /charset\s*=\s*"?([^";\s]+)/i.exec(contentType || '');
  if (match) {
    try {
      return new TextDecoder(match[1]).decode(buffer);
    } catch {
      // 不认识的字符集，按 UTF-8 处理
    }
  }
  return new TextDecoder('utf-8').decode(buffer);
}

// 发一次请求。成功时得到 { redirect } 或 { text, contentType }。
function requestOnce(url, { lookup, isBlocked, maxBytes, deadline }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const fail = (err) =>
      settle(reject, err instanceof FetchError ? err : new FetchError('UPSTREAM', err.message));

    const client = url.protocol === 'https:' ? https : http;
    const req = client.request(
      url,
      {
        method: 'GET',
        agent: false,
        lookup: guardedLookup(lookup, isBlocked),
        headers: {
          'User-Agent': USER_AGENT,
          Accept: '*/*',
          'Accept-Encoding': 'gzip, deflate, br',
        },
      },
      (res) => {
        const status = res.statusCode || 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          return settle(resolve, { redirect: res.headers.location });
        }
        if (status < 200 || status >= 300) {
          res.destroy();
          return fail(new FetchError('UPSTREAM', `上游返回 ${status}`));
        }

        const decoder = decoderFor(res.headers['content-encoding']);
        const body = decoder ? res.pipe(decoder) : res;
        const chunks = [];
        let size = 0;
        body.on('data', (chunk) => {
          size += chunk.length;
          if (size > maxBytes) {
            req.destroy();
            fail(new FetchError('TOO_LARGE', '响应过大'));
          } else {
            chunks.push(chunk);
          }
        });
        body.on('end', () => {
          const contentType = String(res.headers['content-type'] || '');
          settle(resolve, { text: decodeText(Buffer.concat(chunks), contentType), contentType });
        });
        body.on('error', fail);
        if (decoder) res.on('error', fail);
        return undefined;
      }
    );

    timer = setTimeout(() => {
      fail(new FetchError('TIMEOUT', '请求超时'));
      req.destroy();
    }, Math.max(0, deadline - Date.now()));

    req.on('error', fail);
    req.end();
  });
}

async function safeFetchText(input, options = {}) {
  const {
    maxBytes,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    lookup = dns.lookup,
    isBlocked = isPrivateAddress,
    ports = DEFAULT_PORTS,
  } = options;
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) throw new TypeError('maxBytes is required');

  const deadline = Date.now() + timeoutMs;
  let url = assertSafeUrl(input, { ports, isBlocked });

  for (let redirects = 0; ; redirects += 1) {
    const result = await requestOnce(url, { lookup, isBlocked, maxBytes, deadline });
    if (!result.redirect) {
      return { text: result.text, contentType: result.contentType, finalUrl: url.href };
    }
    if (redirects >= MAX_REDIRECTS) throw new FetchError('UPSTREAM', '重定向次数过多');
    let next;
    try {
      next = new URL(result.redirect, url).href;
    } catch {
      throw new FetchError('UPSTREAM', '重定向地址无效');
    }
    url = assertSafeUrl(next, { ports, isBlocked });
  }
}

function statusFor(err) {
  if (err && err.code === 'BAD_URL') return 400;
  if (err && err.code === 'TIMEOUT') return 504;
  return 502;
}

module.exports = { FetchError, isPrivateAddress, assertSafeUrl, safeFetchText, statusFor };
