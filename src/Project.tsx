import { lazy, Suspense, useEffect, useState } from 'react'
import { scopeFromUrl, useAnalysis, useProject, type Analysis } from './projectData.ts'
import { sortCampaigns, type Project, type TrajStore } from './store.ts'
import { Empty, fmtN, go, isTyping, Link, Modal, SyntheticBadge } from './ui.tsx'

const Tabs = lazy(() => import('./Tabs.tsx'))
const DataTab = lazy(() => import('./Import.tsx'))

export const TABS = [['overview', 'Overview'], ['coverage', 'Coverage'], ['failures', 'Failures'], ['replay', 'Replay'], ['next', 'Next scenarios'], ['history', 'History'], ['data', 'Data & ODD']] as const
export type Tab = (typeof TABS)[number][0]

export interface TabProps {
  project: Project
  traj: TrajStore
  scope: string
  a: Analysis
  update(p: Partial<Project>): Promise<unknown>
}

export default function ProjectView({ id, tab: rawTab }: { id: string; tab: string }) {
  const { loading, project, traj, update } = useProject(id)
  const tab = (TABS.some(t => t[0] === rawTab) ? rawTab : 'overview') as Tab
  const scope = scopeFromUrl(project)
  const a = useAnalysis(project, scope)
  const [help, setHelp] = useState(false)
  const scopes = project ? ['all', ...sortCampaigns(project.campaigns).map(c => c.id)] : ['all']

  useEffect(() => { if (project) document.title = `${project.name} · Scenario Coverage` }, [project?.name])

  const q = scope === 'all' ? '' : `?c=${scope}`
  const setTab = (t: Tab) => go(`/app/p/${id}${t === 'overview' ? '' : '/' + t}${q}`, { keepScroll: true })
  const setScope = (s: string) => go(`${location.pathname}${s === 'all' ? '' : `?c=${s}`}`, { replace: true, keepScroll: true })

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e) || e.metaKey || e.ctrlKey || e.altKey) return
      const n = Number(e.key)
      if (n >= 1 && n <= TABS.length) { e.preventDefault(); setTab(TABS[n - 1][0]) }
      else if (e.key === '?') setHelp(true)
      else if (e.key === 'p') go(`/app/p/${id}/report${q}`)
      else if (e.key === '[' || e.key === ']') {
        const i = scopes.indexOf(scope), j = e.key === '[' ? i - 1 : i + 1
        if (scopes[j]) setScope(scopes[j])
      }
    }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  })

  if (loading) return <div className="boot" role="status"><span className="spinner" /> Loading the project</div>
  if (!project) return (
    <section className="page narrow center">
      <Empty title="Project not found"><p className="muted">It may have been deleted, or it lives on another device.</p><Link href="/app" className="btn primary">All projects</Link></Empty>
    </section>
  )
  const empty = !project.odd.length || !project.campaigns.some(c => c.runs.length)

  return (
    <section className="page">
      <div className="proj-head">
        <div>
          <div className="eyebrow"><Link href="/app">Projects</Link></div>
          <h1 className="row gap wrap">{project.name} {project.sampleId && <SyntheticBadge />}</h1>
          {a && !empty && <p className="muted small" style={{ margin: 0 }}>{fmtN(a.runs.length)} runs · {project.odd.length} ODD dimensions · {project.campaigns.length} campaign{project.campaigns.length === 1 ? '' : 's'}</p>}
        </div>
        {!empty && (
          <div className="toolbar">
            <select value={scope} onChange={e => setScope(e.target.value)} aria-label="Campaign scope" title="Scope ([ and ])">
              <option value="all">All campaigns (cumulative)</option>
              {sortCampaigns(project.campaigns).map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
            </select>
            <Link href={`/app/p/${id}/report${q}`} className="btn primary" title="Coverage report (P)">Coverage report</Link>
          </div>
        )}
      </div>
      <nav className="tabs" aria-label="Project sections">
        {TABS.map(([t, l], i) => <Link key={t} href={`/app/p/${id}${t === 'overview' ? '' : '/' + t}${q}`} aria-current={t === tab ? 'page' : undefined} title={`${l} (${i + 1})`}>{l}</Link>)}
      </nav>
      <Suspense fallback={<div className="boot"><span className="spinner" /></div>}>
        {tab === 'data' || empty || !a
          ? <DataTab project={project} traj={traj ?? {}} update={update} />
          : traj === null ? <div className="boot"><span className="spinner" /> Loading trajectories</div>
          : <Tabs tab={tab} project={project} traj={traj} scope={scope} a={a} update={update} />}
      </Suspense>
      <Modal open={help} onClose={() => setHelp(false)} title="Keyboard shortcuts">
        <dl className="shortcuts">
          <div><dt><kbd>1</kbd>&ndash;<kbd>7</kbd></dt><dd>Switch sections</dd></div>
          <div><dt><kbd>[</kbd> <kbd>]</kbd></dt><dd>Previous / next campaign scope</dd></div>
          <div><dt><kbd>P</kbd></dt><dd>Open the printable coverage report</dd></div>
          <div><dt><kbd>Space</kbd></dt><dd>Play / pause the replay</dd></div>
          <div><dt><kbd>&#8984;</kbd>/<kbd>Ctrl</kbd> <kbd>Z</kbd></dt><dd>Undo the last delete</dd></div>
        </dl>
      </Modal>
    </section>
  )
}
