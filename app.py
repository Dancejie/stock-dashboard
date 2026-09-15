"""Stock dashboard: Cowork SSO, per-user PostgreSQL workspace, public market data.
SSO/properties/connection helpers follow the installed fastapi-only template.
"""
from __future__ import annotations
import asyncio
import hashlib
import json
import math
import re
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Optional
from zoneinfo import ZoneInfo
import httpx
import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from fastapi import FastAPI, Header, HTTPException, Query, Request
from fastapi.responses import FileResponse, JSONResponse
from init_db import SCHEMA, load_db_props

VERSION = '2026.09.15-strategies.4'
ROOT = Path(__file__).resolve().parent
CN = ZoneInfo('Asia/Shanghai')
SYMBOL = re.compile(r'^(sh|sz)\d{6}$')
app = FastAPI(title='交易看板', docs_url=None, redoc_url=None, redirect_slashes=False)

def _get_db_conn():
    p = load_db_props('db.properties')
    if not p.get('db.host'):
        raise HTTPException(503, '个人工作区暂时不可用，请稍后重试；尚未保存的数据不会被标为已保存')
    return psycopg.connect(host=p['db.host'], port=int(p['db.port']), dbname=p['db.database'],
        user=p['db.username'], password=p['db.password'], row_factory=dict_row, connect_timeout=8)

def _parse_sso_user(decrypted_userinfo: Optional[str]):
    if not isinstance(decrypted_userinfo, str) or not decrypted_userinfo or len(decrypted_userinfo) > 16384:
        return None
    try:
        # ASGI headers are latin-1 decoded; direct calls may already contain Unicode.
        try:
            fixed = decrypted_userinfo.encode('latin-1').decode('utf-8')
        except (UnicodeEncodeError, UnicodeDecodeError):
            fixed = decrypted_userinfo
        data = json.loads(fixed)
        if not isinstance(data, dict):
            return None
        user = {key: data.get(key, '') for key in ['avatar', 'displayName', 'email', 'userId', 'name', 'emailAlias']}
        if any(not isinstance(value, str) for value in user.values()):
            return None
        if not user['userId'].strip() or not user['displayName'].strip():
            return None
        if any(ord(char) < 32 for char in user['userId']):
            return None
        if any(len(user[key]) > 320 for key in ['userId', 'displayName', 'name', 'email']):
            return None
        return user
    except (ValueError, UnicodeError, AttributeError):
        return None

def _require_user(decrypted_userinfo: Optional[str]):
    user = _parse_sso_user(decrypted_userinfo)
    if not user:
        raise HTTPException(401, 'unauthenticated')
    return user

def _provision(conn, user):
    conn.execute(SCHEMA)
    conn.execute('INSERT INTO stock_users (owner_id, email, username) VALUES (%s,%s,%s) '
        'ON CONFLICT (owner_id) DO UPDATE SET email=EXCLUDED.email, username=EXCLUDED.username',
        (user['userId'], user['email'], user['name']))
    conn.execute('INSERT INTO stock_workspaces (owner_id) VALUES (%s) ON CONFLICT (owner_id) DO NOTHING', (user['userId'],))

def _symbol(value):
    if not isinstance(value, str) or not SYMBOL.fullmatch(value):
        raise HTTPException(422, '本版回测支持沪深 A 股代码，如 sh600000 或 sz000001')
    return value

def _number(value, label, low=0, high=1e12, integer=False):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not low <= value <= high or (integer and value != int(value)):
        raise HTTPException(422, f'{label}超出允许范围')
    return value

def _name(value, default='', maximum=80):
    if value is None:
        return default
    if not isinstance(value, str) or len(value) > maximum:
        raise HTTPException(422, '名称过长或格式错误')
    return value.strip()

def validate_workspace(body):
    if not isinstance(body, dict) or len(json.dumps(body, ensure_ascii=False)) > 150000:
        raise HTTPException(422, '工作区格式或大小不正确')
    version = _number(body.get('version'), '版本', high=1e9, integer=True)
    watch = body.get('watchlist', [])
    portfolios = body.get('portfolios', [])
    if not isinstance(watch, list) or len(watch) > 100 or not isinstance(portfolios, list) or len(portfolios) > 30:
        raise HTTPException(422, '最多保存100只自选股和30个组合')
    out_watch, seen = [], set()
    for row in watch:
        if not isinstance(row, dict):
            raise HTTPException(422, '自选股格式错误')
        sym = _symbol(row.get('symbol'))
        if sym in seen:
            raise HTTPException(422, '自选股不能重复')
        seen.add(sym)
        item = {'symbol': sym, 'name': _name(row.get('name'), sym)}
        for key in ['avgCost', 'quantity', 'sellableQty']:
            if row.get(key) is not None and row.get(key) != '':
                item[key] = _number(row[key], key, integer=key != 'avgCost')
        if item.get('sellableQty', 0) > item.get('quantity', 0):
            raise HTTPException(422, '可卖数量不能超过持仓数量')
        out_watch.append(item)
    out_ports, seen = [], set()
    for row in portfolios:
        if not isinstance(row, dict):
            raise HTTPException(422, '组合格式错误')
        pid = _name(row.get('id'), maximum=100)
        if not pid or pid in seen:
            raise HTTPException(422, '组合标识为空或重复')
        seen.add(pid)
        mode = row.get('mode')
        if mode not in ['allocation', 'shares']:
            raise HTTPException(422, '请选择组合份额类型')
        start, end = _dates(row.get('start'), row.get('end'))
        assets = row.get('assets', [])
        if not isinstance(assets, list) or not 1 <= len(assets) <= 20:
            raise HTTPException(422, '每个组合需包含1至20只股票')
        checked, syms = [], set()
        for asset in assets:
            if not isinstance(asset, dict):
                raise HTTPException(422, '组合股票格式错误')
            sym = _symbol(asset.get('symbol'))
            if sym in syms:
                raise HTTPException(422, '同一组合不能重复添加股票')
            syms.add(sym)
            strategy = asset.get('strategy', 'hold')
            if strategy not in ['hold', 'mr', 'ma', 'turtle', 'boll', 'td', 'grid', 'supertrend', 'tsmom', 'chandelier']:
                raise HTTPException(422, '策略不支持')
            params = asset.get('params', {})
            if not isinstance(params, dict) or len(params) > 25:
                raise HTTPException(422, '策略参数错误')
            for key, value in params.items():
                if not isinstance(key, str) or len(key) > 40:
                    raise HTTPException(422, '策略参数名错误')
                _number(value, '策略参数', low=-1e9, high=1e9)
            checked.append({'symbol': sym, 'name': _name(asset.get('name'), sym),
                'weight': _number(asset.get('weight', 0), '比例', high=100),
                'quantity': _number(asset.get('quantity', 0), '股数', integer=True), 'strategy': strategy, 'params': params})
        if mode == 'allocation' and not 0 < sum(a['weight'] for a in checked) <= 100 + 1e-8:
            raise HTTPException(422, '总分配比例需大于0且不超过100%')
        if mode == 'shares' and not any(a['quantity'] > 0 for a in checked):
            raise HTTPException(422, '固定股数组合需至少有一只股票的持仓数量大于0')
        fees = row.get('feeOptions', {})
        if not isinstance(fees, dict):
            raise HTTPException(422, '交易费用参数格式错误')
        safe_fees = {}
        for key, upper in [('commissionRate', .05), ('minCommission', 10000), ('stampTaxRate', .05), ('slippageBps', 1000)]:
            if key in fees:
                safe_fees[key] = _number(fees[key], key, high=upper)
        out_ports.append({'id': pid, 'name': _name(row.get('name'), '未命名组合'), 'mode': mode,
            'initialCash': _number(row.get('initialCash'), '资金', low=0 if mode == 'shares' else .01),
            'start': start.isoformat(), 'end': end.isoformat(), 'assets': checked, 'feeOptions': safe_fees})
    return {'version': int(version), 'watchlist': out_watch, 'portfolios': out_ports}

def _dates(start, end, max_years=10):
    try:
        if not isinstance(start, str) or not isinstance(end, str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}', start) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}', end):
            raise ValueError('ISO date required')
        a, b = date.fromisoformat(start), date.fromisoformat(end)
    except (ValueError, TypeError):
        raise HTTPException(422, '请输入有效起止日期')
    if a > b or (b-a).days > math.ceil(max_years * 365.25) or a < date(2000,1,1) or b > datetime.now(CN).date():
        raise HTTPException(422, f'日期需为2000年至今天之内，单次跨度不超过{max_years}年')
    return a, b

@app.get('/health')
def health():
    return {'ok': True, 'version': VERSION}

@app.get('/api/session/me')
def me(decrypted_userinfo: Optional[str] = Header(None, alias='Decrypted-Userinfo')):
    user = _require_user(decrypted_userinfo)
    return JSONResponse({key: user[key] for key in ['userId', 'displayName', 'avatar']}, headers={'Cache-Control': 'no-store'})

@app.get('/api/workspace')
def get_workspace(decrypted_userinfo: Optional[str] = Header(None, alias='Decrypted-Userinfo')):
    user = _require_user(decrypted_userinfo)
    with _get_db_conn() as conn:
        _provision(conn, user)
        row = conn.execute('SELECT revision, payload FROM stock_workspaces WHERE owner_id=%s', (user['userId'],)).fetchone()
    return JSONResponse({'version': row['revision'], **row['payload']}, headers={'Cache-Control': 'no-store'})

@app.put('/api/workspace')
def put_workspace(body: dict, request: Request, decrypted_userinfo: Optional[str] = Header(None, alias='Decrypted-Userinfo')):
    user = _require_user(decrypted_userinfo)
    data = validate_workspace(body)
    payload = {k: data[k] for k in ['watchlist', 'portfolios']}
    with _get_db_conn() as conn:
        _provision(conn, user)
        row = conn.execute('UPDATE stock_workspaces SET payload=%s, revision=revision+1, updated_at=NOW() '
            'WHERE owner_id=%s AND revision=%s RETURNING revision', (Jsonb(payload), user['userId'], data['version'])).fetchone()
        if not row:
            raise HTTPException(409, '工作区已在另一页面更新，请重新载入后再保存')
    return JSONResponse({'version': row['revision'], **payload}, headers={'Cache-Control': 'no-store'})

def clean_bars(rows, start, end):
    values = {}
    if not isinstance(rows, list):
        raise HTTPException(502, '行情格式错误，已停止计算')
    for b in rows:
        try:
            if not isinstance(b, (list, tuple)) or len(b) < 5 or not isinstance(b[0], str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}', b[0]):
                raise ValueError('bar format')
            day = date.fromisoformat(b[0])
            if any(isinstance(n, bool) for n in b[1:5]):
                raise ValueError('numeric price required')
            op, cl, hi, lo = map(float, b[1:5])
            if not all(math.isfinite(n) and 1e-7 <= n <= 1e12 for n in [op,cl,hi,lo]) or lo > min(op,cl) + 1e-8 or hi < max(op,cl) - 1e-8 or hi < lo:
                raise ValueError('OHLC')
            value = {'time': day.isoformat(), 'open': op, 'close': cl, 'high': hi, 'low': lo}
            # Unknown volume is not zero volume: zero would incorrectly declare a suspension.
            volume = b[5] if len(b) > 5 else None
            if volume is not None and not (isinstance(volume, str) and not volume.strip()):
                if isinstance(volume, bool):
                    raise ValueError('volume')
                volume = float(volume)
                if not math.isfinite(volume) or not 0 <= volume <= 1e18:
                    raise ValueError('volume')
                value['volume'] = volume
            if start <= day <= end:
                if day.isoformat() in values and values[day.isoformat()] != value:
                    raise ValueError('conflicting duplicate date')
                values[day.isoformat()] = value
        except (ValueError, TypeError, IndexError, OverflowError):
            raise HTTPException(502, '行情包含无效日期或价格，已停止计算')
    return [values[k] for k in sorted(values)]

async def market_bars(symbol, start, end, adjust):
    _symbol(symbol)
    a, b = _dates(start, end, max_years=12)
    today = datetime.now(CN)
    # Completed daily bars only. The last reported quote is displayed separately.
    if b == today.date() and (today.hour, today.minute) < (15, 15):
        b -= timedelta(days=1)
    if b < a:
        raise HTTPException(422, '该区间还没有已完成的日线')
    fq = {'qfq': 'qfq', 'hfq': 'hfq', 'raw': ''}.get(adjust)
    if fq is None:
        raise HTTPException(422, '复权类型错误')
    source = '腾讯日线'
    raw = []
    cursor = b
    try:
        async with httpx.AsyncClient(timeout=15, follow_redirects=False) as client:
            for _ in range(7):
                response = await client.get('https://web.ifzq.gtimg.cn/appstock/app/fqkline/get',
                    params={'param': f'{symbol},day,,{cursor.isoformat()},640,{fq}'})
                response.raise_for_status()
                obj = response.json().get('data', {}).get(symbol, {})
                key = fq + 'day' if fq else 'day'
                chunk = obj.get(key)
                # A missing adjustment array does not prove raw prices are equivalent.
                # Fall back to another provider with the same explicit adjustment request.
                if chunk is None:
                    raise ValueError('requested adjustment series missing')
                if not isinstance(chunk, list) or not chunk:
                    break
                raw.extend(chunk)
                earliest = min(date.fromisoformat(str(x[0])[:10]) for x in chunk)
                if earliest <= a or len(chunk) < 640:
                    break
                next_cursor = earliest - timedelta(days=1)
                if next_cursor >= cursor:
                    raise ValueError('pagination did not advance')
                cursor = next_cursor
    except (httpx.HTTPError, ValueError, TypeError, KeyError, AttributeError, IndexError, OverflowError):
        raw = []
    if not raw:
        source = '东方财富日线'
        try:
            async with httpx.AsyncClient(timeout=15) as client:
                response = await client.get('https://push2his.eastmoney.com/api/qt/stock/kline/get', params={
                    'secid': ('1.' if symbol.startswith('sh') else '0.')+symbol[2:],
                    'fields1': 'f1,f2,f3', 'fields2': 'f51,f52,f53,f54,f55,f56', 'klt':101,
                    'fqt': {'raw':0,'qfq':1,'hfq':2}[adjust], 'beg':a.strftime('%Y%m%d'), 'end':b.strftime('%Y%m%d'), 'lmt':3000})
                response.raise_for_status()
                raw = [s.split(',') for s in (response.json().get('data') or {}).get('klines', [])]
        except (httpx.HTTPError, ValueError, TypeError, AttributeError):
            raise HTTPException(502, '行情源暂时不可用，请稍后重试')
    bars = clean_bars(raw, a, b)
    if not bars:
        raise HTTPException(422, f'{symbol} 在该区间没有行情')
    digest = hashlib.sha256(json.dumps(bars, separators=(',',':')).encode()).hexdigest()[:16]
    return {'bars': bars, 'meta': {'symbol':symbol,'adjust':adjust,'adjustment':adjust,'source':source,'requestedStart':start,'requestedEnd':end,
        'actualStart':bars[0]['time'],'actualEnd':bars[-1]['time'],'count':len(bars),'completedOnly':True,
        'fetchedAt':datetime.now(CN).isoformat(), 'dataHash':digest,
        'corporateActionsIncluded':False,'unknownVolumeCount':sum('volume' not in item for item in bars),
        'note':'复权序列用于收益模拟；原始价格模式不含分红及送转事件。'}}

@app.get('/api/market/bars')
async def bars(symbol: str, start: str, end: str, adjust: str='qfq', decrypted_userinfo: Optional[str] = Header(None, alias='Decrypted-Userinfo')):
    _require_user(decrypted_userinfo)
    return await market_bars(symbol, start, end, adjust)

@app.get('/api/market/quote')
async def quote(symbol: str, decrypted_userinfo: Optional[str] = Header(None, alias='Decrypted-Userinfo')):
    _require_user(decrypted_userinfo)
    _symbol(symbol)
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.get('https://qt.gtimg.cn/q='+symbol)
            r.raise_for_status()
            body = r.content.decode('gb18030',errors='replace')
            parts = body.split('"')[1].split('~')
            price, prev = float(parts[3]), float(parts[4])
            stamp = parts[30]
            op, hi, lo, volume, amount = float(parts[5]), float(parts[33]), float(parts[34]), float(parts[6])*100, float(parts[37])*10000
            if not all(math.isfinite(value) and value >= 0 for value in [price,prev,op,hi,lo,volume,amount]) or price <= 0 or parts[2] != symbol[2:] or not re.fullmatch(r'\d{14}',stamp):
                raise ValueError()
            datetime.strptime(stamp, '%Y%m%d%H%M%S')
            return {'name':parts[1],'code':parts[2],'price':price,'prevClose':prev,'open':op,
                'high':hi,'low':lo,'volume':volume,
                'amount':amount, 'changeAmt':price-prev,'changePct':(price/prev-1)*100 if prev else 0,
                'quoteTime':f'{stamp[:4]}-{stamp[4:6]}-{stamp[6:8]} {stamp[8:10]}:{stamp[10:12]}:{stamp[12:14]}',
                'quoteDate':f'{stamp[:4]}-{stamp[4:6]}-{stamp[6:8]}', 'source':'腾讯行情'}
    except (httpx.HTTPError, ValueError, IndexError):
        raise HTTPException(502,'实时行情暂不可用；历史日线仍可独立回测')

@app.get('/api/market/search')
async def search(q: str=Query(min_length=1,max_length=30), decrypted_userinfo: Optional[str] = Header(None, alias='Decrypted-Userinfo')):
    _require_user(decrypted_userinfo)
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.get('https://searchapi.eastmoney.com/api/suggest/get',params={'input':q,'type':14,'token':'D43BF722C8E33BDC906FB84D85E326E8','count':10})
            r.raise_for_status()
            rows = (r.json().get('QuotationCodeTable') or {}).get('Data') or []
            return {'items':[x for x in rows if x.get('MktNum') in ['0','1',0,1] and re.fullmatch(r'\d{6}',str(x.get('Code','')))]}
    except (httpx.HTTPError,ValueError):
        raise HTTPException(502,'搜索暂不可用，可输入完整六位股票代码')

@app.get('/')
@app.get('/index.html')
@app.get('/dashboard.html')
def index(decrypted_userinfo: Optional[str] = Header(None, alias='Decrypted-Userinfo')):
    _require_user(decrypted_userinfo)
    return FileResponse(ROOT/'index.html', headers={'Cache-Control':'no-cache'})

@app.get('/{asset}')
def asset_file(asset: str):
    if asset not in ['market-client.js','market-search.js','lightweight-charts-4.1.7.js','quant-core.js','portfolio-engine.js','workspace-ui.js','workspace-ui.css','dashboard-upgrade.js','dashboard-upgrade.css']:
        raise HTTPException(404)
    return FileResponse(ROOT/asset, headers={'Cache-Control':'no-cache'})
