import assert from 'node:assert/strict';
import { test } from 'node:test';
import { matchImportedRows, parseMaimaiHtml } from '../lib/import-html';
import { emptyPerformance, regionalCharts, type Catalog, type Chart } from '../lib/model';
import { achievementGrade, best50, chartRating, chartsAsOfVersion, newSongVersions, recommendations } from '../lib/rating';
import { compareRegionalReleases } from '../lib/regional-releases';

const chart: Chart = {
  id: 'dsht_23456789ab', songId: 'dsng_23456789ab', title: 'Example & Song',
  artist: '', category: 'maimai', imageName: '', type: 'std', difficulty: 'master',
  level: '14+', constant: 14.7, version: 'current',
};

test('detects row-level difficulty, score, type and icons in mixed HTML', () => {
  const html = `
    <select name="diff"><option value="3" selected>MASTER</option></select>
    <div class="w_450 m_15 p_r f_0">
      <div class="music_master_score_back">
        <div class="music_name_block">Example &amp; Song</div>
        <div class="music_lv_block">14+</div>
        <div class="music_score_block w_120">100.1234%</div>
        <div class="music_score_block">2,345 / 2,700</div>
        <img src="music_icon_sss.png"><img src="music_icon_fdxp.png">
      </div>
      <img src="music_standard.png">
    </div>
    <div class="w_450 m_15 p_r f_0" id="dx_other">
      <div class="music_remaster_score_back">
        <div class="music_name_block">Second Song</div>
      </div>
    </div>`;
  const rows = parseMaimaiHtml(html);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].score?.achievement, 1_001_234);
  assert.equal(rows[0].score?.dxScore, 2345);
  assert.equal(rows[0].score?.dxScoreMax, 2700);
  assert.equal(rows[0].score?.rank, 'sss');
  assert.equal(rows[0].score?.sync, 'fsdp');
  assert.equal(rows[0].difficulty, 'master');
  assert.equal(rows[0].type, 'std');
  assert.equal(rows[1].difficulty, 'remaster');
  assert.equal(rows[1].type, 'dx');
  assert.equal(rows[1].score, null);
  assert.equal(matchImportedRows(rows, [chart], [])[0].chart?.id, chart.id);
});

test('does not import an error page or guess chart type', () => {
  assert.throws(() => parseMaimaiHtml('<h1>Login</h1>'), /找不到成绩清单/);
  const [row] = parseMaimaiHtml(`<div class="music_master_score_back">
    <div class="music_name_block">Example &amp; Song</div>
    <div class="music_score_block">0.0000%</div>
  </div>`);
  assert.equal(row.score?.achievement, 0);
  assert.equal(row.type, null);
  assert.equal(matchImportedRows([row], [chart], [])[0].chart, null);
});

test('computes B50 and one-chart gain with an empty slot or an existing result', () => {
  assert.equal(chartRating(14.7, 1_005_000), 330);
  assert.equal(chartRating(14.7, 1_010_000, 'app'), 331);
  assert.equal(chartRating(14.7, 1_000_000), 317);
  const score = { ...emptyPerformance, chartId: chart.id, achievement: 1_000_000 };
  assert.equal(best50([chart], [score], ['current']).total, 317);
  assert.equal(recommendations([chart], [score], ['current'], 1_005_000)[0].gain, 13);
  assert.equal(recommendations([chart], [], ['current'], 1_005_000)[0].gain, 330);
});

test('subtracts the B15 cutoff when a new chart enters a full group', () => {
  const charts = Array.from({ length: 15 }, (_, index) => ({ ...chart, id: `played-${index}`, constant: 14 }));
  const scores = charts.map(({ id }) => ({ ...emptyPerformance, chartId: id, achievement: 1_000_000 }));
  const potential = recommendations([...charts, chart], scores, ['current'], 1_000_000);
  assert.equal(potential[0].gain, 317 - chartRating(14, 1_000_000));
});

test('excludes future-version charts from an earlier version calculation', () => {
  const previous = { ...chart, id: 'previous', version: 'older' };
  const versions = [{ version: 'older' }, { version: 'current' }];
  assert.deepEqual(chartsAsOfVersion([previous, chart], versions, 'older'), [previous]);
});

test('labels the achievement grade independently from Rating coefficient edge cases', () => {
  assert.equal(achievementGrade(999_999), 'SS+');
  assert.equal(achievementGrade(1_000_000), 'SSS');
  assert.equal(achievementGrade(1_004_999), 'SSS');
  assert.equal(achievementGrade(1_005_000), 'SSS+');
});

test('groups all difficulties by regional song type and keeps DX and STANDARD releases separate', () => {
  const catalog: Catalog = {
    schemaVersion: 1, updatedAt: '2026-11-24', aliases: [],
    versions: [{ version: 'CiRCLE PLUS' }, { version: 'MAGiCAL' }, { version: 'Next' }],
    songs: [{
      id: 'dsng_23456789ab', title: 'New Example', artist: 'Artist', category: 'maimai', imageName: '',
      sheets: [{
        id: 'dsht_ya4ecwmxrr', type: 'dx', difficulty: 'master', version: 'MAGiCAL',
        level: '14+', internalLevelValue: 14.8, serverIds: ['intl', 'usa', 'jp'], isSpecial: false,
      }, {
        id: 'dsht_23456789ab', type: 'dx', difficulty: 'remaster', version: 'Next',
        level: '14+', internalLevelValue: 14.9, serverIds: ['jp'], isSpecial: false,
      }, {
        id: 'dsht_23456789ac', type: 'std', difficulty: 'master', version: 'CiRCLE PLUS',
        level: '14', internalLevelValue: 14.1, serverIds: ['jp'], isSpecial: false,
      }],
    }],
  };
  const source = (version: number) => ({
    versions: [{ id: 26, name: 'CiRCLE PLUS' }, { id: 27, name: 'MAGiCAL' }, { id: 28, name: 'Next' }],
    current: version,
    songs: [{
      title: 'New Example', artist: 'Artist', type: 'DX' as const, naUnavailable: false, version,
      charts: [{ id: 1, difficulty: 'MASTER', level: '14+', internalLevel: 148 }, { id: 2, difficulty: 'RE_MASTER', level: '14+', internalLevel: 149 }],
    }, {
      title: 'New Example', artist: 'Artist', type: 'STANDARD' as const, naUnavailable: false, version: 26,
      charts: [{ id: 3, difficulty: 'MASTER', level: '14', internalLevel: 141 }],
    }],
  });
  const compare = () => compareRegionalReleases(catalog, { intl: source(26), usa: source(26), jp: source(27) });
  const reviewed = compare();
  const score = { ...emptyPerformance, chartId: 'dsht_ya4ecwmxrr', achievement: 1_005_000 };
  for (const [region, expected] of [['intl', 'CiRCLE PLUS'], ['usa', 'CiRCLE PLUS'], ['jp', 'MAGiCAL']] as const) {
    const charts = regionalCharts(reviewed.catalog, region);
    assert.equal(charts[0].version, expected);
    assert.equal(reviewed.versionAudit[region].current, expected);
    const best = best50(chartsAsOfVersion(charts, catalog.versions, expected), [score], [expected]);
    assert.equal(best.recent[0]?.chart.id, score.chartId);
    assert.equal(best.old.length, 0);
  }
  assert.equal(reviewed.versionAudit.jp.checked, 2);
  const japanese = regionalCharts(reviewed.catalog, 'jp');
  assert.equal(japanese[1].version, 'MAGiCAL');
  assert.equal(japanese[2].version, 'CiRCLE PLUS');
  const jpBest = best50(japanese, [score, { ...score, chartId: japanese[2].id }], ['MAGiCAL']);
  assert.equal(jpBest.recent[0]?.chart.type, 'dx');
  assert.equal(jpBest.old[0]?.chart.type, 'std');
  assert.deepEqual(regionalCharts(catalog, 'cn'), []);
  catalog.songs[0].sheets[0].serverOverrides = { intl: { version: 'MAGiCAL', levelValue: 14.9 } };
  const conflict = compare();
  assert.equal(conflict.versionAudit.intl.conflicts, 1);
  assert.equal(regionalCharts(conflict.catalog, 'intl')[0].version, 'CiRCLE PLUS');
  assert.equal(regionalCharts(conflict.catalog, 'intl')[0].constant, 14.9);
});


test('CiRCLE-era B15 shares both release versions with the recommendation cutoff', () => {
  const versions = ['PRiSM', 'PRiSM PLUS', 'CiRCLE', 'CiRCLE PLUS'].map((version) => ({ version }));
  assert.deepEqual(newSongVersions(versions, 'PRiSM PLUS'), ['PRiSM PLUS']);
  assert.deepEqual(newSongVersions(versions, 'CiRCLE'), ['CiRCLE', 'PRiSM PLUS']);
  const pool = newSongVersions(versions, 'CiRCLE PLUS');
  assert.deepEqual(pool, ['CiRCLE PLUS', 'CiRCLE']);
  const speakers = { ...chart, id: 'speakers', version: 'CiRCLE' };
  const legacy = { ...chart, id: 'legacy', version: 'PRiSM PLUS' };
  const best = best50([speakers, legacy], [
    { ...emptyPerformance, chartId: speakers.id, achievement: 1_005_000 },
    { ...emptyPerformance, chartId: legacy.id, achievement: 1_005_000 },
  ], pool);
  assert.equal(best.recent[0].chart.id, speakers.id);
  assert.equal(best.old[0].chart.id, legacy.id);

  const filled = Array.from({ length: 15 }, (_, id) => ({
    ...chart, id: String(id), version: 'CiRCLE PLUS', constant: 15,
  }));
  const filledScores = filled.map(({ id }) => ({ ...emptyPerformance, chartId: id, achievement: 1_005_000 }));
  assert.deepEqual(recommendations([...filled, speakers], filledScores, pool, 1_005_000), []);
});
