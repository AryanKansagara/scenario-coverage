import { useEffect, useMemo } from 'react'
import { span } from './engine/coverage.ts'
import { scopeFromUrl, trend, useAnalysis, useProject } from './projectData.ts'
import { Empty, fmtN, fmtPct, Link } from './ui.tsx'
import { HeatLegend, Heatmap, TrendChart } from './viz.tsx'

export default function Report({ id }: { id: string }) {
  const { loading, project } = useProject(id)
  const scope = scopeFromUrl(project)
  const a = useAnalysis(project, scope)
  const tr = useMemo(() => project ? trend(project) : [], [project?.campaigns, project?.odd, project?.thresholds])
  useEffect(() => { if (project) document.title = `Coverage report · ${project.name}` }, [project?.name])
  if (loading) return <div className="boot"><span className="spinner" /></div>
  if (!project || !a) return <section className="page narrow center"><Empty title="Nothing to report"><Link href="/app" className="btn primary">Projects</Link></Empty></section>
  const scopeLabel = scope === 'all' ? 'All campaigns (cumulative)' : project.campaigns.find(c => c.id === scope)?.label
  const judged = a.runs.length - a.untested
  const worst = [...a.cov.pairs].sort((x, y) => x.covered / x.total - y.covered / y.total).slice(0, 2)
  const th = project.thresholds
  return (
    <article className="report">
      <div className="report-actions">
        <Link href={`/app/p/${id}${scope === 'all' ? '' : `?c=${scope}`}`} className="btn ghost">Back</Link>
        <button type="button" className="btn primary" onClick={() => print()}>Print or save as PDF</button>
      </div>
      <div className="eyebrow">ODD coverage report{project.sampleId ? ' · synthetic sample data' : ''}</div>
      <h1>{project.name}</h1>
      <p className="muted">{scopeLabel} · {fmtN(a.runs.length)} runs · generated {new Date().toLocaleDateString('en-US', { dateStyle: 'long' })}</p>

      <div className="kpis">
        <div className="kpi"><small>Pairwise coverage</small><b>{fmtPct(a.cov.pairwisePct, 1)}</b><p>{a.cov.coveredCells}/{a.cov.totalCells} cells</p></div>
        <div className="kpi"><small>1-way coverage</small><b>{fmtPct(a.cov.oneWayPct, 1)}</b></div>
        <div className="kpi"><small>Failure rate</small><b>{judged ? fmtPct(a.fails / judged, 1) : '—'}</b><p>{a.fails} of {judged}</p></div>
        <div className="kpi"><small>Outside ODD</small><b>{a.cov.outside}</b><p>runs</p></div>
      </div>

      <h2>ODD and thresholds</h2>
      <table><thead><tr><th>Parameter</th><th>Domain</th><th className="num">Bins covered</th></tr></thead>
        <tbody>{project.odd.map((d, i) => <tr key={d.key}><th>{d.label}</th><td>{d.kind === 'range' ? `${span(d.min ?? 0, d.max ?? 1)} ${d.unit ?? ''} in ${d.bins} bins` : (d.categories ?? []).join(', ')}</td><td className="num">{a.cov.oneWay[i].covered}/{a.cov.oneWay[i].total}</td></tr>)}</tbody></table>
      <p className="small muted">Fail if: TTC &lt; {th.ttc} s · PET &lt; {th.pet} s · gap &lt; {th.minDist} m · deceleration &gt; {th.maxDecel} m/s² · jerk &gt; {th.maxJerk} m/s³ · lane offset &gt; {th.laneDev} m · collision · simulator failure.</p>

      {tr.length > 1 && <><h2>Coverage trend</h2><TrendChart points={tr} /></>}

      <h2>Least covered parameter pairs</h2>
      <div className="grid-2">{worst.map(p => <div key={`${p.a}-${p.b}`}><h3>{project.odd[p.a].label} × {project.odd[p.b].label} · {fmtPct(p.covered / p.total)}</h3><Heatmap odd={project.odd} pair={p} /></div>)}</div>
      <HeatLegend />

      <h2>Failure regions</h2>
      {a.rules.length ? <ol>{a.rules.slice(0, 8).map(r => <li key={r.text}>{r.text}: {r.fails}/{r.n} runs fail ({fmtPct(r.rate)}, {r.lift.toFixed(1)}× base rate)</li>)}</ol> : <p>No compact failure rule.</p>}
      {a.clusters.length > 0 && <table><thead><tr><th>Cluster</th><th className="num">Runs</th><th>Shared conditions</th></tr></thead><tbody>{a.clusters.map(c => <tr key={c.id}><th>{c.id + 1}</th><td className="num">{c.runs.length}</td><td>{c.summary.join(' · ') || 'spread out'}</td></tr>)}</tbody></table>}

      <h2>Top untested combinations</h2>
      {a.gaps.length ? <ol className="cols-2">{a.gaps.slice(0, 20).map(g => <li key={g.text}>{g.text}</li>)}</ol> : <p>Full pairwise coverage.</p>}
      <p className="small muted">Coverage counts a 2-way cell as covered when at least one run lands in both bins. Gaps are ranked by how often their bins fail elsewhere.</p>
    </article>
  )
}
