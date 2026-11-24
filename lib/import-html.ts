import { parse, type DefaultTreeAdapterTypes as Html } from 'parse5';
import {
  difficulty, emptyPerformance, normalizeTitle, parseAchievement, performance,
  type Catalog, type Chart, type Performance,
} from './model';

type Element = Html.Element;
type Node = Html.Node;
type Diff = Chart['difficulty'];
type ChartType = Chart['type'];

export type ImportedRow = {
  row: number;
  title: string;
  difficulty: Diff | null;
  type: ChartType | null;
  level: string | null;
  score: Performance | null;
  issues: string[];
};

function attr(node: Element, name: string) {
  return node.attrs.find((attribute) => attribute.name === name)?.value ?? '';
}

function classes(node: Element) {
  return attr(node, 'class').split(/\s+/u);
}

function elements(node: Node): Element[] {
  if ('tagName' in node && ['script', 'style', 'template', 'noscript'].includes(node.tagName)) return [];
  return [
    ...('tagName' in node ? [node] : []),
    ...('childNodes' in node ? node.childNodes.flatMap(elements) : []),
  ];
}

function text(node: Node): string {
  if ('value' in node) return node.value;
  if ('tagName' in node && ['script', 'style', 'template', 'svg'].includes(node.tagName)) return '';
  return 'childNodes' in node ? node.childNodes.map(text).join('') : '';
}

function filename(node: Element) {
  return (attr(node, 'src').split(/[?#]/u)[0].split('/').at(-1) ?? '').toLowerCase();
}

function cardFor(title: Element) {
  let card = title;
  while (card.parentNode && 'tagName' in card.parentNode) {
    const parent = card.parentNode;
    if (['main', 'body', 'html'].includes(parent.tagName)) break;
    if (containsOtherTitle(parent, title)) break;
    const rowClasses = classes(parent);
    if (['w_450', 'm_15', 'p_r', 'f_0'].every((token) => rowClasses.includes(token))) return parent;
    card = parent;
  }
  return card;
}

function containsOtherTitle(node: Node, title: Element): boolean {
  if ('tagName' in node && node !== title && classes(node).includes('music_name_block')) return true;
  return 'childNodes' in node && node.childNodes.some((child) => containsOtherTitle(child, title));
}

function findDifficulty(contents: Element[]): Diff[] {
  const markers = contents.flatMap((el) => {
    const inClass = classes(el).flatMap((token) => {
      const match = /^music_(basic|advanced|expert|master|re_master|remaster)_score_back$/.exec(token);
      return match ? [match[1]] : [];
    });
    const inImage = el.tagName === 'img'
      ? /^(?:diff|difficulty)_(basic|advanced|expert|master|re_master|remaster)\.(?:png|webp)$/.exec(filename(el))
      : null;
    return inImage ? [...inClass, inImage[1]] : inClass;
  });
  return [...new Set(markers.map((value) => difficulty.parse(value.replace('re_master', 'remaster'))))];
}

function findType(card: Element, images: string[]): ChartType | null {
  const id = attr(card, 'id');
  const std = /(?:^|_)sta_/i.test(id) || images.some((src) => /^(?:music_)?(?:icon_)?(?:standard|std)\.(?:png|webp)$/.test(src));
  const dx = /(?:^|_)dx_/i.test(id) || images.some((src) => /^(?:music_)?(?:icon_)?(?:deluxe|dx)\.(?:png|webp)$/.test(src));
  return std === dx ? null : std ? 'std' : 'dx';
}

export function parseMaimaiHtml(html: string): ImportedRow[] {
  if (html.length > 15_000_000) throw new Error('单份 HTML 超过 1500 万字符。');
  const all = elements(parse(html, { scriptingEnabled: false }));
  const titles = all.filter((el) => classes(el).includes('music_name_block'));
  if (!titles.length) throw new Error('找不到成绩清单。请打开 maimai DX NET 的按曲目成绩页并保存 HTML。');

  const selected = all.flatMap((el) => {
    if (el.tagName !== 'select' || attr(el, 'name') !== 'diff') return [];
    return elements(el).filter((option) => option.tagName === 'option' &&
      option.attrs.some(({ name }) => name === 'selected'))
      .map((option) => attr(option, 'value'));
  });
  const fallback = selected.length === 1 && /^[0-4]$/.test(selected[0])
    ? difficulty.options[Number(selected[0])] : null;

  return titles.map((titleNode, index) => {
    const card = cardFor(titleNode);
    const contents = elements(card);
    const images = contents.filter((el) => el.tagName === 'img').map(filename);
    const found = findDifficulty(contents);
    const diff = found.length === 1 ? found[0] : found.length ? null : fallback;
    const type = findType(card, images);
    const title = text(titleNode).trim();
    const levelNode = contents.find((el) => classes(el).includes('music_lv_block'));
    const level = levelNode ? text(levelNode).trim() || null : null;
    const scores = contents.filter((el) => classes(el).includes('music_score_block')).map((el) => text(el).trim());
    const percentages = scores.filter((value) => value.endsWith('%'));
    const achievement = percentages.length === 1 ? parseAchievement(percentages[0]) : null;
    const points = scores.map((value) => /^([\d,]+)\s*\/\s*([\d,]+)$/.exec(value)).find((match) => match);
    const dxScore = points ? Number(points[1].replaceAll(',', '')) : null;
    const dxScoreMax = points ? Number(points[2].replaceAll(',', '')) : null;
    const issues: string[] = [];
    if (!title) issues.push('缺少曲名');
    if (!diff) issues.push('难度缺失或冲突');
    if (fallback && found.length === 1 && diff !== fallback) issues.push('筛选栏和行内难度不同，采用行内难度');
    if (!type) issues.push('谱面类型缺失或冲突');
    if (achievement === null) issues.push(scores.length ? '无法读取达成率' : '无成绩（可能未游玩）');

    const icons = images.flatMap((src) => {
      const match = /^music_icon_([a-z0-9]+)\.(?:png|webp)$/.exec(src);
      return match ? [match[1]] : [];
    }).map((icon) => ({
      fdx: 'fsd', fdxp: 'fsdp', fdxplus: 'fsdp', fcplus: 'fcp',
      fsplus: 'fsp', applus: 'app', splus: 'sp', ssplus: 'ssp', sssplus: 'sssp',
    }[icon] ?? icon));

    const getIcon = (values: readonly string[]) => icons.find((icon) => values.includes(icon)) ?? null;
    const stars = images.map((src) => /^music_icon_dxstar_?([1-5])\.(?:png|webp)$/.exec(src)).find((match) => match);
    const validDxScore = dxScore !== null && dxScoreMax !== null &&
      dxScore >= 0 && dxScore <= dxScoreMax && dxScoreMax > 0 && dxScoreMax <= 1_000_000;
    if (points && !validDxScore) issues.push('DX Score 无效，保留达成率');
    const score = achievement === null ? null : performance.parse({
      ...emptyPerformance, achievement,
      dxScore: validDxScore ? dxScore : null, dxScoreMax: validDxScore ? dxScoreMax : null,
      rank: getIcon(performance.shape.rank.unwrap().options),
      combo: getIcon(performance.shape.combo.unwrap().options),
      sync: getIcon(performance.shape.sync.unwrap().options),
      dxStars: stars ? Number(stars[1]) : null,
    });
    return { row: index + 1, title, level, type, difficulty: diff, score, issues };
  });
}

export function matchImportedRows<T extends ImportedRow>(rows: T[], charts: Chart[], aliases: Catalog['aliases']) {
  const byTitle = new Map<string, Set<string>>();
  const bySong = new Map<string, Chart[]>();
  function index(title: string, songId: string) {
    const key = normalizeTitle(title);
    if (!byTitle.has(key)) byTitle.set(key, new Set());
    byTitle.get(key)?.add(songId);
  }

  for (const chart of charts) {
    index(chart.title, chart.songId);
    const songCharts = bySong.get(chart.songId) ?? [];
    songCharts.push(chart);
    bySong.set(chart.songId, songCharts);
  }
  for (const alias of aliases) index(alias.name, alias.song_id);
  return rows.map((row) => {
    const ids = byTitle.get(normalizeTitle(row.title));
    const candidates = [...(ids ?? [])].flatMap((id) => bySong.get(id) ?? [])
      .filter((chart) => chart.type === row.type && chart.difficulty === row.difficulty);
    const exact = candidates.filter((chart) => chart.title === row.title);
    const matches = exact.length ? exact : candidates;
    const byLevel = matches.filter((chart) => chart.level === row.level);
    const chart = matches.length === 1 ? matches[0] : byLevel.length === 1 ? byLevel[0] : null;
    const issues = [...row.issues];
    if (row.score && !chart) issues.push(matches.length ? '有多个候选谱面' : '此地区没有匹配谱面');
    if (chart && row.level && chart.level !== row.level) issues.push(`网页等级 ${row.level}，曲库等级 ${chart.level}`);
    return { ...row, chart, issues };
  });
}
