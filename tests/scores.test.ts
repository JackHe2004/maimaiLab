import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { database } from '../lib/db';
import { emptyPerformance, type Score } from '../lib/model';
import { listScores, saveScores } from '../lib/scores';

test('PostgreSQL merges duplicates and retries atomically by region and chart', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'maimai-scores-test-'));
  const originalPath = process.cwd();
  const originalUrl = process.env.DATABASE_URL;
  process.chdir(folder);
  delete process.env.DATABASE_URL;
  try {
    const score: Score = {
      ...emptyPerformance, chartId: 'dsht_23456789ab', achievement: 1_000_000,
      rank: 'sss', dxScore: 2100, dxScoreMax: 2700, dxStars: 2, combo: 'fc',
    };
    const second: Score = { ...score, achievement: 995_000, rank: 'ssp', combo: 'ap', dxScore: 2300, dxStars: 3 };
    assert.equal(await saveScores('usa', [score, second]), 1);
    await saveScores('intl', [second]);
    await saveScores('usa', [score]);
    assert.deepEqual(await listScores('usa'), [{ ...score, combo: 'ap', dxScore: 2300, dxStars: 3 }]);
    assert.deepEqual(await listScores('intl'), [second]);
  } finally {
    const db = await database().catch(() => null);
    if (db instanceof PGlite) await db.close();
    process.chdir(originalPath);
    if (originalUrl !== undefined) process.env.DATABASE_URL = originalUrl;
    await rm(folder, { recursive: true, force: true });
  }
});
