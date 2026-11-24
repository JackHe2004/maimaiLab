import { z } from 'zod';

const band = z.object({
  chartId: z.string().regex(/^dsht_[23456789abcdefghjkmnpqrstvwxyz]{10}$/),
  from: z.number().int().nonnegative(),
  to: z.number().int().positive(),
  grade: z.enum(['D', 'C', 'B', 'BB', 'BBB', 'A', 'AA', 'AAA', 'S', 'S+', 'SS', 'SS+', 'SSS', 'SSS+']),
  players: z.number().int().min(5),
  count: z.number().int().nonnegative(),
}).refine((row) => row.from < row.to && row.count <= row.players);

const exportSchema = z.object({
  source: z.literal('maishift'),
  sampleRegion: z.literal('north-america'),
  rows: z.array(band).min(1).max(100_000),
}).strict();

export const distributionShadeCount = 8;
export type DistributionRange = { constant: number; min: number; max: number; charts: number };
export type DistributionRow = z.infer<typeof band> & { reference?: DistributionRange };
export type DistributionIndex = Map<string, DistributionRow[]>;

export function parseNorthAmericanDistribution(text: string): DistributionIndex {
  return indexDistributions(exportSchema.parse(JSON.parse(text)).rows);
}

export function indexDistributions(distributions: DistributionRow[]): DistributionIndex {
  const index: DistributionIndex = new Map();
  const seen = new Set<string>();
  for (const row of distributions) {
    const group = `${row.chartId}:${row.grade}`;
    const identity = `${group}:${row.from}:${row.to}`;
    if (seen.has(identity)) throw new Error('重复的谱面、评级和 Rating 区间。');
    seen.add(identity);
    const rows = index.get(group) ?? [];
    rows.push(row);
    index.set(group, rows);
  }
  for (const rows of index.values()) rows.sort((a, b) => (a.to - a.from) - (b.to - b.from) || a.from - b.from);
  return index;
}

export function gradeDistribution(index: DistributionIndex | null, chartId: string, grade: string, rating: number) {
  const row = index?.get(`${chartId}:${grade}`)?.find(({ from, to }) => from <= rating && rating < to);
  if (!row) return null;
  const percent = 100 * row.count / row.players;
  const reference = row.reference;
  const relative = reference && reference.max > reference.min
    ? Math.min(100, Math.max(0, 100 * (percent - reference.min) / (reference.max - reference.min))) : null;
  const shade = relative === null ? undefined
    : Math.min(distributionShadeCount - 1, Math.floor(relative * distributionShadeCount / 100));
  return { ...row, percent, relative, shade };
}
