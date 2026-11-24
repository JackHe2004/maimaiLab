import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { GET } from '../app/api/maishift/route';
import { database } from '../lib/db';
import { distributionRows, ratingBand } from '../lib/maishift';
import type { Catalog } from '../lib/model';

const chartId = 'dsht_23456789ab';
const counts = {
  LT_94: 0, AAA: 1, S: 0, S_PLUS: 0, SS: 2, SS_PLUS: 1,
  SSS: 9, SSS_PLUS_WITHOUT_AP: 4, ALL_PERFECT_PLUS: 1, ALL_PERFECT: 3,
};
const band = { from: 16200, to: 16250 };

test('selects the supported half-open Rating interval', () => {
  assert.deepEqual(ratingBand(16219), band);
  assert.deepEqual(ratingBand(13999), { from: 13500, to: 14000 });
  assert.deepEqual(ratingBand(14000), { from: 14000, to: 14250 });
  assert.equal(ratingBand(17000), null);
});

test('maps exact achievement buckets and includes omitted APs in SSS+', () => {
  const chart = { chartId: 2, players: 20, counts, suppressed: false };
  const rows = distributionRows(chartId, band, chart);
  assert.equal(rows.find((row) => row.grade === 'SSS')?.count, 9);
  assert.equal(rows.find((row) => row.grade === 'SSS+')?.count, 7);
  assert.deepEqual(distributionRows(chartId, band, { ...chart, suppressed: true }), []);
});

test('B50 route reads and caches the NA view without sending personal scores', async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'maimai-api-test-'));
  const originalPath = process.cwd();
  const originalDb = process.env.DATABASE_URL;
  const originalKey = process.env.MAISHIFT_API_KEY;
  const url = `http://localhost/api/maishift?rating=16219&ids=${chartId}`;
  process.chdir(folder);
  delete process.env.DATABASE_URL;
  delete process.env.MAISHIFT_API_KEY;
  try {
    assert.deepEqual(await (await GET(new Request(url))).json(), { rows: [], status: 'missing-key' });
    process.env.MAISHIFT_API_KEY = 'test-key';
    const db = await database();
    const catalog: Catalog = {
      schemaVersion: 1, updatedAt: '2026-11-24', versions: [], aliases: [],
      songs: [{
        id: 'dsng_23456789ab', title: 'Example', artist: 'Artist', category: 'maimai', imageName: '',
        sheets: [{
          id: chartId, type: 'std', difficulty: 'remaster', level: '14+', version: 'Example version',
          internalLevelValue: 14.7, serverIds: ['usa'], isSpecial: false,
        }],
      }],
    };
    await db.query('INSERT INTO catalog_cache (source, body) VALUES ($1, $2::jsonb)', ['dxrating', JSON.stringify(catalog)]);
    const requests: string[] = [];
    t.mock.method(globalThis, 'fetch', async (input: URL, init: RequestInit) => {
      const address = new URL(input);
      assert.equal(address.origin, 'https://maimai.shiftpsh.com');
      assert.equal(address.searchParams.get('region'), 'na');
      assert.equal(new Headers(init.headers).get('X-API-Key'), 'test-key');
      requests.push(address.pathname);
      if (address.pathname.endsWith('/songs')) {
        return Response.json({ region: 'na', version: 26, songs: [{
          title: 'Example', artist: 'Artist', type: 'STANDARD', naUnavailable: false, version: 26,
          charts: [{ id: 2, difficulty: 'RE_MASTER', level: '14+', internalLevel: 147 }],
        }, {
          title: 'Unrequested peer', artist: 'Artist', type: 'DX', naUnavailable: false, version: 26,
          charts: [{ id: 3, difficulty: 'MASTER', level: '14+', internalLevel: 147 }],
        }, {
          title: 'Other constant', artist: 'Artist', type: 'DX', naUnavailable: false, version: 26,
          charts: [{ id: 4, difficulty: 'MASTER', level: '14+', internalLevel: 148 }],
        }, {
          title: 'Unavailable in NA', artist: 'Artist', type: 'DX', naUnavailable: true, version: 26,
          charts: [{ id: 5, difficulty: 'MASTER', level: '14+', internalLevel: 147 }],
        }] });
      }
      assert.deepEqual(Object.fromEntries(address.searchParams), { region: 'na', level: '14+', rating: '16200-16250' });
      return Response.json({ region: 'na', band, charts: [
        { chartId: 2, players: 20, suppressed: false, counts },
        { chartId: 3, players: 20, suppressed: false, counts: { ...counts, SSS: 1, LT_94: 8 } },
        { chartId: 4, players: 20, suppressed: false, counts: { ...counts, SSS: 0, LT_94: 9 } },
        { chartId: 5, players: 20, suppressed: false, counts: { ...counts, SSS: 0, LT_94: 9 } },
      ] });
    });
    const response = await (await GET(new Request(url))).json();
    assert.equal(response.status, 'ready');
    assert.equal(response.rows.find((row: { grade: string }) => row.grade === 'SSS').count, 9);
    assert.deepEqual(response.rows.find((row: { grade: string }) => row.grade === 'SSS').reference,
      { constant: 14.7, min: 5, max: 45, charts: 2 });
    assert.deepEqual(await (await GET(new Request(url))).json(), response);
    assert.deepEqual(requests, ['/api/v1/songs', '/api/v1/stats/level-charts']);
  } finally {
    const db = await database().catch(() => null);
    if (db instanceof PGlite) await db.close();
    process.chdir(originalPath);
    if (originalDb === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDb;
    if (originalKey === undefined) delete process.env.MAISHIFT_API_KEY;
    else process.env.MAISHIFT_API_KEY = originalKey;
    await rm(folder, { force: true, recursive: true });
  }
});
