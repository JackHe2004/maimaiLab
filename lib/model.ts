import { z } from 'zod';

export const region = z.enum(['usa', 'intl', 'jp', 'cn']);
export type Region = z.infer<typeof region>;
export const regions: Record<Region, string> = {
  usa: '北美', intl: '国际服', jp: '日服', cn: '国服',
};

export const chartType = z.enum(['std', 'dx']);
export const difficulty = z.enum(['basic', 'advanced', 'expert', 'master', 'remaster']);
export const difficulties = {
  basic: 'BASIC', advanced: 'ADVANCED', expert: 'EXPERT', master: 'MASTER', remaster: 'Re:MASTER',
};

const sheet = z.object({
  id: z.string(),
  type: z.string(),
  difficulty: z.string(),
  level: z.string(),
  version: z.string(),
  internalLevelValue: z.number().nonnegative(),
  serverIds: z.array(z.string()),
  isSpecial: z.boolean(),
  serverOverrides: z.record(z.string(), z.object({
    level: z.string().optional(),
    levelValue: z.number().nonnegative().optional(),
    version: z.string().optional(),
  })).optional(),
});

export const catalogSchema = z.object({
  schemaVersion: z.literal(1),
  updatedAt: z.string(),
  versions: z.array(z.object({ version: z.string(), releaseDate: z.string().optional() })),
  songs: z.array(z.object({
    id: z.string(), title: z.string(), artist: z.string(), category: z.string(),
    imageName: z.string(), sheets: z.array(sheet),
  })).min(1),
  aliases: z.array(z.object({ song_id: z.string(), name: z.string() })),
});
export type Catalog = z.infer<typeof catalogSchema>;

export const performance = z.object({
  achievement: z.number().int().min(0).max(1_010_000),
  dxScore: z.number().int().min(0).max(1_000_000).nullable(),
  dxScoreMax: z.number().int().min(1).max(1_000_000).nullable(),
  rank: z.enum(['d', 'c', 'b', 'bb', 'bbb', 'a', 'aa', 'aaa', 's', 'sp', 'ss', 'ssp', 'sss', 'sssp']).nullable(),
  combo: z.enum(['fc', 'fcp', 'ap', 'app']).nullable(),
  sync: z.enum(['sync', 'fs', 'fsp', 'fsd', 'fsdp']).nullable(),
  dxStars: z.number().int().min(1).max(5).nullable(),
});
export type Performance = z.infer<typeof performance>;
export const emptyPerformance: Omit<Performance, 'achievement'> = {
  dxScore: null, dxScoreMax: null, rank: null, combo: null, sync: null, dxStars: null,
};
export const scoreSchema = performance.extend({ chartId: z.string().regex(/^dsht_[23456789abcdefghjkmnpqrstvwxyz]{10}$/) })
  .refine((score) => (score.dxScore === null && score.dxScoreMax === null) ||
    (score.dxScore !== null && score.dxScoreMax !== null && score.dxScore <= score.dxScoreMax));
export type Score = z.infer<typeof scoreSchema>;

export type Chart = {
  id: string;
  songId: string;
  title: string;
  artist: string;
  category: string;
  imageName: string;
  type: z.infer<typeof chartType>;
  difficulty: z.infer<typeof difficulty>;
  level: string;
  constant: number;
  version: string;
};

export function regionalCharts(catalog: Catalog, playerRegion: Region): Chart[] {
  return catalog.songs.flatMap(({ id: songId, title, artist, category, imageName, sheets }) =>
    sheets.flatMap((sheet) => {
      const type = chartType.safeParse(sheet.type);
      const diff = difficulty.safeParse(sheet.difficulty);
      if (!type.success || !diff.success || sheet.isSpecial || !sheet.serverIds.includes(playerRegion)) return [];
      const override = sheet.serverOverrides?.[playerRegion];
      return [{
        id: sheet.id, songId, title, artist, category, imageName, type: type.data,
        difficulty: diff.data, level: override?.level ?? sheet.level,
        constant: override?.levelValue ?? sheet.internalLevelValue,
        version: override?.version ?? sheet.version,
      }];
    }),
  );
}

export function coverUrl(imageName: string) {
  return /^[a-f\d]{64}$/i.test(imageName)
    ? `https://shama.dxrating.net/images/cover/v2/${imageName}.jpg`
    : undefined;
}

export function normalizeTitle(title: string) {
  return title.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
}

export function parseAchievement(input: string): number | null {
  const match = /^(\d{1,3})(?:\.(\d{1,4}))?\s*%?$/.exec(input.trim());
  if (!match) return null;
  const value = Number(match[1]) * 10_000 + Number((match[2] ?? '').padEnd(4, '0'));
  return value <= 1_010_000 ? value : null;
}

export function formatAchievement(value: number) {
  return `${(value / 10_000).toFixed(4)}%`;
}
