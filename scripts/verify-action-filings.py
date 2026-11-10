"""Recheck immutable publisher PDFs and discovery coverage; never access a brokerage account.

Run: python3 scripts/verify-action-filings.py --output /tmp/filing-verification.json
Optional: --pdf-dir /tmp/filings to retain original files for visual inspection.
Only Python standard library and the bundled JSON fixture are used.
"""
import argparse
import concurrent.futures
import hashlib
import json
from pathlib import Path
import re
from urllib.parse import urlencode
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent.parent
BOOKS = json.loads((ROOT / 'fixtures/corporate-action-books.json').read_text())
ARCHIVES = {
    'sh603099': ('9900022933', '2025-05-01', '2025-07-02'),
    'sh688556': ('gfbj0834278', '2025-05-01', '2025-07-02'),
    'sz002780': ('9900023789', '2026-04-01', '2026-11-10'),
}

def get(url, form=None):
    req = Request(url, data=urlencode(form).encode() if form else None,
                  headers={'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.cninfo.com.cn/'})
    with urlopen(req, timeout=15) as response:
        return response.read()

def verify(book, pdf_dir):
    symbol = book['symbol']
    code, (issuer_id, start, end) = symbol[2:], ARCHIVES[symbol]
    seen, notices = set(), []
    for page in range(1, 100):
        raw = get('https://www.cninfo.com.cn/new/hisAnnouncement/query', {
            'pageNum': page, 'pageSize': 30, 'column': 'szse', 'tabName': 'fulltext',
            'stock': code + ',' + issuer_id, 'seDate': start + '~' + end, 'isHLtitle': 'false',
            'plate': '', 'searchkey': '', 'secid': '', 'category': '', 'trade': '', 'sortName': '', 'sortType': ''
        })
        response = json.loads(raw)
        rows = response.get('announcements')
        if not isinstance(rows, list) or not rows or any(x['secCode'] != code for x in rows):
            raise ValueError('Missing/incorrect issuer archive for ' + symbol)
        for row in rows:
            if row['announcementId'] in seen:
                raise ValueError('Duplicate filing page; refusing incomplete archive')
            seen.add(row['announcementId'])
            notices.append(row)
        if not response['hasMore']:
            break
    else:
        raise ValueError('Archive page limit exceeded')
    candidates = [{'title': r['announcementTitle'], 'url': 'https://static.cninfo.com.cn/' + r['adjunctUrl']}
                  for r in notices if re.search('分派|配股|转增股本|合并实施|拆股|要约收购实施', r['announcementTitle'])]
    actual = {c['url'] for c in candidates if re.search('权益分派实施公告', c['title'])}
    expected = {e['source'] for e in book['events']}
    if actual != expected:
        raise ValueError('New/missing implementation notice: re-review manually: ' + symbol + ' ' + str(actual ^ expected))
    files = []
    for e in book['events']:
        raw = get(e['source'])
        digest = hashlib.sha256(raw).hexdigest()
        if not raw.startswith(b'%PDF-') or digest != e['sha256']:
            raise ValueError('Publisher PDF changed; recheck terms: ' + e['id'])
        if pdf_dir:
            (pdf_dir / (e['id'] + '.pdf')).write_bytes(raw)
        files.append({'id': e['id'], 'url': e['source'], 'bytes': len(raw), 'sha256': digest})
    return {'symbol': symbol, 'archiveStart': start, 'archiveEnd': end, 'issuerId': issuer_id,
            'announcementCount': len(notices), 'candidatesForManualReview': candidates, 'verifiedFiles': files}

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', type=Path)
    parser.add_argument('--pdf-dir', type=Path)
    args = parser.parse_args()
    if args.pdf_dir:
        args.pdf_dir.mkdir(parents=True, exist_ok=True)
    with concurrent.futures.ThreadPoolExecutor(3) as pool:
        reports = list(pool.map(lambda b: verify(b, args.pdf_dir), BOOKS))
    result = json.dumps({'asOf': '2026-11-10', 'scope': 'issuer archive + original implementation-notice SHA-256; manual per-share extraction', 'books': reports}, ensure_ascii=False, indent=2) + '\n'
    if args.output:
        args.output.write_text(result)
    print(result)
