"""Pure unit and in-process ASGI tests; no listener, real database or market request."""
import copy
import json
import unittest
from datetime import date, datetime, timedelta
from unittest.mock import patch

import httpx
from fastapi import HTTPException
import app as backend


def workspace(**changes):
    value = {'version': 0, 'watchlist': [{'symbol': 'sh600000', 'name': '浦发银行', 'avgCost': 8, 'quantity': 100, 'sellableQty': 100}],
             'portfolios': [{'id': 'sample', 'name': '测试组合', 'mode': 'allocation', 'initialCash': 10000,
                             'start': '2024-01-02', 'end': '2024-01-05',
                             'assets': [{'symbol': 'sh600000', 'weight': 60, 'strategy': 'hold', 'params': {}}],
                             'feeOptions': {'commissionRate': .0003, 'minCommission': 5}}]}
    value.update(changes)
    return value


def sso(identity='alice', name='张三'):
    return [(b'Decrypted-Userinfo', json.dumps({'userId': identity, 'name': name}, ensure_ascii=False).encode('utf-8'))]


class FakeResult:
    def __init__(self, row=None):
        self.row = row

    def fetchone(self):
        return copy.deepcopy(self.row)


class FakeConnection:
    def __init__(self, database):
        self.database = database

    def __enter__(self):
        self.snapshot = copy.deepcopy(self.database.rows)
        return self

    def __exit__(self, kind, value, traceback):
        if kind:
            self.database.rows = self.snapshot

    def execute(self, sql, params=()):
        self.database.calls.append((sql, params))
        if sql.startswith('CREATE TABLE') or sql.lstrip().startswith('CREATE TABLE') or sql.startswith('INSERT INTO stock_users'):
            return FakeResult()
        if sql.startswith('INSERT INTO stock_workspaces'):
            self.database.rows.setdefault(params[0], {'revision': 0, 'payload': {'watchlist': [], 'portfolios': []}})
            return FakeResult()
        if sql.startswith('SELECT revision'):
            assert 'WHERE owner_id=%s' in sql
            return FakeResult(self.database.rows.get(params[0]))
        if sql.startswith('UPDATE stock_workspaces'):
            assert 'WHERE owner_id=%s AND revision=%s' in sql
            payload, owner, revision = params
            row = self.database.rows.get(owner)
            if not row or row['revision'] != revision:
                return FakeResult()
            row['payload'] = copy.deepcopy(payload.obj)
            row['revision'] += 1
            return FakeResult({'revision': row['revision']})
        raise AssertionError('Unexpected SQL in test: ' + sql)


class FakeDatabase:
    def __init__(self):
        self.rows, self.calls = {}, []

    def connection(self):
        return FakeConnection(self)


class AuthUnitTests(unittest.TestCase):
    def test_header_utf8_and_already_decoded_chinese(self):
        encoded = json.dumps({'userId': 123, 'name': '张三'}, ensure_ascii=False)
        mojibake = encoded.encode('utf-8').decode('latin-1')
        expected = {'userId': '123', 'username': '张三', 'email': ''}
        self.assertEqual(backend._parse_sso_user(encoded), expected)
        self.assertEqual(backend._parse_sso_user(mojibake), expected)

    def test_email_identity_fallback_and_escaped_json(self):
        self.assertEqual(backend._parse_sso_user(json.dumps({'email': 'a@example.invalid', 'name': '李四'}))['userId'], 'a@example.invalid')

    def test_malformed_or_ambiguous_identity_is_not_authenticated(self):
        for value in [None, '', 'not-json', '[]', '{}', '{"name":"Nobody"}', '{"userId":true}',
                      '{"userId":{}}', '{"userId":[]}', '{"userId":"  "}', '{"userId":"a\\n"}',
                      '{"userId":"alice","name":{}}']:
            with self.subTest(value=value):
                self.assertIsNone(backend._parse_sso_user(value))
                with self.assertRaises(HTTPException) as error:
                    backend._require_user(value)
                self.assertEqual(error.exception.status_code, 401)


class WorkspaceASGITests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.database = FakeDatabase()
        self.db_patch = patch.object(backend, '_get_db_conn', self.database.connection)
        self.db_patch.start()
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=backend.app), base_url='http://test.invalid')

    async def asyncTearDown(self):
        await self.client.aclose()
        self.db_patch.stop()

    async def test_anonymous_requests_fail_before_database_or_upstream_access(self):
        requests = [('GET', '/', None), ('GET', '/api/whoami', None), ('GET', '/api/workspace', None),
                    ('PUT', '/api/workspace', workspace()),
                    ('GET', '/api/market/bars?symbol=sh600000&start=2024-01-02&end=2024-01-05', None),
                    ('GET', '/api/market/quote?symbol=sh600000', None), ('GET', '/api/market/search?q=test', None)]
        for method, url, payload in requests:
            with self.subTest(url=url):
                response = await self.client.request(method, url, json=payload)
                self.assertEqual(response.status_code, 401)
        self.assertEqual(self.database.calls, [])

    async def test_chinese_gateway_header_is_decoded_and_identity_response_is_not_cacheable(self):
        response = await self.client.get('/api/whoami', headers=sso())
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['name'], '张三')
        self.assertEqual(response.headers['cache-control'], 'no-store')

    async def test_owner_is_taken_only_from_authenticated_header(self):
        alice = await self.client.put('/api/workspace', headers=sso('alice'), json=workspace(owner_id='bob', userId='bob'))
        self.assertEqual(alice.status_code, 200)
        self.assertEqual(alice.json()['version'], 1)
        bob = await self.client.get('/api/workspace', headers=sso('bob'))
        self.assertEqual(bob.json(), {'version': 0, 'watchlist': [], 'portfolios': []})
        alice_read = await self.client.get('/api/workspace', headers=sso('alice'))
        self.assertEqual(alice_read.json()['watchlist'][0]['symbol'], 'sh600000')
        self.assertEqual(alice_read.headers['cache-control'], 'no-store')
        self.assertNotIn('owner_id', self.database.rows['alice']['payload'])
        self.assertEqual(self.database.rows['bob']['revision'], 0)

    async def test_stale_revision_returns_409_and_preserves_saved_payload(self):
        self.assertEqual((await self.client.put('/api/workspace', headers=sso(), json=workspace())).status_code, 200)
        stale = workspace(watchlist=[])
        response = await self.client.put('/api/workspace', headers=sso(), json=stale)
        self.assertEqual(response.status_code, 409)
        current = (await self.client.get('/api/workspace', headers=sso())).json()
        self.assertEqual(current['version'], 1)
        self.assertEqual(len(current['watchlist']), 1)
        stale['version'] = 1
        fresh = await self.client.put('/api/workspace', headers=sso(), json=stale)
        self.assertEqual(fresh.status_code, 200)
        self.assertEqual(fresh.json()['version'], 2)
        self.assertEqual(fresh.json()['watchlist'], [])

    async def test_invalid_assets_and_fee_container_return_422_instead_of_500(self):
        for key, value in [('assets', [None]), ('feeOptions', []), ('feeOptions', 'commissionRate')]:
            bad = workspace()
            bad['portfolios'][0][key] = value
            response = await self.client.put('/api/workspace', headers=sso(), json=bad)
            self.assertEqual(response.status_code, 422)
        self.assertEqual(self.database.calls, [])

    async def test_schema_rejects_non_object_put(self):
        response = await self.client.put('/api/workspace', headers=sso(), json=[])
        self.assertEqual(response.status_code, 422)


class WorkspaceValidationTests(unittest.TestCase):
    def test_market_warmup_can_span_twelve_years_but_saved_evaluation_is_limited_to_ten(self):
        self.assertEqual(backend._dates('2014-01-02', '2026-01-02', max_years=12), (date(2014,1,2), date(2026,1,2)))
        bad = workspace()
        bad['portfolios'][0].update(start='2014-01-02', end='2026-01-02')
        with self.assertRaises(HTTPException) as error:
            backend.validate_workspace(bad)
        self.assertEqual(error.exception.status_code, 422)

    def test_legitimate_workspace_is_normalized_without_mutating_original(self):
        original = workspace()
        before = copy.deepcopy(original)
        result = backend.validate_workspace(original)
        self.assertEqual(result['portfolios'][0]['assets'][0]['quantity'], 0)
        self.assertEqual(original, before)

    def test_bad_numbers_structures_duplicates_and_oversized_data(self):
        cases = []
        for version in [True, -1, 1.5, float('nan')]:
            cases.append(workspace(version=version))
        cases += [workspace(watchlist=[None]), workspace(watchlist=workspace()['watchlist'] * 2), workspace(watchlist=[{'symbol': 'http://private'}]), workspace(watchlist=[{'symbol': 'sh600000', 'quantity': 100, 'sellableQty': 101}])]
        for key, value in [('assets', [{'symbol': 'sh600000', 'weight': 101}]), ('initialCash', -1), ('mode', 'unknown'), ('start', '20240102'), ('start', '2024-02-30'), ('end', '2024-01-01'), ('feeOptions', {'minCommission': float('inf')})]:
            bad = workspace(); bad['portfolios'][0][key] = value; cases.append(bad)
        for params in [[], None, {'x': True}, {'x': float('inf')}]:
            bad = workspace(); bad['portfolios'][0]['assets'][0]['params'] = params; cases.append(bad)
        empty_shares = workspace(); empty_shares['portfolios'][0]['mode'] = 'shares'; cases.append(empty_shares)
        cases += [workspace(portfolios=workspace()['portfolios'] * 2), workspace(watchlist=[{'symbol': 'sh600000', 'name': 'a' * 150001}])]
        for value in cases:
            with self.subTest(value=str(value)[:160]):
                with self.assertRaises(HTTPException) as error:
                    backend.validate_workspace(value)
                self.assertEqual(error.exception.status_code, 422)


class MarketCleaningTests(unittest.TestCase):
    def test_date_filter_sort_and_identical_pagination_deduplication(self):
        rows = [['2024-01-04', 10, 11, 12, 9, 100], ['2024-01-02', 10, 11, 12, 9, 100], ['2024-01-02', '10', '11', '12', '9', '100'], ['2024-01-01', 10, 11, 12, 9, 100]]
        result = backend.clean_bars(rows, date(2024, 1, 2), date(2024, 1, 3))
        self.assertEqual([row['time'] for row in result], ['2024-01-02'])

    def test_unknown_volume_is_omitted_but_explicit_zero_is_preserved(self):
        for raw in [None, '', ' ', 'MISSING_FIELD']:
            row = ['2024-01-02', 10, 11, 12, 9]
            if raw != 'MISSING_FIELD': row.append(raw)
            self.assertNotIn('volume', backend.clean_bars([row], date(2024,1,2), date(2024,1,3))[0])
        zero = backend.clean_bars([['2024-01-02', 10, 11, 12, 9, 0]], date(2024,1,2), date(2024,1,3))[0]
        self.assertEqual(zero['volume'], 0)

    def test_invalid_ohlc_dates_nonfinite_and_conflicting_duplicates_fail_closed(self):
        bad = [None, ['2024-01-02'], ['2024-02-30', 10, 11, 12, 9, 100], ['20240102', 10, 11, 12, 9, 100],
               ['2024-01-02', 10, 11, 10.99, 9, 100], ['2024-01-02', 10, 11, 12, 10.01, 100],
               ['2024-01-02', float('nan'), 11, 12, 9, 100], ['2024-01-02', True, 11, 12, 1, 100],
               ['2024-01-02', 10, 11, 12, 9, -1], ['2024-01-02', 10, 11, 12, 9, float('inf')]]
        for row in bad:
            with self.subTest(row=row):
                with self.assertRaises(HTTPException) as error:
                    backend.clean_bars([row], date(2024,1,1), date(2024,3,1))
                self.assertEqual(error.exception.status_code, 502)
        with self.assertRaises(HTTPException):
            backend.clean_bars([['2024-01-02', 10, 11, 12, 9, 100], ['2024-01-02', 10, 12, 12, 9, 100]], date(2024,1,1), date(2024,3,1))


class MockResponse:
    def __init__(self, payload=None, content=b''):
        self.payload, self.content = payload, content

    def raise_for_status(self):
        pass

    def json(self):
        return self.payload


class MockMarketClient:
    def __init__(self, responses):
        self.responses, self.calls = list(responses), []

    async def __aenter__(self): return self
    async def __aexit__(self, *args): pass

    async def get(self, url, **kwargs):
        self.calls.append((url, kwargs))
        if not self.responses: raise AssertionError('Unexpected outbound request: ' + url)
        result = self.responses.pop(0)
        if isinstance(result, Exception): raise result
        return result


class MarketProviderTests(unittest.IsolatedAsyncioTestCase):
    async def test_requested_adjustment_missing_never_uses_raw_day(self):
        for adjustment, fqt in [('qfq', 1), ('hfq', 2)]:
            client = MockMarketClient([
                MockResponse({'data': {'sh600000': {'day': [['2024-01-02', 10, 10, 10, 10, 100]]}}}),
                MockResponse({'data': {'klines': ['2024-01-02,20,20,20,20,100']}})
            ])
            with patch.object(backend.httpx, 'AsyncClient', return_value=client):
                result = await backend.market_bars('sh600000', '2024-01-02', '2024-01-05', adjustment)
            self.assertEqual(result['bars'][0]['close'], 20)
            self.assertEqual(result['meta']['source'], '东方财富日线')
            self.assertEqual(client.calls[1][1]['params']['fqt'], fqt)
            self.assertEqual(result['meta']['adjustment'], adjustment)

    async def test_valid_requested_series_is_used_with_filtered_dates_and_unknown_volume_metadata(self):
        client = MockMarketClient([MockResponse({'data': {'sh600000': {'qfqday': [
            ['2024-01-01', 10, 10, 10, 10, 100], ['2024-01-02', 10, 10, 10, 10, ''], ['2024-01-03', 10, 10, 10, 10, 0]
        ]}}})])
        with patch.object(backend.httpx, 'AsyncClient', return_value=client):
            result = await backend.market_bars('sh600000', '2024-01-02', '2024-01-05', 'qfq')
        self.assertEqual(len(client.calls), 1)
        self.assertEqual(result['meta']['count'], 2)
        self.assertEqual(result['meta']['unknownVolumeCount'], 1)
        self.assertEqual(result['meta']['actualStart'], '2024-01-02')
        self.assertTrue(result['meta']['completedOnly'])
        self.assertNotIn('volume', result['bars'][0])
        self.assertEqual(result['bars'][1]['volume'], 0)

    async def test_raw_mode_explicitly_uses_day_key(self):
        client = MockMarketClient([MockResponse({'data': {'sh600000': {'day': [['2024-01-02', 10, 10, 10, 10, 100]]}}})])
        with patch.object(backend.httpx, 'AsyncClient', return_value=client):
            result = await backend.market_bars('sh600000', '2024-01-02', '2024-01-05', 'raw')
        self.assertEqual(result['meta']['adjustment'], 'raw')
        self.assertEqual(result['meta']['source'], '腾讯日线')
        self.assertEqual(len(client.calls), 1)

    async def test_adjustment_missing_on_later_page_discards_partial_source(self):
        first = date(2023,1,1)
        rows = [[(first + timedelta(days=i)).isoformat(), 10, 10, 10, 10, 100] for i in range(640)]
        client = MockMarketClient([MockResponse({'data': {'sh600000': {'hfqday': rows}}}),
            MockResponse({'data': {'sh600000': {'day': [['2022-12-30', 9, 9, 9, 9, 100]]}}}),
            MockResponse({'data': {'klines': ['2022-12-30,20,20,20,20,100']}})])
        with patch.object(backend.httpx, 'AsyncClient', return_value=client):
            result = await backend.market_bars('sh600000', '2022-12-30', '2024-12-31', 'hfq')
        self.assertEqual(len(result['bars']), 1)
        self.assertEqual(result['bars'][0]['close'], 20)
        self.assertEqual(result['meta']['source'], '东方财富日线')
        self.assertEqual(client.calls[-1][1]['params']['fqt'], 2)

    async def test_preclose_request_excludes_today_daily_bar(self):
        class BeforeClose(datetime):
            @classmethod
            def now(cls, tz=None): return cls(2026, 9, 15, 10, 0, tzinfo=tz)
        client = MockMarketClient([MockResponse({'data': {'sh600000': {'day': [['2026-09-14', 10, 10, 10, 10, 100], ['2026-09-15', 11, 11, 11, 11, 100]]}}})])
        with patch.object(backend, 'datetime', BeforeClose), patch.object(backend.httpx, 'AsyncClient', return_value=client):
            result = await backend.market_bars('sh600000', '2026-09-14', '2026-09-15', 'raw')
        self.assertEqual([b['time'] for b in result['bars']], ['2026-09-14'])
        self.assertIn('2026-09-14', client.calls[0][1]['params']['param'])

    async def test_invalid_provider_ohlc_and_nonfinite_quote_are_rejected(self):
        client = MockMarketClient([MockResponse({'data': {'sh600000': {'qfqday': [['2024-01-02', 10, 11, 10.99, 9, 100]]}}})])
        with patch.object(backend.httpx, 'AsyncClient', return_value=client):
            with self.assertRaises(HTTPException) as error:
                await backend.market_bars('sh600000', '2024-01-02', '2024-01-05', 'qfq')
        self.assertEqual(error.exception.status_code, 502)
        parts = ['0'] * 40
        parts[1], parts[2], parts[3], parts[4], parts[5] = '股票', '600000', 'nan', '10', '10'
        parts[30], parts[33], parts[34] = '20260915100000', '11', '9'
        client = MockMarketClient([MockResponse(content=('v="' + '~'.join(parts) + '";').encode('gb18030'))])
        with patch.object(backend.httpx, 'AsyncClient', return_value=client):
            with self.assertRaises(HTTPException) as error:
                await backend.quote('sh600000', json.dumps({'userId': 'alice'}))
        self.assertEqual(error.exception.status_code, 502)


if __name__ == '__main__':
    unittest.main()
