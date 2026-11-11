import { useEffect, useMemo, useState } from 'react'
import { coverage, judgeAll } from './engine/coverage.ts'
import { createBlankProject, createSampleProject, SAMPLE_ID } from './projectData.ts'
import { deleteProject, saveProject, useProjects, type Project } from './store.ts'
import { useSync } from './sync.ts'
import { ask, fmtN, fmtPct, go, Link, SyntheticBadge, toast } from './ui.tsx'
import { Meter } from './viz.tsx'

export default function Workspace() {
  const list = useProjects()
  const sync = useSync()
  const [busy, setBusy] = useState(false)

  // /app?sample=1 opens (or creates) the sample straight away.
  useEffect(() => {
    const q = new URLSearchParams(location.search)
    if (!q.get('sample') || list === null || busy) return
    const tab = q.get('tab')?.replace(/[^a-z]/g, '')
    setBusy(true)
    void createSampleProject().then(p => go(`/app/p/${p.id}${tab ? '/' + tab : ''}`, { replace: true }))
  }, [list, busy])

  const openSample = async () => { setBusy(true); const p = await createSampleProject(); go(`/app/p/${p.id}`) }
  const newProject = async () => {
    const p = await createBlankProject(`Programme ${(list?.filter(p => !p.sampleId).length ?? 0) + 1}`)
    go(`/app/p/${p.id}/data`)
  }

  if (list === null || busy) return <div className="boot" role="status"><span className="spinner" /> {busy ? 'Simulating 600 synthetic runs' : 'Opening your projects'}</div>

  return (
    <section className="page">
      <div className="page-head">
        <div>
          <div className="eyebrow">Workspace</div>
          <h1>Projects</h1>
          <p className="muted">One project per test programme: its ODD, thresholds, campaigns and failure triage. {sync.user ? 'Synced to your account.' : 'Stored on this device.'}</p>
        </div>
        {list.length > 0 && <button type="button" className="btn primary" onClick={newProject}>New project</button>}
      </div>

      {list.length === 0 ? (
        <div className="onboard">
          <article className="onboard-card feature-card">
            <div className="eyebrow">Two minutes</div>
            <h2>Try the sample</h2>
            <p>A synthetic highway trucking programme: three campaigns, 600 closed-loop runs of cut-ins, merges, hard-braking leads and debris across weather and lighting, with trajectories for 75 of them. Everything is clickable.</p>
            <button type="button" className="sample-btn" onClick={() => void openSample()}>
              <span><strong>Highway trucking</strong><small>600 runs · 3 campaigns · labelled synthetic</small></span><span aria-hidden="true">&rarr;</span>
            </button>
          </article>
          <article className="onboard-card">
            <div className="eyebrow">Your programme</div>
            <h2>Import your data</h2>
            <p>Drop a scenario parameter table (CSV or JSON), OpenSCENARIO .xosc files, CARLA scenario_runner results or per-run trajectory CSVs. Formats are detected, columns mapped, and every bad row is reported with its line number.</p>
            <div className="row gap wrap">
              <button type="button" className="btn primary" onClick={newProject}>Import your data</button>
              <Link href="/docs" className="btn ghost">Export guides</Link>
            </div>
            <p className="muted small">Files are parsed in your browser and stay on this device unless you sign in to sync.</p>
          </article>
        </div>
      ) : (
        <>
          <div className="project-grid">{list.map(p => <ProjectCard key={p.id} p={p} />)}</div>
          {!list.some(p => p.sampleId === SAMPLE_ID) && <div className="samples-row"><span className="muted small">Sample:</span><button type="button" className="linkish small" onClick={() => void openSample()}>Highway trucking (synthetic)</button></div>}
        </>
      )}
    </section>
  )
}

function ProjectCard({ p }: { p: Project }) {
  const [renaming, setRenaming] = useState(false)
  const stats = useMemo(() => {
    const runs = p.campaigns.flatMap(c => c.runs)
    if (!p.odd.length || !runs.length) return null
    const v = judgeAll(runs, p.thresholds)
    return { runs: runs.length, cov: coverage(p.odd, runs).pairwisePct, fails: v.filter(x => x.status === 'fail').length }
  }, [p.odd, p.campaigns, p.thresholds])
  return (
    <article className="project-card">
      <div className="row between">
        {renaming ? (
          <form onSubmit={e => { e.preventDefault(); const v = String(new FormData(e.currentTarget).get('n')).trim(); if (v) void saveProject({ ...p, name: v }); setRenaming(false) }}>
            <input name="n" defaultValue={p.name} autoFocus aria-label="Project name" onBlur={e => e.currentTarget.form?.requestSubmit()} />
          </form>
        ) : <h3><Link href={`/app/p/${p.id}`}>{p.name}</Link></h3>}
        {p.sampleId && <SyntheticBadge />}
      </div>
      {stats ? <>
        <div className="row between small"><span className="muted">Pairwise ODD coverage</span><b className="tab-nums">{fmtPct(stats.cov, 1)}</b></div>
        <Meter value={stats.cov} label="Pairwise coverage" />
      </> : <p className="muted small">No runs yet. Open it to import a catalog or results.</p>}
      <dl className="mini-stats">
        <div><dt>Campaigns</dt><dd>{p.campaigns.length}</dd></div>
        <div><dt>Runs</dt><dd>{stats ? fmtN(stats.runs) : '—'}</dd></div>
        <div><dt>Failures</dt><dd>{stats ? fmtN(stats.fails) : '—'}</dd></div>
        <div><dt>ODD dims</dt><dd>{p.odd.length}</dd></div>
      </dl>
      {p.dataMissing && <p className="warn-text small">Trajectories live on another device. Re-import them here to replay.</p>}
      <div className="row between">
        <span className="muted small">Updated {new Date(p.updatedAt).toLocaleDateString()}</span>
        <div className="row gap-sm">
          <button type="button" className="btn ghost sm" onClick={() => setRenaming(true)}>Rename</button>
          <button type="button" className="btn danger-ghost sm" onClick={async () => {
            if (!(await ask(`Delete “${p.name}”?`, 'Removes the project, its campaigns and trajectories from this device (and the cloud, if you are signed in). You can undo for a few seconds.', 'Delete project'))) return
            const undo = await deleteProject(p.id)
            toast(`Deleted ${p.name}`, { undo: () => void undo() })
          }}>Delete</button>
        </div>
      </div>
    </article>
  )
}
