import { database } from './db';
import { catalogSchema, type Catalog } from './model';

const endpoint = 'https://miruku.dxrating.net/api/v1/dxdata';
const refreshInterval = 12 * 60 * 60 * 1000;

type CacheRow = { body: Catalog; etag: string | null; checked_at: Date };
type CatalogResult = { catalog: Catalog; stale: boolean };
let pending: Promise<CatalogResult> | undefined;

async function load(force: boolean): Promise<CatalogResult> {
  const db = await database();
  const { rows: [cached] } = await db.query<CacheRow>(
    'SELECT body, etag, checked_at FROM catalog_cache WHERE source = $1', ['dxrating'],
  );
  if (!force && cached && Date.now() - new Date(cached.checked_at).getTime() < refreshInterval) {
    return { catalog: cached.body, stale: false };
  }

  try {
    const response = await fetch(endpoint, {
      cache: 'no-store',
      headers: cached?.etag ? { 'If-None-Match': cached.etag } : undefined,
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 304 && cached) {
      await db.query('UPDATE catalog_cache SET checked_at = now() WHERE source = $1', ['dxrating']);
      return { catalog: cached.body, stale: false };
    }
    if (!response.ok) throw new Error(`DXRating HTTP ${response.status}`);
    const catalog = catalogSchema.parse(await response.json());
    await db.query(`
      INSERT INTO catalog_cache (source, etag, body) VALUES ($1, $2, $3::jsonb)
      ON CONFLICT (source) DO UPDATE SET etag = excluded.etag, body = excluded.body, checked_at = now()
    `, ['dxrating', response.headers.get('etag'), JSON.stringify(catalog)]);
    return { catalog, stale: false };
  } catch (error) {
    if (cached) return { catalog: cached.body, stale: true };
    throw error;
  }
}

export function getCatalog(force = false) {
  pending ??= load(force).finally(() => { pending = undefined; });
  return pending;
}
