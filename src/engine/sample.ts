// Synthetic highway trucking campaigns. Every number here is generated; nothing comes from a real fleet.
import { rng } from './cluster.ts'
import { computeMetrics } from './metrics.ts'
import type { Campaign, Odd, Params, Run, Thresholds, TrajRow } from './types.ts'

export const SAMPLE_ODD: Odd = [
  { key: 'event', label: 'Event', kind: 'category', categories: ['cut_in', 'merge', 'lead_brake', 'debris'] },
  { key: 'weather', label: 'Weather', kind: 'category', categories: ['clear', 'rain', 'fog', 'snow'] },
  { key: 'lighting', label: 'Lighting', kind: 'category', categories: ['day', 'dusk', 'night'] },
  { key: 'road', label: 'Road', kind: 'category', categories: ['straight', 'curve', 'on_ramp', 'work_zone'] },
  { key: 'ego_speed', label: 'Ego speed', kind: 'range', unit: 'km/h', min: 60, max: 105, bins: 5 },
  { key: 'gap', label: 'Cut-in gap', kind: 'range', unit: 'm', min: 5, max: 60, bins: 5 },
  { key: 'rel_speed', label: 'Actor rel. speed', kind: 'range', unit: 'km/h', min: -30, max: 10, bins: 4 },
]

export const DEFAULT_THRESHOLDS: Thresholds = { ttc: 1.5, pet: 0.5, minDist: 1.0, maxDecel: 5, maxJerk: 12, laneDev: 0.9 }

const SIGHT: Record<string, number> = { clear: 160, rain: 110, fog: 45, snow: 80 }
const LIGHT: Record<string, number> = { day: 1, dusk: 0.8, night: 0.55 }
const MU: Record<string, number> = { clear: 1, rain: 0.8, fog: 0.9, snow: 0.55 }

/**
 * Closed-loop toy simulation of a tractor-trailer (21 m x 2.6 m) at 10 Hz for 12 s.
 * The event actor cuts in, merges, brakes ahead, or is static debris; the ego brakes when its own
 * time-gap to whatever is in its lane gets short, after a perception delay that grows in bad weather.
 */
export function simulate(p: Params, seed = 1): TrajRow[] {
  const r = rng(seed)
  const dt = 0.1, T = 12, lane = 3.7
  const v0 = Number(p.ego_speed) / 3.6, gap = Number(p.gap), rel = Number(p.rel_speed) / 3.6
  const ev = String(p.event), weather = String(p.weather), road = String(p.road)
  const EL = 21, EW = 2.6
  const debris = ev === 'debris'
  const AL = debris ? 1.2 : 4.8, AW = debris ? 1.6 : 1.9
  const sight = SIGHT[weather] * LIGHT[String(p.lighting)] * (debris ? 0.85 : 1)
  const delay = 0.4 + (weather === 'fog' ? 0.5 : weather === 'snow' ? 0.3 : 0) + (p.lighting === 'night' ? 0.3 : 0) + r() * 0.2
  const maxBrake = 7 * MU[weather]
  const wobble = 0.12 + (road === 'curve' ? 0.012 * Math.max(0, Number(p.ego_speed) - 60) : 0) + (road === 'work_zone' ? 0.35 : 0) + (weather === 'snow' ? 0.25 : 0)

  // Actor initial state.
  const side = ev === 'merge' ? -lane : lane
  let ax = EL / 2 + gap + AL / 2 + (debris ? 70 : ev === 'merge' ? 4 : 0), ay = ev === 'lead_brake' || debris ? 0 : side
  let av = debris ? 0 : Math.max(0, v0 + (ev === 'lead_brake' ? 0 : rel))
  const brakeAt = 1.5 + r(), leadDecel = 1.5 + Math.max(0, -Number(p.rel_speed)) / 9
  const changeStart = 0.8 + r() * 0.6, changeDur = ev === 'merge' ? 4 : 2.2 + r() * 1.2

  let ex = 0, ev_ = v0, acc = 0, seen = -1
  const rows: TrajRow[] = []
  const phase = r() * 6
  for (let i = 0; i <= T / dt + 1e-9; i++) {
    const t = Math.round(i * dt * 10) / 10
    // Actor lateral profile.
    let ah = 0
    if (!debris && ev !== 'lead_brake') {
      const f = Math.min(1, Math.max(0, (t - changeStart) / changeDur))
      const s = (1 - Math.cos(Math.PI * f)) / 2
      const ny = side * (1 - s)
      const dyRate = f > 0 && f < 1 ? (-side * Math.PI * Math.sin(Math.PI * f)) / (2 * changeDur) : 0
      ah = av > 0.1 ? Math.atan2(dyRate, av) : 0
      ay = ny
    }
    if (ev === 'lead_brake' && t >= brakeAt) av = Math.max(0, av - leadDecel * dt)
    const ey = wobble * Math.sin(t * 0.9 + phase) * Math.min(1, t / 2)
    rows.push({ t, id: 'ego', x: ex, y: ey, h: Math.atan2(wobble * 0.9 * Math.cos(t * 0.9 + phase) * Math.min(1, t / 2), Math.max(1, ev_)), v: ev_, len: EL, wid: EW })
    rows.push({ t, id: debris ? 'debris' : ev === 'lead_brake' ? 'lead' : 'npc', x: ax, y: ay, h: ah, v: av, len: AL, wid: AW })

    // Ego control: look at the actor once it overlaps our lane and is within sight.
    const inLane = Math.abs(ay - ey) < (AW + EW) / 2 + 0.3
    const dist = ax - AL / 2 - (ex + EL / 2)
    if (inLane && dist > -AL && dist < sight && seen < 0) seen = t
    let want = 0
    if (seen >= 0 && t - seen >= delay && dist > -AL) {
      const closing = ev_ - av
      const headway = dist / Math.max(1, ev_)
      const aLead = ev === 'lead_brake' && t >= brakeAt + delay && av > 0 ? leadDecel : 0
      if (closing > 0 && dist > 0.5) want = Math.min(maxBrake, aLead + (closing * closing) / (2 * Math.max(0.5, dist - 8)) + (headway < 1 ? 1 : 0))
      else if (aLead) want = Math.min(maxBrake, aLead)
      if (!want && headway < 0.8) want = Math.min(maxBrake, 1.5)
      if (dist <= 0.5) want = maxBrake
    }
    // Brake actuation is jerk-limited.
    const target = -want
    const jl = 9
    acc += Math.max(-jl * dt, Math.min(jl * dt, target - acc))
    ev_ = Math.max(0, ev_ + acc * dt)
    ex += ev_ * dt
    ax += av * Math.cos(ah) * dt
  }
  return rows
}

interface Mix { n: number; label: string; date: string; w: Record<string, Record<string, number>>; speed: [number, number]; gap: [number, number]; rel: [number, number] }

const MIXES: Mix[] = [
  { n: 200, label: 'Aug 2026 · Highway baseline', date: '2026-08-28', speed: [70, 100], gap: [15, 60], rel: [-20, 10],
    w: { event: { cut_in: 6, lead_brake: 4 }, weather: { clear: 8, rain: 2 }, lighting: { day: 8, dusk: 2 }, road: { straight: 7, curve: 3 } } },
  { n: 200, label: 'Sep 2026 · Merges and rain', date: '2026-09-29', speed: [60, 105], gap: [8, 60], rel: [-30, 10],
    w: { event: { cut_in: 4, merge: 4, lead_brake: 2 }, weather: { clear: 4, rain: 5, fog: 1 }, lighting: { day: 6, dusk: 3, night: 1 }, road: { straight: 4, curve: 2, on_ramp: 4 } } },
  { n: 200, label: 'Oct 2026 · Night, fog and debris', date: '2026-10-30', speed: [60, 105], gap: [5, 60], rel: [-30, 10],
    w: { event: { cut_in: 4, merge: 2, lead_brake: 2, debris: 3 }, weather: { clear: 3, rain: 2, fog: 3, snow: 1 }, lighting: { day: 3, dusk: 2, night: 4 }, road: { straight: 4, curve: 3, on_ramp: 2, work_zone: 2 } } },
]

function pick(r: () => number, w: Record<string, number>): string {
  const tot = Object.values(w).reduce((s, x) => s + x, 0)
  let x = r() * tot
  for (const [k, v] of Object.entries(w)) if ((x -= v) <= 0) return k
  return Object.keys(w)[0]
}

export interface SampleData { campaigns: Campaign[]; traj: Record<string, TrajRow[]> }

/** Parameter sets for the three campaigns (cheap; no simulation). */
export function sampleParams(): Params[][] {
  const r = rng(2026)
  return MIXES.map(m => {
    const out: Params[] = []
    for (let i = 0; i < m.n; i++) {
      let params: Params
      // Combinations this synthetic programme never got to, so the sample has real gaps to find.
      do params = {
        event: pick(r, m.w.event), weather: pick(r, m.w.weather), lighting: pick(r, m.w.lighting), road: pick(r, m.w.road),
        ego_speed: Math.round(m.speed[0] + r() * (m.speed[1] - m.speed[0])),
        gap: Math.round((m.gap[0] + Math.sqrt(r()) * (m.gap[1] - m.gap[0])) * 10) / 10,
        rel_speed: Math.round(m.rel[1] - Math.sqrt(r()) * (m.rel[1] - m.rel[0])),
      }
      while ((params.weather === 'snow' && (params.lighting === 'night' || params.road === 'work_zone' || Number(params.ego_speed) > 95)) || (params.event === 'debris' && params.road === 'on_ramp') || (params.event === 'merge' && params.road === 'curve'))
      out.push(params)
    }
    return out
  })
}

export const SAMPLE_CAMPAIGNS = MIXES.map(m => ({ label: m.label, date: m.date }))

/** 600 runs in three campaigns. Every run is simulated and measured; every 8th keeps its trajectory for replay. */
export function generateSample(): SampleData {
  const traj: Record<string, TrajRow[]> = {}
  const campaigns = sampleParams().map((list, ci): Campaign => {
    const runs: Run[] = list.map((params, i) => {
      const id = `C${ci + 1}-${String(i + 1).padStart(4, '0')}`
      const rows = simulate(params, ci * 1000 + i + 1)
      const { metrics } = computeMetrics(rows)
      const keep = i % 8 === 0
      if (keep) traj[id] = rows
      return { id, scenario: `${params.event}_${params.road}`, params, metrics, traj: keep || undefined }
    })
    return { id: `sample-c${ci + 1}`, label: MIXES[ci].label, date: MIXES[ci].date, runs, source: 'Synthetic campaign' }
  })
  return { campaigns, traj }
}

/** The cut-in the landing page replays: a car squeezes into a short gap in front of the truck at night. */
export const HERO_PARAMS: Params = { event: 'cut_in', weather: 'clear', lighting: 'dusk', road: 'straight', ego_speed: 88, gap: 9, rel_speed: -8 }
