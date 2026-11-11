// node scripts/make-examples.ts : writes the synthetic example files served from /examples
import { writeFileSync } from 'node:fs'
import { toCsv } from '../src/engine/csv.ts'
import { computeMetrics } from '../src/engine/metrics.ts'
import { sampleParams, simulate } from '../src/engine/sample.ts'

const dir = new URL('../public/examples/', import.meta.url)
const params = sampleParams()[2].slice(0, 60)
const rows: (string | number)[][] = [['run_id', 'scenario', 'event', 'weather', 'lighting', 'road', 'ego_speed_kmh', 'gap_m', 'rel_speed_kmh', 'min_ttc', 'min_distance', 'max_decel', 'collision', 'result']]
const traj: (string | number)[][] = [['run_id', 'time', 'actor_id', 'x', 'y', 'heading_deg', 'speed', 'length', 'width']]
const carla: object[] = []
params.forEach((p, i) => {
  const id = `EX-${String(i + 1).padStart(4, '0')}`
  const sim = simulate(p, 500 + i)
  const m = computeMetrics(sim).metrics
  const fail = m.collision || (m.ttc ?? 9) < 1.5 || (m.maxDecel ?? 0) > 5
  const planned = i >= 50
  rows.push([id, `${p.event}_${p.road}`, p.event, p.weather, p.lighting, p.road, p.ego_speed, p.gap, p.rel_speed,
    planned ? '' : m.ttc ?? '', planned ? '' : m.minDist ?? '', planned ? '' : m.maxDecel ?? '', planned ? '' : String(!!m.collision), planned ? '' : fail ? 'fail' : 'pass'])
  if (i < 3) for (const r of sim) traj.push([id, r.t, r.id, Math.round(r.x * 100) / 100, Math.round(r.y * 1000) / 1000, Math.round((r.h * 180) / Math.PI * 100) / 100, Math.round(r.v * 100) / 100, r.len ?? '', r.wid ?? ''])
  if (planned) carla.push({ scenario: id, success: !m.collision, criteria: [
    { name: 'CollisionTest', actor: 'vehicle.tesla.cybertruck (id=221)', optional: false, expected: '0', actual: m.collision ? '1' : '0', result: m.collision ? 'FAILURE' : 'SUCCESS' },
    { name: 'RouteCompletionTest', actor: 'vehicle.tesla.cybertruck (id=221)', optional: false, expected: '100 %', actual: m.collision ? '41 %' : '100 %', result: m.collision ? 'FAILURE' : 'SUCCESS' },
  ] })
})
writeFileSync(new URL('scenario_runs.csv', dir), toCsv(rows))
writeFileSync(new URL('trajectory_run.csv', dir), toCsv(traj))
writeFileSync(new URL('carla_results.json', dir), JSON.stringify(carla, null, 1))
console.log('wrote', rows.length - 1, 'runs,', traj.length - 1, 'trajectory rows,', carla.length, 'CARLA results')
