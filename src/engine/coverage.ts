import type { Metrics, Odd, OddParam, ParamValue, Run, Thresholds } from './types.ts'

// ---------- Binning ----------

export const nBins = (p: OddParam) => p.kind === 'category' ? (p.categories?.length ?? 0) : Math.max(1, p.bins ?? 5)

/** Bin index of a value, or -1 when it is outside the ODD (out of range, unknown category, missing). */
export function binOf(p: OddParam, v: ParamValue | undefined): number {
  if (v === undefined || v === '') return -1
  if (p.kind === 'category') return (p.categories ?? []).indexOf(String(v))
  const x = typeof v === 'number' ? v : Number(v)
  const lo = p.min ?? 0, hi = p.max ?? 1
  if (!Number.isFinite(x) || x < lo || x > hi || hi <= lo) return -1
  const b = nBins(p)
  return Math.min(b - 1, Math.floor(((x - lo) / (hi - lo)) * b))
}

const trim = (n: number) => String(Math.round(n * 100) / 100)
export function binLabels(p: OddParam): string[] {
  if (p.kind === 'category') return [...(p.categories ?? [])]
  const lo = p.min ?? 0, hi = p.max ?? 1, b = nBins(p), w = (hi - lo) / b
  return Array.from({ length: b }, (_, i) => `${trim(lo + i * w)}–${trim(lo + (i + 1) * w)}`)
}

/** The value range covered by bin i (numeric params only). */
export function binRange(p: OddParam, i: number): [number, number] {
  const lo = p.min ?? 0, hi = p.max ?? 1, w = (hi - lo) / nBins(p)
  return [lo + i * w, lo + (i + 1) * w]
}

export const inOdd = (odd: Odd, r: Run) => odd.every(p => binOf(p, r.params[p.key]) >= 0)

// ---------- Verdicts ----------

export type Status = 'pass' | 'fail' | 'untested'
export interface Verdict { status: Status; reasons: string[] }

const hasMetrics = (m: Metrics) => Object.values(m).some(v => v !== undefined)

/** Pass/fail against the user's thresholds; a simulator-reported failure always counts. */
export function judge(r: Run, th: Thresholds): Verdict {
  const m = r.metrics, reasons: string[] = []
  if (m.collision) reasons.push('Collision')
  if (m.ttc !== undefined && m.ttc < th.ttc) reasons.push(`TTC ${m.ttc.toFixed(2)} s < ${th.ttc} s`)
  if (m.pet !== undefined && m.pet < th.pet) reasons.push(`PET ${m.pet.toFixed(2)} s < ${th.pet} s`)
  if (m.minDist !== undefined && m.minDist < th.minDist) reasons.push(`Min gap ${m.minDist.toFixed(2)} m < ${th.minDist} m`)
  if (m.maxDecel !== undefined && m.maxDecel > th.maxDecel) reasons.push(`Hard braking ${m.maxDecel.toFixed(1)} m/s² > ${th.maxDecel}`)
  if (m.maxJerk !== undefined && m.maxJerk > th.maxJerk) reasons.push(`Jerk ${m.maxJerk.toFixed(1)} m/s³ > ${th.maxJerk}`)
  if (m.laneDev !== undefined && m.laneDev > th.laneDev) reasons.push(`Lane offset ${m.laneDev.toFixed(2)} m > ${th.laneDev} m`)
  if (r.outcome === 'fail' && !reasons.length) reasons.push(r.reason ? `Simulator: ${r.reason}` : 'Simulator reported failure')
  if (reasons.length) return { status: 'fail', reasons }
  if (r.outcome === 'pass' || hasMetrics(m)) return { status: 'pass', reasons }
  return { status: 'untested', reasons }
}

export const judgeAll = (runs: Run[], th: Thresholds) => runs.map(r => judge(r, th))

// ---------- Coverage ----------

export interface OneWay { key: string; label: string; labels: string[]; hits: number[]; fails: number[]; covered: number; total: number }
export interface Pair { a: number; b: number; counts: number[][]; fails: number[][]; covered: number; total: number }
export interface Coverage {
  oneWay: OneWay[]
  pairs: Pair[]
  oneWayPct: number
  pairwisePct: number
  coveredCells: number
  totalCells: number
  outside: number
  runs: number
}

export function coverage(odd: Odd, runs: Run[], verdicts?: Verdict[]): Coverage {
  const bins = runs.map(r => odd.map(p => binOf(p, r.params[p.key])))
  const failed = runs.map((_, i) => verdicts?.[i]?.status === 'fail')
  const oneWay: OneWay[] = odd.map((p, k) => {
    const n = nBins(p), hits = Array(n).fill(0), fails = Array(n).fill(0)
    bins.forEach((b, i) => { if (b[k] >= 0) { hits[b[k]]++; if (failed[i]) fails[b[k]]++ } })
    return { key: p.key, label: p.label, labels: binLabels(p), hits, fails, covered: hits.filter(h => h > 0).length, total: n }
  })
  const pairs: Pair[] = []
  for (let a = 0; a < odd.length; a++) for (let b = a + 1; b < odd.length; b++) {
    const na = nBins(odd[a]), nb = nBins(odd[b])
    const counts = Array.from({ length: na }, () => Array(nb).fill(0) as number[])
    const fails = Array.from({ length: na }, () => Array(nb).fill(0) as number[])
    bins.forEach((x, i) => { if (x[a] >= 0 && x[b] >= 0) { counts[x[a]][x[b]]++; if (failed[i]) fails[x[a]][x[b]]++ } })
    const covered = counts.flat().filter(c => c > 0).length
    pairs.push({ a, b, counts, fails, covered, total: na * nb })
  }
  const sum = <T,>(l: T[], f: (x: T) => number) => l.reduce((s, x) => s + f(x), 0)
  const coveredCells = sum(pairs, p => p.covered), totalCells = sum(pairs, p => p.total)
  const ow = sum(oneWay, o => o.total)
  return {
    oneWay, pairs, coveredCells, totalCells,
    oneWayPct: ow ? sum(oneWay, o => o.covered) / ow : 0,
    pairwisePct: totalCells ? coveredCells / totalCells : 0,
    outside: bins.filter(b => b.some(x => x < 0)).length,
    runs: runs.length,
  }
}

export interface Gap { a: string; ai: number; b: string; bi: number; text: string; priority: number }

/**
 * Uncovered 2-way cells, ranked by risk: cells whose two bins already fail often on their own come first,
 * so the riskiest holes get filled before the comfortable ones.
 */
export function findGaps(odd: Odd, cov: Coverage): Gap[] {
  const rate = (k: number, i: number) => { const o = cov.oneWay[k]; return o.hits[i] ? o.fails[i] / o.hits[i] : 0.5 }
  const out: Gap[] = []
  for (const p of cov.pairs) for (let i = 0; i < p.counts.length; i++) for (let j = 0; j < p.counts[i].length; j++) {
    if (p.counts[i][j] > 0) continue
    const A = odd[p.a], B = odd[p.b]
    out.push({ a: A.key, ai: i, b: B.key, bi: j, priority: rate(p.a, i) + rate(p.b, j), text: `${A.label} ${cov.oneWay[p.a].labels[i]}${A.unit && A.kind === 'range' ? ' ' + A.unit : ''} × ${B.label} ${cov.oneWay[p.b].labels[j]}${B.unit && B.kind === 'range' ? ' ' + B.unit : ''}` })
  }
  return out.sort((x, y) => y.priority - x.priority || x.text.localeCompare(y.text))
}
