import assert from 'node:assert/strict'
import { test } from 'node:test'
import { csvTable } from './parse.ts'
import { clusterFailures, extractRules, kmeans, normalise, ruleMatches } from './cluster.ts'
import { binOf, coverage, findGaps, judge, judgeAll } from './coverage.ts'
import { box, computeMetrics, distToPolyline, overlaps, polyDist, postEncroachment, toTracks, ttcBoxes } from './metrics.ts'
import { attachResults, autoMap, detect, inferOdd, jsonTable, parseCarla, pickFiles, parseTrajectories, parseXosc, validateTable, xoscOdd, xoscToRun } from './parse.ts'
import { formatList, parseCsv, parseList, toCsv } from './csv.ts'
import { freeTrajKey, trajTargets } from './parse.ts'
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

test('bins are whole numbers and one dimension has no pairs', () => {
  const dim = (bins?: number): Odd => [{ key: 'g', label: 'G', kind: 'range', min: 0, max: 10, bins }]
  assert.deepEqual([2.5, 1.2, 0, -3, 99, NaN, undefined, 4].map(b => coverage(dim(b), []).oneWay[0].total), [3, 1, 1, 1, 20, 5, 5, 4])
  const c = coverage(dim(5), [{ id: 'a', scenario: 'a', params: { g: 3 }, metrics: {} }])
  assert.deepEqual([c.pairs.length, c.totalCells, c.oneWayPct], [0, 0, 0.2])
  assert.deepEqual(findGaps(dim(5), c), [])
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

test('computeMetrics: lane offset is measured from a lane along the starting heading', () => {
  const drive = (deg: number, side = 0, drift = 0): TrajRow[] => [0, 1, 2].map(t => {
    const h = (deg * Math.PI) / 180, l = t ? side : 0
    return { t, id: 'ego', x: 20 * t * Math.cos(h) - l * Math.sin(h), y: 20 * t * Math.sin(h) + l * Math.cos(h), h: h + drift, v: 20 }
  })
  for (const deg of [0, 30, 45, 90, 135, 180, -90, 270, 360, 450]) {
    assert.equal(computeMetrics(drive(deg)).metrics.laneDev, 0, `${deg}`)
    assert.equal(computeMetrics(drive(deg, 1.2)).metrics.laneDev, 1.2, `${deg} offset`)
  }
  assert.equal(computeMetrics(drive(90)).laneDeparture, false)
  // A run along +x keeps its horizontal lane when the ego starts with a little steering.
  for (const drift of [0.03, -0.03]) assert.equal(computeMetrics(drive(0, 0.5, drift)).metrics.laneDev, 0.5)
  // A given centreline still wins.
  assert.equal(computeMetrics(drive(90), { centreline: [[-100, 0], [100, 0]] }).metrics.laneDev, 40)
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
  assert.equal(res[1].reason, 'CollisionTest: 1 (expected 0)')
  assert.equal(res[1].metrics.collision, true)
  const base: Run[] = [{ id: 'r1', scenario: 'FollowLeadingVehicle_1', params: {}, metrics: {} }, { id: 'r2', scenario: 'CutIn_2', params: {}, metrics: {} }]
  const a = attachResults(base, res)
  assert.equal(a.matched, 2)
  assert.equal(a.unmatched[0].scenario, 'Unknown_9')
  assert.equal(a.runs[1].outcome, 'fail')
})

test('CARLA: no verdict is not a pass, status words are whole, collisions without a result fail', () => {
  const one = (o: object) => parseCarla(JSON.stringify([{ scenario: 'a', ...o }]))[0].outcome
  assert.equal(one({ criteria: [] }), undefined)
  assert.equal(one({ status: 'UNKNOWN' }), undefined)
  assert.equal(one({ status: 'UNSUCCESSFUL' }), 'fail')
  assert.equal(one({ status: 'not passed' }), 'fail')
  assert.equal(one({ status: 'Success' }), 'pass')
  assert.equal(one({ success: true }), 'pass')
  assert.equal(one({ criteria: [{ name: 'X', actual: 1, result: 'ACCEPTABLE' }] }), 'pass')
  assert.equal(one({ criteria: [{ name: 'CollisionTest', actual: 1 }] }), 'fail')
  assert.equal(one({ criteria: [{ name: 'CollisionTest', actual: 0, result: 'RUNNING' }] }), undefined)
  assert.equal(one({ criteria: [{ name: 'CollisionTest', actual: 0, result: 'SUCCESS' }] }), 'pass')
  assert.equal(one({ success: true, criteria: [{ name: 'CollisionTest', actual: 1, success: false }] }), 'fail')
  for (const bad of ['[]', '{"_checkpoint":{"records":[]}}', '[null]', '[1]']) assert.throws(() => parseCarla(bad))
})

test('CARLA: repetitions fail if one failed, whatever the order; shared scenario names are not guessed', () => {
  const run = (id: string, scenario = id): Run => ({ id, scenario, params: {}, metrics: {} })
  const bad = { scenario: 'a', outcome: 'fail' as const, reason: 'hit', metrics: { collision: true } }, good = { scenario: 'a', outcome: 'pass' as const, metrics: { collision: false } }
  for (const list of [[bad, good], [good, bad]]) {
    const r = attachResults([run('a')], list).runs[0]
    assert.deepEqual([r.outcome, r.reason, r.metrics.collision], ['fail', 'hit', true])
  }
  // A new import is a re-run and replaces the earlier verdict.
  assert.equal(attachResults(attachResults([run('a')], [bad]).runs, [good]).runs[0].outcome, 'pass')
  const shared = attachResults([run('r1', 'a'), run('r2', 'a')], [bad])
  assert.deepEqual([shared.matched, shared.unmatched.length, shared.runs[0].outcome], [0, 1, undefined])
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

test('collision cells: counts, floats and words; anything else is unknown and reported', () => {
  const table = (cell: string) => validateTable(['run_id', 'weather', 'collision'], [['a', 'rain', cell]], [2], ['id', 'param', 'collision'], [{ key: 'weather', label: 'Weather', kind: 'category', categories: ['rain'] }])
  for (const c of ['1', '1.0', '2', 'TRUE', 'T', 'yes', 'crash', 'Collision']) assert.equal(table(c).runs[0].metrics.collision, true, c)
  for (const c of ['0', '0.0', 'False', 'f', 'no', 'none']) assert.equal(table(c).runs[0].metrics.collision, false, c)
  for (const c of ['unknown', '-1', 'maybe', '1?']) { const v = table(c); assert.equal('collision' in v.runs[0].metrics, false, c); assert.equal(v.issues.length, 1, c) }
  for (const c of ['', 'NaN', 'n/a']) { const v = table(c); assert.equal('collision' in v.runs[0].metrics, false, c); assert.equal(v.issues.length, 0, c) }
})

test('signed braking, jerk and lane offset are judged by size; TTC and gap keep their sign', () => {
  const v = validateTable(['w', 'd', 'j', 'l', 't', 'g'], [['a', '-7.2', '-13', '-1.4', '-1', '-0.2'], ['a', '-6', '1', '1', '2', '2']], [2, 3], ['param', 'maxDecel', 'maxJerk', 'laneDev', 'ttc', 'minDist'], [{ key: 'w', label: 'w', kind: 'category', categories: ['a'] }])
  assert.deepEqual(v.runs[0].metrics, { maxDecel: 7.2, maxJerk: 13, laneDev: 1.4, ttc: -1, minDist: -0.2 })
  assert.equal(v.issues.length, 3)
})

test('damaged and foreign files are refused', () => {
  assert.throws(() => csvTable('a,b\n1,"x\n2,y\n'), /line 2/)
  assert.throws(() => csvTable('a,b\n1,"x\ny"\n2,"z'), /line 4/)
  for (const bad of ['PK\x03\x04a,b\n1,2\n', '\uFFFD\uFFFDa\0,\0b\0\n\0', 'a,b\n1,\x02\n', '\uFEFF<html>\na,b\n', '<?xml version="1.0"?>\n<a/>\n']) assert.throws(() => csvTable(bad))
  // A quoted line break, a Latin-1 degree sign (decoded as U+FFFD) and an inch mark are all fine.
  assert.deepEqual(csvTable('\uFEFFa,b\r\n"1\n2",20\uFFFDC\r\n3,5"\r\n').rows, [['1\n2', '20\uFFFDC'], ['3', '5"']])
})

test('rows with the wrong number of cells are skipped; trailing blanks are not extra cells', () => {
  const run = (text: string) => { const t = csvTable(text), map = autoMap(t.headers), odd = inferOdd(t.headers, t.rows, map); return { odd, v: validateTable(t.headers, t.rows, t.lines, map, odd) } }
  const { odd, v } = run('run_id,weather,gap,result\na,rain,3,5,fail\nb,rain,900\nc,dry,5,fail\nd,dry,6,pass,,\ne,dry,7,\n')
  assert.deepEqual(v.runs.map(r => r.id), ['c', 'd', 'e'])
  assert.deepEqual([v.skipped, v.issues.map(i => [i.line, i.level])], [2, [[2, 'error'], [3, 'error']]])
  assert.equal(odd.find(d => d.key === 'gap')!.max, 7)
  assert.equal(run('run_id,weather,,\na,rain\nb,dry,,\n').v.runs.length, 2)
  assert.equal(run('run_id,weather,\na,rain,stray,more\nb,dry\n').v.runs.length, 1)
})

test('two columns with one key block the import until one is ignored', () => {
  const h = ['run_id', 'Ego Speed', 'ego_speed'], rows = [['a', '1', '5']]
  const odd = inferOdd(h, rows, autoMap(h))
  assert.deepEqual(odd.map(d => d.key), ['ego_speed'])
  assert.deepEqual(validateTable(h, rows, [2], autoMap(h), odd).issues.filter(i => i.level === 'error').map(i => [i.line, i.level]), [[1, 'error']])
  assert.equal(validateTable(h, rows, [2], ['id', 'param', 'ignore'], odd).issues.length, 0)
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

test('trajectories go to one campaign and never replace another campaign\'s trajectory', () => {
  const run = (id: string, extra: Partial<Run> = {}): Run => ({ id, scenario: id, params: {}, metrics: {}, ...extra })
  const one = { id: 'c1', label: 'One', date: '2026-01-01', runs: [run('a', { traj: true }), run('only1')] }
  const two = { id: 'c2', label: 'Two', date: '2026-02-01', runs: [run('a'), run('b')] }
  const t = trajTargets([one, two], ['a', 'b', 'only1', 'new'])
  assert.deepEqual([...t.target], [['a', 'c2'], ['b', 'c2'], ['only1', 'c1']])
  assert.deepEqual(t.shared, ['a'])
  assert.equal(trajTargets([one, two], ['a', 'b'], 'c1').target.get('a'), 'c1')
  assert.equal(freeTrajKey([one, two], 'c2', two.runs[0]), 'c2:a')
  assert.equal(freeTrajKey([one, two], 'c1', one.runs[0]), 'a')
  assert.equal(freeTrajKey([one, two], 'c2', two.runs[1]), 'b')
  // Projects saved before this fix: both runs point at one trajectory.
  const both = [{ ...one }, { ...two, runs: [run('a', { traj: true })] }]
  assert.equal(freeTrajKey(both, 'c2', both[1].runs[0]), 'c2:a')
})

test('planned runs are covered but not judged', () => {
  const odd: Odd = [{ key: 'g', label: 'Gap', kind: 'range', min: 0, max: 50, bins: 5 }, { key: 'w', label: 'W', kind: 'category', categories: ['a', 'b'] }]
  const mk = (id: string, g: number, ttc?: number): Run => ({ id, scenario: id, params: { g, w: 'a' }, metrics: ttc === undefined ? {} : { ttc } })
  const runs = [mk('f', 5, 1), mk('p', 8), mk('k', 45, 4)]
  const v = judgeAll(runs, DEFAULT_THRESHOLDS), cov = coverage(odd, runs, v)
  assert.deepEqual([cov.oneWay[0].hits, cov.oneWay[0].judged, cov.oneWay[0].fails], [[2, 0, 0, 0, 1], [1, 0, 0, 0, 1], [1, 0, 0, 0, 0]])
  assert.deepEqual([cov.pairs[0].counts[0][0], cov.pairs[0].judged[0][0], cov.pairs[0].fails[0][0]], [2, 1, 1])
  // g bin 1 fails 1 of 1, w=b was never run (0.5): priority 1.5.
  assert.equal(findGaps(odd, cov).find(g => g.ai === 0 && g.bi === 1)!.priority, 1.5)
  const failed = v.map(x => x.status === 'fail'), passed = v.map(x => x.status === 'pass')
  const probes = (p: boolean[]) => recommend(odd, runs, failed, { n: 4, boundaryShare: 1, passed: p }).filter(r => r.kind === 'boundary')
  assert.ok(probes(passed).length && probes(passed).every(r => /passing k/.test(r.reason)))
  assert.equal(probes([false, false, false]).length, 0)
})

test('trajectory CSV: without a heading column headings follow the motion and are reported', () => {
  // North at 10 m/s towards a stopped car; the boxes are 4.8 m long, so contact is 30.7 m away at first.
  const csv = (h: boolean) => `time,actor_id,x,y,${h ? 'heading,' : ''}speed,length,width\n` + [0, 1, 2].map(t => `${t},ego,0,${10 * t},${h ? `${Math.PI / 2},` : ''}10,4.8,1.9\n${t},car,0,35.5,${h ? `${Math.PI / 2},` : ''}0,4.8,1.9\n`).join('')
  const t = parseTrajectories(csv(false), 'r'), given = parseTrajectories(csv(true), 'r')
  assert.equal(t.derived, true)
  assert.deepEqual(computeMetrics(t.byRun.get('r')!).metrics, computeMetrics(given.byRun.get('r')!).metrics)
  assert.equal(computeMetrics(t.byRun.get('r')!).metrics.ttc, 1.08)
  assert.match(t.issues[0].message, /derived from positions/)
  assert.match(t.issues[1].message, /car never moved/)
  assert.deepEqual([given.derived, given.issues], [false, []])

  const head = (rows: [number, number, number?][]) => parseTrajectories('time,id,x,y,v\n' + rows.map(([x, y, v], i) => `${i},ego,${x},${y},${v ?? 5}\n`).join(''), 'r').byRun.get('r')!.map(r => Math.round((Math.atan2(Math.sin(r.h), Math.cos(r.h)) * 180) / Math.PI) + 0)
  assert.deepEqual(head([[0, 0], [0, 0.01], [0, 5], [0, 5.02], [0, 5]]), [90, 90, 90, 90, 90]) // noise while standing
  assert.deepEqual(head([[0, 0], [10, 0], [10, 10]]), [0, 45, 90])
  assert.deepEqual(head([[10, 0, -5], [5, 0, -5], [0, 0, -5]]), [0, 0, 0]) // reversing
  assert.deepEqual(head([[0, 0], [5, 0], [0, 0]]).map(Math.abs), [0, 180, 180]) // turned back
  assert.deepEqual(head([[0, 0]]), [0])
  assert.deepEqual(head([[-5, 0], [-10, 0]]).map(Math.abs), [180, 180])
})

test('trajectory CSV: a unit in the heading header wins over the size of the values', () => {
  const t = (h: string, v: number) => parseTrajectories(`time,id,x,y,${h}\n0,ego,0,0,${v}\n1,ego,1,0,${v}\n`, 'r')
  for (const h of ['heading_rad', 'yaw_rad', 'heading (rad)']) {
    const r = t(h, 7)
    assert.deepEqual([r.degrees, r.derived, r.byRun.get('r')![0].h], [false, false, 7], h)
    assert.match(r.issues[0].message, /beyond 2π/)
  }
  assert.equal(t('heading_deg', 1).degrees, true)
  assert.equal(t('yaw_deg', 90).degrees, true)
  assert.equal(t('heading', 7).degrees, true)
  assert.equal(t('heading', 3).degrees, false)
})

test('JSON: records with a verdict and parameters are a table, bare verdicts and criteria are CARLA results', () => {
  const d = (x: unknown) => detect('r.json', JSON.stringify(x))
  assert.equal(d([{ id: 'a', weather: 'rain', light: 'day', success: true }]), 'param-json')
  assert.equal(d({ runs: [{ id: 'a', params: { weather: 'rain' }, success: true }] }), 'param-json')
  assert.equal(d([{ id: 'a', weather: 'rain' }, { id: 'b', weather: 'dry', success: false }]), 'param-json')
  assert.equal(d([{ id: 'a', criteria: 'strict', weather: 'rain', success: true }]), 'param-json')
  assert.equal(d([...Array(2000)].map((_, i) => ({ id: `r${i}`, weather: 'rain', success: true }))), 'param-json')
  assert.equal(d({ scenario: 'a', success: true }), 'carla-json')
  assert.equal(d([{ scenario: 'a', success: true, duration_game: 12.1, timeout: 60 }]), 'carla-json')
  assert.equal(d([{ scenario: 'a', success: true, weather: 'rain', criteria: [] }]), 'carla-json')
  assert.equal(d([{ scenario: 'a', name: 'b', success: true, status: 'SUCCESS' }]), 'carla-json')
  assert.equal(d([{ scenario: 'a' }, { scenario: 'b', criteria: [{ name: 'CollisionTest', actual: 1 }] }]), 'carla-json')
  assert.equal(d({ _checkpoint: { records: [] } }), 'carla-json')
  for (const x of [null, [], [null], [1], {}, { runs: 3 }, 'x']) assert.doesNotThrow(() => d(x))
  assert.equal(detect('r.json', '[{"scenario":"a","success":true,"crit'), 'carla-json')
  // Both readings of a record the detector sends to the table keep its verdict.
  const t = jsonTable(JSON.stringify([{ id: 'a', weather: 'rain', light: 'day', success: true }, { id: 'b', weather: 'dry', light: 'day', success: false }]))
  const map = autoMap(t.headers)
  assert.deepEqual(validateTable(t.headers, t.rows, t.lines, map, inferOdd(t.headers, t.rows, map)).runs.map(r => [r.id, r.outcome, r.params.weather]), [['a', 'pass', 'rain'], ['b', 'fail', 'dry']])
})

test('a bad first row or record is skipped; only mapping errors stop the import', () => {
  const t = jsonTable(JSON.stringify([{ id: 'x', gap: 'fast' }, ...[...Array(12)].map((_, i) => ({ id: `r${i}`, gap: i }))]))
  const map = autoMap(t.headers), v = validateTable(t.headers, t.rows, t.lines, map, inferOdd(t.headers, t.rows, map))
  assert.deepEqual([v.runs.length, v.skipped, v.issues.map(i => [i.line, i.level, i.blocks])], [12, 1, [[1, 'error', undefined]]])
  assert.deepEqual(validateTable(['id', 'Gap', 'gap'], [['a', '1', '2']], [2], ['id', 'param', 'param'], []).issues.map(i => i.blocks), [true])
  assert.deepEqual(validateTable(['id'], [['a']], [2], ['id'], []).issues.map(i => i.blocks), [true])
})

test('category lists keep commas, quotes and spaces', () => {
  for (const l of [[], ['rain', 'dry'], ['rain, heavy', 'dry'], ['5" rim', 'a "b" c', '"', ',', ', ,'], [' lead', 'trail '], ['a\\b', "it's"]]) assert.deepEqual(parseList(formatList(l)), l)
  assert.equal(formatList(['rain', 'dry']), 'rain, dry')
  assert.equal(formatList(['rain, heavy', 'dry']), '"rain, heavy", dry')
  assert.deepEqual(parseList('rain,dry , ,fog,'), ['rain', 'dry', 'fog'])
  assert.deepEqual(parseList('"rain, heavy" , dry, "fog"'), ['rain, heavy', 'dry', 'fog'])
  // Text that is not properly quoted is split like before.
  assert.deepEqual(parseList('"rain, heavy'), ['"rain', 'heavy'])
  assert.deepEqual(parseList('5" rim, a "b" c'), ['5" rim', 'a "b" c'])
  assert.deepEqual(parseList('"a"b, c'), ['"a"b', 'c'])
  assert.deepEqual(parseList(''), [])
})

test('recommended values stay in the bin they were drawn for, whatever the range', () => {
  for (const [min, max, bins] of [[0, 0.01, 5], [0, 1e-5, 5], [-0.002, 0.003, 20], [0, 50, 20], [1000, 1000.5, 7], [0, 5, 3], [60, 105, 5], [-1e6, 1e6, 20], [0, 1e-9, 2]]) {
    const odd: Odd = [{ key: 'w', label: 'W', kind: 'category', categories: ['a', 'b'] }, { key: 'x', label: 'X', kind: 'range', min, max, bins }]
    const runs: Run[] = [{ id: 'r', scenario: 's', params: { w: 'a', x: min }, metrics: {} }]
    const recs = recommend(odd, runs, [false], { n: 2 * bins })
    const cov = coverage(odd, [...runs, ...recs.map(r => ({ ...runs[0], params: r.params }))])
    assert.equal(cov.pairwisePct, 1, `${min}..${max} in ${bins}`)
    // The CSV carries the same values.
    const csv = parseCsv(recsToCsv(odd, recs)).rows.slice(1)
    assert.deepEqual(csv.map(r => Number(r[2])), recs.map(r => r.params.x), `${min}..${max} in ${bins}`)
  }
  // Ranges whose bins were already wide enough keep their short values.
  const speed: Odd = [{ key: 'w', label: 'W', kind: 'category', categories: ['a'] }, { key: 'x', label: 'X', kind: 'range', min: 60, max: 105, bins: 5 }]
  for (const r of recommend(speed, [], [], { n: 5 })) assert.equal(Math.round(Number(r.params.x) * 10) / 10, r.params.x)
  // A range without a width does not produce NaN.
  for (const max of [5, 4]) for (const r of recommend([speed[0], { ...speed[1], min: 5, max }], [], [], { n: 3 })) assert.ok(Number.isFinite(r.params.x))
})

test('every file of a drop is imported or named as left out', () => {
  const table = (n: string) => ({ name: n, text: 'run_id,weather\na,rain\n' })
  const traj = (n: string) => ({ name: n, text: 'time,actor_id,x,y,heading\n0,ego,0,0,0\n' })
  const carla = { name: 'c.json', text: '{"scenario":"a","success":true,"criteria":[]}' }, xosc = { name: 's.xosc', text: XOSC }
  const pick = (...f: { name: string; text: string }[]) => { const p = pickFiles(f); return [p.format, p.take, f.filter(x => p.notice.includes(x.name)).map(x => x.name)] }
  assert.deepEqual(pick(table('a.csv')), ['param-csv', [0], []])
  assert.deepEqual(pick(table('a.csv'), table('b.csv')), ['param-csv', [0], ['b.csv']])
  assert.deepEqual(pick({ name: 'a.json', text: '[{"id":"a","weather":"rain"}]' }, table('b.csv'), carla), ['param-json', [0], ['b.csv', 'c.json']])
  assert.deepEqual(pick(traj('t1.csv'), table('b.csv'), traj('t2.csv')), ['trajectory-csv', [0, 2], ['b.csv']])
  assert.deepEqual(pick(xosc, { ...xosc, name: 't.xosc' }), ['xosc', [0, 1], []])
  assert.deepEqual(pick(carla, xosc, { name: 'empty.json', text: '' }), ['carla-json', [0], ['s.xosc', 'empty.json']])
})

test('CSV export: cells a spreadsheet would run are neutralised, numbers are not', () => {
  const cell = (v: string | number) => parseCsv(toCsv([['h', 'x'], [v, 'x']])).rows[1][0]
  for (const s of ['=1+1', '=HYPERLINK("http://x.test","go")', '+cmd', '-2+3', '@SUM(A1)', '\t=1', '\r=1', '-', '--1', '+1 2', '-5 to -1', '-1e', '-Infinity']) assert.equal(cell(s), `'${s}`)
  for (const s of ['-5', '+5', '-0.5', '-.5', '-5.', '-1e-7', '+3E8', '1=1', 'a-b', '', "'=1", ' x', '−5']) assert.equal(cell(s), s)
  assert.equal(cell(-5.25), '-5.25')
  assert.equal(toCsv([['a\rb', 'a\nb', 'a"b', 'a,b']]), '"a\rb","a\nb","a""b","a,b"\n')
  // Header cells and exported parameters go through the same path.
  const odd: Odd = [{ key: '=k', label: 'K', kind: 'category', categories: ['=x'] }, { key: 'x', label: 'X', kind: 'range', min: -10, max: -5, bins: 2 }]
  const rows = parseCsv(recsToCsv(odd, recommend(odd, [], [], { n: 2 }))).rows
  assert.deepEqual([rows[0][1], rows[1][1]], ["'=k", "'=x"])
  assert.ok(rows.slice(1).every(r => Number(r[2]) <= -5))
})
