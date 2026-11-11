import { useMemo, useState } from 'react'
import { ruleMatches } from './engine/cluster.ts'
import { binOf, coverage } from './engine/coverage.ts'
import { toCsv } from './engine/csv.ts'
import { recommend, recsToCsv, recsToXosc } from './engine/recommend.ts'
import type { Run } from './engine/types.ts'
import { analyse, trend } from './projectData.ts'
import type { Tab, TabProps } from './Project.tsx'
import { getDefaults, sortCampaigns, type TriageStatus } from './store.ts'
import { deleteCampaignCloud } from './sync.ts'
import { ask, Code, CopyButton, download, Empty, fmtN, fmtPct, go, Link, signed, toast } from './ui.tsx'
import { HeatLegend, Heatmap, Hist, Meter, Replay, TrendChart } from './viz.tsx'

export default function Tabs(props: TabProps & { tab: Tab }) {
  switch (props.tab) {
    case 'coverage': return <CoverageTab {...props} />
    case 'failures': return <FailuresTab {...props} />
    case 'replay': return <ReplayTab {...props} />
    case 'next': return <NextTab {...props} />
    case 'history': return <HistoryTab {...props} />
    default: return <Overview {...props} />
  }
}

const tabHref = (p: TabProps, t: string, extra = '') => {
  const q = new URLSearchParams(extra)
  if (p.scope !== 'all') q.set('c', p.scope)
  const s = q.toString()
  return `/app/p/${p.project.id}/${t}${s ? '?' + s : ''}`
}

/** Pair with the most failures: the most informative heatmap to open with. */
function defaultPair(a: TabProps['a']) {
  let best = 0, score = -1
  a.cov.pairs.forEach((p, i) => { const f = (p.total - p.covered) * 10 + p.fails.flat().reduce((s, x) => s + x, 0) / Math.max(1, p.counts.flat().reduce((s, x) => s + x, 0)) * p.total; if (f > score) { score = f; best = i } })
  return best
}

function PairSelect({ p, value, onChange }: { p: TabProps; value: number; onChange(i: number): void }) {
  const odd = p.project.odd
  return (
    <select value={value} onChange={e => onChange(Number(e.target.value))} aria-label="Parameter pair">
      {p.a.cov.pairs.map((x, i) => <option key={i} value={i}>{odd[x.a].label} × {odd[x.b].label} ({Math.round((x.covered / x.total) * 100)}%)</option>)}
    </select>
  )
}

// ---------- Overview ----------

function Overview(p: TabProps) {
  const { a, project } = p
  const [pair, setPair] = useState(() => defaultPair(a))
  const tr = useMemo(() => trend(project), [project.campaigns, project.odd, project.thresholds])
  const judged = a.runs.length - a.untested
  const m = (k: keyof Run['metrics']) => a.runs.map(r => r.metrics[k]).filter((x): x is number => typeof x === 'number')
  return (
    <>
      <div className="kpis">
        <div className="kpi"><small>Pairwise ODD coverage</small><b>{fmtPct(a.cov.pairwisePct, 1)}</b><Meter value={a.cov.pairwisePct} label="Pairwise coverage" /><p>{fmtN(a.cov.coveredCells)} of {fmtN(a.cov.totalCells)} 2-way cells</p></div>
        <div className="kpi"><small>1-way coverage</small><b>{fmtPct(a.cov.oneWayPct, 1)}</b><Meter value={a.cov.oneWayPct} label="1-way coverage" /><p>every bin of every parameter</p></div>
        <div className="kpi"><small>Failure rate</small><b>{judged ? fmtPct(a.fails / judged, 1) : '—'}</b><p>{fmtN(a.fails)} of {fmtN(judged)} judged runs{a.untested ? ` · ${a.untested} not run yet` : ''}</p></div>
        <div className="kpi"><small>Untested 2-way gaps</small><b>{fmtN(a.gaps.length)}</b><p>{a.cov.outside ? `${a.cov.outside} runs outside the ODD` : 'all runs inside the ODD'}</p></div>
      </div>

      <div className="grid-2">
        <div className="panel">
          <div className="panel-head"><h2>Coverage map</h2><PairSelect p={p} value={pair} onChange={setPair} /></div>
          <Heatmap odd={project.odd} pair={a.cov.pairs[pair]} />
          <HeatLegend />
        </div>
        <div className="panel">
          <div className="panel-head"><h2>Where it fails</h2><Link href={tabHref(p, 'failures')} className="small">Worklist &rarr;</Link></div>
          {a.rules.length ? (
            <ol className="rules">
              {a.rules.slice(0, 4).map((r, i) => <li key={i}><b>{r.text}</b><span className="muted small">{r.fails} of {r.n} runs fail ({fmtPct(r.rate)}) · {r.lift.toFixed(1)}× the base rate</span></li>)}
            </ol>
          ) : <p className="muted">{a.fails ? 'Failures are spread out; no single region explains them.' : 'No failures in this scope.'}</p>}
          <h3 className="mt">Riskiest untested combinations</h3>
          {a.gaps.length ? <ul className="gap-list">{a.gaps.slice(0, 5).map(g => <li key={g.text}>{g.text}</li>)}</ul> : <p className="muted small">Every 2-way combination has at least one run.</p>}
          <Link href={tabHref(p, 'next')} className="btn primary sm">Recommend next scenarios</Link>
        </div>
      </div>

      <div className="grid-3">
        <div className="panel"><h3>Min TTC</h3><Hist values={m('ttc')} threshold={project.thresholds.ttc} unit="s" /></div>
        <div className="panel"><h3>Min gap</h3><Hist values={m('minDist')} threshold={project.thresholds.minDist} unit="m" /></div>
        <div className="panel"><h3>Max deceleration</h3><Hist values={m('maxDecel')} threshold={project.thresholds.maxDecel} unit="m/s²" lowerIsBad={false} max={Math.max(project.thresholds.maxDecel * 1.8, 8)} /></div>
      </div>

      {tr.length > 1 && <div className="panel">
        <div className="panel-head"><h2>Coverage trend</h2><Link href={tabHref(p, 'history')} className="small">Compare campaigns &rarr;</Link></div>
        <TrendChart points={tr} />
        <div className="legend"><span><i className="lg-pair" />Pairwise coverage (cumulative)</span><span><i className="lg-oneway" />1-way coverage</span><span><i className="lg-fail" />Failure rate per campaign</span></div>
      </div>}
    </>
  )
}

// ---------- Coverage ----------

function CoverageTab(p: TabProps) {
  const { a, project } = p
  const [pair, setPair] = useState(() => defaultPair(a))
  const [cell, setCell] = useState<[number, number] | null>(null)
  const P = a.cov.pairs[pair]
  const A = project.odd[P.a], B = project.odd[P.b]
  const cellRuns = cell ? a.runs.filter(r => binOf(A, r.params[A.key]) === cell[0] && binOf(B, r.params[B.key]) === cell[1]) : []
  const gapCsv = () => toCsv([['parameter_a', 'bin_a', 'parameter_b', 'bin_b', 'priority'], ...a.gaps.map(g => [g.a, a.cov.oneWay[project.odd.findIndex(d => d.key === g.a)].labels[g.ai], g.b, a.cov.oneWay[project.odd.findIndex(d => d.key === g.b)].labels[g.bi], Math.round(g.priority * 100) / 100])])
  return (
    <>
      <div className="panel">
        <div className="panel-head"><h2>1-way coverage</h2><span className="muted small">Bar height = runs per bin; red share = failures</span></div>
        <div className="oneway">
          {a.cov.oneWay.map(o => {
            const max = Math.max(1, ...o.hits)
            return (
              <div key={o.key} className="ow">
                <div className="ow-head"><b>{o.label}</b><span className={o.covered < o.total ? 'warn-text' : 'muted'}>{o.covered}/{o.total} bins</span></div>
                <div className="ow-bars">
                  {o.hits.map((h, i) => (
                    <div key={i} className={`ow-bar${h ? '' : ' empty'}`} title={`${o.labels[i]}: ${h} runs, ${o.fails[i]} failed`}>
                      <span style={{ height: `${(h / max) * 100}%` }}><i style={{ height: `${h ? (o.fails[i] / h) * 100 : 0}%` }} /></span>
                      <small>{o.labels[i].replace(/_/g, ' ')}</small>
                    </div>
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      </div>

      <div className="panel">
        <div className="panel-head"><h2>Pairwise (2-way) coverage</h2><span className="muted small">Every pair of ODD parameters; click one to inspect</span></div>
        <div className="pair-grid">
          {a.cov.pairs.map((x, i) => (
            <button key={i} type="button" className={`pair-tile${i === pair ? ' on' : ''}`} onClick={() => { setPair(i); setCell(null) }}>
              <span className="pt-name">{project.odd[x.a].label} × {project.odd[x.b].label}</span>
              <b>{Math.round((x.covered / x.total) * 100)}%</b>
              <Meter value={x.covered / x.total} label="coverage" />
              <small>{x.total - x.covered} gap{x.total - x.covered === 1 ? '' : 's'}</small>
            </button>
          ))}
        </div>
      </div>

      <div className="grid-2">
        <div className="panel">
          <div className="panel-head"><h2>{A.label} × {B.label}</h2><PairSelect p={p} value={pair} onChange={i => { setPair(i); setCell(null) }} /></div>
          <Heatmap odd={project.odd} pair={P} onCell={(i, j) => setCell([i, j])} selected={cell} />
          <HeatLegend />
        </div>
        <div className="panel">
          {cell ? <>
            <h2>{a.cov.oneWay[P.a].labels[cell[0]]} × {a.cov.oneWay[P.b].labels[cell[1]]}</h2>
            {cellRuns.length ? <RunTable p={p} runs={cellRuns.slice(0, 40)} /> : <Empty title="Never tested"><p className="muted small">No run has {A.label} in {a.cov.oneWay[P.a].labels[cell[0]]} together with {B.label} in {a.cov.oneWay[P.b].labels[cell[1]]}.</p><Link href={tabHref(p, 'next')} className="btn primary sm">Recommend runs for gaps</Link></Empty>}
            {cellRuns.length > 40 && <p className="muted small">Showing 40 of {cellRuns.length}.</p>}
          </> : <>
            <div className="panel-head"><h2>Gap list</h2><button type="button" className="btn ghost sm" onClick={() => download('coverage-gaps.csv', gapCsv())}>Download CSV</button></div>
            <p className="muted small">{fmtN(a.gaps.length)} untested 2-way combinations, riskiest first (cells whose bins already fail often on their own).</p>
            {a.gaps.length ? <ol className="gap-list scroll">{a.gaps.slice(0, 60).map(g => <li key={g.text}>{g.text}</li>)}</ol> : <p>Full pairwise coverage.</p>}
          </>}
        </div>
      </div>
    </>
  )
}

function RunTable({ p, runs }: { p: TabProps; runs: Run[] }) {
  const idx = useMemo(() => new Map(p.a.runs.map((r, i) => [r.id, i])), [p.a.runs])
  return (
    <div className="table-wrap"><table>
      <thead><tr><th>Run</th><th>Scenario</th><th>Verdict</th><th className="num">TTC</th><th className="num">Gap</th></tr></thead>
      <tbody>{runs.map(r => { const v = p.a.verdicts[idx.get(r.id)!]; return (
        <tr key={r.id}>
          <th>{r.traj ? <Link href={tabHref(p, 'replay', `run=${r.id}`)}>{r.id}</Link> : r.id}</th>
          <td>{r.scenario}</td>
          <td><span className={`badge ${v.status}`} title={v.reasons.join('; ')}>{v.status}</span></td>
          <td className="num">{r.metrics.ttc?.toFixed(2) ?? '—'}</td>
          <td className="num">{r.metrics.minDist?.toFixed(1) ?? '—'}</td>
        </tr>) })}</tbody>
    </table></div>
  )
}

// ---------- Failures ----------

const STATUS: [TriageStatus, string][] = [['open', 'Open'], ['triaged', 'Triaged'], ['fixed', 'Fixed'], ['wontfix', "Won't fix"]]

function FailuresTab(p: TabProps) {
  const { a, project, update } = p
  const [rule, setRule] = useState<number | null>(null)
  const [cluster, setCluster] = useState<number | null>(null)
  const [status, setStatus] = useState<TriageStatus | 'all'>('all')
  const failedRuns = a.runs.map((r, i) => ({ r, v: a.verdicts[i] })).filter(x => x.v.status === 'fail')
  const rows = failedRuns.filter(({ r }) =>
    (rule === null || ruleMatches(a.rules[rule], r)) &&
    (cluster === null || a.clusterOf.get(r.id) === cluster) &&
    (status === 'all' || (project.triage[r.id]?.status ?? 'open') === status))
  const setTriage = (id: string, s: TriageStatus, note?: string) => void update({ triage: { ...project.triage, [id]: { status: s, note: note ?? project.triage[id]?.note, at: Date.now() } } })
  const csv = () => toCsv([['run_id', 'scenario', ...project.odd.map(d => d.key), 'reasons', 'cluster', 'status', 'note'], ...rows.map(({ r, v }) => [r.id, r.scenario, ...project.odd.map(d => r.params[d.key] ?? ''), v.reasons.join('; '), (a.clusterOf.get(r.id) ?? 0) + 1, project.triage[r.id]?.status ?? 'open', project.triage[r.id]?.note ?? ''])])
  if (!a.fails) return <div className="panel"><Empty title="No failures in this scope"><p className="muted">Every judged run is within your thresholds. Tighten them on the Data &amp; ODD tab, or look for gaps instead.</p><Link href={tabHref(p, 'next')} className="btn primary">Next scenarios</Link></Empty></div>
  return (
    <>
      <div className="grid-2">
        <div className="panel">
          <div className="panel-head"><h2>Failure rules</h2><span className="muted small">Decision tree on all runs, fail vs pass</span></div>
          {a.rules.length ? <div className="choice-list">
            {a.rules.map((r, i) => (
              <button key={i} type="button" className={`choice${rule === i ? ' on' : ''}`} aria-pressed={rule === i} onClick={() => setRule(rule === i ? null : i)}>
                <b>{r.text}</b><span className="muted small">{r.fails}/{r.n} fail · {fmtPct(r.rate)} · {r.lift.toFixed(1)}× base rate</span>
              </button>
            ))}
          </div> : <p className="muted">No compact rule explains the failures; see the clusters.</p>}
        </div>
        <div className="panel">
          <div className="panel-head"><h2>Failure clusters</h2><span className="muted small">k-means on normalised parameters, k by silhouette</span></div>
          <div className="choice-list">
            {a.clusters.map(c => (
              <button key={c.id} type="button" className={`choice${cluster === c.id ? ' on' : ''}`} aria-pressed={cluster === c.id} onClick={() => setCluster(cluster === c.id ? null : c.id)}>
                <span className="row between"><b>Cluster {c.id + 1}</b><span className="badge fail">{c.runs.length} runs</span></span>
                <span className="small">{c.summary.length ? c.summary.join(' · ') : 'Spread across the ODD'}</span>
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <h2>Worklist <span className="muted small">({rows.length} of {failedRuns.length})</span></h2>
          <div className="toolbar">
            <select value={status} onChange={e => setStatus(e.target.value as TriageStatus | 'all')} aria-label="Triage status filter"><option value="all">Any status</option>{STATUS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
            {(rule !== null || cluster !== null) && <button type="button" className="btn ghost sm" onClick={() => { setRule(null); setCluster(null) }}>Clear filters</button>}
            <button type="button" className="btn ghost sm" onClick={() => download('failure-worklist.csv', csv())}>Download CSV</button>
          </div>
        </div>
        <div className="table-wrap"><table className="worklist">
          <thead><tr><th>Run</th><th>Scenario</th><th>Why it failed</th><th>Cluster</th><th>Status</th><th>Note</th></tr></thead>
          <tbody>{rows.slice(0, 200).map(({ r, v }) => (
            <tr key={r.id}>
              <th>{r.traj ? <Link href={tabHref(p, 'replay', `run=${r.id}`)} title="Replay">{r.id} &#9654;</Link> : r.id}</th>
              <td><span className="small">{r.scenario}</span><div className="tiny muted">{project.odd.slice(0, 4).map(d => String(r.params[d.key] ?? '—').replace(/_/g, ' ')).join(' · ')}</div></td>
              <td className="small">{v.reasons.join('; ')}</td>
              <td className="num">{(a.clusterOf.get(r.id) ?? 0) + 1}</td>
              <td><select className="table-input" value={project.triage[r.id]?.status ?? 'open'} onChange={e => setTriage(r.id, e.target.value as TriageStatus)} aria-label={`Status of ${r.id}`}>{STATUS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></td>
              <td><input className="table-input" defaultValue={project.triage[r.id]?.note ?? ''} placeholder="Ticket, owner…" aria-label={`Note for ${r.id}`} onBlur={e => { if (e.target.value !== (project.triage[r.id]?.note ?? '')) setTriage(r.id, project.triage[r.id]?.status ?? 'open', e.target.value) }} /></td>
            </tr>
          ))}</tbody>
        </table></div>
        {rows.length > 200 && <p className="muted small">Showing 200 of {rows.length}; the CSV has all of them.</p>}
      </div>
    </>
  )
}

// ---------- Replay ----------

function ReplayTab(p: TabProps) {
  const { a, project, traj } = p
  const idx = useMemo(() => new Map(a.runs.map((r, i) => [r.id, i])), [a.runs])
  const withTraj = a.runs.filter(r => traj[r.id])
  const fromUrl = new URLSearchParams(location.search).get('run')
  const [only, setOnly] = useState<'all' | 'fail'>('all')
  const list = withTraj.filter(r => only === 'all' || a.verdicts[idx.get(r.id)!].status === 'fail')
  const sel = fromUrl && traj[fromUrl] ? fromUrl : (list.find(r => a.verdicts[idx.get(r.id)!].status === 'fail') ?? list[0])?.id
  const pick = (id: string) => go(tabHref(p, 'replay', `run=${id}`), { replace: true, keepScroll: true })
  if (!withTraj.length) return <div className="panel"><Empty title="No trajectories in this scope"><p className="muted">Import per-run trajectory CSVs (time, actor, x, y, heading, speed) on the Data &amp; ODD tab to compute TTC, PET, gaps and braking from the motion itself, and replay runs here.</p>{project.dataMissing && <p className="warn-text small">This project's trajectories live on another device.</p>}<Link href={`/app/p/${project.id}/data`} className="btn primary">Import trajectories</Link></Empty></div>
  const run = a.runs[idx.get(sel!)!]
  const v = a.verdicts[idx.get(sel!)!]
  return (
    <div className="replay-layout">
      <aside className="panel run-list">
        <div className="seg-control" role="radiogroup" aria-label="Filter runs">
          <button type="button" role="radio" aria-checked={only === 'all'} className={only === 'all' ? 'on' : ''} onClick={() => setOnly('all')}>All {withTraj.length}</button>
          <button type="button" role="radio" aria-checked={only === 'fail'} className={only === 'fail' ? 'on' : ''} onClick={() => setOnly('fail')}>Failed</button>
        </div>
        <ul>{list.map(r => { const s = a.verdicts[idx.get(r.id)!].status; return (
          <li key={r.id}><button type="button" className={r.id === sel ? 'on' : ''} aria-current={r.id === sel} onClick={() => pick(r.id)}>
            <i className={`dot ${s}`} aria-hidden="true" /><span><b>{r.id}</b><small>{r.scenario.replace(/_/g, ' ')}</small></span>
          </button></li>) })}</ul>
      </aside>
      {run && <div className="panel">
        <div className="panel-head"><h2>{run.id} <span className={`badge ${v.status}`}>{v.status}</span></h2><span className="muted small">{project.odd.map(d => `${d.label}: ${String(run.params[d.key] ?? '—').replace(/_/g, ' ')}${d.unit && d.kind === 'range' ? ' ' + d.unit : ''}`).join(' · ')}</span></div>
        <Replay key={run.id} rows={traj[run.id]} th={project.thresholds} laneWidth={project.laneWidth} autoplay />
        <div className="metric-row">
          {([['ttc', 'Min TTC', 's'], ['pet', 'Min PET', 's'], ['minDist', 'Min gap', 'm'], ['maxDecel', 'Max decel', 'm/s²'], ['maxJerk', 'Max jerk', 'm/s³'], ['laneDev', 'Lane offset', 'm']] as const).map(([k, l, u]) => {
            const x = run.metrics[k], th = project.thresholds[k]
            const bad = x !== undefined && (k === 'ttc' || k === 'pet' || k === 'minDist' ? x < th : x > th)
            return <div key={k} className={`metric${bad ? ' bad' : ''}`}><small>{l}</small><b>{x === undefined ? '—' : x.toFixed(2)}</b><span>{u} · limit {th}</span></div>
          })}
        </div>
        {v.reasons.length > 0 && <p className="error small">{v.reasons.join(' · ')}</p>}
        <p className="muted small">TTC projects both oriented boxes forward at constant velocity along their headings. PET is the smallest time gap between the two footprints occupying the same road. Metrics are recomputed from the trajectory on import.</p>
      </div>}
    </div>
  )
}

// ---------- Next scenarios ----------

function NextTab(p: TabProps) {
  const { a, project, update } = p
  const d = getDefaults()
  const [n, setN] = useState(d.recCount)
  const [share, setShare] = useState(d.boundaryShare)
  const [seed, setSeed] = useState(11)
  const recs = useMemo(() => recommend(project.odd, a.runs, a.failed, { n, boundaryShare: share, seed }), [project.odd, a.runs, a.failed, n, share, seed])
  const after = useMemo(() => coverage(project.odd, [...a.runs, ...recs.map(r => ({ id: r.id, scenario: r.id, params: r.params, metrics: {} }))]), [recs, a.runs, project.odd])
  const xosc = recsToXosc(project.odd, recs, project.scenarioFile)
  return (
    <>
      <div className="panel">
        <div className="panel-head"><h2>Recommended next runs</h2>
          <div className="toolbar">
            <label className="field inline"><span>Runs</span><input type="number" min="4" max="200" value={n} onChange={e => setN(Math.max(4, Math.min(200, Number(e.target.value) || 4)))} /></label>
            <label className="field inline"><span>Near failures {Math.round(share * 100)}%</span><input type="range" min="0" max="1" step="0.05" value={share} onChange={e => setShare(Number(e.target.value))} /></label>
            <button type="button" className="btn ghost sm" onClick={() => setSeed(s => s + 1)}>Reshuffle</button>
          </div>
        </div>
        <div className="kpis three">
          <div className="kpi"><small>Pairwise coverage now</small><b>{fmtPct(a.cov.pairwisePct, 1)}</b></div>
          <div className="kpi"><small>After these {recs.length} runs</small><b className="good-text">{fmtPct(after.pairwisePct, 1)}</b><p>{signed((after.pairwisePct - a.cov.pairwisePct) * 100, x => x.toFixed(1))} points</p></div>
          <div className="kpi"><small>Boundary probes</small><b>{recs.filter(r => r.kind === 'boundary').length}</b><p>between failing runs and their nearest passing neighbour</p></div>
        </div>
        <div className="row gap wrap">
          <button type="button" className="btn primary" onClick={() => download('recommended-scenarios.csv', recsToCsv(project.odd, recs))}>Download CSV</button>
          <button type="button" className="btn primary" onClick={() => download('recommended-scenarios.xosc', xosc, 'application/xml')}>Download OpenSCENARIO</button>
          <CopyButton text={recsToCsv(project.odd, recs)} label="Copy CSV" />
          <label className="field inline grow-0"><span>Scenario file</span><input value={project.scenarioFile} onChange={e => void update({ scenarioFile: e.target.value })} aria-label="Scenario file referenced in the distribution" /></label>
        </div>
      </div>
      <div className="panel">
        <div className="table-wrap"><table>
          <thead><tr><th>Id</th>{project.odd.map(d => <th key={d.key}>{d.label}{d.unit && d.kind === 'range' ? ` (${d.unit})` : ''}</th>)}<th>Why</th></tr></thead>
          <tbody>{recs.map(r => (
            <tr key={r.id}><th className="mono small">{r.id}</th>{project.odd.map(d => <td key={d.key} className={d.kind === 'range' ? 'num' : ''}>{String(r.params[d.key]).replace(/_/g, ' ')}</td>)}<td className="small"><span className={`badge ${r.kind === 'gap' ? 'gapk' : 'fail'}`}>{r.kind === 'gap' ? 'gap fill' : 'boundary'}</span> {r.reason}</td></tr>
          ))}</tbody>
        </table></div>
      </div>
      <details className="panel"><summary>OpenSCENARIO parameter value distribution</summary><Code code={xosc} label="recommended-scenarios.xosc" /></details>
    </>
  )
}

// ---------- History ----------

function HistoryTab(p: TabProps) {
  const { project, update } = p
  const list = sortCampaigns(project.campaigns)
  const tr = useMemo(() => trend(project), [project.campaigns, project.odd, project.thresholds])
  const [A, setA] = useState(list.at(-2)?.id ?? list[0]?.id)
  const [B, setB] = useState(list.at(-1)?.id)
  const ca = list.find(c => c.id === A), cb = list.find(c => c.id === B)
  const cmp = useMemo(() => {
    if (!ca || !cb) return null
    const x = analyse(project.odd, ca.runs, project.thresholds), y = analyse(project.odd, cb.runs, project.thresholds)
    const both = coverage(project.odd, [...ca.runs, ...cb.runs])
    const cells = (c: typeof x.cov) => new Set(c.pairs.flatMap((pp, k) => pp.counts.flatMap((r, i) => r.map((n, j) => n ? `${k}:${i}:${j}` : '')).filter(Boolean)))
    const sa = cells(x.cov), sb = cells(y.cov)
    const rate = (z: typeof x) => z.runs.length - z.untested ? z.fails / (z.runs.length - z.untested) : 0
    return { x, y, both, newCells: [...sb].filter(c => !sa.has(c)).length, lostCells: [...sa].filter(c => !sb.has(c)).length, rateA: rate(x), rateB: rate(y),
      rulesNew: y.rules.filter(r => !x.rules.some(o => o.text === r.text)), rulesGone: x.rules.filter(r => !y.rules.some(o => o.text === r.text)) }
  }, [ca, cb, project.odd, project.thresholds])

  const remove = async (id: string) => {
    const c = list.find(x => x.id === id)!
    if (!(await ask(`Delete campaign “${c.label}”?`, `Removes ${c.runs.length} runs from this project. You can undo for a few seconds.`, 'Delete campaign'))) return
    const before = project.campaigns
    await update({ campaigns: before.filter(x => x.id !== id) })
    void deleteCampaignCloud(id)
    toast(`Deleted ${c.label}`, { undo: () => void update({ campaigns: before }) })
  }

  return (
    <>
      <div className="panel">
        <div className="panel-head"><h2>Coverage trend</h2><span className="muted small">Coverage is cumulative over every campaign so far; failure rate is per campaign</span></div>
        <TrendChart points={tr} compareIds={[A ?? '', B ?? '']} />
        <div className="legend"><span><i className="lg-pair" />Pairwise coverage</span><span><i className="lg-oneway" />1-way coverage</span><span><i className="lg-fail" />Failure rate</span></div>
      </div>
      <div className="panel">
        <div className="panel-head"><h2>Campaigns</h2><Link href={`/app/p/${project.id}/data`} className="btn ghost sm">Import a campaign</Link></div>
        <div className="table-wrap"><table>
          <thead><tr><th>Campaign</th><th>Date</th><th className="num">Runs</th><th className="num">Cumulative pairwise</th><th className="num">Failure rate</th><th /></tr></thead>
          <tbody>{tr.map(t => <tr key={t.id}><th>{t.label}</th><td>{t.date}</td><td className="num">{fmtN(t.runs)}</td><td className="num">{fmtPct(t.pairwise, 1)}</td><td className="num">{fmtPct(t.failRate, 1)}</td><td className="num"><button type="button" className="btn danger-ghost sm" onClick={() => void remove(t.id)}>Delete</button></td></tr>)}</tbody>
        </table></div>
      </div>
      {list.length > 1 && <div className="panel">
        <div className="panel-head"><h2>Compare</h2>
          <div className="toolbar">
            <select value={A} onChange={e => setA(e.target.value)} aria-label="Baseline campaign">{list.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}</select>
            <span aria-hidden="true">&rarr;</span>
            <select value={B} onChange={e => setB(e.target.value)} aria-label="Comparison campaign">{list.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}</select>
          </div>
        </div>
        {cmp && <>
          <div className="kpis">
            <div className="kpi"><small>Pairwise coverage</small><b>{fmtPct(cmp.y.cov.pairwisePct, 1)}</b><p>{signed((cmp.y.cov.pairwisePct - cmp.x.cov.pairwisePct) * 100, x => x.toFixed(1))} pts vs baseline ({fmtPct(cmp.x.cov.pairwisePct, 1)})</p></div>
            <div className="kpi"><small>Newly covered cells</small><b>{cmp.newCells}</b><p>{cmp.lostCells} cells only the baseline touched</p></div>
            <div className="kpi"><small>Failure rate</small><b className={cmp.rateB > cmp.rateA ? 'error' : 'good-text'}>{fmtPct(cmp.rateB, 1)}</b><p>{signed((cmp.rateB - cmp.rateA) * 100, x => x.toFixed(1))} pts vs {fmtPct(cmp.rateA, 1)}</p></div>
            <div className="kpi"><small>Together</small><b>{fmtPct(cmp.both.pairwisePct, 1)}</b><p>pairwise coverage of both</p></div>
          </div>
          <div className="grid-2">
            <div><h3>1-way coverage by parameter</h3>
              <table><thead><tr><th>Parameter</th><th className="num">Baseline</th><th className="num">Compared</th></tr></thead>
                <tbody>{cmp.x.cov.oneWay.map((o, i) => { const n = cmp.y.cov.oneWay[i]; return <tr key={o.key}><th>{o.label}</th><td className="num">{o.covered}/{o.total}</td><td className={`num ${n.covered > o.covered ? 'good-text' : n.covered < o.covered ? 'error' : ''}`}>{n.covered}/{n.total}</td></tr> })}</tbody></table>
            </div>
            <div><h3>Failure rules</h3>
              {cmp.rulesNew.length ? <ul className="rules plain">{cmp.rulesNew.map(r => <li key={r.text}><span className="badge fail">new</span> {r.text} <span className="muted small">({r.fails}/{r.n})</span></li>)}</ul> : <p className="muted small">No new failure regions.</p>}
              {cmp.rulesGone.length > 0 && <ul className="rules plain">{cmp.rulesGone.map(r => <li key={r.text}><span className="badge pass">gone</span> {r.text}</li>)}</ul>}
            </div>
          </div>
        </>}
      </div>}
    </>
  )
}

