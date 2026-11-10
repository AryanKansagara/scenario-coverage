import { binOf, binRange, nBins } from './coverage.ts'
import { dist2, normalise, rng } from './cluster.ts'
import { toCsv } from './csv.ts'
import type { Odd, OddParam, Params, Run } from './types.ts'

export interface Rec { id: string; params: Params; kind: 'gap' | 'boundary'; reason: string; newCells: number }

const decimals = (d: OddParam) => { const span = (d.max ?? 1) - (d.min ?? 0); return span >= 50 ? 0 : span >= 5 ? 1 : 2 }
const round = (d: OddParam, x: number) => { const f = 10 ** decimals(d); return Math.min(d.max ?? x, Math.max(d.min ?? x, Math.round(x * f) / f)) }

function randomPoint(odd: Odd, r: () => number, fixed: Record<string, number> = {}): Params {
  const p: Params = {}
  for (const d of odd) {
    const bin = fixed[d.key]
    if (d.kind === 'category') { const cs = d.categories ?? []; p[d.key] = cs[bin ?? Math.floor(r() * cs.length)] ?? '' }
    else {
      const [lo, hi] = bin === undefined ? [d.min ?? 0, d.max ?? 1] : binRange(d, bin)
      // Stay strictly inside the bin so rounding cannot push the value into a neighbour.
      p[d.key] = round(d, lo + (hi - lo) * (0.1 + 0.8 * r()))
    }
  }
  return p
}

/** Keys of the 2-way cells a parameter set lands in. */
function cellsOf(odd: Odd, p: Params): string[] {
  const b = odd.map(d => binOf(d, p[d.key]))
  const out: string[] = []
  for (let i = 0; i < odd.length; i++) for (let j = i + 1; j < odd.length; j++) if (b[i] >= 0 && b[j] >= 0) out.push(`${i}:${b[i]}|${j}:${b[j]}`)
  return out
}

/**
 * Next scenarios to run.
 * Gap fill: candidates are drawn inside uncovered 2-way cells, then picked greedily by how many new cells they
 * cover, with ties broken by maximin distance (the candidate farthest from every run already tested or picked).
 * Boundary: midpoints between each failing run and its nearest passing run, jittered, again picked maximin,
 * so they probe where the pass/fail boundary actually is.
 */
export function recommend(odd: Odd, runs: Run[], failed: boolean[], opts: { n?: number; boundaryShare?: number; seed?: number } = {}): Rec[] {
  const n = opts.n ?? 24, r = rng(opts.seed ?? 11)
  const nBoundary = failed.some(Boolean) && runs.some((_, i) => !failed[i]) ? Math.round(n * (opts.boundaryShare ?? 0.35)) : 0
  const tested = runs.map(x => normalise(odd, x.params))
  const covered = new Set(runs.flatMap(x => cellsOf(odd, x.params)))
  const chosen: number[][] = []
  const out: Rec[] = []
  const minD = (v: number[]) => { let m = Infinity; for (const t of tested) m = Math.min(m, dist2(v, t)); for (const c of chosen) m = Math.min(m, dist2(v, c)); return Math.sqrt(m) }

  // Gap fill.
  const gapCells: [number, number, number, number][] = []
  for (let i = 0; i < odd.length; i++) for (let j = i + 1; j < odd.length; j++)
    for (let a = 0; a < nBins(odd[i]); a++) for (let b = 0; b < nBins(odd[j]); b++)
      if (!covered.has(`${i}:${a}|${j}:${b}`)) gapCells.push([i, a, j, b])
  const pool: Params[] = []
  for (const [i, a, j, b] of gapCells.slice(0, 600)) for (let k = 0; k < 3; k++) pool.push(randomPoint(odd, r, { [odd[i].key]: a, [odd[j].key]: b }))
  if (!gapCells.length) for (let k = 0; k < 300; k++) pool.push(randomPoint(odd, r))
  const poolV = pool.map(p => normalise(odd, p))
  const poolCells = pool.map(p => cellsOf(odd, p))
  // Squared distance from each candidate to its nearest tested or picked point, updated as picks are made.
  const near = poolV.map(v => { let m = Infinity; for (const t of tested) m = Math.min(m, dist2(v, t)); return m })
  const used = new Set<number>()
  while (out.length < n - nBoundary && used.size < pool.length) {
    let best = -1, bestScore = -Infinity, bestNew = 0
    for (let k = 0; k < pool.length; k++) {
      if (used.has(k)) continue
      const fresh = poolCells[k].filter(c => !covered.has(c)).length
      const score = fresh + Math.sqrt(near[k])
      if (score > bestScore) { bestScore = score; best = k; bestNew = fresh }
    }
    if (best < 0) break
    used.add(best)
    poolCells[best].forEach(c => covered.add(c))
    chosen.push(poolV[best])
    for (let k = 0; k < pool.length; k++) near[k] = Math.min(near[k], dist2(poolV[k], poolV[best]))
    out.push({ id: '', params: pool[best], kind: 'gap', newCells: bestNew, reason: bestNew ? `Covers ${bestNew} untested 2-way combination${bestNew > 1 ? 's' : ''}` : 'Space-filling: farthest from everything tested' })
  }

  // Boundary sampling near failures.
  if (nBoundary) {
    const passIdx = runs.map((_, i) => i).filter(i => !failed[i])
    const cands: { p: Params; v: number[]; reason: string }[] = []
    runs.forEach((fr, i) => {
      if (!failed[i]) return
      let nb = -1, nd = Infinity
      for (const j of passIdx) { const d = dist2(tested[i], tested[j]); if (d < nd) { nd = d; nb = j } }
      if (nb < 0) return
      const pr = runs[nb]
      for (const t of [0.35, 0.5, 0.65]) {
        const p: Params = {}
        for (const d of odd) {
          if (d.kind === 'category') p[d.key] = r() < t ? pr.params[d.key] ?? fr.params[d.key] : fr.params[d.key]
          else {
            const a = Number(fr.params[d.key]), b = Number(pr.params[d.key])
            const span = (d.max ?? 1) - (d.min ?? 0)
            p[d.key] = Number.isFinite(a) && Number.isFinite(b) ? round(d, a + (b - a) * t + (r() - 0.5) * 0.04 * span) : round(d, ((d.min ?? 0) + (d.max ?? 1)) / 2)
          }
        }
        cands.push({ p, v: normalise(odd, p), reason: `Between failing ${fr.id} and passing ${pr.id}` })
      }
    })
    const taken = new Set<number>()
    while (out.length < n && taken.size < cands.length) {
      let best = -1, bd = -1
      cands.forEach((c, k) => { if (!taken.has(k)) { const d = minD(c.v); if (d > bd) { bd = d; best = k } } })
      if (best < 0) break
      taken.add(best)
      chosen.push(cands[best].v)
      const fresh = cellsOf(odd, cands[best].p).filter(c => !covered.has(c)).length
      cellsOf(odd, cands[best].p).forEach(c => covered.add(c))
      out.push({ id: '', params: cands[best].p, kind: 'boundary', newCells: fresh, reason: cands[best].reason })
    }
  }
  return out.map((x, i) => ({ ...x, id: `REC-${String(i + 1).padStart(3, '0')}` }))
}

export function recsToCsv(odd: Odd, recs: Rec[]): string {
  return toCsv([['id', ...odd.map(d => d.key), 'kind', 'reason'], ...recs.map(x => [x.id, ...odd.map(d => x.params[d.key] ?? ''), x.kind, x.reason])])
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')

/** OpenSCENARIO 1.2 parameter value distribution: one ParameterValueSet per recommended run. */
export function recsToXosc(odd: Odd, recs: Rec[], scenarioFile: string, date = new Date().toISOString().slice(0, 19)): string {
  const sets = recs.map(x => `          <ParameterValueSet>\n${odd.map(d => `            <ParameterAssignment parameterRef="${esc(d.key)}" value="${esc(String(x.params[d.key] ?? ''))}"/>`).join('\n')}\n          </ParameterValueSet>`).join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<OpenSCENARIO>
  <FileHeader revMajor="1" revMinor="2" date="${date}" description="Recommended scenarios (${recs.length})" author="Scenario Coverage"/>
  <ParameterValueDistribution>
    <ScenarioFile filepath="${esc(scenarioFile)}"/>
    <Deterministic>
      <DeterministicMultiParameterDistribution>
        <ValueSetDistribution>
${sets}
        </ValueSetDistribution>
      </DeterministicMultiParameterDistribution>
    </Deterministic>
  </ParameterValueDistribution>
</OpenSCENARIO>
`
}
