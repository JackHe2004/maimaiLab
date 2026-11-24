import { getCatalog } from '../../../lib/catalog';
import { verifyRegionalReleases } from '../../../lib/regional-releases';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const force = new URL(request.url).searchParams.get('refresh') === '1';
    const { catalog, stale } = await getCatalog(force);
    return Response.json({ ...await verifyRegionalReleases(catalog, force), stale }, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    console.error('读取 DXRating 曲库失败', error instanceof Error ? error.message.slice(0, 200) : '未知错误');
    return Response.json({ error: '无法读取 DXRating 曲库。请检查网络和本地数据库后重试。' }, { status: 503 });
  }
}
