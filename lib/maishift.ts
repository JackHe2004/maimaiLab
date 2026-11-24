import { z } from 'zod';
import { database } from './db';
import { normalizeTitle, type Chart } from './model';
import type { DistributionRange, DistributionRow } from './maishift-distribution';

const base = 'https://maimai.shiftpsh.com/api/v1/';
const maishiftRegion = z.enum(['na', 'intl', 'jp']);
const displayedLevel = z.string().regex(/^(?:[1-9]|1[0-5])\+?$/);
const count = z.number().int().nonnegative();
const grades = {
  AAA: 'AAA', S: 'S', S_PLUS: 'S+', SS: 'SS', SS_PLUS: 'SS+', SSS: 'SSS',
} as const;

const songsSchema = z.object({
  region: maishiftRegion,
  version: z.number().int(),
  songs: z.array(z.object({
    title: z.string(),
    artist: z.string().nullable(),
    type: z.enum(['STANDARD', 'DX']),
    version: z.number().int(),
    naUnavailable: z.boolean(),
    charts: z.array(z.object({
      id: z.number().int().positive(), difficulty: z.string(), level: displayedLevel, internalLevel: count,
    })),
  })),
});
const versionsSchema = z.object({
  region: maishiftRegion,
  latestVersion: z.number().int(),
  versions: z.array(z.object({ id: z.number().int(), name: z.string() })),
});
const chartsSchema = z.object({
  region: z.enum(['na', 'intl']),
  band: z.object({ from: count, to: count }),
  charts: z.array(z.object({
    chartId: z.number().int().positive(),
    players: count,
    suppressed: z.boolean(),
    counts: z.object({
      LT_94: count, AAA: count, S: count, S_PLUS: count, SS: count, SS_PLUS: count, SSS: count,
      SSS_PLUS_WITHOUT_AP: count, ALL_PERFECT_PLUS: count, ALL_PERFECT: count,
    }).nullable(),
  })),
});
export type MaiSongs = z.infer<typeof songsSchema>['songs'];

export function maiSongIndex(songs: MaiSongs) {
  const index = new Map<string, MaiSongs>();
  for (const song of songs) {
    const key = `${song.type}:${normalizeTitle(song.title)}`;
    const candidates = index.get(key) ?? [];
    candidates.push(song);
    index.set(key, candidates);
  }
  return index;
}

export function matchMaiSong(type: 'std' | 'dx', title: string, artist: string,
  index: ReturnType<typeof maiSongIndex>, northAmerican = false) {
  const key = `${type === 'std' ? 'STANDARD' : 'DX'}:${normalizeTitle(title)}`;
  const options = (index.get(key) ?? []).filter((song) => !northAmerican || !song.naUnavailable);
  if (options.length === 1) return options[0];
  const matches = options.filter((song) =>
    song.artist && normalizeTitle(song.artist) === normalizeTitle(artist));
  return matches.length === 1 ? matches[0] : undefined;
}
type MaiChart = z.infer<typeof chartsSchema>['charts'][number];

export function ratingBand(rating: number) {
  if (rating < 13_000 || rating >= 17_000) return null;
  const width = rating < 14_000 ? 500 : rating < 16_000 ? 250 : 50;
  const from = Math.floor(rating / width) * width;
  return { from, to: from + width };
}

export function matchMaiChart(chart: Chart, index: ReturnType<typeof maiSongIndex>) {
  const song = matchMaiSong(chart.type, chart.title, chart.artist, index, true);
  if (!song) return undefined;
  const difficulty = chart.difficulty === 'remaster' ? 'RE_MASTER' : chart.difficulty.toUpperCase();
  const charts = song.charts.filter((item) => item.difficulty === difficulty);
  return charts.length === 1 ? charts[0] : undefined;
}

function gradeCounts(chart: MaiChart): Pick<DistributionRow, 'grade' | 'count'>[] {
  const { counts, players, suppressed } = chart;
  if (suppressed || !counts || players < 5) return [];
  const lower = counts.LT_94 + Object.keys(grades).reduce((sum, grade) => sum + counts[grade as keyof typeof grades], 0);
  const sssp = players - lower;
  // SSS+ also contains APs omitted from the achievement bands and listed under combo.
  const knownSssp = counts.SSS_PLUS_WITHOUT_AP + counts.ALL_PERFECT_PLUS;
  if (sssp < knownSssp || sssp > knownSssp + counts.ALL_PERFECT) return [];
  return [
    ...Object.entries(grades).map(([key, grade]) => ({ grade, count: counts[key as keyof typeof grades] })),
    { grade: 'SSS+', count: sssp },
  ];
}

export function distributionRows(chartId: string, band: { from: number; to: number }, chart: MaiChart): DistributionRow[] {
  return gradeCounts(chart).map((bucket) => ({ chartId, ...band, players: chart.players, ...bucket }));
}

export class MaiShiftHttpError extends Error {
  constructor(readonly status: number) {
    super(`MaiShift HTTP ${status}`);
  }
}

const pending = new Map<string, Promise<unknown>>();
let retryAt = 0;

async function request<T>(path: string, schema: z.ZodType<T>, ttlMs: number, key: string, force = false,
  allowStale = false): Promise<T> {
  const source = `maishift:na:${path}`;
  const db = await database();
  const { rows: [cached] } = await db.query<{ body: unknown; checked_at: Date }>(
    'SELECT body, checked_at FROM catalog_cache WHERE source = $1', [source],
  );
  const parsed = cached ? schema.safeParse(cached.body) : undefined;
  if (!force && cached && parsed?.success && Date.now() - new Date(cached.checked_at).getTime() < ttlMs) {
    return parsed.data;
  }

  const inFlight = pending.get(source);
  if (inFlight) return schema.parse(await inFlight);
  if (Date.now() < retryAt) {
    if (allowStale && parsed?.success) return parsed.data;
    throw new MaiShiftHttpError(429);
  }

  const update = (async () => {
    const response = await fetch(new URL(path, base), {
      headers: { 'X-API-Key': key },
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 429) {
      const seconds = Number(response.headers.get('Retry-After')) || 10;
      retryAt = Date.now() + Math.max(1, seconds) * 1000;
    }
    if (!response.ok) throw new MaiShiftHttpError(response.status);
    const result = schema.parse(await response.json());
    await db.query(`
      INSERT INTO catalog_cache (source, body) VALUES ($1, $2::jsonb)
      ON CONFLICT (source) DO UPDATE SET body = excluded.body, checked_at = now()
    `, [source, JSON.stringify(result)]);
    return result;
  })();

  pending.set(source, update);
  try {
    return await update;
  } catch (error) {
    if (allowStale && parsed?.success) return parsed.data;
    throw error;
  } finally {
    pending.delete(source);
  }
}

export async function maiReleaseCatalog(region: 'na' | 'jp', key: string, force = false) {
  const day = 24 * 60 * 60 * 1000;
  const [catalog, versions] = await Promise.all([
    request(`songs?region=${region}`, songsSchema, day, key, force, true),
    request(`versions?region=${region}`, versionsSchema, day, key, force, true),
  ]);
  if ((catalog.region === 'jp') !== (region === 'jp') || (versions.region === 'jp') !== (region === 'jp')) {
    throw new Error('Unexpected MaiShift region');
  }
  return { songs: catalog.songs, versions: versions.versions, current: versions.latestVersion };
}

export async function sharedDistributions(charts: Chart[], band: { from: number; to: number }, key: string) {
  const { songs, region } = await request('songs?region=na', songsSchema, 24 * 60 * 60 * 1000, key);
  if (region === 'jp') throw new Error('Unexpected MaiShift region');
  if (songs.length === 0) return { rows: [], failure: null };
  const index = maiSongIndex(songs);
  const targets = charts.flatMap((chart) => {
    const match = matchMaiChart(chart, index);
    return match ? [{ localId: chart.id, match }] : [];
  });
  const constants = new Set(targets.map(({ match }) => match.internalLevel).filter((value) => value > 0));
  const peersByConstant = new Map<number, Map<number, string>>();
  for (const song of songs) {
    if (song.naUnavailable) continue;
    for (const chart of song.charts) {
      if (!constants.has(chart.internalLevel)) continue;
      const peers = peersByConstant.get(chart.internalLevel) ?? new Map<number, string>();
      peers.set(chart.id, chart.level);
      peersByConstant.set(chart.internalLevel, peers);
    }
  }
  const levels = new Set(targets.map(({ match }) => match.level));
  for (const peers of peersByConstant.values()) {
    for (const level of peers.values()) levels.add(level);
  }
  const loadedLevels = new Set<string>();
  const samples = new Map<number, MaiChart>();
  const failures: number[] = [];
  for (const level of levels) {
    try {
      const query = new URLSearchParams({ region: 'na', level, rating: `${band.from}-${band.to}` });
      const result = await request(`stats/level-charts?${query}`, chartsSchema, 60 * 60 * 1000, key);
      if (result.band.from !== band.from || result.band.to !== band.to) throw new Error('Unexpected rating band');
      loadedLevels.add(level);
      for (const sample of result.charts) samples.set(sample.chartId, sample);
    } catch (error) {
      const status = error instanceof MaiShiftHttpError ? error.status : 503;
      failures.push(status);
      if ([401, 403, 429].includes(status)) break;
    }
  }
  const ranges = new Map<number, Map<DistributionRow['grade'], DistributionRange>>();
  for (const [constant, peers] of peersByConstant) {
    if ([...peers.values()].some((level) => !loadedLevels.has(level))) continue;
    const grades = new Map<DistributionRow['grade'], DistributionRange>();
    for (const id of peers.keys()) {
      const sample = samples.get(id);
      if (!sample) continue;
      for (const { grade, count } of gradeCounts(sample)) {
        const rate = 100 * count / sample.players;
        const bounds = grades.get(grade);
        if (bounds) {
          bounds.min = Math.min(bounds.min, rate);
          bounds.max = Math.max(bounds.max, rate);
          bounds.charts++;
        } else {
          grades.set(grade, { constant: constant / 10, min: rate, max: rate, charts: 1 });
        }
      }
    }
    ranges.set(constant, grades);
  }
  const rows = targets.flatMap(({ localId, match }) => {
    const sample = samples.get(match.id);
    if (!sample) return [];
    return distributionRows(localId, band, sample).map((row) => ({
      ...row, reference: ranges.get(match.internalLevel)?.get(row.grade),
    }));
  });
  return { rows, failure: failures[0] ?? null };
}
