import type { Metrics, TrajRow } from './types.ts'

// Geometry is in metres, seconds and radians; heading 0 points along +x, counter-clockwise positive.

export type Pt = [number, number]
export interface Track { id: string; len: number; wid: number; t: number[]; x: number[]; y: number[]; h: number[]; v: number[] }

export const DEFAULT_SIZE: Record<string, [number, number]> = { truck: [21, 2.6], car: [4.8, 1.9] }

/** Groups rows by actor and sorts each track by time. The ego is the actor named "ego" (any case) or the first one seen. */
export function toTracks(rows: TrajRow[]): { ego: Track; others: Track[] } {
  const by = new Map<string, TrajRow[]>()
  for (const r of rows) { const l = by.get(r.id); if (l) l.push(r); else by.set(r.id, [r]) }
  const tracks = [...by.entries()].map(([id, l]) => {
    l.sort((a, b) => a.t - b.t)
    const big = /ego|truck|semi/i.test(id)
    return { id, len: l[0].len ?? (big ? 21 : 4.8), wid: l[0].wid ?? (big ? 2.6 : 1.9), t: l.map(r => r.t), x: l.map(r => r.x), y: l.map(r => r.y), h: l.map(r => r.h), v: l.map(r => r.v) }
  })
  if (!tracks.length) throw new Error('No trajectory rows')
  const ei = Math.max(0, tracks.findIndex(t => /^ego$/i.test(t.id) || /ego/i.test(t.id)))
  return { ego: tracks[ei], others: tracks.filter((_, i) => i !== ei) }
}

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a))

/** State of a track at time t (linear interpolation, no extrapolation). Null outside the recorded window. */
export function stateAt(tr: Track, t: number): { x: number; y: number; h: number; v: number } | null {
  const n = tr.t.length
  if (!n || t < tr.t[0] - 1e-9 || t > tr.t[n - 1] + 1e-9) return null
  let lo = 0, hi = n - 1
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (tr.t[m] <= t) lo = m; else hi = m }
  const span = tr.t[hi] - tr.t[lo]
  const f = span > 0 ? Math.min(1, Math.max(0, (t - tr.t[lo]) / span)) : 0
  const L = (a: number[]) => a[lo] + (a[hi] - a[lo]) * f
  return { x: L(tr.x), y: L(tr.y), h: tr.h[lo] + wrap(tr.h[hi] - tr.h[lo]) * f, v: L(tr.v) }
}

/** Corners of an oriented bounding box centred on (x, y). */
export function box(x: number, y: number, h: number, len: number, wid: number): Pt[] {
  const c = Math.cos(h), s = Math.sin(h), l = len / 2, w = wid / 2
  return [[l, w], [-l, w], [-l, -w], [l, -w]].map(([a, b]) => [x + a * c - b * s, y + a * s + b * c] as Pt)
}

/** Separating-axis test for two convex polygons. */
export function overlaps(A: Pt[], B: Pt[]): boolean {
  for (const P of [A, B]) for (let i = 0; i < P.length; i++) {
    const [x1, y1] = P[i], [x2, y2] = P[(i + 1) % P.length]
    const nx = y2 - y1, ny = x1 - x2
    let aMin = Infinity, aMax = -Infinity, bMin = Infinity, bMax = -Infinity
    for (const [x, y] of A) { const d = x * nx + y * ny; aMin = Math.min(aMin, d); aMax = Math.max(aMax, d) }
    for (const [x, y] of B) { const d = x * nx + y * ny; bMin = Math.min(bMin, d); bMax = Math.max(bMax, d) }
    if (aMax < bMin || bMax < aMin) return false
  }
  return true
}

function segDist(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy
  const t = L ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L)) : 0
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy)
}

/** Shortest distance between two convex polygons; 0 when they overlap. */
export function polyDist(A: Pt[], B: Pt[]): number {
  if (overlaps(A, B)) return 0
  let d = Infinity
  for (const [P, Q] of [[A, B], [B, A]]) for (const p of P) for (let i = 0; i < Q.length; i++) d = Math.min(d, segDist(p, Q[i], Q[(i + 1) % Q.length]))
  return d
}

/**
 * Time-to-collision of two oriented boxes under constant velocity along their headings.
 * Steps forward until the boxes touch; Infinity if they do not within the horizon.
 */
export function ttcBoxes(a: { x: number; y: number; h: number; v: number; len: number; wid: number }, b: { x: number; y: number; h: number; v: number; len: number; wid: number }, horizon = 10, dt = 0.02): number {
  const avx = a.v * Math.cos(a.h), avy = a.v * Math.sin(a.h), bvx = b.v * Math.cos(b.h), bvy = b.v * Math.sin(b.h)
  const reach = (Math.hypot(a.len, a.wid) + Math.hypot(b.len, b.wid)) / 2
  const rvx = bvx - avx, rvy = bvy - avy
  // Cheap reject: centres never get within reach over the horizon.
  const dx = b.x - a.x, dy = b.y - a.y, rv2 = rvx * rvx + rvy * rvy
  const tc = rv2 ? Math.max(0, Math.min(horizon, -(dx * rvx + dy * rvy) / rv2)) : 0
  if (Math.hypot(dx + rvx * tc, dy + rvy * tc) > reach) return Infinity
  for (let t = 0; t <= horizon + 1e-9; t += dt) {
    if (overlaps(box(a.x + avx * t, a.y + avy * t, a.h, a.len, a.wid), box(b.x + bvx * t, b.y + bvy * t, b.h, b.len, b.wid))) return t
  }
  return Infinity
}

/** Distance from a point to a polyline. */
export function distToPolyline(p: Pt, line: Pt[]): number {
  if (line.length === 1) return Math.hypot(p[0] - line[0][0], p[1] - line[0][1])
  let d = Infinity
  for (let i = 0; i + 1 < line.length; i++) d = Math.min(d, segDist(p, line[i], line[i + 1]))
  return d
}

export interface Series { t: number[]; ttc: number[]; dist: number[]; accel: number[] }
export interface MetricResult { metrics: Metrics; series: Series; laneDeparture: boolean }

/**
 * All per-run safety metrics from a trajectory, evaluated at the ego's sample times.
 * centreline defaults to the ego's own lane at its starting y (straight road along +x).
 */
export function computeMetrics(rows: TrajRow[], opts: { centreline?: Pt[]; laneWidth?: number; horizon?: number } = {}): MetricResult {
  const { ego, others } = toTracks(rows)
  const laneWidth = opts.laneWidth ?? 3.7
  const line: Pt[] = opts.centreline ?? [[ego.x[0] - 1e4, ego.y[0]], [ego.x[0] + 1e4, ego.y[0]]]
  const series: Series = { t: [], ttc: [], dist: [], accel: [] }
  let ttc = Infinity, minDist = Infinity, collision = false, laneDev = 0

  for (let i = 0; i < ego.t.length; i++) {
    const t = ego.t[i]
    const e = { x: ego.x[i], y: ego.y[i], h: ego.h[i], v: ego.v[i], len: ego.len, wid: ego.wid }
    const eb = box(e.x, e.y, e.h, e.len, e.wid)
    let st = Infinity, sd = Infinity
    for (const o of others) {
      const s = stateAt(o, t)
      if (!s) continue
      const ob = { ...s, len: o.len, wid: o.wid }
      const d = polyDist(eb, box(s.x, s.y, s.h, o.len, o.wid))
      sd = Math.min(sd, d)
      if (d === 0) { collision = true; st = 0 } else st = Math.min(st, ttcBoxes(e, ob, opts.horizon ?? 10))
    }
    ttc = Math.min(ttc, st); minDist = Math.min(minDist, sd)
    laneDev = Math.max(laneDev, distToPolyline([e.x, e.y], line))
    series.t.push(t); series.ttc.push(st); series.dist.push(sd)
  }

  // Longitudinal dynamics from the ego speed trace.
  const acc: number[] = []
  for (let i = 0; i + 1 < ego.t.length; i++) { const dt = ego.t[i + 1] - ego.t[i]; acc.push(dt > 0 ? (ego.v[i + 1] - ego.v[i]) / dt : 0) }
  let maxDecel = 0, maxJerk = 0
  for (const a of acc) maxDecel = Math.max(maxDecel, -a)
  for (let i = 0; i + 1 < acc.length; i++) { const dt = ego.t[i + 1] - ego.t[i]; if (dt > 0) maxJerk = Math.max(maxJerk, Math.abs(acc[i + 1] - acc[i]) / dt) }
  series.accel = [...acc, acc.at(-1) ?? 0]

  const pet = others.length ? Math.min(...others.map(o => postEncroachment(ego, o))) : Infinity
  const metrics: Metrics = { collision, maxDecel: r2(maxDecel), maxJerk: r2(maxJerk), laneDev: r2(laneDev) }
  if (Number.isFinite(ttc)) metrics.ttc = r2(ttc)
  if (Number.isFinite(minDist)) metrics.minDist = r2(minDist)
  if (Number.isFinite(pet)) metrics.pet = r2(pet)
  return { metrics, series, laneDeparture: laneDev + ego.wid / 2 > laneWidth / 2 }
}

const r2 = (n: number) => Math.round(n * 100) / 100

/**
 * Post-encroachment time: the smallest gap in time between one actor occupying a piece of road and the other
 * occupying it. Compares footprints across all sample pairs; 0 means they were there at the same time (a collision).
 */
export function postEncroachment(a: Track, b: Track): number {
  const reach = (Math.hypot(a.len, a.wid) + Math.hypot(b.len, b.wid)) / 2
  let pet = Infinity
  for (let i = 0; i < a.t.length; i++) {
    let A: Pt[] | null = null
    for (let j = 0; j < b.t.length; j++) {
      const dt = Math.abs(a.t[i] - b.t[j])
      if (dt >= pet) continue
      if (Math.hypot(a.x[i] - b.x[j], a.y[i] - b.y[j]) > reach) continue
      A ??= box(a.x[i], a.y[i], a.h[i], a.len, a.wid)
      if (overlaps(A, box(b.x[j], b.y[j], b.h[j], b.len, b.wid))) pet = dt
    }
  }
  return pet
}
