import { database } from './db';
import type { Region, Score } from './model';

export async function listScores(region: Region) {
  const db = await database();
  const { rows } = await db.query<Score>(`
    SELECT chart_id AS "chartId", achievement, dx_score AS "dxScore", dx_score_max AS "dxScoreMax",
      rank, combo, sync, dx_stars AS "dxStars"
    FROM scores WHERE region = $1 ORDER BY chart_id
  `, [region]);
  return rows;
}

export async function saveScores(region: Region, scores: Score[]) {
  const db = await database();
  // A single statement makes the batch atomic. Each id appears once per statement.
  const distinct = new Map<string, Score>();
  const comboOrder = [null, 'fc', 'fcp', 'ap', 'app'];
  const syncOrder = [null, 'sync', 'fs', 'fsp', 'fsd', 'fsdp'];
  for (const incoming of scores) {
    const previous = distinct.get(incoming.chartId);
    if (!previous) {
      distinct.set(incoming.chartId, incoming);
      continue;
    }
    const bestAchievement = incoming.achievement >= previous.achievement ? incoming : previous;
    const bestDx = (incoming.dxScore ?? -1) >= (previous.dxScore ?? -1) ? incoming : previous;
    distinct.set(incoming.chartId, {
      ...bestAchievement,
      rank: incoming.achievement === previous.achievement ? incoming.rank ?? previous.rank : bestAchievement.rank,
      dxScore: bestDx.dxScore, dxScoreMax: bestDx.dxScoreMax,
      dxStars: bestDx.dxScore === previous.dxScore ? bestDx.dxStars ?? previous.dxStars : bestDx.dxStars,
      combo: comboOrder.indexOf(incoming.combo) >= comboOrder.indexOf(previous.combo) ? incoming.combo : previous.combo,
      sync: syncOrder.indexOf(incoming.sync) >= syncOrder.indexOf(previous.sync) ? incoming.sync : previous.sync,
    });
  }

  await db.query(`
    INSERT INTO scores (region, chart_id, achievement, dx_score, dx_score_max, rank, combo, sync, dx_stars)
    SELECT $1, "chartId", achievement, "dxScore", "dxScoreMax", rank, combo, sync, "dxStars"
    FROM jsonb_to_recordset($2::jsonb) AS incoming(
      "chartId" text, achievement integer, "dxScore" integer, "dxScoreMax" integer,
      rank text, combo text, sync text, "dxStars" integer
    )
    ON CONFLICT (region, chart_id) DO UPDATE SET
      achievement = greatest(scores.achievement, excluded.achievement),
      rank = CASE
        WHEN excluded.achievement > scores.achievement THEN excluded.rank
        WHEN excluded.achievement = scores.achievement THEN coalesce(excluded.rank, scores.rank)
        ELSE scores.rank END,
      dx_score = greatest(scores.dx_score, excluded.dx_score),
      dx_score_max = CASE WHEN excluded.dx_score >= coalesce(scores.dx_score, -1)
        THEN excluded.dx_score_max ELSE scores.dx_score_max END,
      dx_stars = CASE
        WHEN excluded.dx_score > coalesce(scores.dx_score, -1) THEN excluded.dx_stars
        WHEN excluded.dx_score IS NOT DISTINCT FROM scores.dx_score THEN coalesce(excluded.dx_stars, scores.dx_stars)
        ELSE scores.dx_stars END,
      combo = (ARRAY['fc', 'fcp', 'ap', 'app'])[greatest(
        array_position(ARRAY['fc', 'fcp', 'ap', 'app'], scores.combo),
        array_position(ARRAY['fc', 'fcp', 'ap', 'app'], excluded.combo))],
      sync = (ARRAY['sync', 'fs', 'fsp', 'fsd', 'fsdp'])[greatest(
        array_position(ARRAY['sync', 'fs', 'fsp', 'fsd', 'fsdp'], scores.sync),
        array_position(ARRAY['sync', 'fs', 'fsp', 'fsd', 'fsdp'], excluded.sync))],
      updated_at = now()
  `, [region, JSON.stringify([...distinct.values()])]);
  return distinct.size;
}
