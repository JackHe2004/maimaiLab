'use client';

import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { matchImportedRows, parseMaimaiHtml, type ImportedRow } from '../lib/import-html';
import {
  coverUrl, difficulties, emptyPerformance, formatAchievement, normalizeTitle, parseAchievement,
  regions, regionalCharts, type Catalog, type Chart, type Region, type Score,
} from '../lib/model';
import { distributionShadeCount, gradeDistribution, indexDistributions, parseNorthAmericanDistribution, type DistributionIndex, type DistributionRow } from '../lib/maishift-distribution';
import { achievementGrade, best50, chartRating, chartsAsOfVersion, newSongVersions, recommendations, regionVersions, targets } from '../lib/rating';
import type { VersionAudit } from '../lib/regional-releases';

const sections = [
  { id: 'catalog', label: '曲库', icon: '♫', description: '查找当前地区的歌曲、谱面和定数。' },
  { id: 'import', label: '导入成绩', icon: '⇥', description: '读取 maimai DX NET 的成绩页，在保存前核对谱面。' },
  { id: 'best', label: '我的 B50', icon: '◈', description: '查看旧曲 Best 35 和新曲 Best 15。' },
  { id: 'suggest', label: '推分', icon: '◉', description: '按目标达成率估算每张谱面能带来的 B50 涨分。' },
] as const;
type Section = (typeof sections)[number]['id'];
type PreviewRow = ImportedRow & { file: string };
type SharedDistributionResponse = {
  rows: DistributionRow[];
  status: 'missing-key' | 'outside-band' | 'no-samples' | 'unavailable' | 'ready';
  band?: { from: number; to: number };
  failure?: number;
};

async function json<T>(response: Response): Promise<T> {
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || '请求失败。');
  return body;
}

function Cover({ chart }: { chart: Chart }) {
  const [failed, setFailed] = useState(false);
  const src = coverUrl(chart.imageName);
  return <div className="cover">
    {src && !failed
      ? <img src={src} alt="" width={56} height={56} onError={() => setFailed(true)} loading="lazy" referrerPolicy="no-referrer" />
      : <span aria-hidden="true">♫</span>}
  </div>;
}

function ChartLabel({ chart }: { chart: Chart }) {
  return <div className="chart-label">
    <Cover key={chart.imageName} chart={chart} />
    <div className="chart-text">
      <strong>{chart.title}</strong>
      <div className="chart-meta">
        <span className={`difficulty ${chart.difficulty}`}>{difficulties[chart.difficulty]}</span>
        <span>{chart.type === 'std' ? 'STANDARD' : 'DX'}</span>
        <span>{chart.version}</span>
        <span className="artist">{chart.artist}</span>
      </div>
    </div>
  </div>;
}

export default function Workspace() {
  const [section, setSection] = useState<Section>('catalog');
  const [playerRegion, setPlayerRegion] = useState<Region>('usa');
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [versionAudit, setVersionAudit] = useState<VersionAudit | null>(null);
  const [loading, setLoading] = useState(true);
  const [stale, setStale] = useState(false);
  const [catalogError, setCatalogError] = useState('');
  const [scoreState, setScoreState] = useState<{ region: Region; scores: Score[] } | null>(null);
  const [scoreError, setScoreError] = useState('');
  const [scoreRetry, setScoreRetry] = useState(0);
  const [query, setQuery] = useState('');
  const [diff, setDiff] = useState<string>('master');
  const [type, setType] = useState('');
  const [playedOnly, setPlayedOnly] = useState(false);
  const [limit, setLimit] = useState(20);
  const [requestedVersion, setRequestedVersion] = useState('');
  const [html, setHtml] = useState('');
  const [preview, setPreview] = useState<PreviewRow[]>([]);
  const [importErrors, setImportErrors] = useState<string[]>([]);
  const [importLimit, setImportLimit] = useState(20);
  const [saving, setSaving] = useState(false);
  const [reading, setReading] = useState(false);
  const [notice, setNotice] = useState('');
  const [saveError, setSaveError] = useState('');
  const [distribution, setDistribution] = useState<DistributionIndex | null>(null);
  const [distributionError, setDistributionError] = useState('');
  const [shared, setShared] = useState<{ query: string; result: SharedDistributionResponse } | null>(null);
  const [distributionRetry, setDistributionRetry] = useState(0);
  const [target, setTarget] = useState(1_000_000);
  const [editing, setEditing] = useState<Chart | null>(null);
  const [manual, setManual] = useState('');
  const [manualError, setManualError] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);

  async function readDistribution(file: File) {
    setDistributionError('');
    try {
      if (file.size > 10_000_000) throw new Error('文件过大。');
      setDistribution(parseNorthAmericanDistribution(await file.text()));
    } catch {
      setDistributionError('无法读取分布文件。请检查北美样本标记、谱面 ID 和统计格式。');
    }
  }

  async function refresh(force = false, signal?: AbortSignal) {
    setLoading(true);
    setCatalogError('');
    try {
      const data = await json<{ catalog: Catalog; stale: boolean; versionAudit: VersionAudit }>(
        await fetch(`/api/catalog${force ? '?refresh=1' : ''}`, { signal }),
      );
      setCatalog(data.catalog);
      setVersionAudit(data.versionAudit);
      setStale(data.stale);
    } catch (error) {
      if (!signal?.aborted) setCatalogError(error instanceof Error ? error.message : '无法加载曲库。');
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    void refresh(false, controller.signal);
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setScoreError('');
    fetch(`/api/scores?region=${playerRegion}`, { signal: controller.signal })
      .then(json<{ scores: Score[] }>)
      .then(({ scores }) => setScoreState({ region: playerRegion, scores }))
      .catch((error) => { if (!controller.signal.aborted) setScoreError(error.message); });
    return () => controller.abort();
  }, [playerRegion, scoreRetry]);

  const scoresReady = scoreState?.region === playerRegion;
  const scores = useMemo(() => scoresReady ? scoreState.scores : [], [scoreState, scoresReady]);
  const charts = useMemo(() => catalog ? regionalCharts(catalog, playerRegion) : [], [catalog, playerRegion]);
  const versions = useMemo(() => catalog ? regionVersions(catalog.versions, charts) : [], [catalog, charts]);
  const audit = versionAudit?.[playerRegion];
  const currentVersion = audit?.current ?? versions[0] ?? '';
  const currentIndex = catalog?.versions.findIndex((item) => item.version === currentVersion) ?? -1;
  const calculationVersions = [...new Set([currentVersion, ...versions])].filter((name) =>
    name && (!audit?.current || (catalog?.versions.findIndex((item) => item.version === name) ?? -1) <= currentIndex));
  const version = calculationVersions.includes(requestedVersion) ? requestedVersion : currentVersion;
  const ratingCharts = useMemo(() => catalog ? chartsAsOfVersion(charts, catalog.versions, version) : [],
    [catalog, charts, version]);
  const newVersions = useMemo(() => newSongVersions(catalog?.versions ?? [], version), [catalog, version]);
  const best = useMemo(() => best50(ratingCharts, scores, newVersions), [ratingCharts, scores, newVersions]);
  const distributionIds = [...best.old, ...best.recent].map(({ chart }) => chart.id).sort().join(',');
  const distributionQuery = distributionIds
    ? new URLSearchParams({ rating: String(best.total), ids: distributionIds }).toString() : '';
  const activeShared = shared?.query === distributionQuery ? shared.result : null;
  const sharedIndex = useMemo(() => activeShared ? indexDistributions(activeShared.rows) : null, [activeShared]);

  useEffect(() => {
    if (section !== 'best' || !distributionQuery) return;
    const controller = new AbortController();
    fetch(`/api/maishift?${distributionQuery}`, { signal: controller.signal })
      .then(json<SharedDistributionResponse>)
      .then((result) => { if (!controller.signal.aborted) setShared({ query: distributionQuery, result }); })
      .catch(() => {
        if (!controller.signal.aborted) setShared({ query: distributionQuery, result: { rows: [], status: 'unavailable' } });
      });
    return () => controller.abort();
  }, [section, distributionQuery, distributionRetry]);

  const sharedStatus = activeShared?.status;
  const sharedMessage = sharedStatus === 'missing-key' ? '在 .env.local 配置 MAISHIFT_API_KEY 并重启后，即可自动读取共享分布。'
    : sharedStatus === 'outside-band' ? '当前 Rating 不在 MaiShift 提供的 13,000–16,999 区间内。'
    : sharedStatus === 'no-samples' ? '该 Rating 区间暂无可用的匹配样本。'
    : sharedStatus === 'unavailable' ? (
      activeShared?.failure === 401 || activeShared?.failure === 403 ? 'MaiShift 无法授权，请检查服务端 API Key。'
        : activeShared?.failure === 429 ? 'MaiShift 请求达到限额，请稍后重试。'
          : '部分或全部 MaiShift 分布暂时无法加载。'
    ) : !activeShared && distributionQuery ? '正在读取 MaiShift 分布…' : '';
  const byChart = useMemo(() => new Map(scores.map((score) => [score.chartId, score])), [scores]);
  const suggested = useMemo(() => version ? recommendations(ratingCharts, scores, newVersions, target) : [],
    [ratingCharts, scores, version, newVersions, target]);
  const matched = useMemo(() => preview.length
    ? matchImportedRows(preview, charts, catalog?.aliases ?? []) : [], [preview, charts, catalog]);
  const ready = matched.flatMap(({ chart, score }) => chart && score ? [{ chartId: chart.id, ...score }] : []);
  const readyCount = new Set(ready.map((score) => score.chartId)).size;
  const difficultySummary = Object.entries(difficulties).flatMap(([key, label]) => {
    const count = matched.filter((row) => row.difficulty === key && row.score).length;
    return count ? [`${label} ${count}`] : [];
  });

  const filtered = useMemo(() => {
    const terms = normalizeTitle(query).split(' ').filter(Boolean);
    const aliases = new Map<string, string[]>();
    if (terms.length) {
      for (const entry of catalog?.aliases ?? []) {
        const names = aliases.get(entry.song_id) ?? [];
        names.push(entry.name);
        aliases.set(entry.song_id, names);
      }
    }
    return charts.filter((chart) => (!playedOnly || byChart.has(chart.id)) &&
      (!diff || chart.difficulty === diff) && (!type || chart.type === type) &&
      terms.every((term) => [chart.title, chart.artist, chart.level, chart.category, ...(aliases.get(chart.songId) ?? [])]
        .some((value) => normalizeTitle(value).includes(term))))
      .sort((a, b) => b.constant - a.constant || a.title.localeCompare(b.title));
  }, [catalog, charts, query, diff, type, playedOnly, byChart]);

  const page = sections.find((item) => item.id === section)!;

  function navigate(id: Section) {
    setSection(id);
    setNotice('');
    setSaveError('');
    setLimit(20);
  }

  async function readFiles(files: File[]) {
    setReading(true);
    setNotice('');
    setImportLimit(20);
    const result: PreviewRow[] = [];
    const errors: string[] = [];
    try {
      if (files.reduce((total, file) => total + file.size, 0) > 40_000_000) {
        throw new Error('这一批文件超过 40 MB。请分批导入。');
      }
      for (const file of files) {
        try {
          result.push(...parseMaimaiHtml(await file.text()).map((row) => ({ ...row, file: file.name })));
        } catch (error) {
          errors.push(`${file.name}：${error instanceof Error ? error.message : '解析失败'}`);
        }
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : '解析失败');
    } finally {
      setPreview(result);
      setImportErrors(errors);
      setReading(false);
    }
  }

  function readPasted() {
    setNotice('');
    setImportLimit(20);
    try {
      setPreview(parseMaimaiHtml(html).map((row) => ({ ...row, file: '粘贴的源码' })));
      setHtml('');
      setImportErrors([]);
    } catch (error) {
      setPreview([]);
      setImportErrors([error instanceof Error ? error.message : '解析失败']);
    }
  }

  async function persist(rows: Score[]) {
    setSaving(true);
    setNotice('');
    setSaveError('');
    try {
      const data = await json<{ scores: Score[]; saved: number }>(await fetch('/api/scores', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ region: playerRegion, scores: rows }),
      }));
      setScoreState({ region: playerRegion, scores: data.scores });
      setScoreError('');
      setNotice(`已合并 ${data.saved} 张谱面的成绩。`);
    } finally {
      setSaving(false);
    }
  }

  function openManual(chart: Chart) {
    setEditing(chart);
    const score = byChart.get(chart.id);
    setManual(score ? formatAchievement(score.achievement).replace('%', '') : '');
    setManualError('');
    dialog.current?.showModal();
  }

  async function recordManual(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editing) return;
    const achievement = parseAchievement(manual);
    if (achievement === null) {
      setManualError('请输入 0 到 101 之间的达成率，最多四位小数。');
      return;
    }
    try {
      await persist([{ ...emptyPerformance, chartId: editing.id, achievement }]);
      dialog.current?.close();
    } catch (error) {
      setManualError(error instanceof Error ? error.message : '保存失败。');
    }
  }

  return <div className="shell">
    <aside className="sidebar">
      <button className="brand" onClick={() => navigate('catalog')}>
        <span className="brand-mark" aria-hidden="true">m</span>
        <span>maimai<span className="brand-accent"> Lab</span><small>本地成绩工作台</small></span>
      </button>
      <nav aria-label="工作台">
        {sections.map((item) => <button key={item.id} onClick={() => navigate(item.id)}
          aria-current={section === item.id ? 'page' : undefined} className={section === item.id ? 'active' : ''}>
          <span aria-hidden="true">{item.icon}</span>{item.label}
        </button>)}
      </nav>
      <div className="sidebar-bottom">
        <label htmlFor="region">玩家地区</label>
        <select id="region" value={playerRegion} disabled={saving || reading} onChange={(event) => {
          setPlayerRegion(event.target.value as Region);
          setRequestedVersion('');
          setPreview([]);
          setImportErrors([]);
          setNotice('');
          setSaveError('');
          setLimit(20);
        }}>
          {Object.entries(regions).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </select>
        <a href="https://dxrating.net/zh-hant/developers" target="_blank" rel="noreferrer">曲库数据 · DXRating</a>
      </div>
    </aside>
    <main>
      <header className="page-head">
        <div><h1>{page.label}</h1><p>{page.description}</p></div>
        <button className="quiet" disabled={loading} onClick={() => void refresh(true)}>
          {loading ? '正在读取曲库…' : '同步曲库'}
        </button>
      </header>
      {catalogError && <div className="message error" role="alert">{catalogError}</div>}
      {stale && <div className="message" role="status">DXRating 暂不可用，当前显示上次同步的曲库。</div>}
      {scoreError && <div className="message error" role="alert">{scoreError}
        {' '}<button onClick={() => setScoreRetry((value) => value + 1)}>重新读取</button></div>}
      {notice && <div className="message success" role="status">{notice}</div>}
      {saveError && <div className="message error" role="alert">{saveError}</div>}
      {section === 'catalog' && <>
        <div className="summary">
          <div><span>地区谱面</span><strong>{catalog ? charts.length.toLocaleString() : '—'}</strong></div>
          <div><span>已保存成绩</span><strong>{scoresReady ? scores.length.toLocaleString() : '—'}</strong></div>
          <div><span>当前版本</span><strong className="version-value">{currentVersion || '—'}</strong></div>
        </div>
        {audit && <details className="message">
          <summary>地区版本核验</summary>
          {audit.source !== 'unavailable' ? <p>
            检查 {audit.checked.toLocaleString()} 组地区曲目 · 一致 {audit.confirmed.toLocaleString()} ·
            修正 {audit.corrected.toLocaleString()} ·
            未匹配 {audit.unmatched.toLocaleString()} · 有冲突 {audit.conflicts.toLocaleString()}
          </p> : <p>这一区域暂无对照目录，使用 DXRating 的地区版本。</p>}
        </details>}
        <section className="panel">
          <div className="toolbar">
            <input aria-label="搜索曲库" type="search" placeholder="搜索曲名、别名、曲师或等级" value={query}
              onChange={(event) => { setQuery(event.target.value); setLimit(20); }} />
            <select aria-label="谱面难度" value={diff} onChange={(event) => { setDiff(event.target.value); setLimit(20); }}>
              <option value="">全部难度</option>
              {Object.entries(difficulties).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
            </select>
            <select aria-label="谱面类型" value={type} onChange={(event) => { setType(event.target.value); setLimit(20); }}>
              <option value="">全部类型</option><option value="dx">DX</option><option value="std">STANDARD</option>
            </select>
            <label className="toggle"><input type="checkbox" checked={playedOnly} onChange={(event) => {
              setPlayedOnly(event.target.checked);
              setLimit(20);
            }} /> 仅已录入</label>
          </div>
          <div className="list-heading"><span>谱面</span><span>等级 / 定数</span><span>我的成绩</span></div>
          {filtered.slice(0, limit).map((chart) => {
            const score = byChart.get(chart.id);
            return <div className="data-row" key={chart.id}>
              <ChartLabel chart={chart} />
              <div><strong>{chart.level}</strong><small>{chart.constant ? chart.constant.toFixed(1) : '暂无定数'}</small></div>
              <button className="quiet score-button" disabled={!scoresReady || saving} onClick={() => openManual(chart)}
                aria-label={`${score ? '更新' : '录入'} ${chart.title} ${difficulties[chart.difficulty]} 成绩`}>
                {score ? formatAchievement(score.achievement) : '录入成绩'}
              </button>
            </div>;
          })}
          {!filtered.length && <p className="empty">{loading ? '正在同步地区曲库…' : '没有符合条件的谱面。'}</p>}
          {filtered.length > 0 && <div className="list-footer"><span>显示 {Math.min(limit, filtered.length)} / {filtered.length} 张谱面</span>
            {limit < filtered.length && <button className="quiet" onClick={() => setLimit((value) => value + 30)}>显示更多</button>}
          </div>}
        </section>
      </>}
      {section === 'import' && <>
        <section className="panel inset stack">
          <h2>读取 HTML</h2>
          <p>可导入多份按曲目成绩页，难度会从每行自动识别。原始网页在浏览器内解析。</p>
          <label className="upload">
            <span>选择成绩页文件</span>
            <input type="file" accept=".html,.htm,text/html" multiple disabled={reading || saving}
              onChange={(event) => {
                const files = Array.from(event.target.files ?? []);
                if (files.length) void readFiles(files);
                event.target.value = '';
              }} />
          </label>
          <label className="stack compact">或者粘贴网页源码
            <textarea rows={4} value={html} disabled={reading || saving} onChange={(event) => setHtml(event.target.value)}
              placeholder="<!doctype html> …" autoComplete="off" spellCheck={false} />
          </label>
          <div><button className="primary" disabled={!html.trim() || reading || saving} onClick={readPasted}>解析源码</button></div>
          {reading && <p role="status">正在读取文件…</p>}
          {importErrors.map((error, index) => <div className="message error" key={index} role="alert">{error}</div>)}
        </section>
        {matched.length > 0 && <section className="panel import-preview">
          <div className="panel-head">
            <div><h2>导入预览</h2>
              <p>{matched.length} 行 · 可合并 {readyCount} 张谱面 · {matched.length - ready.length} 行跳过</p>
              {difficultySummary.length > 0 && <p>{difficultySummary.join(' · ')}</p>}
            </div>
            <button className="primary" disabled={!ready.length || saving} onClick={() => void persist(ready).catch((error) =>
              setSaveError(error instanceof Error ? error.message : '保存失败。'))}>{saving ? '正在保存…' : '确认合并'}</button>
          </div>
          {matched.slice(0, importLimit).map((row, index) => <div className="data-row" key={index}>
            <div><strong>{row.title || '曲名缺失'}</strong>
              <small>{[row.type === 'std' ? 'STANDARD' : row.type?.toUpperCase(),
                row.difficulty ? difficulties[row.difficulty] : null, ...row.issues].filter(Boolean).join(' · ')}</small>
              <small>{row.file} · 第 {row.row} 行</small>
            </div>
            <div>{row.chart ? row.chart.level : '—'}</div>
            <div>{row.score ? formatAchievement(row.score.achievement) : '—'}
              {row.score && <small>{[
                row.score.dxScore !== null ? `${row.score.dxScore}/${row.score.dxScoreMax}` : null,
                row.score.rank, row.score.combo, row.score.sync,
                row.score.dxStars ? `${row.score.dxStars}★` : null,
              ].filter(Boolean).join(' · ').toUpperCase()}</small>}</div>
          </div>)}
          {importLimit < matched.length && <div className="list-footer"><button className="quiet"
            onClick={() => setImportLimit((value) => value + 50)}>显示更多导入行</button></div>}
        </section>}
      </>}
      {(section === 'best' || section === 'suggest') && <>
        <div className="summary">
          <div><span>B50 Rating</span><strong>{scoresReady && version ? best.total.toLocaleString() : '—'}</strong></div>
          <div><span>本次计算的当前版本</span>
            <select aria-label="本次计算的当前版本" value={version} onChange={(event) => setRequestedVersion(event.target.value)}>
              {!calculationVersions.length && <option value="">暂无版本</option>}
              {calculationVersions.map((name) => <option key={name}>{name}</option>)}
            </select>
          </div>
          {section === 'suggest' ? <div><span>目标达成率</span><select aria-label="目标达成率" value={target}
            onChange={(event) => { setTarget(Number(event.target.value)); setLimit(20); }}>
            {targets.map(({ value, label }) => <option key={value} value={value}>{label} · {formatAchievement(value)}</option>)}
          </select></div> : <div><span>计入 Rating 的谱面</span><strong>{best.old.length + best.recent.length}<small> / 50</small></strong></div>}
        </div>
        {scoresReady && !scores.length && <div className="message">当前地区还没有成绩。<button onClick={() => navigate('import')}>导入成绩</button></div>}
      </>}
      {section === 'best' && <div className="best-groups">
        <div className="best-distribution-status">
          <p>MaiShift 北美视图（国际服共享样本） · 按同定数、同评级比较
            {activeShared?.band && ` · Rating ${activeShared.band.from.toLocaleString()}–${activeShared.band.to.toLocaleString()}`}
          </p>
          {sharedMessage && <p role="status">{sharedMessage} {sharedStatus === 'unavailable' &&
            <button className="quiet" onClick={() => {
              setShared(null);
              setDistributionRetry((value) => value + 1);
            }}>重试</button>}
          </p>}
          {activeShared?.rows.some(({ reference }) => reference && reference.max > reference.min) ? <div className="distribution-legend" aria-label="相对值从 0 到 100，颜色由深到浅">
            <span>相对 0</span>
            {Array.from({ length: distributionShadeCount }, (_, shade) => <i key={shade} data-shade={shade} aria-hidden="true" />)}
            <span>100</span>
          </div> : null}
          <label className="distribution-file">载入纯北美分布 JSON
            <input type="file" accept=".json,application/json" onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file) void readDistribution(file);
            }} />
          </label>
          {distributionError && <p className="error" role="alert">{distributionError}</p>}
        </div>
        {([{ title: 'Best 35', rows: best.old, total: best.oldTotal }, { title: 'Best 15', rows: best.recent, total: best.recentTotal }]).map((group) =>
          <section className="panel" key={group.title}>
            <div className="panel-head"><h2>{group.title}</h2><strong className="gain">{group.total.toLocaleString()}</strong></div>
            {!group.rows.length && <p className="empty">暂无符合条件的成绩。</p>}
            {group.rows.length > 0 && <ol className="best-grid" role="list" aria-label={group.title}>
              {group.rows.map(({ chart, score, rating }) => {
                const grade = achievementGrade(score.achievement);
                const localSample = gradeDistribution(distribution, chart.id, grade, best.total);
                const sample = localSample ?? gradeDistribution(sharedIndex, chart.id, grade, best.total);
                const detail = sample ? [
                  `${grade} · Rating ${sample.from}–${sample.to} · ${sample.count}/${sample.players} 人`,
                  sample.reference && `MaiShift 定数 ${sample.reference.constant.toFixed(1)} · ${sample.reference.charts} 张谱面 · 原始占比 ${sample.reference.min.toFixed(1)}%–${sample.reference.max.toFixed(1)}%`,
                ].filter(Boolean).join('\n') : undefined;
                return <li className="best-tile" data-shade={sample?.shade} key={chart.id}>
                  <div className="best-tile-head">
                    <Cover key={chart.imageName} chart={chart} />
                    <div className="best-tile-info">
                      <strong className="best-tile-title" title={chart.title}>{chart.title}</strong>
                      <div className="best-tile-meta">
                        <span className={`difficulty ${chart.difficulty}`}>{difficulties[chart.difficulty]}</span>
                        <span>{chart.type === 'std' ? 'STD' : 'DX'} · {chart.constant.toFixed(1)}</span>
                      </div>
                    </div>
                  </div>
                  <div className="best-tile-score">
                    <strong>{formatAchievement(score.achievement)}</strong>
                    <span title={`单曲 Rating ${rating}`}>{grade} · {rating}</span>
                  </div>
                  <div className="best-tile-sample" title={detail}>
                    <span>{localSample ? '本地北美' : 'MaiShift'}{sample && ` ${sample.percent.toFixed(1)}%`}</span>
                    <strong>{sample ? (sample.relative === null ? '相对 —' : `相对 ${sample.relative.toFixed(1)}`) : '暂无数据'}</strong>
                  </div>
                </li>;
              })}
            </ol>}
          </section>)}
      </div>}
      {section === 'suggest' && <section className="panel">
        <div className="panel-head"><div><h2>潜在涨分</h2>
          <p>按单张谱面的潜在 B50 涨分排序。</p></div></div>
        {(!scoresReady || !scores.length || !suggested.length) && <div className="empty">
          {!scoresReady ? '正在读取成绩…' : !scores.length ? '导入或录入成绩后查看推分建议。' : '在这个目标达成率下，暂无可涨分的谱面。'}
        </div>}
        {scoresReady && scores.length > 0 && <>
          {suggested.slice(0, limit).map(({ chart, current, projected, gain }) => <div className="data-row suggestion-row" key={chart.id}>
            <ChartLabel chart={chart} />
            <div>{current === null ? '未录入' : formatAchievement(current)}<small>目标 Rating {projected} · 定数 {chart.constant.toFixed(1)}</small></div>
            <strong className="gain">+{gain}</strong>
          </div>)}
          {limit < suggested.length && <div className="list-footer"><button className="quiet"
            onClick={() => setLimit((value) => value + 30)}>显示更多</button></div>}
        </>}
      </section>}
    </main>
    <dialog ref={dialog} onCancel={(event) => { if (saving) event.preventDefault(); }}>
      {editing && <form onSubmit={recordManual} className="stack">
        <h2>录入成绩</h2>
        <ChartLabel chart={editing} />
        <label className="stack compact">达成率（%）
          <input inputMode="decimal" value={manual} onChange={(event) => setManual(event.target.value)}
            placeholder="100.0000" required />
        </label>
        {byChart.has(editing.id) && <p>当前单曲 Rating {chartRating(editing.constant, byChart.get(editing.id)!.achievement, byChart.get(editing.id)!.combo)}</p>}
        {manualError && <p className="message error" role="alert">{manualError}</p>}
        <div className="actions"><button className="quiet" type="button" disabled={saving} onClick={() => dialog.current?.close()}>取消</button>
          <button className="primary" disabled={saving}>{saving ? '正在保存…' : '保存成绩'}</button></div>
      </form>}
    </dialog>
  </div>;
}
