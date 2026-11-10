import { parseCsv, parseNum } from './csv.ts'
import type { Metrics, Odd, OddParam, Params, Run, TrajRow } from './types.ts'

export type Format = 'param-csv' | 'param-json' | 'xosc' | 'carla-json' | 'trajectory-csv'
export const FORMATS: Record<Format, string> = {
  'param-csv': 'Scenario parameter table (CSV)',
  'param-json': 'Scenario parameter table (JSON)',
  'xosc': 'OpenSCENARIO 1.x (.xosc)',
  'carla-json': 'CARLA scenario_runner results (JSON)',
  'trajectory-csv': 'Per-run trajectories (CSV)',
}

export interface Issue { line: number; level: 'error' | 'warning'; message: string }

export const norm = (h: string) => h.trim().toLowerCase().replace(/^"|"$/g, '').replace(/[\s\-.()/]+/g, '_').replace(/_+$/, '')

const TRAJ = { t: ['t', 'time', 'timestamp', 'sim_time', 'time_s'], id: ['actor', 'actor_id', 'id', 'agent', 'agent_id', 'entity', 'object_id'], x: ['x', 'pos_x', 'x_m'], y: ['y', 'pos_y', 'y_m'], h: ['heading', 'yaw', 'theta', 'h', 'heading_rad', 'heading_deg', 'yaw_deg'], v: ['speed', 'v', 'velocity', 'speed_mps', 'speed_m_s'] }

export function detect(fileName: string, text: string): Format {
  const head = text.slice(0, 4000)
  if (/\.xosc$/i.test(fileName) || /<OpenSCENARIO[\s>]/.test(head)) return 'xosc'
  const t = head.trimStart()
  if (t.startsWith('{') || t.startsWith('[')) {
    if (/"criteria"\s*:|"_checkpoint"\s*:|"scenario_runner"|"success"\s*:\s*(true|false)/.test(text.slice(0, 20000))) return 'carla-json'
    return 'param-json'
  }
  const first = parseCsv(head.split(/\r?\n/).slice(0, 2).join('\n')).rows[0]?.map(norm) ?? []
  const has = (al: string[]) => first.some(h => al.includes(h))
  if (has(TRAJ.t) && has(TRAJ.x) && has(TRAJ.y) && has(TRAJ.id)) return 'trajectory-csv'
  return 'param-csv'
}

// ---------- Parameter tables ----------

export type Role = 'id' | 'scenario' | 'outcome' | 'reason' | 'param' | 'ignore' | keyof Metrics
export const ROLE_LABEL: Record<Role, string> = { id: 'Run id', scenario: 'Scenario name', outcome: 'Pass / fail', reason: 'Failure reason', param: 'ODD parameter', ignore: 'Ignore', ttc: 'Min TTC (s)', pet: 'Min PET (s)', minDist: 'Min distance (m)', maxDecel: 'Max decel (m/s²)', maxJerk: 'Max jerk (m/s³)', laneDev: 'Lane offset (m)', collision: 'Collision' }

const ALIASES: Partial<Record<Role, string[]>> = {
  id: ['id', 'run_id', 'run', 'test_id', 'case_id', 'sim_id'],
  scenario: ['scenario', 'scenario_name', 'name', 'scenario_id', 'test', 'template'],
  outcome: ['outcome', 'result', 'status', 'verdict', 'pass', 'passed', 'success', 'pass_fail'],
  reason: ['reason', 'failure_reason', 'fail_reason', 'message', 'notes', 'failure'],
  ttc: ['ttc', 'min_ttc', 'ttc_min', 'ttc_s', 'min_ttc_s', 'time_to_collision'],
  pet: ['pet', 'min_pet', 'pet_s', 'post_encroachment_time'],
  minDist: ['min_dist', 'min_distance', 'min_distance_m', 'min_gap', 'closest_distance'],
  maxDecel: ['max_decel', 'max_deceleration', 'max_brake', 'max_decel_mps2', 'peak_decel'],
  maxJerk: ['max_jerk', 'jerk', 'peak_jerk'],
  laneDev: ['lane_dev', 'lane_offset', 'max_lateral_offset', 'lane_deviation', 'max_lane_offset'],
  collision: ['collision', 'collided', 'crash', 'has_collision'],
}

export type Mapping = Role[]

export function autoMap(headers: string[]): Mapping {
  const seen = new Set<Role>()
  return headers.map(h => {
    const n = norm(h)
    for (const [role, al] of Object.entries(ALIASES) as [Role, string[]][]) if (!seen.has(role) && al.includes(n)) { seen.add(role); return role }
    return n ? 'param' : 'ignore'
  })
}

export function toOutcome(raw: string): 'pass' | 'fail' | undefined {
  const s = raw.trim().toLowerCase()
  if (/^(pass|passed|success|succeeded|ok|true|1|yes|green)$/.test(s)) return 'pass'
  if (/^(fail|failed|failure|false|0|no|red|collision|error|timeout)$/.test(s)) return 'fail'
  return undefined
}
const truthy = (raw: string) => /^(true|1|yes|y|collision)$/i.test(raw.trim())

const niceFloor = (x: number) => { const m = 10 ** Math.floor(Math.log10(Math.abs(x) || 1)) / 2; return Math.floor(x / m) * m }
const niceCeil = (x: number) => { const m = 10 ** Math.floor(Math.log10(Math.abs(x) || 1)) / 2; return Math.ceil(x / m) * m }

/** Guesses an ODD from the parameter columns: mostly-numeric columns become ranges, the rest categories. */
export function inferOdd(headers: string[], rows: string[][], map: Mapping): Odd {
  const odd: Odd = []
  headers.forEach((h, c) => {
    if (map[c] !== 'param') return
    const vals = rows.map(r => (r[c] ?? '').trim()).filter(v => v !== '')
    if (!vals.length) return
    const nums = vals.map(parseNum).filter(Number.isFinite)
    const key = norm(h)
    if (nums.length >= vals.length * 0.9) {
      let min = Math.min(...nums), max = Math.max(...nums)
      if (min === max) { min -= 1; max += 1 }
      const unit = h.match(/\(([^)]+)\)|_(kmh|kph|mps|m|s|deg|pct)$/i)
      odd.push({ key, label: pretty(h), kind: 'range', min: niceFloor(min), max: niceCeil(max), bins: 5, unit: unit ? (unit[1] ?? unit[2]).replace(/^(kmh|kph)$/i, 'km/h') : undefined })
    } else {
      const cats = [...new Set(vals)].slice(0, 24)
      odd.push({ key, label: pretty(h), kind: 'category', categories: cats })
    }
  })
  return odd
}

export const pretty = (h: string) => { const s = h.replace(/\([^)]*\)/g, '').replace(/[_-]+/g, ' ').trim(); return s.charAt(0).toUpperCase() + s.slice(1) }

export interface Validated { runs: Run[]; issues: Issue[]; skipped: number; total: number }

/** Turns mapped table rows into runs, reporting problems with their source line numbers. */
export function validateTable(headers: string[], rows: string[][], lines: number[], map: Mapping, odd: Odd): Validated {
  const issues: Issue[] = []
  const runs: Run[] = []
  const ids = new Set<string>()
  const byKey = new Map(odd.map(d => [d.key, d]))
  let skipped = 0
  if (!map.includes('param')) issues.push({ line: 1, level: 'error', message: 'No column is mapped to an ODD parameter, so there is nothing to measure coverage on.' })
  rows.forEach((row, ri) => {
    const line = lines[ri]
    if (row.every(c => !c.trim())) return
    const params: Params = {}, metrics: Metrics = {}
    let id = '', scenario = '', outcome: Run['outcome'], reason: string | undefined, bad = false
    headers.forEach((h, c) => {
      const raw = (row[c] ?? '').trim(), role = map[c]
      if (role === 'ignore') return
      if (role === 'id') id = raw
      else if (role === 'scenario') scenario = raw
      else if (role === 'reason') reason = raw || undefined
      else if (role === 'outcome') {
        if (!raw) return
        outcome = toOutcome(raw)
        if (!outcome) issues.push({ line, level: 'warning', message: `Result "${raw}" is not a recognised pass/fail value; treated as not reported.` })
      } else if (role === 'collision') { if (raw) metrics.collision = truthy(raw) }
      else if (role === 'param') {
        const key = norm(h), d = byKey.get(key)
        if (!d) return
        if (raw === '') { issues.push({ line, level: 'warning', message: `${d.label} is empty; the run counts as outside the ODD.` }); return }
        if (d.kind === 'range') {
          const x = parseNum(raw)
          if (!Number.isFinite(x)) { issues.push({ line, level: 'error', message: `${d.label} "${raw}" is not a number.` }); bad = true; return }
          if (x < (d.min ?? -Infinity) || x > (d.max ?? Infinity)) issues.push({ line, level: 'warning', message: `${d.label} ${x} is outside the ODD range ${d.min}–${d.max}.` })
          params[key] = x
        } else {
          if (!(d.categories ?? []).includes(raw)) issues.push({ line, level: 'warning', message: `${d.label} "${raw}" is not one of the ODD categories.` })
          params[key] = raw
        }
      } else {
        if (!raw) return
        const x = parseNum(raw)
        if (!Number.isFinite(x)) { issues.push({ line, level: 'warning', message: `${ROLE_LABEL[role]} "${raw}" is not a number; ignored.` }); return }
        metrics[role] = x
      }
    })
    if (bad) { skipped++; return }
    if (!id) id = `row-${line}`
    if (ids.has(id)) { issues.push({ line, level: 'warning', message: `Duplicate run id ${id}; kept the later row under ${id}-${line}.` }); id = `${id}-${line}` }
    ids.add(id)
    runs.push({ id, scenario: scenario || id, params, metrics, outcome, reason })
  })
  return { runs, issues, skipped, total: rows.length }
}

/** Flattens a JSON array of objects (or { runs: [...] }) into a header row plus string rows. */
export function jsonTable(text: string): { headers: string[]; rows: string[][]; lines: number[] } {
  const data = JSON.parse(text)
  const list: unknown[] = Array.isArray(data) ? data : Array.isArray(data?.runs) ? data.runs : Array.isArray(data?.scenarios) ? data.scenarios : []
  if (!list.length) throw new Error('Expected a JSON array of runs, or an object with a "runs" or "scenarios" array.')
  const flat = list.map(o => {
    const out: Record<string, string> = {}
    const walk = (v: unknown, pre: string) => {
      if (v && typeof v === 'object' && !Array.isArray(v)) for (const [k, x] of Object.entries(v)) walk(x, pre && !/^(params|parameters|metrics)$/.test(pre) ? `${pre}_${k}` : k)
      else out[pre] = v === null || v === undefined ? '' : String(v)
    }
    walk(o, '')
    return out
  })
  const headers = [...new Set(flat.flatMap(o => Object.keys(o)))]
  return { headers, rows: flat.map(o => headers.map(h => o[h] ?? '')), lines: flat.map((_, i) => i + 1) }
}

// ---------- OpenSCENARIO ----------

export interface Xosc { name: string; params: Record<string, string>; ranges: Record<string, [number, number]>; entities: { name: string; type: string; category?: string }[]; initSpeeds: Record<string, number> }

const attrs = (tag: string) => Object.fromEntries([...tag.matchAll(/([\w:]+)\s*=\s*"([^"]*)"/g)].map(m => [m[1], m[2]]))

/** Reads ParameterDeclarations (with 1.2 Range constraints), entities and Init absolute speeds from an .xosc file. */
export function parseXosc(text: string): Xosc {
  if (!/<OpenSCENARIO[\s>]/.test(text)) throw new Error('Not an OpenSCENARIO file (no <OpenSCENARIO> root).')
  const header = text.match(/<FileHeader\b[^>]*>/)
  const params: Record<string, string> = {}, ranges: Record<string, [number, number]> = {}
  const decl = text.match(/<ParameterDeclarations>([\s\S]*?)<\/ParameterDeclarations>/)
  if (decl) for (const m of decl[1].matchAll(/<ParameterDeclaration\b([^>]*?)(\/>|>([\s\S]*?)<\/ParameterDeclaration>)/g)) {
    const a = attrs(m[1])
    if (!a.name) continue
    params[a.name] = a.value ?? ''
    const r = m[3]?.match(/<Range\b[^>]*>/)
    if (r) { const ra = attrs(r[0]); const lo = Number(ra.lowerLimit), hi = Number(ra.upperLimit); if (Number.isFinite(lo) && Number.isFinite(hi)) ranges[a.name] = [lo, hi] }
  }
  const resolve = (v: string) => v.startsWith('$') ? params[v.slice(1)] ?? v : v
  const entities: Xosc['entities'] = []
  for (const m of text.matchAll(/<ScenarioObject\b([^>]*)>([\s\S]*?)<\/ScenarioObject>/g)) {
    const a = attrs(m[1])
    const kind = m[2].match(/<(Vehicle|Pedestrian|MiscObject|CatalogReference)\b([^>]*)>/)
    const ka = kind ? attrs(kind[2]) : {}
    entities.push({ name: a.name ?? '?', type: kind?.[1] ?? 'Unknown', category: ka.vehicleCategory ?? ka.pedestrianCategory ?? ka.miscObjectCategory ?? ka.entryName })
  }
  const initSpeeds: Record<string, number> = {}
  const init = text.match(/<Init>([\s\S]*?)<\/Init>/)
  if (init) for (const m of init[1].matchAll(/<Private\b([^>]*)>([\s\S]*?)<\/Private>/g)) {
    const who = attrs(m[1]).entityRef
    const sp = m[2].match(/<AbsoluteTargetSpeed\b[^>]*>/)
    if (who && sp) { const v = Number(resolve(attrs(sp[0]).value ?? '')); if (Number.isFinite(v)) initSpeeds[who] = v }
  }
  return { name: header ? attrs(header[0]).description || 'scenario' : 'scenario', params, ranges, entities, initSpeeds }
}

/** One .xosc becomes one planned run: its parameter values, plus init speeds as <entity>_init_speed in m/s. */
export function xoscToRun(x: Xosc, fileName: string): Run {
  const params: Params = {}
  for (const [k, v] of Object.entries(x.params)) { const n = Number(v); params[norm(k)] = v !== '' && Number.isFinite(n) ? n : v }
  for (const [e, v] of Object.entries(x.initSpeeds)) params[norm(e) + '_init_speed'] = v
  const id = fileName.replace(/\.xosc$/i, '')
  return { id, scenario: x.name || id, params, metrics: {} }
}

/** ODD suggestion from a set of .xosc files: declared Range constraints win, else the spread of values seen. */
export function xoscOdd(list: Xosc[], runs: Run[]): Odd {
  const keys = [...new Set(runs.flatMap(r => Object.keys(r.params)))]
  return keys.map((key): OddParam => {
    const vals = runs.map(r => r.params[key]).filter(v => v !== undefined)
    const declared = list.map(x => Object.entries(x.ranges).find(([k]) => norm(k) === key)?.[1]).find(Boolean)
    if (vals.every(v => typeof v === 'number')) {
      const xs = vals as number[]
      const [lo, hi] = declared ?? [niceFloor(Math.min(...xs)), niceCeil(Math.max(...xs))]
      return { key, label: pretty(key), kind: 'range', min: lo, max: hi === lo ? lo + 1 : hi, bins: 5 }
    }
    return { key, label: pretty(key), kind: 'category', categories: [...new Set(vals.map(String))] }
  })
}

// ---------- CARLA scenario_runner ----------

export interface CarlaResult { scenario: string; outcome: 'pass' | 'fail'; reason?: string; metrics: Metrics }

/**
 * scenario_runner `--json` output ({ scenario, success, criteria: [{ name, actual, expected, result }] }), a list of
 * those, or a leaderboard checkpoint ({ _checkpoint: { records: [{ route_id, status, infractions }] } }).
 */
export function parseCarla(text: string): CarlaResult[] {
  const data = JSON.parse(text)
  const recs = data?._checkpoint?.records
  if (Array.isArray(recs)) return recs.map((r: { route_id?: string; status?: string; infractions?: Record<string, unknown[]> }) => {
    const inf = Object.entries(r.infractions ?? {}).filter(([, v]) => Array.isArray(v) && v.length)
    const collision = inf.some(([k]) => /collision/i.test(k))
    const ok = /^(completed|perfect)$/i.test(r.status ?? '') && !inf.length
    return { scenario: String(r.route_id ?? 'route'), outcome: ok ? 'pass' : 'fail', reason: ok ? undefined : [r.status, ...inf.map(([k, v]) => `${k} ×${v.length}`)].filter(Boolean).join('; '), metrics: collision ? { collision } : {} }
  })
  const list: unknown[] = Array.isArray(data) ? data : [data]
  return list.map(raw => {
    const o = raw as { scenario?: string; name?: string; success?: boolean; status?: string; criteria?: { name?: string; actual?: unknown; result?: string; optional?: boolean }[] }
    const crit = Array.isArray(o.criteria) ? o.criteria : []
    const failed = crit.filter(c => !c.optional && /fail/i.test(String(c.result ?? '')))
    const collision = crit.some(c => /collision/i.test(c.name ?? '') && Number(c.actual) > 0)
    const success = typeof o.success === 'boolean' ? o.success : o.status ? /success|pass/i.test(o.status) : !failed.length
    const metrics: Metrics = {}
    if (crit.some(c => /collision/i.test(c.name ?? ''))) metrics.collision = collision
    return { scenario: String(o.scenario ?? o.name ?? 'scenario'), outcome: success && !failed.length ? 'pass' : 'fail', reason: failed.length ? failed.map(c => `${c.name}: ${c.actual}`).join('; ') : undefined, metrics }
  })
}

/** Attaches CARLA verdicts to runs by scenario name or run id. Unmatched results are returned separately. */
export function attachResults(runs: Run[], results: CarlaResult[]): { runs: Run[]; matched: number; unmatched: CarlaResult[] } {
  const out = runs.map(r => ({ ...r }))
  const unmatched: CarlaResult[] = []
  let matched = 0
  for (const res of results) {
    const r = out.find(x => x.id === res.scenario && !x.outcome) ?? out.find(x => x.scenario === res.scenario && !x.outcome) ?? out.find(x => x.id === res.scenario || x.scenario === res.scenario)
    if (!r) { unmatched.push(res); continue }
    r.outcome = res.outcome; r.reason = res.reason; r.metrics = { ...r.metrics, ...res.metrics }
    matched++
  }
  return { runs: out, matched, unmatched }
}

// ---------- Trajectories ----------

export interface TrajParsed { byRun: Map<string, TrajRow[]>; issues: Issue[]; degrees: boolean }

/** Trajectory CSV: time, actor id, x, y, heading, speed (+ optional run_id, length, width). Heading in degrees is detected. */
export function parseTrajectories(text: string, fallbackRun: string): TrajParsed {
  const { rows, lines } = parseCsv(text)
  if (rows.length < 2) throw new Error('The trajectory file has no data rows.')
  const h = rows[0].map(norm)
  const col = (al: string[]) => h.findIndex(x => al.includes(x))
  const c = { t: col(TRAJ.t), id: col(TRAJ.id), x: col(TRAJ.x), y: col(TRAJ.y), h: col(TRAJ.h), v: col(TRAJ.v), run: col(['run_id', 'run', 'scenario_id', 'case_id']), len: col(['length', 'len', 'length_m']), wid: col(['width', 'wid', 'width_m']) }
  const missing = (['t', 'id', 'x', 'y'] as const).filter(k => c[k] < 0)
  if (missing.length) throw new Error(`Missing column${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}. Expected time, actor id, x, y, heading, speed.`)
  const issues: Issue[] = []
  const parsed: { run: string; row: TrajRow }[] = []
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i], num = (k: number) => k < 0 ? NaN : parseNum(r[k] ?? '')
    const row: TrajRow = { t: num(c.t), id: (r[c.id] ?? '').trim(), x: num(c.x), y: num(c.y), h: c.h < 0 ? 0 : num(c.h), v: c.v < 0 ? NaN : num(c.v) }
    if (!row.id || ![row.t, row.x, row.y, row.h].every(Number.isFinite)) { issues.push({ line: lines[i], level: 'error', message: 'Row skipped: time, actor, x, y and heading must be present and numeric.' }); continue }
    const L = num(c.len), W = num(c.wid)
    if (Number.isFinite(L)) row.len = L
    if (Number.isFinite(W)) row.wid = W
    parsed.push({ run: c.run >= 0 ? (r[c.run] ?? '').trim() || fallbackRun : fallbackRun, row })
  }
  const degrees = parsed.some(p => Math.abs(p.row.h) > 2 * Math.PI + 0.01) || /deg/.test(h[c.h] ?? '')
  const byRun = new Map<string, TrajRow[]>()
  for (const { run, row } of parsed) {
    if (degrees) row.h = (row.h * Math.PI) / 180
    const l = byRun.get(run); if (l) l.push(row); else byRun.set(run, [row])
  }
  // Fill missing speeds from positions.
  for (const list of byRun.values()) {
    const actors = new Map<string, TrajRow[]>()
    list.forEach(r => { const a = actors.get(r.id); if (a) a.push(r); else actors.set(r.id, [r]) })
    for (const a of actors.values()) {
      a.sort((p, q) => p.t - q.t)
      a.forEach((r, i) => {
        if (Number.isFinite(r.v)) return
        const p = a[Math.max(0, i - 1)], q = a[Math.min(a.length - 1, i + 1)]
        r.v = q.t > p.t ? Math.hypot(q.x - p.x, q.y - p.y) / (q.t - p.t) : 0
      })
    }
  }
  if (c.v < 0) issues.push({ line: 1, level: 'warning', message: 'No speed column; speeds were derived from positions.' })
  return { byRun, issues, degrees }
}
