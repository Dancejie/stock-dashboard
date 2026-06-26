const http = require('http');
const https = require('https');
const url = require('url');

const PORT = 7788;

const ALLOWED = [
  'money.finance.sina.com.cn',
  'push2.eastmoney.com',
  'searchapi.eastmoney.com',
  'push2his.eastmoney.com',
];

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  const q = url.parse(req.url, true);
  const target = q.query.url;
  if (!target) { res.writeHead(400); res.end('missing url param'); return; }

  let parsed;
  try { parsed = new URL(target); } catch { res.writeHead(400); res.end('bad url'); return; }

  if (!ALLOWED.some(h => parsed.hostname === h || parsed.hostname.endsWith('.' + h))) {
    res.writeHead(403); res.end('host not allowed'); return;
  }

  const options = {
    hostname: parsed.hostname,
    path: parsed.pathname + parsed.search,
    method: 'GET',
    headers: {
      'Referer': 'https://quote.eastmoney.com/',
      'User-Agent': 'Mozilla/5.0 Chrome/120.0.0.0 Safari/537.36',
    }
  };

  const proto = parsed.protocol === 'https:' ? https : http;
  const proxyReq = proto.get(options, proxyRes => {
    res.writeHead(proxyRes.statusCode, { 'Content-Type': proxyRes.headers['content-type'] || 'application/json' });
    proxyRes.pipe(res);
  });
  proxyReq.on('error', e => { res.writeHead(502); res.end(e.message); });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Stock proxy running on http://0.0.0.0:${PORT}`);
});
