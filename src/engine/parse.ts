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

const isTrajHeader = (row: string[]) => { const h = row.map(norm); const has = (al: string[]) => h.some(x => al.includes(x)); return has(TRAJ.t) && has(TRAJ.x) && has(TRAJ.y) && has(TRAJ.id) }

export function detect(fileName: string, text: string): Format {
  const head = text.slice(0, 4000)
  if (/\.xosc$/i.test(fileName) || /<OpenSCENARIO[\s>]/.test(head)) return 'xosc'
  const t = head.trimStart()
  if (t.startsWith('{') || t.startsWith('[')) {
    if (/"criteria"\s*:|"_checkpoint"\s*:|"scenario_runner"|"success"\s*:\s*(true|false)/.test(text.slice(0, 20000))) return 'carla-json'
    return 'param-json'
  }
  if (/#1 World_Position_X/.test(head)) return 'trajectory-csv'
  const top = parseCsv(head.split(/\r?\n/).slice(0, 4).join('\n')).rows.slice(0, 3)
  if (top.some(isTrajHeader)) return 'trajectory-csv'
  return 'param-csv'
}

// ---------- Parameter tables ----------

const unclosed = (line: number) => new Error(`The quote opened on line ${line} is never closed. The file is damaged or cut off.`)

/** Why a file cannot be a text table, or null. */
export function notText(text: string): string | null {
  if (/^PK\x03\x04/.test(text)) return 'This is an Excel workbook or ZIP archive. Save the sheet as CSV first.'
  if (/^\uFFFD\uFFFD/.test(text) || /[\x00-\x08\x0e-\x1f]/.test(text)) return 'This is not a UTF-8 text file. Save it as CSV (UTF-8) first.'
  if (/^[\s\uFEFF]*<[!?a-z]/i.test(text)) return 'This is an HTML or XML document, not a table.'
  return null
}

/** Reads a CSV parameter table; throws when the file is not one or is damaged beyond a single row. */
export function csvTable(text: string): { headers: string[]; rows: string[][]; lines: number[] } {
  const why = notText(text)
  if (why) throw new Error(why)
  const { rows, lines, openQuote } = parseCsv(text)
  if (openQuote) throw unclosed(openQuote)
  return { headers: rows[0] ?? [], rows: rows.slice(1), lines: lines.slice(1) }
}

/** Cells cannot be told apart in a row with the wrong number of them. Blank cells past the last named column do not count. */
const cellsFit = (headers: string[], row: string[]) => {
  const n = headers.findLastIndex(h => h.trim()) + 1
  return row.length >= n && row.slice(n).every((c, i) => !c.trim() || n + i < headers.length)
}

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
/** Reads a collision cell: a word, or a count (pandas writes booleans next to blanks as 1.0 and 0.0). Undefined when it says neither. */
export function toCollision(raw: string): boolean | undefined {
  const s = raw.trim().toLowerCase()
  if (/^(true|t|yes|y|collision|collided|crash|crashed|hit)$/.test(s)) return true
  if (/^(false|f|no|n|none|no[ _-]collision)$/.test(s)) return false
  const n = parseNum(s)
  return n >= 0 ? n > 0 : undefined
}
const isBlank = (raw: string) => /^(null|nan|na|n\/a|-)?$/i.test(raw.trim())
/** Metrics with an upper limit. Loggers that write braking as negative acceleration or offsets left/right give them a sign. */
const SIZED = new Set<Role>(['maxDecel', 'maxJerk', 'laneDev'])

const niceFloor = (x: number) => { const m = 10 ** Math.floor(Math.log10(Math.abs(x) || 1)) / 2; return Math.floor(x / m) * m }
const niceCeil = (x: number) => { const m = 10 ** Math.floor(Math.log10(Math.abs(x) || 1)) / 2; return Math.ceil(x / m) * m }

/** Guesses an ODD from the parameter columns: mostly-numeric columns become ranges, the rest categories. */
export function inferOdd(headers: string[], rows: string[][], map: Mapping): Odd {
  const odd: Odd = []
  const fit = rows.filter(r => cellsFit(headers, r))
  headers.forEach((h, c) => {
    if (map[c] !== 'param' || odd.some(d => d.key === norm(h))) return
    const vals = fit.map(r => (r[c] ?? '').trim()).filter(v => v !== '')
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

export const pretty = (h: string) => { const s = h.replace(/\([^)]*\)/g, '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim(); return s.charAt(0).toUpperCase() + s.slice(1) }

export interface Validated { runs: Run[]; issues: Issue[]; skipped: number; total: number }

/** Turns mapped table rows into runs, reporting problems with their source line numbers. */
export function validateTable(headers: string[], rows: string[][], lines: number[], map: Mapping, odd: Odd): Validated {
  const issues: Issue[] = []
  const runs: Run[] = []
  const ids = new Set<string>()
  const signed = new Set<number>()
  const byKey = new Map(odd.map(d => [d.key, d]))
  let skipped = 0
  if (!map.includes('param')) issues.push({ line: 1, level: 'error', message: 'No column is mapped to an ODD parameter, so there is nothing to measure coverage on.' })
  const taken = new Map<string, string>()
  headers.forEach((h, c) => {
    if (map[c] !== 'param') return
    const first = taken.get(norm(h))
    if (first === undefined) taken.set(norm(h), h)
    else issues.push({ line: 1, level: 'error', message: `Columns "${first}" and "${h}" are the same parameter (${norm(h)}). Set one of them to Ignore.` })
  })
  rows.forEach((row, ri) => {
    const line = lines[ri]
    if (row.every(c => !c.trim())) return
    if (!cellsFit(headers, row)) { skipped++; issues.push({ line, level: 'error', message: `Row skipped: it has ${row.length} cells, the header has ${headers.length}. A value with the column separator in it must be quoted.` }); return }
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
      } else if (role === 'collision') {
        if (isBlank(raw)) return
        const hit = toCollision(raw)
        if (hit === undefined) issues.push({ line, level: 'warning', message: `Collision "${raw}" is not a yes/no value or a count; treated as not reported.` })
        else metrics.collision = hit
      }
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
        if (x < 0 && SIZED.has(role) && !signed.has(c)) { signed.add(c); issues.push({ line, level: 'warning', message: `${h} has negative values; they are judged by size (${raw} as ${-x}).` }) }
        metrics[role] = SIZED.has(role) ? Math.abs(x) : x
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

/** A ParameterValueDistribution file: the concrete parameter sets it enumerates for another scenario file. */
export interface XoscDist { scenarioFile: string; sets: Record<string, string>[]; stochastic: string[]; testRuns?: number; truncated?: boolean }
export interface Xosc {
  name: string
  /** Declared parameters by their original name, with $references and ${expressions} resolved. */
  params: Record<string, string>
  ranges: Record<string, [number, number]>
  entities: { name: string; type: string; category?: string }[]
  initSpeeds: Record<string, number>
  /** Init environment (time of day, weather, friction) and the road network name. */
  env: Params
  dist?: XoscDist
}

const XML_ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
const attrs = (tag: string): Record<string, string> => Object.fromEntries([...tag.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map(m => [m[1], (m[2] ?? m[3]).replace(/&(amp|lt|gt|quot|apos);/g, (_, e) => XML_ENT[e])]))
const round6 = (n: number) => Math.round(n * 1e6) / 1e6
const MAX_SETS = 2000

const FN: Record<string, (...a: number[]) => number> = { round: Math.round, floor: Math.floor, ceil: Math.ceil, sqrt: Math.sqrt, abs: Math.abs, pow: Math.pow, sin: Math.sin, cos: Math.cos, tan: Math.tan, min: Math.min, max: Math.max, sign: Math.sign }

/** Evaluates the arithmetic inside an OpenSCENARIO 1.1+ `${...}` expression. NaN when it is not purely numeric. */
export function evalExpr(src: string, get: (name: string) => number): number {
  const tok = src.match(/\$?[A-Za-z_]\w*|\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+|[-+*/%(),]/g) ?? []
  if (tok.join('') !== src.replace(/\s+/g, '')) return NaN
  let i = 0
  const primary = (): number => {
    const t = tok[i++]
    if (t === undefined) return NaN
    if (t === '(') { const v = sum(); return tok[i++] === ')' ? v : NaN }
    if (t === '-') return -primary()
    if (t === '+') return primary()
    if (t[0] === '$') return get(t.slice(1))
    if (/^[A-Za-z_]/.test(t)) {
      const f = FN[t]
      if (!f || tok[i++] !== '(') return NaN
      const args: number[] = []
      if (tok[i] === ')') i++
      else do args.push(sum()); while (tok[i++] === ',')
      return f(...args)
    }
    return Number(t)
  }
  const product = (): number => {
    let v = primary()
    while (tok[i] === '*' || tok[i] === '/' || tok[i] === '%') { const op = tok[i++], r = primary(); v = op === '*' ? v * r : op === '/' ? v / r : v % r }
    return v
  }
  const sum = (): number => {
    let v = product()
    while (tok[i] === '+' || tok[i] === '-') { const op = tok[i++], r = product(); v = op === '+' ? v + r : v - r }
    return v
  }
  const v = sum()
  return i === tok.length ? v : NaN
}

function parseDist(text: string, ranges: Record<string, [number, number]>): XoscDist | undefined {
  const body = text.match(/<ParameterValueDistribution>([\s\S]*?)<\/ParameterValueDistribution>/)?.[1]
  if (body === undefined) return undefined
  const axes: Record<string, string>[][] = []
  const det = body.match(/<Deterministic>([\s\S]*?)<\/Deterministic>/)?.[1] ?? ''
  for (const m of det.matchAll(/<DeterministicMultiParameterDistribution>([\s\S]*?)<\/DeterministicMultiParameterDistribution>|<DeterministicSingleParameterDistribution\b([^>]*)>([\s\S]*?)<\/DeterministicSingleParameterDistribution>/g)) {
    if (m[1] !== undefined) {
      const sets = [...m[1].matchAll(/<ParameterValueSet>([\s\S]*?)<\/ParameterValueSet>/g)].map(s => Object.fromEntries([...s[1].matchAll(/<ParameterAssignment\b[^>]*>/g)].map(a => { const t = attrs(a[0]); return [t.parameterRef ?? '', t.value ?? ''] }).filter(([k]) => k)))
      if (sets.length) axes.push(sets)
      continue
    }
    const name = attrs(m[2]).parameterName
    const vals = [...m[3].matchAll(/<Element\b[^>]*>/g)].map(e => attrs(e[0]).value ?? '')
    const dr = m[3].match(/<DistributionRange\b([^>]*)>([\s\S]*?)<\/DistributionRange>/)
    if (dr) {
      const step = Number(attrs(dr[1]).stepWidth), r = attrs(dr[2].match(/<Range\b[^>]*>/)?.[0] ?? ''), lo = Number(r.lowerLimit), hi = Number(r.upperLimit)
      if (step > 0 && Number.isFinite(lo) && Number.isFinite(hi)) for (let k = 0; lo + k * step <= hi + 1e-9 && k < MAX_SETS; k++) vals.push(String(round6(lo + k * step)))
    }
    if (name && vals.length) axes.push(vals.map(v => ({ [name]: v })))
  }
  // Deterministic distributions combine as a cartesian product, the first one varying slowest.
  let sets: Record<string, string>[] = axes.length ? [{}] : []
  let truncated = false
  for (const axis of axes) {
    const next: Record<string, string>[] = []
    for (const s of sets) for (const a of axis) { if (next.length >= MAX_SETS) { truncated = true; break } next.push({ ...s, ...a }) }
    sets = next
  }
  const stochastic: string[] = []
  for (const m of body.matchAll(/<StochasticDistribution\b([^>]*)>([\s\S]*?)<\/StochasticDistribution>/g)) {
    const name = attrs(m[1]).parameterName
    if (!name) continue
    stochastic.push(name)
    const lim = [...m[2].matchAll(/<Range\b[^>]*>/g)].flatMap(r => { const a = attrs(r[0]); return [Number(a.lowerLimit), Number(a.upperLimit)] })
    const pts = (lim.length ? lim : [...m[2].matchAll(/<Element\b[^>]*>/g)].map(e => Number(attrs(e[0]).value))).filter(Number.isFinite)
    if (pts.length > 1 && Math.min(...pts) < Math.max(...pts)) ranges[name] = [Math.min(...pts), Math.max(...pts)]
  }
  const n = Number(attrs(body.match(/<Stochastic\b[^>]*>/)?.[0] ?? '').numberOfTestRuns)
  return { scenarioFile: attrs(body.match(/<ScenarioFile\b[^>]*>/)?.[0] ?? '').filepath ?? '', sets, stochastic, testRuns: Number.isFinite(n) && n > 0 ? n : undefined, truncated: truncated || undefined }
}

/**
 * Reads an .xosc file: top-level ParameterDeclarations (with value constraints), entities, Init absolute speeds, the
 * Init environment and the road network. `overrides` replaces declared parameter values before anything is resolved,
 * which is how a parameter value distribution is applied to its scenario.
 */
export function parseXosc(raw: string, overrides: Record<string, string> = {}): Xosc {
  const text = raw.replace(/<!--[\s\S]*?-->/g, '')
  if (!/<OpenSCENARIO[\s>]/.test(text)) throw new Error('Not an OpenSCENARIO file (no <OpenSCENARIO> root).')
  const header = text.match(/<FileHeader\b[^>]*>/)
  const params: Record<string, string> = {}, ranges: Record<string, [number, number]> = {}
  const resolve = (v: string): string => {
    const t = v.trim()
    if (/^\$[A-Za-z_]\w*$/.test(t)) return params[t.slice(1)] ?? v
    const m = t.match(/^\$\{([\s\S]*)\}$/)
    if (!m) return v
    const n = evalExpr(m[1], k => params[k] === undefined || params[k] === '' ? NaN : Number(params[k]))
    return Number.isFinite(n) ? String(round6(n)) : v
  }
  // Only the scenario's own declarations: vehicles and catalogs further down declare parameters of their own.
  const cut = text.search(/<(Entities|Storyboard|Catalog)[\s>]/)
  const decl = (cut < 0 ? text : text.slice(0, cut)).match(/<ParameterDeclarations>([\s\S]*?)<\/ParameterDeclarations>/)
  if (decl) for (const m of decl[1].matchAll(/<ParameterDeclaration\b([^>]*?)(\/>|>([\s\S]*?)<\/ParameterDeclaration>)/g)) {
    const a = attrs(m[1])
    if (!a.name) continue
    params[a.name] = resolve(overrides[a.name] ?? a.value ?? '')
    const r = m[3]?.match(/<Range\b[^>]*>/)
    if (r) { const ra = attrs(r[0]); const lo = Number(ra.lowerLimit), hi = Number(ra.upperLimit); if (Number.isFinite(lo) && Number.isFinite(hi)) ranges[a.name] = [lo, hi] }
    else if (m[3]) {
      // OpenSCENARIO 1.1+ ValueConstraint rules; the ODD bound is the envelope of all groups.
      const lows: number[] = [], highs: number[] = []
      for (const c of m[3].matchAll(/<ValueConstraint\b[^>]*>/g)) {
        const ca = attrs(c[0]), v = Number(ca.value)
        if (!Number.isFinite(v)) continue
        if (/^greater/.test(ca.rule ?? '')) lows.push(v); else if (/^less/.test(ca.rule ?? '')) highs.push(v)
      }
      if (lows.length && highs.length && Math.min(...lows) < Math.max(...highs)) ranges[a.name] = [Math.min(...lows), Math.max(...highs)]
    }
  }
  for (const [k, v] of Object.entries(overrides)) if (!(k in params)) params[k] = resolve(v)
  const entities: Xosc['entities'] = []
  for (const m of text.matchAll(/<ScenarioObject\b([^>]*)>([\s\S]*?)<\/ScenarioObject>/g)) {
    const a = attrs(m[1])
    const kind = m[2].match(/<(Vehicle|Pedestrian|MiscObject|CatalogReference)\b([^>]*)>/)
    const ka = kind ? attrs(kind[2]) : {}
    const category = ka.vehicleCategory ?? ka.pedestrianCategory ?? ka.miscObjectCategory ?? ka.entryName
    entities.push({ name: a.name ?? '?', type: kind?.[1] ?? 'Unknown', category: category === undefined ? undefined : resolve(category) })
  }
  const initSpeeds: Record<string, number> = {}
  const env: Params = {}
  const init = text.match(/<Init>([\s\S]*?)<\/Init>/)
  if (init) {
    for (const m of init[1].matchAll(/<Private\b([^>]*)>([\s\S]*?)<\/Private>/g)) {
      const who = attrs(m[1]).entityRef
      const sp = m[2].match(/<AbsoluteTargetSpeed\b[^>]*>/)
      if (who && sp) { const v = Number(resolve(attrs(sp[0]).value ?? '')); if (Number.isFinite(v)) initSpeeds[who] = v }
    }
    const e = init[1].match(/<Environment\b[^>]*>([\s\S]*?)<\/Environment>/)
    if (e) {
      const tag = (n: string) => attrs(e[1].match(new RegExp(`<${n}\\b[^>]*>`))?.[0] ?? '')
      const num = (k: string, v?: string) => { if (v === undefined) return; const n = Number(resolve(v)); if (Number.isFinite(n)) env[k] = n }
      const cat = (k: string, v?: string) => { if (v) env[k] = resolve(v) }
      const tod = resolve(tag('TimeOfDay').dateTime ?? '').match(/T(\d\d):(\d\d)/)
      if (tod) env.time_of_day = round6(Number(tod[1]) + Number(tod[2]) / 60)
      const w = tag('Weather'), p = tag('Precipitation')
      cat('cloud_state', w.cloudState ?? w.fractionalCloudCover)
      cat('precipitation', p.precipitationType)
      num('precipitation_intensity', p.precipitationIntensity ?? p.intensity)
      num('fog_visual_range', tag('Fog').visualRange)
      num('road_friction', tag('RoadCondition').frictionScaleFactor)
    }
  }
  const road = attrs(text.match(/<LogicFile\b[^>]*>/)?.[0] ?? '').filepath
  if (road) env.road_network = resolve(road).split(/[\\/]/).pop()!.replace(/\.xodr$/i, '')
  return { name: header ? attrs(header[0]).description || 'scenario' : 'scenario', params, ranges, entities, initSpeeds, env, dist: parseDist(text, ranges) }
}

/** One .xosc becomes one planned run: environment, parameter values, and init speeds as <entity>_init_speed in m/s. */
export function xoscToRun(x: Xosc, fileName: string): Run {
  const params: Params = { ...x.env }
  for (const [k, v] of Object.entries(x.params)) { const n = Number(v); params[norm(k)] = v !== '' && Number.isFinite(n) ? n : v }
  for (const [e, v] of Object.entries(x.initSpeeds)) params[norm(e) + '_init_speed'] = v
  const id = fileName.replace(/\.xosc$/i, '')
  return { id, scenario: x.name || id, params, metrics: {} }
}

export interface XoscBatch { parsed: { name: string; x: Xosc }[]; runs: Run[]; notes: string[]; errors: string[] }

/**
 * Turns a batch of .xosc files into planned runs. A scenario file is one run; a parameter value distribution file
 * becomes one run per enumerated parameter set, applied to its scenario when that file is in the same batch.
 */
export function xoscRuns(files: { name: string; text: string }[]): XoscBatch {
  const out: XoscBatch = { parsed: [], runs: [], notes: [], errors: [] }
  for (const f of files) { try { out.parsed.push({ name: f.name, x: parseXosc(f.text) }) } catch (e) { out.errors.push(`${f.name}: ${(e as Error).message}`) } }
  const base = (p: string) => p.split(/[\\/]/).pop()!.toLowerCase()
  const expanded = new Set<string>()
  const variations: Run[] = []
  for (const { name, x } of out.parsed) {
    const d = x.dist
    if (!d) continue
    const stem = name.replace(/\.xosc$/i, '')
    const src = files.find(f => f.name !== name && base(f.name) === base(d.scenarioFile))
    const width = String(d.sets.length).length
    d.sets.forEach((set, i) => {
      const id = `${stem}-${String(i + 1).padStart(width, '0')}`
      if (src) { const r = xoscToRun(parseXosc(src.text, set), id); variations.push({ ...r, id }) }
      else variations.push({ ...xoscToRun({ name: d.scenarioFile.replace(/\.xosc$/i, '') || stem, params: set, ranges: {}, entities: [], initSpeeds: {}, env: {} }, id), id })
    })
    if (src && d.sets.length) expanded.add(src.name)
    if (d.sets.length && !src) out.notes.push(`${name} varies ${d.scenarioFile || 'a scenario file'}, which is not in this import, so only the varied parameters are known. Drop both files together to keep the scenario's other parameters, speeds and environment.`)
    if (d.truncated) out.notes.push(`${name} enumerates more than ${MAX_SETS} combinations; only the first ${MAX_SETS} were read.`)
    if (d.stochastic.length) out.notes.push(`${name} samples ${d.stochastic.join(', ')} stochastically${d.testRuns ? ` (${d.testRuns} test runs)` : ''}. The simulator draws those values, so no runs are created for them; their ranges are used as ODD bounds.`)
    else if (!d.sets.length) out.notes.push(`${name} contains no parameter sets.`)
  }
  for (const { name, x } of out.parsed) if (!x.dist && !expanded.has(name)) out.runs.push(xoscToRun(x, name))
  out.runs.push(...variations)
  return out
}

const ENV_UNIT: Record<string, string> = { time_of_day: 'h', fog_visual_range: 'm' }

/** ODD suggestion from a set of .xosc files: declared constraints win, else the spread of values seen. */
export function xoscOdd(list: Xosc[], runs: Run[]): Odd {
  const keys = [...new Set(runs.flatMap(r => Object.keys(r.params)))]
  const declared = new Map<string, string>()
  for (const x of list) for (const k of [...Object.keys(x.params), ...Object.keys(x.ranges), ...(x.dist?.sets.flatMap(s => Object.keys(s)) ?? [])]) if (!declared.has(norm(k))) declared.set(norm(k), k)
  for (const k of declared.keys()) if (!keys.includes(k) && list.some(x => Object.keys(x.ranges).some(r => norm(r) === k))) keys.push(k)
  // Environment and speed values that never vary across the batch say nothing about coverage; the runs keep them,
  // and the dimension can be added on the ODD editor once another campaign varies it.
  const constant = (key: string) => runs.length > 1 && !declared.has(key) && new Set(runs.map(r => String(r.params[key]))).size === 1
  return keys.filter(key => !constant(key)).map((key): OddParam => {
    const vals = runs.map(r => r.params[key]).filter(v => v !== undefined)
    const range = list.map(x => Object.entries(x.ranges).find(([k]) => norm(k) === key)?.[1]).find(Boolean)
    const ref = declared.get(key)
    const label = pretty(ref ?? key)
    if (vals.every(v => typeof v === 'number')) {
      const xs = vals as number[]
      const [lo, hi] = range ?? [niceFloor(Math.min(...xs)), niceCeil(Math.max(...xs))]
      return { key, label, kind: 'range', min: lo, max: hi === lo ? lo + 1 : hi, bins: 5, unit: ENV_UNIT[key] ?? (/_init_speed$/.test(key) ? 'm/s' : undefined), ref }
    }
    return { key, label, kind: 'category', categories: [...new Set(vals.map(String))], ref }
  })
}

// ---------- CARLA scenario_runner ----------

/** No outcome means the record states no verdict, so the run stays "not run yet". */
export interface CarlaResult { scenario: string; outcome?: 'pass' | 'fail'; reason?: string; metrics: Metrics }

/**
 * scenario_runner `--json` output ({ scenario, success, criteria: [{ name, actual, expected, result }] }), a list of
 * those, or a leaderboard checkpoint ({ _checkpoint: { records: [{ route_id, status, infractions }] } }).
 */
export function parseCarla(text: string): CarlaResult[] {
  const data = JSON.parse(text)
  const recs = data?._checkpoint?.records
  const list: unknown[] = Array.isArray(recs) ? recs : Array.isArray(data) ? data : [data]
  if (!list.length) throw new Error('The results file contains no records.')
  if (!list.every(r => r !== null && typeof r === 'object' && !Array.isArray(r))) throw new Error('Every result must be a JSON object.')
  if (Array.isArray(recs)) return recs.map((r: { route_id?: string; status?: string; infractions?: Record<string, unknown[]> }) => {
    const inf = Object.entries(r.infractions ?? {}).filter(([, v]) => Array.isArray(v) && v.length)
    const collision = inf.some(([k]) => /collision/i.test(k))
    const ok = /^(completed|perfect)$/i.test(r.status ?? '') && !inf.length
    return { scenario: String(r.route_id ?? 'route'), outcome: ok ? 'pass' : 'fail', reason: ok ? undefined : [r.status, ...inf.map(([k, v]) => `${k} ×${v.length}`)].filter(Boolean).join('; '), metrics: collision ? { collision } : {} }
  })
  return list.map(raw => {
    const o = raw as { scenario?: string; name?: string; success?: boolean; status?: string; criteria?: Criterion[] }
    const crit = Array.isArray(o.criteria) ? o.criteria : []
    // scenario_runner writes a boolean `success` per criterion; older exports and the console table use a status word.
    const verdict = (c: Criterion) => typeof c.success === 'boolean' ? c.success : statusWord(c.result ?? c.test_status)
    const isCollision = (c: Criterion) => /collision/i.test(c.name ?? '') && Number(c.actual) > 0
    const required = crit.filter(c => !c.optional)
    const failed = required.filter(c => verdict(c) === false || (verdict(c) === undefined && isCollision(c)))
    const collision = crit.some(isCollision)
    const success = typeof o.success === 'boolean' ? o.success : statusWord(o.status) ?? (required.length > 0 && required.every(c => verdict(c) === true) ? true : undefined)
    const metrics: Metrics = {}
    if (crit.some(c => /collision/i.test(c.name ?? ''))) metrics.collision = collision
    const why = (c: Criterion) => `${c.name}: ${typeof c.actual === 'number' ? round6(c.actual) : c.actual}${c.expected === undefined || c.expected === null ? '' : ` (expected ${c.expected})`}`
    const outcome = failed.length || success === false ? 'fail' : success ? 'pass' : undefined
    return { scenario: String(o.scenario ?? o.name ?? 'scenario'), outcome, reason: failed.length ? failed.map(why).join('; ') : outcome === 'fail' ? 'Reported as failed by scenario_runner' : undefined, metrics: outcome || collision ? metrics : {} }
  })
}

interface Criterion { name?: string; actual?: unknown; expected?: unknown; success?: boolean; result?: string; test_status?: string; optional?: boolean }

/** "SUCCESS", "ACCEPTABLE" (within scenario_runner's acceptable value) or "FAILURE" in their usual spellings; undefined for anything else ("RUNNING", "UNKNOWN", nothing). */
function statusWord(raw: unknown): boolean | undefined {
  const s = String(raw ?? '').trim()
  if (/^(success|successful|succeeded|acceptable|pass|passed|ok)$/i.test(s)) return true
  return /fail|unsuccess|not[ _-]*(success|pass)|error|timeout|collision/i.test(s) ? false : undefined
}

/**
 * Attaches CARLA verdicts to runs by run id, else by a scenario name only one run has. Results that match no run, or
 * several, are returned separately. Repetitions of one run in the same batch fail if any of them failed.
 */
export function attachResults(runs: Run[], results: CarlaResult[]): { runs: Run[]; matched: number; unmatched: CarlaResult[] } {
  const out = runs.map(r => ({ ...r }))
  const unmatched: CarlaResult[] = []
  let matched = 0
  const byName = new Map<string, Run[]>()
  for (const r of out) { const l = byName.get(r.scenario); if (l) l.push(r); else byName.set(r.scenario, [r]) }
  const seen = new Set<Run>()
  for (const res of results) {
    const named = byName.get(res.scenario) ?? []
    const r = out.find(x => x.id === res.scenario) ?? (named.length === 1 ? named[0] : undefined)
    if (!r) { unmatched.push(res); continue }
    const again = seen.has(r), collision = again && r.metrics.collision || res.metrics.collision
    seen.add(r)
    r.metrics = { ...r.metrics, ...res.metrics, ...(collision === undefined ? {} : { collision }) }
    if (again && r.outcome === 'fail') { if (res.outcome === 'fail' && res.reason !== r.reason) r.reason = [r.reason, res.reason].filter(Boolean).join('; ') }
    else if (res.outcome) { r.outcome = res.outcome; r.reason = res.reason }
    matched++
  }
  return { runs: out, matched, unmatched }
}

// ---------- Trajectories ----------

export interface TrajParsed { byRun: Map<string, TrajRow[]>; issues: Issue[]; degrees: boolean }

/**
 * esmini --csv_logger writes one row per step with a block of columns per entity ("#2 World_Position_X [m]").
 * Positions are the entity reference point (rear axle); bb_x / bb_y give the bounding-box centre offset from it.
 */
function esminiWide(rows: string[][], lines: number[], fallbackRun: string, issues: Issue[]): { run: string; row: TrajRow }[] {
  const head = rows[0].map(c => c.trim())
  const tCol = head.findIndex(c => /^TimeStamp\b/i.test(c))
  const ents = new Map<string, Record<string, number>>()
  head.forEach((c, i) => { const m = c.match(/^#(\d+)\s+(\w+)/); if (m) { const e = ents.get(m[1]) ?? {}; e[m[2]] ??= i; ents.set(m[1], e) } })
  if (tCol < 0) throw new Error('The esmini log has no TimeStamp column.')
  const out: { run: string; row: TrajRow }[] = []
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i], t = parseNum(r[tCol] ?? '')
    for (const [n, c] of ents) {
      const num = (k: string) => c[k] === undefined ? NaN : parseNum(r[c[k]] ?? '')
      const x = num('World_Position_X'), y = num('World_Position_Y'), h = num('World_Heading_Angle')
      const id = (r[c.Entity_Name ?? c.Entitity_Name] ?? '').trim() || `entity_${n}`
      if (![t, x, y, h].every(Number.isFinite)) { if ((r[c.World_Position_X] ?? '').trim() !== '') issues.push({ line: lines[i], level: 'error', message: `Entity #${n} skipped: time, position and heading must be numeric.` }); continue }
      const bx = num('bb_x'), by = num('bb_y'), ox = Number.isFinite(bx) ? bx : 0, oy = Number.isFinite(by) ? by : 0
      const row: TrajRow = { t, id, x: x + ox * Math.cos(h) - oy * Math.sin(h), y: y + ox * Math.sin(h) + oy * Math.cos(h), h, v: num('Current_Speed') }
      const L = num('bb_length'), W = num('bb_width')
      if (L > 0) row.len = L
      if (W > 0) row.wid = W
      out.push({ run: fallbackRun, row })
    }
  }
  return out
}

/**
 * Trajectory CSV: time, actor id, x, y, heading, speed (+ optional run_id, length, width). Heading in degrees is
 * detected. Reads esmini dat2csv output (a version banner above the header, entity names in `name`) and esmini
 * --csv_logger files (one column block per entity) as they are written.
 */
export function parseTrajectories(text: string, fallbackRun: string): TrajParsed {
  const all = parseCsv(text)
  if (all.openQuote) throw unclosed(all.openQuote)
  const wide = all.rows.findIndex(r => r.some(c => /#1 World_Position_X/.test(c)))
  // Skip banner lines above the header (esmini dat2csv writes "Version: ..., OpenDRIVE: ..." first).
  const start = wide >= 0 ? wide : Math.max(0, all.rows.slice(0, 5).findIndex(isTrajHeader))
  const rows = all.rows.slice(start), lines = all.lines.slice(start)
  if (rows.length < 2) throw new Error('The trajectory file has no data rows.')
  const h = rows[0].map(norm)
  const col = (al: string[]) => h.findIndex(x => al.includes(x))
  // A name column identifies actors better than a numeric id ("Ego" rather than "0").
  const named = col(['name', 'entity_name', 'actor_name', 'role_name'])
  const c = { t: col(TRAJ.t), id: named >= 0 ? named : col(TRAJ.id), x: col(TRAJ.x), y: col(TRAJ.y), h: col(TRAJ.h), v: col(TRAJ.v), run: col(['run_id', 'run', 'scenario_id', 'case_id']), len: col(['length', 'len', 'length_m']), wid: col(['width', 'wid', 'width_m']) }
  const issues: Issue[] = []
  let parsed: { run: string; row: TrajRow }[] = []
  if (wide >= 0) parsed = esminiWide(rows, lines, fallbackRun, issues)
  else {
    const missing = (['t', 'id', 'x', 'y'] as const).filter(k => c[k] < 0)
    if (missing.length) throw new Error(`Missing column${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}. Expected time, actor id, x, y, heading, speed.`)
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i], num = (k: number) => k < 0 ? NaN : parseNum(r[k] ?? '')
      const row: TrajRow = { t: num(c.t), id: (r[c.id] ?? '').trim(), x: num(c.x), y: num(c.y), h: c.h < 0 ? 0 : num(c.h), v: c.v < 0 ? NaN : num(c.v) }
      if (!row.id || ![row.t, row.x, row.y, row.h].every(Number.isFinite)) { issues.push({ line: lines[i], level: 'error', message: 'Row skipped: time, actor, x, y and heading must be present and numeric.' }); continue }
      const L = num(c.len), W = num(c.wid)
      if (Number.isFinite(L)) row.len = L
      if (Number.isFinite(W)) row.wid = W
      parsed.push({ run: c.run >= 0 ? (r[c.run] ?? '').trim() || fallbackRun : fallbackRun, row })
    }
  }
  if (!parsed.length) throw new Error('No usable trajectory rows: every row was missing time, actor, position or heading.')
  const degrees = wide < 0 && (parsed.some(p => Math.abs(p.row.h) > 2 * Math.PI + 0.01) || /deg/.test(h[c.h] ?? ''))
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
  if (c.v < 0 && wide < 0) issues.push({ line: 1, level: 'warning', message: 'No speed column; speeds were derived from positions.' })
  return { byRun, issues, degrees }
}
