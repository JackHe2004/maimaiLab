import { z } from 'zod';
import { database } from './db';
import type { MaiSongs } from './maishift';
import { normalizeTitle, type Catalog } from './model';

const source = 'saltmeta:cn:releases';
const endpoint = 'https://meta.salt.realtvop.top/meta.next.json';
const schema = z.object({
  musics: z.array(z.object({
    title: z.string(),
    artist: z.string(),
    charts: z.array(z.object({
      type: z.string(),
      difficulty: z.number(),
      regions: z.object({ cn: z.object({ version: z.union([z.string(), z.number()]).nullish() }).nullish() }),
    })),
  })),
});

async function readCatalog(force: boolean) {
  const db = await database();
  const { rows: [cached] } = await db.query<{ body: unknown; checked_at: Date }>(
    'SELECT body, checked_at FROM catalog_cache WHERE source = $1', [source],
  );
  const saved = schema.safeParse(cached?.body);
  if (!force && cached && saved.success && Date.now() - new Date(cached.checked_at).getTime() < 86_400_000) return saved.data;
  try {
    const response = await fetch(endpoint, { cache: 'no-store', signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`SaltMeta HTTP ${response.status}`);
    const data = schema.parse(await response.json());
    await db.query(`
      INSERT INTO catalog_cache (source, body) VALUES ($1, $2::jsonb)
      ON CONFLICT (source) DO UPDATE SET body = excluded.body, checked_at = now()
    `, [source, JSON.stringify(data)]);
    return data;
  } catch (error) {
    if (saved.success) return saved.data;
    throw error;
  }
}

export async function cnReleaseCatalog(versions: Catalog['versions'], force: boolean) {
  const { musics } = await readCatalog(force);
  const dxStart = versions.findIndex(({ version }) => normalizeTitle(version) === 'maimaiでらっくす');
  const legacy = versions.slice(0, dxStart < 0 ? 0 : dxStart).map(({ version }) => version);
  const legacyNames = new Map(legacy.map((name) => [normalizeTitle(name), name]));

  function recognize(value: string | number | null | undefined) {
    if (typeof value === 'number' && value >= 2021 && value <= 2100) return `舞萌DX ${value}`;
    if (typeof value !== 'string') return undefined;
    const text = value.normalize('NFKC').trim();
    if (/^舞萌DX(?: 20\d{2})?$/.test(text)) return text;
    const normalized = normalizeTitle(text);
    return legacyNames.get(normalized) ?? legacyNames.get(normalized.replace(/^maimai /, ''));
  }

  const annual = new Set<string>();
  const groups = musics.flatMap((music) => (['sd', 'dx'] as const).flatMap((type) => {
    const names = music.charts.flatMap((chart) => {
      if (chart.type !== type || chart.difficulty < 0 || chart.difficulty > 4) return [];
      const name = recognize(chart.regions.cn?.version);
      if (name?.startsWith('舞萌DX')) annual.add(name);
      return name ? [name] : [];
    });
    return names.length ? [{ music, type, names }] : [];
  }));
  const labels = [...legacy, ...[...annual].sort()];
  const order = new Map(labels.map((name, index) => [name, index]));
  const songs: MaiSongs = groups.map(({ music, type, names }) => ({
    title: music.title, artist: music.artist, type: type === 'sd' ? 'STANDARD' : 'DX',
    version: Math.min(...names.map((name) => order.get(name)!)), naUnavailable: false, charts: [],
  }));
  return {
    songs,
    versions: labels.map((name, id) => ({ id, name })),
    current: annual.size ? labels.length - 1 : -1,
    extraVersions: [...annual].sort().map((version) => ({ version })),
  };
}
