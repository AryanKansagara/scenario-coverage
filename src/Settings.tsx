import { useState } from 'react'
import type { Thresholds } from './engine/types.ts'
import { deleteProject, getDefaults, getProjects, setDefaults, type Defaults } from './store.ts'
import { exportAll, RAW_SYNC_LIMIT, useSync } from './sync.ts'
import { ask, download, setTheme, toast, useDark } from './ui.tsx'

export const TH_FIELDS: [keyof Thresholds, string, number][] = [
  ['ttc', 'Min TTC (s)', 0.1], ['pet', 'Min PET (s)', 0.1], ['minDist', 'Min gap (m)', 0.1],
  ['maxDecel', 'Max decel (m/s²)', 0.1], ['maxJerk', 'Max jerk (m/s³)', 0.5], ['laneDev', 'Max lane offset (m)', 0.05],
]

export default function Settings() {
  const [d, setD] = useState<Defaults>(getDefaults)
  const dark = useDark()
  const sync = useSync()
  const save = (p: Partial<Defaults>) => { const next = { ...d, ...p }; setD(next); setDefaults(next); toast('Saved', { tone: 'ok', ttl: 1500 }) }

  return (
    <section className="page narrow settings">
      <div className="eyebrow">Settings</div>
      <h1>Settings</h1>

      <div className="panel">
        <h2>Defaults for new projects</h2>
        <p className="muted small">Existing projects keep their own thresholds; change those on the project&rsquo;s Data &amp; ODD tab. A run fails if any measured metric crosses its threshold, or if the simulator reported a failure.</p>
        <div className="inline-fields">
          {TH_FIELDS.map(([k, label, step]) => (
            <label key={k} className="field"><span>{label}</span><input type="number" min="0" step={step} value={d.thresholds[k]} onChange={e => save({ thresholds: { ...d.thresholds, [k]: Math.max(0, Number(e.target.value)) } })} /></label>
          ))}
          <label className="field"><span>Lane width (m)</span><input type="number" min="2" max="6" step="0.1" value={d.laneWidth} onChange={e => save({ laneWidth: Number(e.target.value) })} /></label>
          <label className="field"><span>Recommended runs</span><input type="number" min="4" max="200" value={d.recCount} onChange={e => save({ recCount: Math.max(4, Math.min(200, Number(e.target.value))) })} /></label>
          <label className="field"><span>Boundary share (%)</span><input type="number" min="0" max="100" step="5" value={Math.round(d.boundaryShare * 100)} onChange={e => save({ boundaryShare: Math.max(0, Math.min(1, Number(e.target.value) / 100)) })} /></label>
        </div>
      </div>

      <div className="panel">
        <h2>Appearance</h2>
        <div className="seg-control" role="radiogroup" aria-label="Theme">
          <button type="button" role="radio" aria-checked={!dark} className={!dark ? 'on' : ''} onClick={() => setTheme('light')}>Light</button>
          <button type="button" role="radio" aria-checked={dark} className={dark ? 'on' : ''} onClick={() => setTheme('dark')}>Dark</button>
        </div>
      </div>

      <div className="panel">
        <h2>Your data</h2>
        <p>Projects live in this browser (IndexedDB). {sync.user ? <>Signed in as <b>{sync.user.email}</b>: ODDs, thresholds, triage, campaign results and trajectory sets under {(RAW_SYNC_LIMIT / 1e6).toFixed(1)} MB per project sync to your account.</> : 'Sign in from the account menu (top right) to sync across devices. It is optional.'}</p>
        <div className="row gap wrap">
          <button type="button" className="btn ghost" onClick={async () => download(`scenario-coverage-export-${new Date().toISOString().slice(0, 10)}.json`, await exportAll())}>Export all my data (JSON)</button>
          <button type="button" className="btn danger-ghost" onClick={async () => {
            const list = getProjects()
            if (!list.length) { toast('Nothing to delete'); return }
            if (!(await ask('Delete all local projects?', `Removes ${list.length} project${list.length > 1 ? 's' : ''} from this browser${sync.user ? ' and from your cloud account' : ''}. You can undo for a few seconds.`, 'Delete everything'))) return
            const undos = await Promise.all(list.map(p => deleteProject(p.id)))
            toast(`Deleted ${list.length} projects`, { undo: () => { for (const u of undos) void u() } })
          }}>Delete all projects</button>
        </div>
      </div>

      <div className="panel">
        <h2>Keyboard shortcuts</h2>
        <dl className="shortcuts">
          <div><dt><kbd>1</kbd>&ndash;<kbd>7</kbd></dt><dd>Switch project sections</dd></div>
          <div><dt><kbd>[</kbd> <kbd>]</kbd></dt><dd>Previous / next campaign scope</dd></div>
          <div><dt><kbd>P</kbd></dt><dd>Printable coverage report</dd></div>
          <div><dt><kbd>Space</kbd></dt><dd>Play / pause a replay</dd></div>
          <div><dt><kbd>&#8984;</kbd>/<kbd>Ctrl</kbd> <kbd>Z</kbd></dt><dd>Undo the last delete</dd></div>
          <div><dt><kbd>?</kbd></dt><dd>Show shortcuts on a project page</dd></div>
        </dl>
      </div>
    </section>
  )
}
