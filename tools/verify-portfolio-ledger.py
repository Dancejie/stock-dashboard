#!/usr/bin/env python3
"""Reconcile the production JS ledger against a separate Decimal implementation.

Default: offline; read frozen public data and print the report. --refresh fetches
two explicit RAW endpoints per security and rewrites the fixture. --write-report
writes the verified report; no network/third-party libraries are needed offline.
"""
import argparse
from datetime import datetime, timezone
from decimal import Decimal as D, ROUND_HALF_UP
import hashlib
import json
from pathlib import Path
import subprocess
from urllib.parse import urlencode
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
FIXTURE = ROOT / 'tests/fixtures/portfolio-ledger-raw-202506.json'
REPORT = ROOT / 'validation/portfolio-ledger-real-202506.json'
A, B = 'sh603099', 'sh688556'
SYMBOLS = (A, B)
START, END = '2025-06-16', '2025-07-02'
FILINGS = {
    A: 'https://static.cninfo.com.cn/finalpage/2025-06-13/1223859419.PDF',
    B: 'https://static.cninfo.com.cn/finalpage/2025-06-20/1223935346.PDF',
}
SPEC = dict(mode='shares', rebalance='monthly', start=START, end=END, initialCash=5000,
            assets=[dict(symbol=A, name='长白山', quantity=1000, sellableQty=1000, weight=45),
                    dict(symbol=B, name='高测股份', quantity=2000, sellableQty=2000, weight=45)],
            executionOptions=dict(commissionRate=0.0003, minCommission=5, slippageBps=5))


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def refresh():
    data = {'adjustment': 'raw', 'fetchedAt': datetime.now(timezone.utc).isoformat(), 'symbols': {}}
    for symbol in SYMBOLS:
        urls = {
            'tencent': 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?' +
                       urlencode({'param': f'{symbol},day,2025-06-13,{END},100,'}),
            'eastmoney': 'https://push2his.eastmoney.com/api/qt/stock/kline/get?' + urlencode({
                'secid': '1.' + symbol[2:], 'klt': 101, 'fqt': 0, 'beg': '20250613', 'end': '20250702',
                'lmt': 30, 'fields1': 'f1,f2,f3', 'fields2': 'f51,f52,f53,f54,f55,f56'}),
        }
        packs = {}
        for provider, url in urls.items():
            with urlopen(Request(url, headers={'User-Agent': 'stock-dashboard-public-ledger-verification/1'}), timeout=15) as response:
                body = json.load(response)
            if provider == 'tencent':
                rows = body['data'][symbol]['day']  # never use qfqday/hfqday
                rows = [row[:6] for row in rows]
            else:
                assert body['data']['code'] == symbol[2:]
                rows = [raw.split(',')[:6] for raw in body['data']['klines']]
            packs[provider] = {'url': url, 'sha256': digest(rows), 'rows': rows}
        data['symbols'][symbol] = packs
    compare_sources(data)
    FIXTURE.parent.mkdir(parents=True, exist_ok=True)
    FIXTURE.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n')
    return data


def compare_sources(data):
    assert data['adjustment'] == 'raw'
    checks = 0
    for key in SYMBOLS:
        packs = data['symbols'][key]
        t, e = [packs[p]['rows'] for p in ('tencent', 'eastmoney')]
        for p in packs.values():
            assert digest(p['rows']) == p['sha256']
        assert len(e) == len(t) == 14
        for a, b in zip(t, e):
            assert a[0] == b[0]
            for x, y in zip(a[1:5], b[1:5]):
                assert D(x) == D(y), (key, a[0], x, y)
                checks += 1
            # Providers can report shares vs lots. This ledger only uses the
            # zero/unknown/nonzero state; do not claim volume counts are equal.
            assert D(a[5]) > 0 and D(b[5]) > 0
    return checks


def cents(x):
    return x.quantize(D('.01'), rounding=ROUND_HALF_UP)


def reference(data, rebalance):
    """Eastmoney fqt=0 prices, explicit official record dates, independent arithmetic.

    This oracle intentionally only describes this finite case. It imports no production
    JS rule, indicator, event book, signal, or fill and never uses JS outputs as inputs.
    """
    prices = {s: {r[0]: {'open': D(r[1]), 'close': D(r[2])} for r in data['symbols'][s]['eastmoney']['rows']} for s in SYMBOLS}
    days = sorted(d for d in prices[A] if START <= d <= END)
    assert days == sorted(d for d in prices[B] if START <= d <= END)
    shares = {A: 1000, B: 2000}
    cash = D('5000')
    orders, fills, daily, entitlements = [], [], [], {}
    for day in days:
        sellable = shares.copy()
        if day == '2025-06-27':  # Listing date specified by 688556 2025-035.
            bonus = int(D(entitlements[B]) * D('.4'))
            shares[B] += bonus
            sellable[B] += bonus
        if day == '2025-07-01' and rebalance:
            for s, delta in sorted(orders, key=lambda x: x[1]):  # sell before buy
                if not delta:
                    continue
                buying, qty = delta > 0, abs(delta)
                assert (s == A and qty % 100 == 0) or (s == B and qty >= 200)
                p = cents(prices[s][day]['open'] * (D('1.0005') if buying else D('.9995')))
                gross = cents(qty * p)
                commission = cents(max(D(5), gross * D('.0003')))
                transfer = cents(gross * D('.00001'))
                stamp = D(0) if buying else cents(gross * D('.0005'))
                fees = commission + transfer + stamp
                cash += (-gross if buying else gross) - fees
                shares[s] += delta
                if not buying:
                    sellable[s] += delta
                assert cash >= 0 and sellable[s] >= 0
                fills.append({'symbol': s, 'side': 'buy' if buying else 'sell', 'quantity': qty, 'price': p,
                              'commission': commission, 'stampTax': stamp, 'transferFee': transfer, 'totalFees': fees, 'amount': gross})
        # Payments booked at close. These two filings' ex/pay dates coincide, and
        # the bonus shares list on the ex date; no outstanding claims at day end.
        if day == '2025-06-20':
            cash += cents(D(entitlements[A]) * D('.0815'))
        if day == '2025-06-27':
            cash += cents(D(entitlements[B]) * D('.18'))
        if day == '2025-06-19':
            entitlements[A] = shares[A]
        if day == '2025-06-26':
            entitlements[B] = shares[B]
        nav = cash + sum(cents(shares[s] * prices[s][day]['close']) for s in SYMBOLS)
        daily.append({'time': day, 'value': nav, 'cash': cash, 'shares': shares.copy(), 'sellable': sellable.copy()})
        if rebalance and day == '2025-06-30':
            for s in SYMBOLS:
                ideal = int(nav * D('.45') / prices[s][day]['close'])
                delta = ideal - shares[s]
                if s == A:
                    delta = (1 if delta >= 0 else -1) * (abs(delta) // 100 * 100)
                elif abs(delta) < 200:
                    delta = 0
                orders.append((s, delta))
    return daily, fills


def verify(data):
    source_checks = compare_sources(data)
    packs = {}
    for s in SYMBOLS:
        rows = data['symbols'][s]['tencent']['rows']
        packs[s] = {'meta': {'symbol': s, 'adjustment': 'raw', 'corporateActionsIncluded': False},
                    'bars': [dict(time=r[0], open=float(r[1]), close=float(r[2]), high=float(r[3]), low=float(r[4]), volume=float(r[5])) for r in rows]}
    spec = dict(SPEC, barsBySymbol=packs)
    runner = "const fs=require('node:fs'); const spec=JSON.parse(fs.readFileSync(0,'utf8')); process.stdout.write(JSON.stringify(require('./portfolio-ledger.js').calculate(spec)));"
    js = json.loads(subprocess.run(['node', '-e', runner], cwd=ROOT, input=json.dumps(spec), capture_output=True,
                                   text=True, check=True).stdout, parse_float=D)
    expected, expected_fills = reference(data, True)
    hold, _ = reference(data, False)
    assert len(expected) == len(js['equity']) == len(hold) == len(js['baseline']['equity']) == 13
    max_nav_error = D(0)
    assertions = 0
    comparison = []
    for modeled, truth, modeled_hold, hold_truth in zip(js['equity'], expected, js['baseline']['equity'], hold):
        assert modeled['time'] == truth['time'] == modeled_hold['time'] == hold_truth['time']
        err = abs(modeled['value'] - truth['value'])
        max_nav_error = max(err, max_nav_error)
        assert err == 0 and modeled['cash'] == truth['cash']
        assert modeled_hold['value'] == hold_truth['value'] and modeled_hold['cash'] == hold_truth['cash']
        assert modeled['receivableCash'] == modeled['pendingStockValue'] == 0
        assertions += 7
        for s in SYMBOLS:
            assert modeled['holdings'][s]['shares'] == truth['shares'][s]
            assert modeled['holdings'][s]['sellableQty'] == truth['sellable'][s]
            assertions += 2
        comparison.append({'date': truth['time'], 'engineNAV': str(modeled['value']), 'independentNAV': str(truth['value']),
                           'cash': str(truth['cash']), 'shares': truth['shares'], 'sellable': truth['sellable'], 'buyHoldNAV': str(hold_truth['value'])})
    assert len(js['actions']) == 2 and [a['eligibleShares'] for a in js['actions']] == [1000, 2000]
    assert [a['addedShares'] for a in js['actions']] == [0, 800]
    assert [a['cashAmount'] for a in js['actions']] == [D('81.50'), D('360.00')]
    assert len(js['rebalances']) == 1 and js['rebalances'][0]['signalDate'] == '2025-06-30'
    assert len(js['fills']) == len(expected_fills) == js['rebalances'][0]['fillCount'] == 2
    assert all(t['time'] == '2025-07-01' and t['signalDate'] == '2025-06-30' for t in js['fills'])
    for modeled, truth in zip(js['fills'], expected_fills):
        for k, v in truth.items():
            assert modeled[k] == v, (k, modeled[k], v)
            assertions += 1
    assert js['finalNAV'] == expected[-1]['value'] and js['baseline']['finalNAV'] == hold[-1]['value']
    return {'sample': SPEC, 'priceAdjustment': 'raw_only', 'priceFixtureHash': digest(data['symbols']),
            'filings': FILINGS, 'priceSources': {s: {k: b['url'] for k, b in data['symbols'][s].items()} for s in SYMBOLS},
            'sourceOHLCAssertions': source_checks, 'dailyAndFillAssertions': assertions,
            'realTradingDays': 13, 'uniqueHeldCorporateActions': 2, 'cashDividendPayments': 2, 'capitalizationEvents': 1,
            'grossCashDividends': '441.50', 'bonusShares': 800, 'rebalances': js['rebalances'], 'fills': js['fills'],
            'initialNAV': js['initialNAV'], 'finalNAV': js['finalNAV'], 'buyHoldFinalNAV': js['baseline']['finalNAV'],
            'totalCash': js['finalCash'], 'totalFees': js['totalFees'], 'maxDailyNAVErrorCNY': str(max_nav_error),
            'daily': comparison, 'limitation': 'One 13-session accounting example, not a profitability or broker-fill test. Gross dividends; individual sale-time withholding is excluded. Volumes are not compared across vendor units.'}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--refresh', action='store_true')
    parser.add_argument('--write-report', action='store_true')
    args = parser.parse_args()
    data = refresh() if args.refresh else json.loads(FIXTURE.read_text())
    result = verify(data)
    result_text = json.dumps(result, ensure_ascii=False, indent=2, default=str)
    if args.write_report:
        REPORT.parent.mkdir(parents=True, exist_ok=True)
        REPORT.write_text(result_text + '\n')
    print(json.dumps({k: result[k] for k in ['realTradingDays', 'uniqueHeldCorporateActions', 'grossCashDividends', 'bonusShares',
        'initialNAV', 'finalNAV', 'buyHoldFinalNAV', 'totalCash', 'totalFees', 'sourceOHLCAssertions', 'dailyAndFillAssertions', 'maxDailyNAVErrorCNY']}, default=str))
