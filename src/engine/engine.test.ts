import assert from 'node:assert/strict'
import { test } from 'node:test'
import { clusterFailures, extractRules, kmeans, normalise, ruleMatches } from './cluster.ts'
import { binOf, coverage, findGaps, judge } from './coverage.ts'
import { box, computeMetrics, distToPolyline, overlaps, polyDist, postEncroachment, toTracks, ttcBoxes } from './metrics.ts'
import { attachResults, autoMap, detect, inferOdd, jsonTable, parseCarla, parseTrajectories, parseXosc, validateTable, xoscOdd, xoscToRun } from './parse.ts'
import { parseCsv } from './csv.ts'
import { recommend, recsToCsv, recsToXosc } from './recommend.ts'
import { DEFAULT_THRESHOLDS, simulate } from './sample.ts'
import type { Odd, Run, TrajRow } from './types.ts'

const ODD: Odd = [
  { key: 'weather', label: 'Weather', kind: 'category', categories: ['clear', 'rain'] },
  { key: 'speed', label: 'Speed', kind: 'range', unit: 'km/h', min: 60, max: 100, bins: 4 },
  { key: 'gap', label: 'Gap', kind: 'range', unit: 'm', min: 0, max: 40, bins: 2 },
]
const run = (id: string, weather: string, speed: number, gap: number, metrics: Run['metrics'] = {}): Run => ({ id, scenario: 's', params: { weather, speed, gap }, metrics })

// ---------- Coverage ----------

test('binOf: even bins, max lands in the last bin, out of range and unknown categories are -1', () => {
  const sp = ODD[1]
  assert.equal(binOf(sp, 60), 0)
  assert.equal(binOf(sp, 79.9), 1)
  assert.equal(binOf(sp, 80), 2)
  assert.equal(binOf(sp, 100), 3)
  assert.equal(binOf(sp, 101), -1)
  assert.equal(binOf(sp, 'fast'), -1)
  assert.equal(binOf(ODD[0], 'snow'), -1)
  assert.equal(binOf(ODD[0], 'rain'), 1)
})

test('coverage: 1-way and pairwise counts match a hand count', () => {
  const runs = [run('a', 'clear', 65, 10), run('b', 'rain', 95, 30), run('c', 'rain', 95, 35)]
  const c = coverage(ODD, runs)
  assert.equal(c.oneWay[1].covered, 2) // speed bins 0 and 3
  assert.equal(c.oneWayPct, (2 + 2 + 2) / (2 + 4 + 2))
  // Pairs: weather×speed 2/8, weather×gap 2/4, speed×gap 2/8
  assert.equal(c.totalCells, 8 + 4 + 8)
  assert.equal(c.coveredCells, 6)
  assert.equal(c.pairs[0].counts[1][3], 2)
})

test('coverage: runs outside the ODD are counted and excluded from cells', () => {
  const c = coverage(ODD, [run('a', 'snow', 65, 10), run('b', 'clear', 65, 10)])
  assert.equal(c.outside, 1)
  assert.equal(c.pairs[0].counts.flat().reduce((s, x) => s + x, 0), 1)
})

test('findGaps lists every uncovered pair cell, riskiest first', () => {
  const runs = [run('a', 'clear', 65, 10, { collision: true }), run('b', 'clear', 95, 30)]
  const verdicts = runs.map(r => judge(r, DEFAULT_THRESHOLDS))
  const cov = coverage(ODD, runs, verdicts)
  const gaps = findGaps(ODD, cov)
  assert.equal(gaps.length, cov.totalCells - cov.coveredCells)
  // speed bin 0 failed 100% so gaps touching it outrank gaps that touch only clean bins
  const top = gaps[0]
  assert.ok((top.a === 'speed' && top.ai === 0) || (top.b === 'speed' && top.bi === 0) || (top.a === 'gap' && top.ai === 0) || (top.b === 'gap' && top.bi === 0))
})

test('judge: thresholds, simulator verdicts and untested runs', () => {
  const th = DEFAULT_THRESHOLDS
  assert.equal(judge(run('a', 'clear', 70, 10, { ttc: 3, minDist: 5 }), th).status, 'pass')
  const f = judge(run('b', 'clear', 70, 10, { ttc: 0.8, maxDecel: 6 }), th)
  assert.equal(f.status, 'fail')
  assert.equal(f.reasons.length, 2)
  assert.equal(judge({ ...run('c', 'clear', 70, 10), outcome: 'fail', reason: 'CollisionTest' }, th).reasons[0], 'Simulator: CollisionTest')
  assert.equal(judge(run('d', 'clear', 70, 10), th).status, 'untested')
})

// ---------- Geometry and metrics ----------

test('SAT overlap handles rotated boxes', () => {
  const a = box(0, 0, 0, 4, 2)
  assert.ok(overlaps(a, box(3.9, 0, 0, 4, 2)))
  assert.ok(!overlaps(a, box(4.2, 0, 0, 4, 2)))
  // A 45° box whose corner pokes into the first one
  assert.ok(overlaps(a, box(2 + Math.SQRT2 - 0.1, 0, Math.PI / 4, 2, 2)))
  assert.ok(!overlaps(a, box(2 + Math.SQRT2 + 0.1, 0, Math.PI / 4, 2, 2)))
})

test('polyDist is the gap between box edges', () => {
  assert.ok(Math.abs(polyDist(box(0, 0, 0, 4, 2), box(10, 0, 0, 4, 2)) - 6) < 1e-9)
  assert.ok(Math.abs(polyDist(box(0, 0, 0, 4, 2), box(0, 5, 0, 4, 2)) - 3) < 1e-9)
  assert.equal(polyDist(box(0, 0, 0, 4, 2), box(1, 0, 0, 4, 2)), 0)
})

test('TTC of oriented boxes: rear-end closing at 10 m/s over a 20 m gap is 2 s', () => {
  const t = ttcBoxes({ x: 0, y: 0, h: 0, v: 30, len: 4, wid: 2 }, { x: 24, y: 0, h: 0, v: 20, len: 4, wid: 2 }, 10, 0.01)
  assert.ok(Math.abs(t - 2) < 0.02, `got ${t}`)
})

test('TTC is infinite when boxes pass side by side, finite when they cross', () => {
  assert.equal(ttcBoxes({ x: 0, y: 0, h: 0, v: 30, len: 4, wid: 2 }, { x: 20, y: 3.7, h: 0, v: 10, len: 4, wid: 2 }), Infinity)
  // Crossing traffic: target 30 m ahead moving across our path from the side, arrives at our lane in ~1 s
  const t = ttcBoxes({ x: 0, y: 0, h: 0, v: 20, len: 4, wid: 2 }, { x: 22, y: -12, h: Math.PI / 2, v: 10, len: 4, wid: 2 })
  assert.ok(t > 0.5 && t < 1.3, `got ${t}`)
})

test('lane offset is distance to the centreline polyline', () => {
  assert.equal(distToPolyline([5, 1], [[0, 0], [10, 0]]), 1)
  assert.ok(Math.abs(distToPolyline([12, 1], [[0, 0], [10, 0], [10, 10]]) - 2) < 1e-9)
})

const straight = (id: string, x0: number, y: number, v: number, n = 51, dt = 0.1, decel = 0, len = 4.8, wid = 1.9): TrajRow[] => {
  const out: TrajRow[] = []
  let x = x0, vv = v
  for (let i = 0; i < n; i++) { out.push({ t: Math.round(i * dt * 100) / 100, id, x, y, h: 0, v: vv, len, wid }); x += vv * dt; vv = Math.max(0, vv - decel * dt) }
  return out
}

test('computeMetrics: following at constant speed has no braking and a steady gap', () => {
  const m = computeMetrics([...straight('ego', 0, 0, 20), ...straight('lead', 30, 0, 20)]).metrics
  assert.equal(m.collision, false)
  assert.ok(Math.abs((m.minDist ?? 0) - 25.2) < 1e-6)
  assert.equal(m.maxDecel, 0)
  assert.equal(m.ttc, undefined) // never closing
})

test('computeMetrics: braking ego reports max deceleration and jerk', () => {
  const m = computeMetrics([...straight('ego', 0, 0, 25, 51, 0.1, 4), ...straight('other', 500, 0, 25)]).metrics
  assert.ok(Math.abs((m.maxDecel ?? 0) - 4) < 1e-6)
  assert.ok((m.maxJerk ?? 1) < 1e-6) // constant deceleration
})

test('computeMetrics: a rear-end collision is detected', () => {
  const m = computeMetrics([...straight('ego', 0, 0, 30), ...straight('lead', 20, 0, 10)]).metrics
  assert.equal(m.collision, true)
  assert.equal(m.ttc, 0)
})

test('PET: a car crossing the ego path 1.5 s after the ego passed', () => {
  const ego = toTracks(straight('ego', 0, 0, 20, 61)).ego
  // Crosser moves along +y through x = 40 (ego is there at t = 2 s); it arrives at y = 0 at t = 3.5 s.
  const rows: TrajRow[] = []
  for (let i = 0; i < 61; i++) { const t = i * 0.1; rows.push({ t, id: 'x', x: 40, y: -35 + 10 * t, h: Math.PI / 2, v: 10, len: 4, wid: 2 }) }
  const crosser = toTracks(rows).ego
  const pet = postEncroachment(ego, crosser)
  assert.ok(pet > 0.9 && pet < 1.6, `got ${pet}`)
})

test('the synthetic cut-in simulator produces measurable, physically sane runs', () => {
  const rows = simulate({ event: 'cut_in', weather: 'clear', lighting: 'day', road: 'straight', ego_speed: 80, gap: 40, rel_speed: 0 }, 3)
  const r = computeMetrics(rows)
  assert.equal(r.metrics.collision, false)
  assert.ok(r.series.t.length === 121)
  const bad = computeMetrics(simulate({ event: 'debris', weather: 'fog', lighting: 'night', road: 'straight', ego_speed: 100, gap: 10, rel_speed: 0 }, 3))
  assert.ok(bad.metrics.collision || (bad.metrics.ttc ?? 9) < 1.5)
})

// ---------- Clustering and rules ----------

test('normalise: ranges to 0..1, categories one-hot at distance 1', () => {
  const a = normalise(ODD, { weather: 'clear', speed: 60, gap: 40 })
  const b = normalise(ODD, { weather: 'rain', speed: 100, gap: 40 })
  assert.deepEqual(a.slice(2), [0, 1])
  assert.ok(Math.abs(Math.hypot(a[0] - b[0], a[1] - b[1]) - 1) < 1e-9)
})

test('k-means separates two obvious blobs and is deterministic', () => {
  const pts = [[0, 0], [0.05, 0.02], [0.02, 0.06], [1, 1], [0.97, 1.02], [1.03, 0.95]]
  const a = kmeans(pts, 2), b = kmeans(pts, 2)
  assert.deepEqual(a.assign, b.assign)
  assert.equal(new Set(a.assign.slice(0, 3)).size, 1)
  assert.notEqual(a.assign[0], a.assign[3])
})

const synthetic = () => {
  const runs: Run[] = []
  let k = 0
  for (const weather of ['clear', 'rain']) for (let s = 60; s <= 100; s += 2.5) for (let g = 2; g <= 40; g += 4) {
    const fail = weather === 'rain' && g < 14
    runs.push(run(`r${k++}`, weather, s, g, fail ? { collision: true } : { ttc: 4 }))
  }
  return runs
}

test('rule extraction recovers "fails when rain and gap < 14"', () => {
  const runs = synthetic()
  const fail = runs.map(r => judge(r, DEFAULT_THRESHOLDS).status === 'fail')
  const rules = extractRules(ODD, runs, fail)
  assert.ok(rules.length >= 1)
  const r = rules[0]
  assert.equal(r.rate, 1)
  assert.ok(/Weather is rain/.test(r.text) && /Gap < 1[2-4]/.test(r.text), r.text)
  assert.equal(runs.filter(x => ruleMatches(r, x)).length, r.n)
})

test('failure clusters describe what the failed runs share', () => {
  const runs = synthetic()
  const failed = runs.filter(r => r.metrics.collision)
  const cl = clusterFailures(ODD, failed, 1)
  assert.equal(cl[0].runs.length, failed.length)
  assert.ok(cl[0].summary.some(s => s.startsWith('Weather = rain')))
  assert.ok(cl[0].summary.some(s => s.startsWith('Gap')))
})

// ---------- Recommender ----------

test('recommender fills untested combinations first and never duplicates', () => {
  const runs = [run('a', 'clear', 65, 10), run('b', 'clear', 75, 30)]
  const recs = recommend(ODD, runs, [false, false], { n: 8 })
  assert.equal(recs.length, 8)
  assert.ok(recs[0].newCells > 0)
  const after = coverage(ODD, [...runs, ...recs.map(r => ({ ...r, scenario: 'x', metrics: {} }))])
  assert.ok(after.pairwisePct > coverage(ODD, runs).pairwisePct + 0.4)
  for (const r of recs) for (const d of ODD) assert.ok(binOf(d, r.params[d.key]) >= 0, `${d.key} out of ODD`)
})

test('recommender samples the boundary between failing and passing runs', () => {
  const runs = synthetic()
  const fail = runs.map(r => !!r.metrics.collision)
  const recs = recommend(ODD, runs, fail, { n: 10, boundaryShare: 0.5 })
  const b = recs.filter(r => r.kind === 'boundary')
  assert.ok(b.length >= 4)
  // Boundary points sit near the gap = 14 m edge, not deep in the safe region
  assert.ok(b.every(r => Number(r.params.gap) < 30), JSON.stringify(b.map(r => r.params.gap)))
})

test('exports: CSV header and an OpenSCENARIO ParameterValueDistribution per run', () => {
  const recs = recommend(ODD, [run('a', 'clear', 65, 10)], [false], { n: 3 })
  const csv = recsToCsv(ODD, recs)
  assert.ok(csv.startsWith('id,weather,speed,gap,kind,reason\n'))
  const x = recsToXosc(ODD, recs, 'cut_in.xosc', '2026-11-10T00:00:00')
  assert.equal((x.match(/<ParameterValueSet>/g) ?? []).length, 3)
  assert.ok(x.includes('<ScenarioFile filepath="cut_in.xosc"/>'))
  assert.equal(parseXosc(x).name, 'Recommended scenarios (3)')
})

// ---------- Import ----------

const XOSC = `<?xml version="1.0"?>
<OpenSCENARIO>
  <FileHeader revMajor="1" revMinor="2" date="2026-10-01T00:00:00" description="Cut-in left" author="qa"/>
  <ParameterDeclarations>
    <ParameterDeclaration name="EgoSpeed" parameterType="double" value="25">
      <ConstraintGroup><ValueConstraint rule="greaterOrEqual" value="0"/></ConstraintGroup>
      <Range lowerLimit="15" upperLimit="30"/>
    </ParameterDeclaration>
    <ParameterDeclaration name="Weather" parameterType="string" value="rain"/>
  </ParameterDeclarations>
  <Entities>
    <ScenarioObject name="Ego"><Vehicle name="truck" vehicleCategory="truck"></Vehicle></ScenarioObject>
    <ScenarioObject name="Npc"><Vehicle name="car" vehicleCategory="car"></Vehicle></ScenarioObject>
  </Entities>
  <Storyboard><Init><Actions>
    <Private entityRef="Ego"><PrivateAction><LongitudinalAction><SpeedAction><SpeedActionDynamics dynamicsShape="step" value="0" dynamicsDimension="time"/><SpeedActionTarget><AbsoluteTargetSpeed value="$EgoSpeed"/></SpeedActionTarget></SpeedAction></LongitudinalAction></PrivateAction></Private>
    <Private entityRef="Npc"><PrivateAction><LongitudinalAction><SpeedAction><SpeedActionTarget><AbsoluteTargetSpeed value="20"/></SpeedActionTarget></SpeedAction></LongitudinalAction></PrivateAction></Private>
  </Actions></Init></Storyboard>
</OpenSCENARIO>`

test('OpenSCENARIO: parameters, ranges, entities and $-resolved init speeds', () => {
  assert.equal(detect('cut_in.xosc', XOSC), 'xosc')
  const x = parseXosc(XOSC)
  assert.deepEqual(x.params, { EgoSpeed: '25', Weather: 'rain' })
  assert.deepEqual(x.ranges.EgoSpeed, [15, 30])
  assert.deepEqual(x.entities.map(e => e.category), ['truck', 'car'])
  assert.deepEqual(x.initSpeeds, { Ego: 25, Npc: 20 })
  const r = xoscToRun(x, 'cut_in.xosc')
  assert.equal(r.params.egospeed, 25)
  const odd = xoscOdd([x], [r])
  assert.deepEqual([odd[0].min, odd[0].max], [15, 30])
})

test('CARLA scenario_runner JSON: criteria become verdicts and attach by scenario name', () => {
  const j = JSON.stringify([
    { scenario: 'FollowLeadingVehicle_1', success: true, criteria: [{ name: 'CollisionTest', actual: '0', expected: '0', result: 'SUCCESS', optional: false }] },
    { scenario: 'CutIn_2', success: false, criteria: [{ name: 'CollisionTest', actual: '1', expected: '0', result: 'FAILURE', optional: false }, { name: 'DrivenDistanceTest', actual: '40', result: 'FAILURE', optional: true }] },
    { scenario: 'Unknown_9', success: true, criteria: [] },
  ])
  assert.equal(detect('results.json', j), 'carla-json')
  const res = parseCarla(j)
  assert.equal(res[1].outcome, 'fail')
  assert.equal(res[1].reason, 'CollisionTest: 1')
  assert.equal(res[1].metrics.collision, true)
  const base: Run[] = [{ id: 'r1', scenario: 'FollowLeadingVehicle_1', params: {}, metrics: {} }, { id: 'r2', scenario: 'CutIn_2', params: {}, metrics: {} }]
  const a = attachResults(base, res)
  assert.equal(a.matched, 2)
  assert.equal(a.unmatched[0].scenario, 'Unknown_9')
  assert.equal(a.runs[1].outcome, 'fail')
})

test('parameter CSV: auto-mapping, inferred ODD and line-numbered validation', () => {
  const text = 'run_id,weather,ego_speed_kmh,min_ttc,result\nr1,clear,80,2.5,pass\nr2,rain,fast,1.1,fail\nr3,fog,95,,maybe\nr1,clear,140,3,pass\n'
  assert.equal(detect('runs.csv', text), 'param-csv')
  const { rows, lines } = parseCsv(text)
  const map = autoMap(rows[0])
  assert.deepEqual(map, ['id', 'param', 'param', 'ttc', 'outcome'])
  const odd = inferOdd(rows[0], [rows[1], rows[3]], map)
  assert.equal(odd[0].kind, 'category')
  assert.equal(odd[1].kind, 'range')
  assert.equal(odd[1].unit, 'km/h')
  odd[1].max = 120
  const v = validateTable(rows[0], rows.slice(1), lines.slice(1), map, odd)
  assert.equal(v.skipped, 1)
  assert.deepEqual(v.issues.filter(i => i.level === 'error').map(i => i.line), [3])
  const warn = v.issues.filter(i => i.level === 'warning').map(i => i.line)
  assert.ok(warn.includes(4) && warn.includes(5))
  assert.equal(v.runs.length, 3)
  assert.equal(v.runs[2].id, 'r1-5')
  assert.equal(v.runs[0].metrics.ttc, 2.5)
})

test('JSON parameter tables flatten nested params and metrics', () => {
  const t = jsonTable(JSON.stringify({ runs: [{ id: 'a', params: { weather: 'rain', speed: 80 }, metrics: { min_ttc: 2 } }] }))
  assert.deepEqual(t.headers, ['id', 'weather', 'speed', 'min_ttc'])
  assert.deepEqual(autoMap(t.headers), ['id', 'param', 'param', 'ttc'])
})

test('trajectory CSV: multi-run files split by run id, degrees converted, speeds derived', () => {
  const text = 'run_id,time,actor_id,x,y,heading_deg\nA,0,ego,0,0,0\nA,1,ego,20,0,0\nA,0,npc,30,3.7,-90\nB,0,ego,0,0,0\nbad,,ego,1,1,0\n'
  assert.equal(detect('traj.csv', text), 'trajectory-csv')
  const t = parseTrajectories(text, 'fallback')
  assert.deepEqual([...t.byRun.keys()], ['A', 'B'])
  assert.equal(t.degrees, true)
  assert.ok(Math.abs(t.byRun.get('A')![2].h + Math.PI / 2) < 1e-9)
  assert.equal(t.byRun.get('A')![0].v, 20)
  assert.equal(t.issues.filter(i => i.level === 'error')[0].line, 6)
})
