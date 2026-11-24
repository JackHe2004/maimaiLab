import { z } from 'zod';
import { getCatalog } from '../../../lib/catalog';
import { MaiShiftHttpError, ratingBand, sharedDistributions } from '../../../lib/maishift';
import { regionalCharts } from '../../../lib/model';

const paramsSchema = z.object({
  rating: z.coerce.number().int().min(0).max(100_000),
  ids: z.array(z.string().regex(/^dsht_[23456789abcdefghjkmnpqrstvwxyz]{10}$/)).min(1).max(50),
});

export async function GET(request: Request) {
  const url = new URL(request.url);
  const parsed = paramsSchema.safeParse({
    rating: url.searchParams.get('rating') ?? undefined,
    ids: url.searchParams.get('ids')?.split(','),
  });
  if (!parsed.success) return Response.json({ error: '请求的 Rating 或谱面无效。' }, { status: 400 });
  const key = process.env.MAISHIFT_API_KEY?.trim();
  if (!key) return Response.json({ rows: [], status: 'missing-key' });
  const band = ratingBand(parsed.data.rating);
  if (!band) return Response.json({ rows: [], status: 'outside-band' });

  try {
    const { catalog } = await getCatalog();
    const requested = new Set(parsed.data.ids);
    const charts = regionalCharts(catalog, 'usa').filter((chart) => requested.has(chart.id));
    const { rows, failure } = await sharedDistributions(charts, band, key);
    return Response.json({ rows, band, status: failure ? 'unavailable' : rows.length ? 'ready' : 'no-samples', failure });
  } catch (error) {
    return Response.json({
      rows: [], band, status: 'unavailable',
      failure: error instanceof MaiShiftHttpError ? error.status : 503,
    });
  }
}
