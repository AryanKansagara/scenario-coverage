import { useEffect, useMemo, useState } from 'react'
import { clusterFailures, extractRules, type FailureCluster, type Rule } from './engine/cluster.ts'
import { coverage, findGaps, judgeAll, type Coverage, type Gap, type Verdict } from './engine/coverage.ts'
import { generateSample, SAMPLE_ODD } from './engine/sample.ts'
import type { Campaign, Odd, Run } from './engine/types.ts'
import { getData, getDefaults, getProjects, putData, saveProject, sortCampaigns, useProjects, uuid, type Project, type TrajStore } from './store.ts'

export const SAMPLE_ID = 'highway-trucking'
export const SAMPLE_NAME = 'Highway trucking (synthetic)'

let sampleCache: ReturnType<typeof generateSample> | null = null
const sample = () => sampleCache ??= generateSample()

export async function createSampleProject(): Promise<Project> {
  const existing = getProjects().find(p => p.sampleId === SAMPLE_ID)
  if (existing) return existing
  // Let the spinner paint before the 600 simulated runs are measured.
  await new Promise(r => setTimeout(r, 30))
  const s = sample()
  const d = getDefaults()
  const now = Date.now()
  const campaigns: Campaign[] = s.campaigns.map(c => ({ ...c, id: uuid() }))
  const p: Project = {
    id: uuid(), name: SAMPLE_NAME, createdAt: now, updatedAt: now, sampleId: SAMPLE_ID,
    odd: structuredClone(SAMPLE_ODD), thresholds: { ...d.thresholds }, laneWidth: 3.7, scenarioFile: 'highway_cut_in.xosc',
    campaigns, triage: {},
    imports: campaigns.map(c => ({ id: uuid(), kind: 'param-csv' as const, fileName: `${c.label} (synthetic)`, rows: c.runs.length, skipped: 0, at: now, campaign: c.id })),
  }
  await putData(p.id, s.traj)
  return saveProject(p)
}

export async function createBlankProject(name: string): Promise<Project> {
  const now = Date.now()
  const d = getDefaults()
  return saveProject({ id: uuid(), name, createdAt: now, updatedAt: now, odd: [], thresholds: { ...d.thresholds }, laneWidth: d.laneWidth, scenarioFile: 'scenario.xosc', campaigns: [], imports: [], triage: {} })
}

export function useProject(id: string) {
  const list = useProjects()
  const project = list?.find(p => p.id === id) ?? null
  const [traj, setTraj] = useState<TrajStore | null>(null)
  const key = project ? project.imports.map(i => i.id).join(',') : ''
  useEffect(() => {
    if (!project) return
    let live = true
    void getData(project.id).then(d => {
      if (!live) return
      if (!d && project.sampleId) { const t = sample().traj; void putData(project.id, t); setTraj(t) } else setTraj(d ?? {})
    })
    return () => { live = false }
  }, [project?.id, key])
  const update = (patch: Partial<Project>) => project ? saveProject({ ...project, ...patch }) : Promise.resolve(null)
  return { loading: list === null, project, traj, update }
}

export interface Analysis {
  runs: Run[]
  verdicts: Verdict[]
  failed: boolean[]
  cov: Coverage
  gaps: Gap[]
  rules: Rule[]
  clusters: FailureCluster[]
  clusterOf: Map<string, number>
  fails: number
  untested: number
}

export function analyse(odd: Odd, runs: Run[], th: Project['thresholds']): Analysis {
  const verdicts = judgeAll(runs, th)
  const failed = verdicts.map(v => v.status === 'fail')
  const cov = coverage(odd, runs, verdicts)
  const failedRuns = runs.filter((_, i) => failed[i])
  const clusters = clusterFailures(odd, failedRuns)
  const clusterOf = new Map<string, number>()
  clusters.forEach(c => c.runs.forEach(r => clusterOf.set(r.id, c.id)))
  return {
    runs, verdicts, failed, cov, gaps: findGaps(odd, cov),
    rules: extractRules(odd, runs, failed, { minSupport: Math.max(3, Math.round(runs.length / 120)) }),
    clusters, clusterOf, fails: failedRuns.length, untested: verdicts.filter(v => v.status === 'untested').length,
  }
}

/** Runs in scope: one campaign, or every campaign up to and including the latest (cumulative). */
export function scopeRuns(p: Project, scope: string): Run[] {
  if (scope === 'all') return p.campaigns.flatMap(c => c.runs)
  return p.campaigns.find(c => c.id === scope)?.runs ?? []
}

export function useAnalysis(p: Project | null, scope: string) {
  return useMemo(() => p && p.odd.length ? analyse(p.odd, scopeRuns(p, scope), p.thresholds) : null, [p?.odd, p?.campaigns, p?.thresholds, scope])
}

/** Cumulative coverage after each campaign, oldest first. */
export function trend(p: Project) {
  const list = sortCampaigns(p.campaigns)
  const out: { id: string; label: string; date: string; pairwise: number; oneWay: number; failRate: number; runs: number; cumRuns: number }[] = []
  let acc: Run[] = []
  for (const c of list) {
    acc = [...acc, ...c.runs]
    const cum = coverage(p.odd, acc)
    const v = judgeAll(c.runs, p.thresholds)
    const judged = v.filter(x => x.status !== 'untested').length
    out.push({ id: c.id, label: c.label, date: c.date, pairwise: cum.pairwisePct, oneWay: cum.oneWayPct, failRate: judged ? v.filter(x => x.status === 'fail').length / judged : 0, runs: c.runs.length, cumRuns: acc.length })
  }
  return out
}

export const scopeFromUrl = (p: Project | null) => {
  const q = new URLSearchParams(location.search).get('c')
  return q && p?.campaigns.some(c => c.id === q) ? q : 'all'
}
