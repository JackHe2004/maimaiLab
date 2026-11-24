import { z } from 'zod';
import { getCatalog } from '../../../lib/catalog';
import { region, regionalCharts, scoreSchema } from '../../../lib/model';
import { listScores, saveScores } from '../../../lib/scores';

export const dynamic = 'force-dynamic';

const batchSchema = z.object({ region, scores: z.array(scoreSchema).min(1).max(12_000) }).strict();
const headers = { 'Cache-Control': 'no-store' };

export async function GET(request: Request) {
  const parsed = region.safeParse(new URL(request.url).searchParams.get('region'));
  if (!parsed.success) return Response.json({ error: '无效的玩家地区。' }, { status: 400 });
  try {
    return Response.json({ scores: await listScores(parsed.data) }, { headers });
  } catch {
    return Response.json({ error: '无法读取本地成绩。' }, { status: 503 });
  }
}

export async function POST(request: Request) {
  if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json' ||
    request.headers.get('sec-fetch-site') === 'cross-site') {
    return Response.json({ error: '此操作需要来自本站的 JSON 请求。' }, { status: 415 });
  }

  const maxBytes = 3_000_000;
  const reader = request.body?.getReader();
  if (!reader) return Response.json({ error: '缺少结构化成绩。' }, { status: 400 });
  const decoder = new TextDecoder();
  let body = '';
  let bytes = 0;
  try {
    for (let next = await reader.read(); !next.done; next = await reader.read()) {
      bytes += next.value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        return Response.json({ error: '导入批次太大。' }, { status: 413 });
      }
      body += decoder.decode(next.value, { stream: true });
    }
    body += decoder.decode();
  } catch {
    return Response.json({ error: '无法读取成绩请求。' }, { status: 400 });
  }
  const decoded: unknown = await Promise.resolve().then(() => JSON.parse(body)).catch(() => null);
  const parsed = batchSchema.safeParse(decoded);
  if (!parsed.success) return Response.json({ error: '成绩格式无效。' }, { status: 400 });
  const { region: playerRegion, scores } = parsed.data;

  try {
    const { catalog } = await getCatalog();
    const available = new Set(regionalCharts(catalog, playerRegion).map((chart) => chart.id));
    if (scores.some((score) => !available.has(score.chartId))) {
      return Response.json({ error: '有谱面不在当前地区的曲库中，请刷新后重新匹配。' }, { status: 422 });
    }
    const saved = await saveScores(playerRegion, scores);
    return Response.json({ saved, scores: await listScores(playerRegion) }, { headers });
  } catch {
    return Response.json({ error: '无法保存成绩，可以安全重试。' }, { status: 503 });
  }
}
