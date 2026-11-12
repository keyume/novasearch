// /api/feed 与 /api/transcript 共用的入口逻辑：校验参数、抓取、转换、错误映射。
const { statusFor } = require('./safe-fetch.js');

// transform 可以抛出带 status 与 publicMessage 的错误来指定响应。
function createTextHandler({ maxBytes, cacheControl, failureMessage, transform }) {
  return function create(fetchText) {
    return async function handler(req, res) {
      res.setHeader('Cache-Control', 'no-store');
      if (req.method !== 'GET') return res.status(405).json({ error: '只支持 GET 请求' });

      const raw = req.query ? req.query.url : undefined;
      const url = typeof raw === 'string' ? raw.trim() : '';
      if (!url) return res.status(400).json({ error: '缺少 url 参数' });

      try {
        const fetched = await fetchText(url, { maxBytes });
        const body = transform(fetched);
        res.setHeader('Cache-Control', cacheControl);
        return res.status(200).json(body);
      } catch (err) {
        if (err && err.publicMessage) return res.status(err.status || 502).json({ error: err.publicMessage });
        const status = statusFor(err);
        const message =
          status === 400 ? '地址不合法或不被允许' : status === 504 ? '节目源响应超时' : failureMessage;
        return res.status(status).json({ error: message });
      }
    };
  };
}

function publicError(status, publicMessage) {
  const err = new Error(publicMessage);
  err.status = status;
  err.publicMessage = publicMessage;
  return err;
}

module.exports = { createTextHandler, publicError };
