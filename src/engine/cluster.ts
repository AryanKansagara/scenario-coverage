import type { Odd, OddParam, Params, Run } from './types.ts'

// ---------- Deterministic randomness ----------

export function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ---------- Normalised parameter space ----------

/** Numbers map to 0..1 across the ODD range; categories become one-hot scaled so two different categories are distance 1 apart. */
export function normalise(odd: Odd, p: Params): number[] {
  const out: number[] = []
  for (const d of odd) {
    if (d.kind === 'range') {
      const lo = d.min ?? 0, hi = d.max ?? 1, x = Number(p[d.key])
      out.push(Number.isFinite(x) && hi > lo ? Math.min(1, Math.max(0, (x - lo) / (hi - lo))) : 0.5)
    } else for (const c of d.categories ?? []) out.push(p[d.key] === c ? Math.SQRT1_2 : 0)
  }
  return out
}

export const dist2 = (a: number[], b: number[]) => { let s = 0; for (let i = 0; i < a.length; i++) s += (a[i] - b[i]) ** 2; return s }

// ---------- k-means ----------

export interface KMeans { assign: number[]; centroids: number[][]; inertia: number }

/** k-means with k-means++ seeding; deterministic for a given seed. */
export function kmeans(pts: number[][], k: number, seed = 7, iters = 60): KMeans {
  const n = pts.length
  k = Math.max(1, Math.min(k, n))
  if (!n) return { assign: [], centroids: [], inertia: 0 }
  const r = rng(seed)
  const centroids: number[][] = [pts[Math.floor(r() * n)].slice()]
  while (centroids.length < k) {
    const d = pts.map(p => Math.min(...centroids.map(c => dist2(p, c))))
    const total = d.reduce((s, x) => s + x, 0)
    if (!total) break
    let pick = r() * total, i = 0
    while (i < n - 1 && (pick -= d[i]) > 0) i++
    centroids.push(pts[i].slice())
  }
  let assign = Array(n).fill(0)
  for (let it = 0; it < iters; it++) {
    const next = pts.map(p => { let best = 0, bd = Infinity; centroids.forEach((c, j) => { const d = dist2(p, c); if (d < bd) { bd = d; best = j } }); return best })
    const same = next.every((a, i) => a === assign[i])
    assign = next
    centroids.forEach((c, j) => {
      const members = pts.filter((_, i) => assign[i] === j)
      if (members.length) for (let x = 0; x < c.length; x++) c[x] = members.reduce((s, m) => s + m[x], 0) / members.length
    })
    if (same && it > 0) break
  }
  const inertia = pts.reduce((s, p, i) => s + dist2(p, centroids[assign[i]]), 0)
  return { assign, centroids, inertia }
}

/** Mean silhouette in [-1, 1]; higher means better separated clusters. */
export function silhouette(pts: number[][], assign: number[]): number {
  const k = Math.max(...assign) + 1
  if (k < 2) return 0
  let s = 0
  for (let i = 0; i < pts.length; i++) {
    const sums = Array(k).fill(0), cnt = Array(k).fill(0)
    for (let j = 0; j < pts.length; j++) if (j !== i) { sums[assign[j]] += Math.sqrt(dist2(pts[i], pts[j])); cnt[assign[j]]++ }
    const own = assign[i]
    if (!cnt[own]) continue
    const a = sums[own] / cnt[own]
    const b = Math.min(...sums.map((x, c) => c === own || !cnt[c] ? Infinity : x / cnt[c]))
    s += Number.isFinite(b) ? (b - a) / Math.max(a, b, 1e-9) : 0
  }
  return s / pts.length
}

export interface FailureCluster { id: number; runs: Run[]; summary: string[]; centroid: Params }

/** Groups failed runs by where they sit in the ODD. k is picked by silhouette (2 to 6) unless given. */
export function clusterFailures(odd: Odd, failed: Run[], k?: number): FailureCluster[] {
  if (!failed.length) return []
  const pts = failed.map(r => normalise(odd, r.params))
  let best: KMeans
  if (k) best = kmeans(pts, k)
  else if (failed.length < 6) best = kmeans(pts, 1)
  else {
    let score = -Infinity
    best = kmeans(pts, 1)
    for (let c = 2; c <= Math.min(6, Math.floor(failed.length / 3)); c++) {
      const km = kmeans(pts, c)
      const s = silhouette(pts, km.assign)
      if (s > score + 0.02) { score = s; best = km }
    }
  }
  const groups = best.centroids.map((_, j) => failed.filter((_, i) => best.assign[i] === j)).filter(g => g.length)
  return groups.sort((a, b) => b.length - a.length).map((runs, id) => ({ id, runs, summary: describe(odd, runs), centroid: centre(odd, runs) }))
}

const q = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))))]
const fmt = (n: number) => String(Math.round(n * 10) / 10)

/** What a group of runs has in common: tight numeric ranges and dominant categories. */
export function describe(odd: Odd, runs: Run[]): string[] {
  const out: { text: string; tight: number }[] = []
  for (const d of odd) {
    const vals = runs.map(r => r.params[d.key])
    if (d.kind === 'range') {
      const xs = vals.map(Number).filter(Number.isFinite).sort((a, b) => a - b)
      if (!xs.length) continue
      const lo = q(xs, 0.1), hi = q(xs, 0.9), span = ((hi - lo) / Math.max(1e-9, (d.max ?? 1) - (d.min ?? 0)))
      if (span <= 0.45) out.push({ text: `${d.label} ${fmt(lo)}–${fmt(hi)}${d.unit ? ' ' + d.unit : ''}`, tight: span })
    } else {
      const counts = new Map<string, number>()
      for (const v of vals) counts.set(String(v), (counts.get(String(v)) ?? 0) + 1)
      const [top, c] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] ?? ['', 0]
      const share = c / runs.length
      const base = 1 / Math.max(1, d.categories?.length ?? 1)
      if (share >= 0.6 && share > base * 1.5) out.push({ text: `${d.label} = ${top}${share < 1 ? ` (${Math.round(share * 100)}%)` : ''}`, tight: 1 - share })
    }
  }
  return out.sort((a, b) => a.tight - b.tight).slice(0, 4).map(o => o.text)
}

function centre(odd: Odd, runs: Run[]): Params {
  const p: Params = {}
  for (const d of odd) {
    if (d.kind === 'range') { const xs = runs.map(r => Number(r.params[d.key])).filter(Number.isFinite).sort((a, b) => a - b); p[d.key] = xs.length ? q(xs, 0.5) : ((d.min ?? 0) + (d.max ?? 1)) / 2 }
    else { const c = new Map<string, number>(); runs.forEach(r => c.set(String(r.params[d.key]), (c.get(String(r.params[d.key])) ?? 0) + 1)); p[d.key] = [...c.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '' }
  }
  return p
}

// ---------- Rule extraction ("fails when X and Y") ----------

export interface Cond { key: string; op: '<' | '>=' | '=' | '!='; value: number | string }
export interface Rule { conds: Cond[]; n: number; fails: number; rate: number; lift: number; text: string }

const gini = (n: number, f: number) => n ? 1 - (f / n) ** 2 - ((n - f) / n) ** 2 : 0

function matches(c: Cond, v: unknown): boolean {
  if (c.op === '=') return String(v) === c.value
  if (c.op === '!=') return String(v) !== c.value
  const x = Number(v)
  if (!Number.isFinite(x)) return false
  return c.op === '<' ? x < (c.value as number) : x >= (c.value as number)
}

function bestSplit(odd: Odd, runs: Run[], fail: boolean[], minLeaf: number): { cond: Cond; gain: number } | null {
  const n = runs.length, f = fail.filter(Boolean).length
  const parent = gini(n, f)
  let best: { cond: Cond; gain: number } | null = null
  const consider = (cond: Cond) => {
    let ln = 0, lf = 0
    runs.forEach((r, i) => { if (matches(cond, r.params[cond.key])) { ln++; if (fail[i]) lf++ } })
    const rn = n - ln, rf = f - lf
    if (ln < minLeaf || rn < minLeaf) return
    const gain = parent - (ln / n) * gini(ln, lf) - (rn / n) * gini(rn, rf)
    if (!best || gain > best.gain + 1e-12) best = { cond, gain }
  }
  for (const d of odd) {
    if (d.kind === 'category') { for (const c of d.categories ?? []) consider({ key: d.key, op: '=', value: c }); continue }
    const xs = [...new Set(runs.map(r => Number(r.params[d.key])).filter(Number.isFinite))].sort((a, b) => a - b)
    const step = Math.max(1, Math.floor(xs.length / 40))
    for (let i = step; i < xs.length; i += step) consider({ key: d.key, op: '<', value: Math.round(((xs[i - 1] + xs[i]) / 2) * 100) / 100 })
  }
  return best
}

/**
 * A small CART tree (Gini splits) on all runs, fail vs not-fail. Leaves that fail far more often than the
 * campaign as a whole become readable rules. Numeric bounds on the same parameter are merged.
 */
export function extractRules(odd: Odd, runs: Run[], fail: boolean[], opts: { maxDepth?: number; minSupport?: number } = {}): Rule[] {
  const maxDepth = opts.maxDepth ?? 3, minSupport = opts.minSupport ?? 5
  const total = runs.length, totalFails = fail.filter(Boolean).length
  if (!total || !totalFails) return []
  const base = totalFails / total
  const rules: Rule[] = []
  const grow = (rs: Run[], fs: boolean[], conds: Cond[], depth: number) => {
    const n = rs.length, f = fs.filter(Boolean).length
    const rate = f / n
    const split = depth < maxDepth && f > 0 && f < n ? bestSplit(odd, rs, fs, minSupport) : null
    if (!split || split.gain < 1e-4) {
      if (conds.length && n >= minSupport && rate >= Math.min(0.85, Math.max(0.4, base * 2))) rules.push(makeRule(odd, conds, n, f, base))
      return
    }
    const c = split.cond
    const neg: Cond = c.op === '<' ? { ...c, op: '>=' } : { ...c, op: '!=' }
    for (const cond of [c, neg]) {
      const idx = rs.map((r, i) => matches(cond, r.params[cond.key]) ? i : -1).filter(i => i >= 0)
      grow(idx.map(i => rs[i]), idx.map(i => fs[i]), [...conds, cond], depth + 1)
    }
  }
  grow(runs, fail, [], 0)
  return rules.sort((a, b) => b.fails - a.fails || b.rate - a.rate)
}

function simplify(conds: Cond[]): Cond[] {
  const out: Cond[] = []
  for (const c of conds) {
    if (c.op === '=') {
      // "is fog" makes any earlier "is not rain" redundant.
      for (let i = out.length - 1; i >= 0; i--) if (out[i].key === c.key && out[i].op === '!=') out.splice(i, 1)
      out.push(c)
      continue
    }
    if (c.op === '!=' && out.some(o => o.key === c.key && o.op === '=')) continue
    const same = out.findIndex(o => o.key === c.key && o.op === c.op)
    if (same >= 0 && (c.op === '<' || c.op === '>=')) {
      const keep = c.op === '<' ? Math.min(out[same].value as number, c.value as number) : Math.max(out[same].value as number, c.value as number)
      out[same] = { ...c, value: keep }
    } else out.push(c)
  }
  return out
}

export function ruleText(odd: Odd, conds: Cond[]): string {
  const label = (k: string) => odd.find(d => d.key === k) as OddParam | undefined
  const parts: string[] = []
  const used = new Set<number>()
  conds.forEach((c, i) => {
    if (used.has(i)) return
    const d = label(c.key), name = d?.label ?? c.key, unit = d?.unit ? ' ' + d.unit : ''
    if (c.op === '>=') {
      const j = conds.findIndex((o, k) => k > i && o.key === c.key && o.op === '<')
      if (j >= 0) { used.add(j); parts.push(`${name} ${c.value}–${conds[j].value}${unit}`); return }
    }
    if (c.op === '<') {
      const j = conds.findIndex((o, k) => k > i && o.key === c.key && o.op === '>=')
      if (j >= 0) { used.add(j); parts.push(`${name} ${conds[j].value}–${c.value}${unit}`); return }
    }
    parts.push(c.op === '=' ? `${name} is ${c.value}` : c.op === '!=' ? `${name} is not ${c.value}` : `${name} ${c.op === '<' ? '<' : '≥'} ${c.value}${unit}`)
  })
  return 'Fails when ' + parts.join(' and ')
}

function makeRule(odd: Odd, conds: Cond[], n: number, fails: number, base: number): Rule {
  let c = simplify(conds)
  // "is not clear" on a two-value parameter reads better as "is rain".
  for (const d of odd) {
    if (d.kind !== 'category' || c.some(x => x.key === d.key && x.op === '=')) continue
    const not = new Set(c.filter(x => x.key === d.key && x.op === '!=').map(x => String(x.value)))
    const left = (d.categories ?? []).filter(v => !not.has(v))
    if (not.size && left.length === 1) c = [...c.filter(x => !(x.key === d.key && x.op === '!=')), { key: d.key, op: '=', value: left[0] }]
  }
  return { conds: c, n, fails, rate: fails / n, lift: base ? fails / n / base : 0, text: ruleText(odd, c) }
}

export const ruleMatches = (rule: Rule, r: Run) => rule.conds.every(c => matches(c, r.params[c.key]))
