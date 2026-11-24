import { maiReleaseCatalog, maiSongIndex, matchMaiSong } from './maishift';
import { cnReleaseCatalog } from './cn-release-catalog';
import { chartType, difficulty, normalizeTitle, type Catalog, type Region } from './model';

type ReleaseCatalog = Awaited<ReturnType<typeof maiReleaseCatalog>>;
type Song = Catalog['songs'][number];
type Sheet = Song['sheets'][number];

export type VersionAudit = Record<Region, {
  source: 'maishift' | 'saltmeta' | 'unavailable';
  current?: string;
  checked: number;
  confirmed: number;
  corrected: number;
  unmatched: number;
  conflicts: number;
}>;

function versionKey(name: string) {
  return normalizeTitle(name).replace(/maimai\s*(?:でらっくす|dx)/u, 'maimai dx');
}

export function compareRegionalReleases(catalog: Catalog, sources: Partial<Record<Region, ReleaseCatalog>>) {
  const canonical = new Map(catalog.versions.map(({ version }) => [versionKey(version), version]));
  const order = new Map(catalog.versions.map(({ version }, index) => [version, index]));
  const audit = {} as VersionAudit;
  const references = (['usa', 'intl', 'jp', 'cn'] as const).map((region) => {
    const source = sources[region];
    const versions = new Map(source?.versions.map(({ id, name }) => [id, canonical.get(versionKey(name))]));
    const result: VersionAudit[Region] = {
      source: source ? (region === 'cn' ? 'saltmeta' : 'maishift') : 'unavailable',
      current: source ? versions.get(source.current) : undefined,
      checked: 0, confirmed: 0, corrected: 0, unmatched: 0, conflicts: 0,
    };
    audit[region] = result;
    return { region, versions, result, index: source ? maiSongIndex(source.songs) : null };
  });

  const songs = catalog.songs.map((song) => {
    const assignments = new Map<Sheet, NonNullable<Sheet['serverOverrides']>>();
    for (const { region, versions, result, index } of references) {
      for (const type of chartType.options) {
        const group = song.sheets.filter((sheet) => sheet.type === type && !sheet.isSpecial &&
          difficulty.safeParse(sheet.difficulty).success && sheet.serverIds.includes(region));
        if (group.length === 0) continue;
        result.checked++;
        const remote = index ? matchMaiSong(type, song.title, song.artist, index, region === 'usa') : undefined;
        const reference = remote ? versions.get(remote.version) : undefined;
        const existing = group.map((sheet) => sheet.serverOverrides?.[region]?.version ?? sheet.version);
        const override = [...new Set(group.flatMap((sheet) => {
          const explicit = sheet.serverOverrides?.[region]?.version;
          return explicit ? [explicit] : [];
        }))];
        const first = [...existing].sort((a, b) => (order.get(a) ?? Infinity) - (order.get(b) ?? Infinity))[0];
        const version = reference ?? (override.length === 1 ? override[0] : first);

        if (!reference) result.unmatched++;
        else if (override.some((explicit) => explicit !== reference)) result.conflicts++;
        else if (existing.every((item) => item === version)) result.confirmed++;
        else result.corrected++;

        for (const sheet of group) {
          const adjustments = assignments.get(sheet) ?? sheet.serverOverrides ?? {};
          const previous = adjustments[region];
          if ((previous?.version ?? sheet.version) !== version) {
            assignments.set(sheet, { ...adjustments, [region]: { ...previous, version } });
          }
        }
      }
    }
    return { ...song, sheets: song.sheets.map((sheet) => {
      const overrides = assignments.get(sheet);
      return overrides ? { ...sheet, serverOverrides: overrides } : sheet;
    }) };
  });
  return { catalog: { ...catalog, songs }, versionAudit: audit };
}

export async function verifyRegionalReleases(catalog: Catalog, force: boolean) {
  const key = process.env.MAISHIFT_API_KEY?.trim();
  const [na, jp, cn] = await Promise.allSettled([
    key ? maiReleaseCatalog('na', key, force) : undefined,
    key ? maiReleaseCatalog('jp', key, force) : undefined,
    cnReleaseCatalog(catalog.versions, force),
  ]);
  const sources: Partial<Record<Region, ReleaseCatalog>> = {};
  if (na.status === 'fulfilled') sources.usa = sources.intl = na.value;
  if (jp.status === 'fulfilled') sources.jp = jp.value;
  if (cn.status !== 'fulfilled') return compareRegionalReleases(catalog, sources);
  sources.cn = cn.value;
  const seen = new Set(catalog.versions.map(({ version }) => version));
  const versions = [...catalog.versions, ...cn.value.extraVersions.filter(({ version }) => !seen.has(version))];
  return compareRegionalReleases({ ...catalog, versions }, sources);
}
