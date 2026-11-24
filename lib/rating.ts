import type { Catalog, Chart, Score } from './model';

const thresholds = [
  [1_005_000, 224], [1_004_999, 222], [1_000_000, 216], [999_999, 214],
  [995_000, 211], [990_000, 208], [989_999, 206], [980_000, 203],
  [970_000, 200], [969_999, 176], [940_000, 168], [900_000, 152],
  [800_000, 136], [799_999, 128], [750_000, 120], [700_000, 112],
  [600_000, 96], [500_000, 80], [0, 0],
] as const;

export const targets = [
  { value: 970_000, label: 'S' }, { value: 980_000, label: 'S+' },
  { value: 990_000, label: 'SS' }, { value: 995_000, label: 'SS+' },
  { value: 1_000_000, label: 'SSS' }, { value: 1_005_000, label: 'SSS+' },
];

const gradeBands = [
  ...[...targets].reverse(),
  { value: 940_000, label: 'AAA' }, { value: 900_000, label: 'AA' },
  { value: 800_000, label: 'A' }, { value: 750_000, label: 'BBB' },
  { value: 700_000, label: 'BB' }, { value: 600_000, label: 'B' },
  { value: 500_000, label: 'C' },
];

export function achievementGrade(achievement: number) {
  return gradeBands.find(({ value }) => achievement >= value)?.label ?? 'D';
}

export function chartRating(constant: number, achievement: number, combo: Score['combo'] = null) {
  if (constant <= 0) return 0;
  const coefficient = thresholds.find(([cutoff]) => achievement >= cutoff)?.[1] ?? 0;
  const rating = Math.floor(Math.round(constant * 10) * Math.min(achievement, 1_005_000) * coefficient / 100_000_000);
  return rating + Number(combo === 'ap' || combo === 'app');
}

export function regionVersions(versions: Catalog['versions'], charts: Chart[], today = new Date()) {
  const available = new Set(charts.map((chart) => chart.version));
  const date = today.toISOString().slice(0, 10);
  return versions.filter((item) => available.has(item.version) && (!item.releaseDate || item.releaseDate <= date))
    .map((item) => item.version).reverse();
}

export function chartsAsOfVersion(charts: Chart[], versions: Catalog['versions'], version: string) {
  const order = new Map(versions.map((item, index) => [item.version, index]));
  const current = order.get(version);
  if (current === undefined) return [];
  return charts.filter((chart) => (order.get(chart.version) ?? Infinity) <= current);
}

export function newSongVersions(versions: Catalog['versions'], current: string) {
  const order = versions.map(({ version }) => version);
  const index = order.indexOf(current);
  const circle = order.indexOf('CiRCLE');
  if (index > 0 && circle >= 0 && index >= circle && !current.startsWith('舞萌DX')) {
    return [current, order[index - 1]];
  }
  return [current];
}

export function best50(charts: Chart[], scores: Score[], newVersions: readonly string[]) {
  const byId = new Map(charts.map((chart) => [chart.id, chart]));
  const results = scores.flatMap((score) => {
    const chart = byId.get(score.chartId);
    if (!chart || !chart.constant) return [];
    return [{ chart, score, rating: chartRating(chart.constant, score.achievement, score.combo) }];
  }).sort((a, b) => b.rating - a.rating || b.score.achievement - a.score.achievement ||
    a.chart.id.localeCompare(b.chart.id));
  const old = results.filter((row) => !newVersions.includes(row.chart.version)).slice(0, 35);
  const recent = results.filter((row) => newVersions.includes(row.chart.version)).slice(0, 15);
  const sum = (rows: typeof results) => rows.reduce((total, row) => total + row.rating, 0);
  return { old, recent, oldTotal: sum(old), recentTotal: sum(recent), total: sum(old) + sum(recent) };
}

export function recommendations(charts: Chart[], scores: Score[], newVersions: readonly string[], target: number) {
  const best = best50(charts, scores, newVersions);
  const byId = new Map(scores.map((score) => [score.chartId, score]));
  const oldCutoff = best.old.length === 35 ? best.old.at(-1)!.rating : 0;
  const recentCutoff = best.recent.length === 15 ? best.recent.at(-1)!.rating : 0;
  return charts.flatMap((chart) => {
    if (!chart.constant) return [];
    const current = byId.get(chart.id);
    if (current && current.achievement >= target) return [];
    const projected = chartRating(chart.constant, target, current?.combo);
    const previous = current ? chartRating(chart.constant, current.achievement, current.combo) : 0;
    const cutoff = newVersions.includes(chart.version) ? recentCutoff : oldCutoff;
    const gain = projected - Math.max(previous, cutoff);
    if (gain <= 0) return [];
    return [{ chart, current: current?.achievement ?? null, projected, gain }];
  }).sort((a, b) => b.gain - a.gain || (b.current ?? 0) - (a.current ?? 0) ||
    a.chart.id.localeCompare(b.chart.id));
}
