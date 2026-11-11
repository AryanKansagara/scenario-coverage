import { useMemo, useRef, useState } from 'react'
import { parseCsv } from './engine/csv.ts'
import { computeMetrics } from './engine/metrics.ts'
import { attachResults, autoMap, detect, FORMATS, inferOdd, jsonTable, norm, parseCarla, parseTrajectories, parseXosc, pretty, ROLE_LABEL, validateTable, xoscOdd, xoscToRun, type CarlaResult, type Format, type Issue, type Mapping, type Role, type Xosc } from './engine/parse.ts'
import type { Campaign, Odd, OddParam, Run, TrajRow } from './engine/types.ts'
import { createSampleProject } from './projectData.ts'
import { TH_FIELDS } from './Settings.tsx'
import { putData, sortCampaigns, uuid, type Project, type TrajStore } from './store.ts'
import { ask, fmtN, go, Link, toast } from './ui.tsx'

interface Props { project: Project; traj: TrajStore; update(p: Partial<Project>): Promise<unknown> }

type Staged =
  | { kind: 'table'; format: Format; fileName: string; headers: string[]; rows: string[][]; lines: number[]; map: Mapping }
  | { kind: 'xosc'; files: { name: string; x: Xosc }[]; errors: string[] }
  | { kind: 'carla'; fileName: string; results: CarlaResult[] }
  | { kind: 'traj'; fileName: string; byRun: Map<string, TrajRow[]>; issues: Issue[]; degrees: boolean }

const today = () => new Date().toISOString().slice(0, 10)
const ROLES: Role[] = ['param', 'id', 'scenario', 'outcome', 'reason', 'ttc', 'pet', 'minDist', 'maxDecel', 'maxJerk', 'laneDev', 'collision', 'ignore']

export default function DataTab({ project, traj, update }: Props) {
  const [staged, setStaged] = useState<Staged | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [over, setOver] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const empty = !project.campaigns.some(c => c.runs.length)

  const load = async (files: FileList | File[]) => {
    setErr(null)
    const list = [...files]
    if (!list.length) return
    try {
      const texts = await Promise.all(list.map(f => f.text()))
      const fmt = detect(list[0].name, texts[0])
      if (fmt === 'xosc') {
        const out: { name: string; x: Xosc }[] = [], errors: string[] = []
        list.forEach((f, i) => { try { out.push({ name: f.name, x: parseXosc(texts[i]) }) } catch (e) { errors.push(`${f.name}: ${(e as Error).message}`) } })
        setStaged({ kind: 'xosc', files: out, errors })
      } else if (fmt === 'carla-json') setStaged({ kind: 'carla', fileName: list[0].name, results: list.flatMap((_, i) => parseCarla(texts[i])) })
      else if (fmt === 'trajectory-csv') {
        const byRun = new Map<string, TrajRow[]>(), issues: Issue[] = []
        let degrees = false
        list.forEach((f, i) => { const t = parseTrajectories(texts[i], f.name.replace(/\.[^.]+$/, '')); t.byRun.forEach((v, k) => byRun.set(k, [...(byRun.get(k) ?? []), ...v])); issues.push(...t.issues.map(x => ({ ...x, message: list.length > 1 ? `${f.name}: ${x.message}` : x.message }))); degrees ||= t.degrees })
        setStaged({ kind: 'traj', fileName: list.map(f => f.name).join(', '), byRun, issues, degrees })
      } else {
        const t = fmt === 'param-json' ? jsonTable(texts[0]) : (() => { const { rows, lines } = parseCsv(texts[0]); return { headers: rows[0] ?? [], rows: rows.slice(1), lines: lines.slice(1) } })()
        if (!t.headers.length || !t.rows.length) throw new Error('The file has a header but no data rows.')
        setStaged({ kind: 'table', format: fmt, fileName: list[0].name, ...t, map: autoMap(t.headers) })
      }
    } catch (e) { setErr(`Could not read ${list[0].name}: ${(e as Error).message}`) }
  }

  const loadExample = async (name: string) => {
    const r = await fetch(`/examples/${name}`)
    await load([new File([await r.text()], name)])
  }

  return (
    <div className="data-tab">
      {empty && !staged && (
        <div className="banner">
          <span>New project. Import a scenario table or results to start; the ODD is inferred from the columns and you can edit it below.</span>
          <button type="button" className="btn ghost sm" onClick={async () => { const p = await createSampleProject(); go(`/app/p/${p.id}`) }}>Or open the synthetic sample</button>
        </div>
      )}
      <div className="panel">
        <div className="panel-head"><h2>Import</h2><Link href="/docs" className="small">How to export from your simulator &rarr;</Link></div>
        {!staged ? <>
          <div className={`drop${over ? ' over' : ''}`} role="button" tabIndex={0} onClick={() => input.current?.click()} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.current?.click() } }}
            onDragOver={e => { e.preventDefault(); setOver(true) }} onDragLeave={() => setOver(false)} onDrop={e => { e.preventDefault(); setOver(false); void load(e.dataTransfer.files) }}>
            <h3>Drop files here, or click to choose</h3>
            <p className="muted small">{Object.values(FORMATS).join(' · ')}. Several .xosc or trajectory files at once are fine.</p>
            <input ref={input} type="file" multiple hidden accept=".csv,.tsv,.txt,.json,.xosc,.xml" onChange={e => { if (e.target.files) void load(e.target.files); e.target.value = '' }} />
          </div>
          <p className="muted small">Example files: {['scenario_runs.csv', 'cut_in.xosc', 'carla_results.json', 'trajectory_run.csv'].map((f, i) => <span key={f}>{i ? ' · ' : ''}<button type="button" className="linkish" onClick={() => void loadExample(f)}>{f}</button> <a href={`/examples/${f}`} download aria-label={`Download ${f}`}>&darr;</a></span>)}</p>
          {err && <p className="error" role="alert">{err}</p>}
        </> : staged.kind === 'table' ? <TableImport s={staged} setS={setStaged} project={project} update={update} done={() => setStaged(null)} />
          : staged.kind === 'xosc' ? <XoscImport s={staged} project={project} update={update} done={() => setStaged(null)} />
          : staged.kind === 'carla' ? <CarlaImport s={staged} project={project} update={update} done={() => setStaged(null)} />
          : <TrajImport s={staged} project={project} traj={traj} update={update} done={() => setStaged(null)} />}
      </div>

      <OddEditor project={project} update={update} />
      <ThresholdEditor project={project} update={update} />

      {project.imports.length > 0 && <div className="panel">
        <h2>Import history</h2>
        <div className="table-wrap"><table>
          <thead><tr><th>File</th><th>Format</th><th className="num">Rows</th><th className="num">Skipped</th><th>When</th></tr></thead>
          <tbody>{[...project.imports].reverse().map(i => <tr key={i.id}><th className="break">{i.fileName}</th><td>{FORMATS[i.kind]}</td><td className="num">{fmtN(i.rows)}</td><td className="num">{fmtN(i.skipped)}</td><td>{new Date(i.at).toLocaleString()}</td></tr>)}</tbody>
        </table></div>
      </div>}
    </div>
  )
}

function Issues({ issues }: { issues: Issue[] }) {
  if (!issues.length) return <p className="good-text small">No problems found.</p>
  const errors = issues.filter(i => i.level === 'error').length
  return <>
    <p className="small"><b className={errors ? 'error' : ''}>{errors} error{errors === 1 ? '' : 's'}</b> · {issues.length - errors} warning{issues.length - errors === 1 ? '' : 's'}</p>
    <div className="issues" role="log">{issues.slice(0, 300).map((i, k) => <div key={k} className={i.level === 'error' ? 'error-row' : ''}><span className="ln">line {i.line}</span><span>{i.message}</span></div>)}</div>
  </>
}

function CampaignFields({ label, setLabel, date, setDate }: { label: string; setLabel(s: string): void; date: string; setDate(s: string): void }) {
  return <div className="inline-fields">
    <label className="field"><span>Campaign name</span><input value={label} onChange={e => setLabel(e.target.value)} /></label>
    <label className="field"><span>Campaign date</span><input type="date" value={date} onChange={e => setDate(e.target.value)} /></label>
  </div>
}

async function addCampaign(project: Project, update: Props['update'], c: Campaign, meta: { kind: Format; fileName: string; rows: number; skipped: number }, odd?: Odd) {
  await update({ odd: odd ?? project.odd, campaigns: sortCampaigns([...project.campaigns, c]), imports: [...project.imports, { id: uuid(), at: Date.now(), campaign: c.id, ...meta }] })
  toast(`Imported ${fmtN(c.runs.length)} runs into “${c.label}”`, { tone: 'ok' })
  go(`/app/p/${project.id}`)
}

function TableImport({ s, setS, project, update, done }: { s: Extract<Staged, { kind: 'table' }>; setS(s: Staged): void; project: Project; update: Props['update']; done(): void }) {
  const inferred = useMemo(() => inferOdd(s.headers, s.rows, s.map), [s])
  const [useInferred, setUseInferred] = useState(!project.odd.length)
  const odd = useMemo(() => {
    if (useInferred) return inferred
    // Keep the current ODD; add any new parameter columns so they are not silently dropped.
    return [...project.odd, ...inferred.filter(d => !project.odd.some(o => o.key === d.key))]
  }, [useInferred, inferred, project.odd])
  const v = useMemo(() => validateTable(s.headers, s.rows, s.lines, s.map, odd), [s, odd])
  const [label, setLabel] = useState(s.fileName.replace(/\.[^.]+$/, ''))
  const [date, setDate] = useState(today())
  const errors = v.issues.filter(i => i.level === 'error' && i.line === 1).length
  return <>
    <p><b>{s.fileName}</b> · detected <b>{FORMATS[s.format]}</b> · {fmtN(s.rows.length)} rows</p>
    <h3>Column mapping</h3>
    <div className="map-grid">
      {s.headers.map((h, c) => (
        <label key={c} className="field"><span className="break">{h} <span className="muted tiny">e.g. {s.rows[0]?.[c] || '—'}</span></span>
          <select value={s.map[c]} onChange={e => { const map = [...s.map]; map[c] = e.target.value as Role; setS({ ...s, map }) }}>{ROLES.map(r => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}</select>
        </label>
      ))}
    </div>
    {project.odd.length > 0 && <label className="row gap-sm small"><input type="checkbox" checked={useInferred} onChange={e => setUseInferred(e.target.checked)} /> Replace the project ODD with the one inferred from this file</label>}
    <p className="muted small">ODD for this import: {odd.map(d => `${d.label} (${d.kind === 'range' ? `${d.min}–${d.max}` : `${d.categories?.length} categories`})`).join(', ') || 'none'}</p>
    <h3>Validation</h3>
    <Issues issues={v.issues} />
    <CampaignFields label={label} setLabel={setLabel} date={date} setDate={setDate} />
    <div className="row gap">
      <button type="button" className="btn primary" disabled={!!errors || !v.runs.length} onClick={() => void addCampaign(project, update, { id: uuid(), label: label || 'Campaign', date, runs: v.runs, source: s.fileName }, { kind: s.format, fileName: s.fileName, rows: v.total, skipped: v.skipped }, odd)}>Import {fmtN(v.runs.length)} runs{v.skipped ? ` (skip ${v.skipped})` : ''}</button>
      <button type="button" className="btn ghost" onClick={done}>Cancel</button>
    </div>
  </>
}

function XoscImport({ s, project, update, done }: { s: Extract<Staged, { kind: 'xosc' }>; project: Project; update: Props['update']; done(): void }) {
  const runs = s.files.map(f => xoscToRun(f.x, f.name))
  const suggested = xoscOdd(s.files.map(f => f.x), runs)
  const [label, setLabel] = useState(`Catalog ${today()}`)
  const [date, setDate] = useState(today())
  const odd = project.odd.length ? [...project.odd, ...suggested.filter(d => !project.odd.some(o => o.key === d.key))] : suggested
  return <>
    <p><b>{s.files.length} OpenSCENARIO file{s.files.length === 1 ? '' : 's'}</b>. Each becomes one planned run (no verdict until results arrive; attach CARLA results or a result table later).</p>
    {s.errors.map(e => <p key={e} className="error small">{e}</p>)}
    <div className="table-wrap"><table>
      <thead><tr><th>File</th><th>Scenario</th><th>Parameters</th><th>Entities</th><th>Init speeds</th></tr></thead>
      <tbody>{s.files.map(f => <tr key={f.name}><th className="break">{f.name}</th><td>{f.x.name}</td><td className="small">{Object.entries(f.x.params).map(([k, v]) => `${k}=${v}`).join(', ') || '—'}</td><td className="small">{f.x.entities.map(e => `${e.name} (${e.category ?? e.type})`).join(', ')}</td><td className="small">{Object.entries(f.x.initSpeeds).map(([k, v]) => `${k} ${v} m/s`).join(', ') || '—'}</td></tr>)}</tbody>
    </table></div>
    <p className="muted small">ODD after import: {odd.map(d => d.label).join(', ')}. Declared &lt;Range&gt; constraints are used as bounds when present.</p>
    <CampaignFields label={label} setLabel={setLabel} date={date} setDate={setDate} />
    <div className="row gap">
      <button type="button" className="btn primary" disabled={!runs.length} onClick={() => void addCampaign(project, update, { id: uuid(), label, date, runs, source: 'OpenSCENARIO' }, { kind: 'xosc', fileName: s.files.map(f => f.name).join(', '), rows: runs.length, skipped: s.errors.length }, odd)}>Import {runs.length} scenario{runs.length === 1 ? '' : 's'}</button>
      <button type="button" className="btn ghost" onClick={done}>Cancel</button>
    </div>
  </>
}

function CarlaImport({ s, project, update, done }: { s: Extract<Staged, { kind: 'carla' }>; project: Project; update: Props['update']; done(): void }) {
  const list = sortCampaigns(project.campaigns)
  const [target, setTarget] = useState(list.at(-1)?.id ?? 'new')
  const camp = list.find(c => c.id === target)
  const res = useMemo(() => attachResults(camp?.runs ?? [], s.results), [camp, s.results])
  const fails = s.results.filter(r => r.outcome === 'fail').length
  const commit = async () => {
    if (camp) {
      const extra: Run[] = res.unmatched.map((r, i) => ({ id: `${r.scenario}-${i + 1}`, scenario: r.scenario, params: {}, metrics: r.metrics, outcome: r.outcome, reason: r.reason }))
      await update({ campaigns: project.campaigns.map(c => c.id === camp.id ? { ...c, runs: [...res.runs, ...extra] } : c), imports: [...project.imports, { id: uuid(), kind: 'carla-json', fileName: s.fileName, rows: s.results.length, skipped: 0, at: Date.now(), campaign: camp.id }] })
      toast(`Attached ${res.matched} results to “${camp.label}”`, { tone: 'ok' })
      go(`/app/p/${project.id}/failures`)
    } else {
      const runs: Run[] = s.results.map((r, i) => ({ id: `${r.scenario}-${i + 1}`, scenario: r.scenario, params: {}, metrics: r.metrics, outcome: r.outcome, reason: r.reason }))
      await addCampaign(project, update, { id: uuid(), label: s.fileName.replace(/\.[^.]+$/, ''), date: today(), runs, source: 'CARLA' }, { kind: 'carla-json', fileName: s.fileName, rows: runs.length, skipped: 0 })
    }
    done()
  }
  return <>
    <p><b>{s.fileName}</b> · CARLA results for <b>{s.results.length}</b> scenarios, <b className="error">{fails} failed</b>.</p>
    <label className="field"><span>Attach to campaign (matched by scenario name or run id)</span>
      <select value={target} onChange={e => setTarget(e.target.value)}>{list.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}<option value="new">New campaign with only these results</option></select>
    </label>
    {camp ? <p className="small">{res.matched} matched · <span className={res.unmatched.length ? 'warn-text' : ''}>{res.unmatched.length} unmatched</span>{res.unmatched.length ? ` (${res.unmatched.slice(0, 5).map(u => u.scenario).join(', ')}${res.unmatched.length > 5 ? '…' : ''}) will be added without ODD parameters and count as outside the ODD.` : ''}</p>
      : <p className="warn-text small">Without a catalog the runs have no ODD parameters: verdicts and failure reasons are kept, but they cannot count towards coverage until a parameter table is imported.</p>}
    <div className="row gap"><button type="button" className="btn primary" onClick={() => void commit()}>Import results</button><button type="button" className="btn ghost" onClick={done}>Cancel</button></div>
  </>
}

function TrajImport({ s, project, traj, update, done }: { s: Extract<Staged, { kind: 'traj' }>; project: Project; traj: TrajStore; update: Props['update']; done(): void }) {
  const all = project.campaigns.flatMap(c => c.runs)
  const ids = [...s.byRun.keys()]
  const matched = ids.filter(id => all.some(r => r.id === id))
  const [busy, setBusy] = useState(false)
  const commit = async () => {
    setBusy(true)
    await new Promise(r => setTimeout(r, 20))
    const store: TrajStore = { ...traj }
    const metrics = new Map<string, Run['metrics']>()
    const failed: string[] = []
    for (const id of ids) {
      try { metrics.set(id, computeMetrics(s.byRun.get(id)!, { laneWidth: project.laneWidth }).metrics); store[id] = s.byRun.get(id)! } catch (e) { failed.push(`${id}: ${(e as Error).message}`) }
    }
    let campaigns = project.campaigns.map(c => ({ ...c, runs: c.runs.map(r => metrics.has(r.id) ? { ...r, metrics: { ...r.metrics, ...metrics.get(r.id) }, traj: true } : r) }))
    const extra = ids.filter(id => metrics.has(id) && !matched.includes(id))
    if (extra.length) campaigns = sortCampaigns([...campaigns, { id: uuid(), label: `Trajectories ${today()}`, date: today(), source: 'Trajectories', runs: extra.map(id => ({ id, scenario: id, params: {}, metrics: metrics.get(id)!, traj: true })) }])
    await putData(project.id, store)
    await update({ campaigns, dataMissing: false, imports: [...project.imports, { id: uuid(), kind: 'trajectory-csv', fileName: s.fileName, rows: ids.length, skipped: failed.length, at: Date.now() }] })
    toast(`Measured ${metrics.size} run${metrics.size === 1 ? '' : 's'} from trajectories`, { tone: 'ok' })
    if (failed.length) toast(failed.join('; '), { tone: 'error' })
    setBusy(false)
    done()
    go(`/app/p/${project.id}/replay?run=${encodeURIComponent([...metrics.keys()][0] ?? '')}`)
  }
  return <>
    <p><b>{s.fileName}</b> · {ids.length} run{ids.length === 1 ? '' : 's'} · headings in {s.degrees ? 'degrees (converted)' : 'radians'}</p>
    <p className="small">{matched.length} match existing runs by id and will get TTC, PET, min gap, braking, jerk and lane offset recomputed. {ids.length - matched.length ? <span className="warn-text">{ids.length - matched.length} have no matching run ({ids.filter(i => !matched.includes(i)).slice(0, 4).join(', ')}) and go into a new campaign without ODD parameters.</span> : null}</p>
    <Issues issues={s.issues} />
    <div className="row gap"><button type="button" className="btn primary" disabled={busy} onClick={() => void commit()}>{busy ? 'Measuring' : 'Compute metrics and save'}</button><button type="button" className="btn ghost" onClick={done}>Cancel</button></div>
  </>
}

// ---------- ODD editor ----------

function OddEditor({ project, update }: { project: Project; update: Props['update'] }) {
  const odd = project.odd
  const set = (i: number, patch: Partial<OddParam>) => void update({ odd: odd.map((d, k) => k === i ? { ...d, ...patch } : d) })
  const [newKey, setNewKey] = useState('')
  return (
    <div className="panel">
      <div className="panel-head"><h2>Operational design domain</h2><span className="muted small">Ranges are split into equal bins; categories are bins of their own. Coverage is measured on these bins.</span></div>
      {odd.length ? <div className="table-wrap"><table className="odd-table">
        <thead><tr><th>Parameter</th><th>Key</th><th>Type</th><th>Range / categories</th><th>Bins</th><th>Unit</th><th /></tr></thead>
        <tbody>{odd.map((d, i) => (
          <tr key={d.key}>
            <td><input className="table-input" value={d.label} onChange={e => set(i, { label: e.target.value })} aria-label={`Label for ${d.key}`} /></td>
            <td className="mono small">{d.key}</td>
            <td><select className="table-input" value={d.kind} onChange={e => set(i, e.target.value === 'range' ? { kind: 'range', min: d.min ?? 0, max: d.max ?? 100, bins: d.bins ?? 5 } : { kind: 'category', categories: d.categories ?? [] })} aria-label={`Type of ${d.key}`}><option value="range">Range</option><option value="category">Category</option></select></td>
            <td>{d.kind === 'range'
              ? <div className="row gap-sm"><input className="table-input" type="number" value={d.min} onChange={e => set(i, { min: Number(e.target.value) })} aria-label={`Minimum ${d.key}`} /><span>to</span><input className="table-input" type="number" value={d.max} onChange={e => set(i, { max: Number(e.target.value) })} aria-label={`Maximum ${d.key}`} /></div>
              : <input className="table-input" defaultValue={(d.categories ?? []).join(', ')} onBlur={e => set(i, { categories: e.target.value.split(',').map(x => x.trim()).filter(Boolean) })} aria-label={`Categories of ${d.key}`} />}</td>
            <td>{d.kind === 'range' ? <input className="table-input narrow" type="number" min="1" max="20" value={d.bins ?? 5} onChange={e => set(i, { bins: Math.max(1, Math.min(20, Number(e.target.value))) })} aria-label={`Bins for ${d.key}`} /> : <span className="muted small">{d.categories?.length ?? 0}</span>}</td>
            <td><input className="table-input narrow" value={d.unit ?? ''} onChange={e => set(i, { unit: e.target.value || undefined })} aria-label={`Unit of ${d.key}`} /></td>
            <td><button type="button" className="btn danger-ghost sm" onClick={async () => {
              if (!(await ask(`Remove ${d.label} from the ODD?`, 'Runs keep the value; it just stops counting towards coverage. You can undo for a few seconds.', 'Remove'))) return
              const before = odd
              await update({ odd: odd.filter((_, k) => k !== i) })
              toast(`Removed ${d.label}`, { undo: () => void update({ odd: before }) })
            }}>Remove</button></td>
          </tr>
        ))}</tbody>
      </table></div> : <p className="muted">No ODD yet. Import a file and it will be inferred, or add parameters by hand.</p>}
      <form className="row gap wrap" onSubmit={e => {
        e.preventDefault()
        const key = norm(newKey)
        if (!key || odd.some(d => d.key === key)) { toast(key ? 'That parameter already exists' : 'Enter a parameter key', { tone: 'error' }); return }
        const seen = project.campaigns.flatMap(c => c.runs.map(r => r.params[key])).filter(v => v !== undefined)
        const nums = seen.map(Number).filter(Number.isFinite)
        const d: OddParam = seen.length && nums.length === seen.length ? { key, label: pretty(key), kind: 'range', min: Math.min(...nums), max: Math.max(...nums), bins: 5 } : seen.length ? { key, label: pretty(key), kind: 'category', categories: [...new Set(seen.map(String))] } : { key, label: pretty(key), kind: 'range', min: 0, max: 100, bins: 5 }
        void update({ odd: [...odd, d] }); setNewKey('')
      }}>
        <input value={newKey} onChange={e => setNewKey(e.target.value)} placeholder="e.g. road_friction" aria-label="New parameter key" style={{ maxWidth: 260 }} />
        <button className="btn ghost sm">Add parameter</button>
      </form>
    </div>
  )
}

function ThresholdEditor({ project, update }: { project: Project; update: Props['update'] }) {
  return (
    <div className="panel">
      <div className="panel-head"><h2>Pass / fail thresholds</h2><span className="muted small">A run fails if any measured metric crosses its limit, or the simulator reported a failure.</span></div>
      <div className="inline-fields">
        {TH_FIELDS.map(([k, label, step]) => <label key={k} className="field"><span>{label}</span><input type="number" min="0" step={step} value={project.thresholds[k]} onChange={e => void update({ thresholds: { ...project.thresholds, [k]: Math.max(0, Number(e.target.value)) } })} /></label>)}
        <label className="field"><span>Lane width (m)</span><input type="number" min="2" max="6" step="0.1" value={project.laneWidth} onChange={e => void update({ laneWidth: Number(e.target.value) })} /></label>
      </div>
    </div>
  )
}
