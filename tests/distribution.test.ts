import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gradeDistribution, indexDistributions, parseNorthAmericanDistribution, type DistributionRow } from '../lib/maishift-distribution';

const chartId = 'dsht_23456789ab';
const row = { chartId, grade: 'SSS', from: 16000, to: 16250, players: 20, count: 16 };
const decode = (rows: unknown[]) => parseNorthAmericanDistribution(JSON.stringify({
  source: 'maishift', sampleRegion: 'north-america', rows,
}));

test('uses the exact grade and narrowest matching Rating band', () => {
  const index = decode([row, { ...row, from: 16200, count: 0 }]);
  assert.equal(gradeDistribution(index, chartId, 'SSS', 16199)?.percent, 80);
  assert.equal(gradeDistribution(index, chartId, 'SSS', 16200)?.percent, 0);
  assert.equal(gradeDistribution(index, chartId, 'SSS', 16200)?.shade, undefined);
  assert.equal(gradeDistribution(index, chartId, 'SSS+', 16200), null);
  assert.equal(gradeDistribution(index, chartId, 'SSS', 16250), null);
});

test('normalizes the cohort extrema to the first and eighth shades', () => {
  const reference = { constant: 14.8, min: 6.5, max: 65.4, charts: 26 };
  const lookup = (count: number, bounds = reference) => gradeDistribution(indexDistributions([{
    ...row, grade: 'SSS+', players: 1000, count, reference: bounds,
  } satisfies DistributionRow]), chartId, 'SSS+', 16200);
  assert.equal(lookup(65)?.relative, 0);
  assert.equal(lookup(65)?.shade, 0);
  assert.equal(lookup(654)?.relative, 100);
  assert.equal(lookup(654)?.shade, 7);
  assert.equal(lookup(359)?.relative?.toFixed(1), '49.9');
  assert.equal(lookup(359)?.shade, 3);
  assert.equal(lookup(360)?.shade, 4);
  assert.equal(lookup(65, { ...reference, max: 6.5 })?.relative, null);
});

test('rejects suppressed counts, duplicates and raw shared-region responses', () => {
  assert.throws(() => decode([{ ...row, players: 4, count: 1 }]));
  assert.throws(() => decode([row, row]));
  assert.throws(() => parseNorthAmericanDistribution(JSON.stringify({ region: 'na', charts: [row] })));
});
