/**
 * Stock Price Monitor Service
 * 扩展 proxy.js，增加 /watch 接口和价格监控功能
 * 触发条件时通过 OpenClaw message 工具发 Hi 消息
 * 
 * 监控任务存储在 watch-tasks.json
 */

const http = require('http');
const https = require('https');
const url = require('url');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const PORT = 7788;
const TASKS_FILE = path.join(__dirname, 'watch-tasks.json');
const CHECK_INTERVAL = 5 * 60 * 1000; // 5分钟检查一次

// ── 监控任务存储 ──────────────────────────────────────────────
function loadTasks() {
  try { return JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8')); } catch { return []; }
}
function saveTasks(tasks) {
  fs.writeFileSync(TASKS_FILE, JSON.stringify(tasks, null, 2));
}

// ── 价格获取 ──────────────────────────────────────────────────
function fetchPrice(sinaSymbol) {
  return new Promise((resolve, reject) => {
    const targetUrl = `https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData?symbol=${sinaSymbol}&scale=240&ma=no&datalen=2`;
    const req = https.get({
      hostname: 'money.finance.sina.com.cn',
      path: `/quotes_service/api/json_v2.php/CN_MarketData.getKLineData?symbol=${sinaSymbol}&scale=240&ma=no&datalen=2`,
      headers: {
        'Referer': 'https://finance.sina.com.cn/',
        'User-Agent': 'Mozilla/5.0 Chrome/120.0.0.0'
      }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const arr = JSON.parse(data);
          if (arr && arr.length > 0) {
            resolve(parseFloat(arr[arr.length - 1].close));
          } else reject(new Error('empty'));
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// ── Hi 消息发送（通过 OpenClaw message channel = hi）─────────
function sendHiMessage(text) {
  try {
    // 用 openclaw 内置 message 工具，走 hi channel 发给自己
    // 这里通过写触发文件的方式让 OpenClaw 发消息
    const triggerFile = path.join(__dirname, 'pending-notifications.json');
    let pending = [];
    try { pending = JSON.parse(fs.readFileSync(triggerFile, 'utf8')); } catch {}
    pending.push({ text, time: new Date().toISOString() });
    fs.writeFileSync(triggerFile, JSON.stringify(pending, null, 2));
    console.log(`[NOTIFY] ${text}`);
  } catch (e) {
    console.error('sendHiMessage error:', e.message);
  }
}

// ── 条件检查 ──────────────────────────────────────────────────
async function checkTask(task) {
  let price;
  try { price = await fetchPrice(task.sinaSymbol); }
  catch (e) { console.log(`[SKIP] ${task.stockName}: fetch error ${e.message}`); return; }

  const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  const triggered = [];

  for (const cond of task.conditions) {
    if (cond.triggered) continue; // 已触发过，跳过

    let hit = false;
    if (cond.type === 'below' && price <= cond.price) hit = true;
    if (cond.type === 'above' && price >= cond.price) hit = true;

    if (hit) {
      cond.triggered = true;
      cond.triggeredAt = now;
      cond.triggeredPrice = price;
      triggered.push(cond);
    }
  }

  if (triggered.length > 0) {
    const msgs = triggered.map(c => {
      if (c.type === 'below') return `🔻 ${c.label}：价格跌至 ${price} 元（≤${c.price}元）→ ${c.action}`;
      if (c.type === 'above') return `🔺 ${c.label}：价格涨至 ${price} 元（≥${c.price}元）→ ${c.action}`;
    });
    const text = `【交易信号】${task.stockName}(${task.stockCode})\n当前价：${price}元\n${msgs.join('\n')}\n时间：${now}`;
    sendHiMessage(text);
    console.log(`[TRIGGERED] ${task.stockName}: ${msgs.join(', ')}`);
  } else {
    console.log(`[OK] ${task.stockName} @ ${price}元（${now}）无触发`);
  }

  task.lastChecked = now;
  task.lastPrice = price;
}

// ── 主监控循环 ────────────────────────────────────────────────
async function runMonitor() {
  const tasks = loadTasks();
  const activeTasks = tasks.filter(t => t.active !== false);
  if (activeTasks.length === 0) return;

  console.log(`[MONITOR] 检查 ${activeTasks.length} 个监控任务...`);
  for (const task of activeTasks) {
    await checkTask(task);
    await new Promise(r => setTimeout(r, 500));
  }
  saveTasks(tasks);
}

// ── HTTP Server ───────────────────────────────────────────────
const ALLOWED_HOSTS = [
  'money.finance.sina.com.cn',
  'push2.eastmoney.com',
  'push2his.eastmoney.com',
  'searchapi.eastmoney.com',
  'datacenter-web.eastmoney.com',
];

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  const parsed = url.parse(req.url, true);

  // ── GET /?url=... 代理接口 ──
  if (req.method === 'GET' && parsed.pathname === '/') {
    const target = parsed.query.url;
    if (!target) { res.writeHead(400); res.end('missing url'); return; }

    let targetParsed;
    try { targetParsed = new URL(target); } catch { res.writeHead(400); res.end('bad url'); return; }
    if (!ALLOWED_HOSTS.some(h => targetParsed.hostname === h)) {
      res.writeHead(403); res.end('host not allowed'); return;
    }

    const options = {
      hostname: targetParsed.hostname,
      path: targetParsed.pathname + targetParsed.search,
      method: 'GET',
      headers: {
        'Referer': 'https://finance.sina.com.cn/',
        'User-Agent': 'Mozilla/5.0 Chrome/120.0.0.0 Safari/537.36',
      }
    };
    const proto = targetParsed.protocol === 'https:' ? https : http;
    const proxyReq = proto.get(options, proxyRes => {
      res.writeHead(proxyRes.statusCode, { 'Content-Type': proxyRes.headers['content-type'] || 'application/json' });
      proxyRes.pipe(res);
    });
    proxyReq.on('error', e => { res.writeHead(502); res.end(e.message); });
    return;
  }

  // ── POST /watch 注册监控任务 ──
  if (req.method === 'POST' && parsed.pathname === '/watch') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const task = JSON.parse(body);
        // 验证必填字段
        if (!task.stockCode || !task.sinaSymbol || !task.conditions) {
          res.writeHead(400); res.end(JSON.stringify({ error: 'missing fields' })); return;
        }
        task.id = `${task.stockCode}_${Date.now()}`;
        task.active = true;
        task.createdAt = new Date().toISOString();

        const tasks = loadTasks();
        // 同一只股票的旧任务标记为非活跃
        tasks.forEach(t => { if (t.stockCode === task.stockCode) t.active = false; });
        tasks.push(task);
        saveTasks(tasks);

        console.log(`[WATCH] 注册监控: ${task.stockName}(${task.stockCode}), ${task.conditions.length}个条件`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, id: task.id, message: `已开启${task.stockName}监控，${task.conditions.length}个触发条件` }));
      } catch (e) {
        res.writeHead(400); res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // ── GET /watch 查看当前监控任务 ──
  if (req.method === 'GET' && parsed.pathname === '/watch') {
    const tasks = loadTasks();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(tasks.filter(t => t.active !== false)));
    return;
  }

  // ── DELETE /watch/:code 取消监控 ──
  if (req.method === 'DELETE' && parsed.pathname.startsWith('/watch/')) {
    const code = parsed.pathname.replace('/watch/', '');
    const tasks = loadTasks();
    tasks.forEach(t => { if (t.stockCode === code) t.active = false; });
    saveTasks(tasks);
    res.writeHead(200); res.end(JSON.stringify({ ok: true }));
    return;
  }

  // ── GET /pending-notifications 让 OpenClaw 轮询取通知 ──
  if (req.method === 'GET' && parsed.pathname === '/pending-notifications') {
    try {
      const triggerFile = path.join(__dirname, 'pending-notifications.json');
      let pending = [];
      try { pending = JSON.parse(fs.readFileSync(triggerFile, 'utf8')); } catch {}
      // 清空
      if (pending.length > 0) fs.writeFileSync(triggerFile, '[]');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(pending));
    } catch (e) {
      res.writeHead(500); res.end('{}');
    }
    return;
  }

  res.writeHead(404); res.end('not found');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[SERVER] Stock proxy + monitor running on http://0.0.0.0:${PORT}`);
  // 启动定时监控
  setInterval(runMonitor, CHECK_INTERVAL);
  // 启动时立刻跑一次
  setTimeout(runMonitor, 3000);
});
