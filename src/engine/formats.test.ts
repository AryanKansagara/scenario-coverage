// Importer tests against the layouts real tools write. The fixtures are short excerpts written to match:
// esmini resources/xosc (cut-in.xosc, cut-in_parameter_set.xosc), CARLA scenario_runner srunner/examples and
// result_writer.py, CARLA leaderboard statistics_manager.py, and esmini dat2csv / --csv_logger output.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { computeMetrics, toTracks } from './metrics.ts'
import { attachResults, detect, evalExpr, parseCarla, parseTrajectories, parseXosc, pretty, xoscOdd, xoscRuns } from './parse.ts'
import { recsToXosc } from './recommend.ts'

// esmini style: catalog references by parameter, speed as an expression, a commented-out block.
const CUT_IN = `﻿<?xml version="1.0" encoding="UTF-8"?>
<OpenSCENARIO>
   <FileHeader revMajor="1" revMinor="1" date="2021-04-09T10:00:00" description="Basic cut-in" author="esmini-team"/>
   <ParameterDeclarations>
      <ParameterDeclaration name="HostVehicle" parameterType="string" value="car_white"/>
      <ParameterDeclaration name="TargetVehicle" parameterType="string" value="car_red"/>
      <ParameterDeclaration name="EgoStartS" parameterType="double" value="50"/>
      <ParameterDeclaration name="HeadwayTime_LaneChange" parameterType="double" value="0.4">
         <ConstraintGroup>
            <ValueConstraint rule="greaterThan" value="0.1"/>
            <ValueConstraint rule="lessOrEqual" value="2.0"/>
         </ConstraintGroup>
      </ParameterDeclaration>
      <ParameterDeclaration name="EgoSpeed" parameterType="double" value="108"/>
      <ParameterDeclaration name="TargetSpeedFactor" parameterType="double" value="1.2"/>
      <!-- <ParameterDeclaration name="Disabled" parameterType="double" value="1"/> -->
   </ParameterDeclarations>
   <CatalogLocations><VehicleCatalog><Directory path="../xosc/Catalogs/Vehicles"/></VehicleCatalog></CatalogLocations>
   <RoadNetwork><LogicFile filepath="../xodr/e6mini.xodr"/></RoadNetwork>
   <Entities>
      <ScenarioObject name="Ego"><CatalogReference catalogName="VehicleCatalog" entryName="$HostVehicle"/></ScenarioObject>
      <ScenarioObject name="OverTaker"><CatalogReference catalogName="VehicleCatalog" entryName="$TargetVehicle"/></ScenarioObject>
      <ScenarioObject name="Parked">
         <Vehicle name="van" vehicleCategory="van">
            <ParameterDeclarations><ParameterDeclaration name="MaxSpeed" parameterType="double" value="40"/></ParameterDeclarations>
         </Vehicle>
      </ScenarioObject>
   </Entities>
   <Storyboard>
      <Init>
         <Actions>
            <Private entityRef="Ego">
               <PrivateAction><TeleportAction><Position><LanePosition roadId="0" laneId="-3" offset="0" s="$EgoStartS"/></Position></TeleportAction></PrivateAction>
               <PrivateAction><LongitudinalAction><SpeedAction>
                  <SpeedActionDynamics dynamicsShape="step" dynamicsDimension="time" value="0.0"/>
                  <SpeedActionTarget><AbsoluteTargetSpeed value="\${$EgoSpeed / 3.6}"/></SpeedActionTarget>
               </SpeedAction></LongitudinalAction></PrivateAction>
            </Private>
            <Private entityRef="OverTaker">
               <PrivateAction><LongitudinalAction><SpeedAction>
                  <SpeedActionDynamics dynamicsShape="step" dynamicsDimension="time" value="0.0"/>
                  <SpeedActionTarget><AbsoluteTargetSpeed value="\${$TargetSpeedFactor * $EgoSpeed / 3.6}"/></SpeedActionTarget>
               </SpeedAction></LongitudinalAction></PrivateAction>
            </Private>
         </Actions>
      </Init>
   </Storyboard>
</OpenSCENARIO>`

// Same structure as esmini's cut-in_parameter_set.xosc: a multi-parameter value set, an element list and a stepped range.
const PARAM_SET = `<?xml version="1.0" encoding="utf-8"?>
<OpenSCENARIO>
  <FileHeader revMajor="1" revMinor="2" date="2022-10-31T12:00:00" description="Parameter values for scenario" author="esmini-team" />
  <ParameterValueDistribution>
    <ScenarioFile filepath="../xosc/cut-in.xosc" />
    <Deterministic>
      <DeterministicMultiParameterDistribution>
        <ValueSetDistribution>
          <ParameterValueSet>
            <ParameterAssignment parameterRef="HostVehicle" value="car_blue" />
            <ParameterAssignment parameterRef="TargetVehicle" value="car_yellow" />
          </ParameterValueSet>
          <ParameterValueSet>
            <ParameterAssignment parameterRef="TargetVehicle" value="van_red" />
          </ParameterValueSet>
        </ValueSetDistribution>
      </DeterministicMultiParameterDistribution>
      <DeterministicSingleParameterDistribution parameterName="EgoSpeed">
        <DistributionSet>
          <Element value="70.0" />
          <Element value="110.0" />
        </DistributionSet>
      </DeterministicSingleParameterDistribution>
      <DeterministicSingleParameterDistribution parameterName="TargetSpeedFactor">
        <DistributionRange stepWidth="0.2">
          <Range lowerLimit="1.1" upperLimit="1.5" />
        </DistributionRange>
      </DeterministicSingleParameterDistribution>
      <!-- <DeterministicSingleParameterDistribution parameterName="HeadwayTime_LaneChange"> -->
        <!-- <DistributionRange stepWidth="0.2"> -->
          <!-- <Range lowerLimit="0.2" upperLimit="0.6" /> -->
        <!-- </DistributionRange> -->
      <!-- </DeterministicSingleParameterDistribution> -->
    </Deterministic>
  </ParameterValueDistribution>
</OpenSCENARIO>`

// CARLA scenario_runner style: no catalogs, an Init EnvironmentAction, hero / adversary entities.
const CARLA_XOSC = `<?xml version="1.0"?>
<OpenSCENARIO>
  <FileHeader revMajor="1" revMinor="0" date="2020-03-20T12:00:00" description="CARLA:FollowLeadingVehicle" author=""/>
  <ParameterDeclarations>
    <ParameterDeclaration name="leadingSpeed" parameterType="double" value="2.0"/>
  </ParameterDeclarations>
  <CatalogLocations/>
  <RoadNetwork><LogicFile filepath="Town01"/><SceneGraphFile filepath=""/></RoadNetwork>
  <Entities>
    <ScenarioObject name="hero"><Vehicle name="vehicle.lincoln.mkz_2017" vehicleCategory="car"><ParameterDeclarations/></Vehicle></ScenarioObject>
    <ScenarioObject name="adversary"><Vehicle name="vehicle.tesla.model3" vehicleCategory="car"><ParameterDeclarations/></Vehicle></ScenarioObject>
  </Entities>
  <Storyboard>
    <Init>
      <Actions>
        <GlobalAction>
          <EnvironmentAction>
            <Environment name="Environment1">
              <TimeOfDay animation="false" dateTime="2020-03-20T17:30:00"/>
              <Weather cloudState="rainy">
                <Sun intensity="0.85" azimuth="0" elevation="1.31"/>
                <Fog visualRange="100000.0"/>
                <Precipitation precipitationType="rain" intensity="0.6"/>
              </Weather>
              <RoadCondition frictionScaleFactor="0.8"/>
            </Environment>
          </EnvironmentAction>
        </GlobalAction>
        <Private entityRef="adversary">
          <PrivateAction><LongitudinalAction><SpeedAction>
            <SpeedActionDynamics dynamicsShape="step" value="0" dynamicsDimension="time"/>
            <SpeedActionTarget><AbsoluteTargetSpeed value="$leadingSpeed"/></SpeedActionTarget>
          </SpeedAction></LongitudinalAction></PrivateAction>
        </Private>
      </Actions>
    </Init>
  </Storyboard>
</OpenSCENARIO>`

test('expressions: precedence, parentheses, functions and parameter references', () => {
  const get = (k: string) => ({ EgoSpeed: 108, Factor: 1.2 } as Record<string, number>)[k] ?? NaN
  assert.equal(evalExpr('$EgoSpeed / 3.6', get), 30)
  assert.equal(evalExpr('2 + 3 * 4', get), 14)
  assert.equal(evalExpr('(2 + 3) * 4', get), 20)
  assert.equal(evalExpr('-$Factor * 10 % 5', get), -2)
  assert.equal(evalExpr('round(pow(2, 3) + sqrt(16) / 3)', get), 9)
  assert.ok(Number.isNaN(evalExpr('$Missing * 2', get)))
  assert.ok(Number.isNaN(evalExpr('BrakeCondition + _ + $Factor', get)))
  assert.ok(Number.isNaN(evalExpr('2 +', get)))
  assert.ok(Number.isNaN(evalExpr('alert(1)', get)))
})

test('esmini scenario: expression speeds, catalog references, comments and nested declarations', () => {
  assert.equal(detect('cut-in.xosc', CUT_IN), 'xosc')
  const x = parseXosc(CUT_IN)
  assert.deepEqual(Object.keys(x.params), ['HostVehicle', 'TargetVehicle', 'EgoStartS', 'HeadwayTime_LaneChange', 'EgoSpeed', 'TargetSpeedFactor'])
  assert.deepEqual(x.initSpeeds, { Ego: 30, OverTaker: 36 })
  assert.deepEqual(x.entities.map(e => e.category), ['car_white', 'car_red', 'van'])
  assert.equal(x.env.road_network, 'e6mini')
  assert.deepEqual(x.ranges.HeadwayTime_LaneChange, [0.1, 2])
})

test('CARLA scenario: Init environment and town become ODD parameters', () => {
  const b = xoscRuns([{ name: 'FollowLeadingVehicle.xosc', text: CARLA_XOSC }])
  assert.deepEqual(b.runs[0].params, { time_of_day: 17.5, cloud_state: 'rainy', precipitation: 'rain', precipitation_intensity: 0.6, fog_visual_range: 100000, road_friction: 0.8, road_network: 'Town01', leadingspeed: 2, adversary_init_speed: 2 })
  const odd = xoscOdd(b.parsed.map(p => p.x), b.runs)
  assert.equal(odd.find(d => d.key === 'time_of_day')?.unit, 'h')
  assert.equal(odd.find(d => d.key === 'leadingspeed')?.label, 'Leading Speed')
  assert.equal(odd.find(d => d.key === 'leadingspeed')?.ref, 'leadingSpeed')
  assert.equal(odd.find(d => d.key === 'road_friction')?.ref, undefined)
})

test('parameter value distribution expands to one run per combination of its scenario', () => {
  const b = xoscRuns([{ name: 'cut-in_parameter_set.xosc', text: PARAM_SET }, { name: 'cut-in.xosc', text: CUT_IN }])
  assert.deepEqual(b.errors, [])
  assert.deepEqual(b.notes, [])
  // 2 value sets x 2 elements x 3 range steps; the template itself is not a run of its own.
  assert.equal(b.runs.length, 12)
  assert.deepEqual(b.runs.map(r => r.id).slice(0, 2), ['cut-in_parameter_set-01', 'cut-in_parameter_set-02'])
  assert.deepEqual([...new Set(b.runs.map(r => r.params.targetspeedfactor))], [1.1, 1.3, 1.5])
  const first = b.runs[0], last = b.runs[11]
  assert.equal(first.scenario, 'Basic cut-in')
  assert.deepEqual([first.params.hostvehicle, first.params.targetvehicle, first.params.egospeed], ['car_blue', 'car_yellow', 70])
  // A partial value set keeps the scenario's declared default for what it does not assign.
  assert.deepEqual([last.params.hostvehicle, last.params.targetvehicle, last.params.egospeed], ['car_white', 'van_red', 110])
  // Speeds are re-evaluated per set: 70 km/h and 110 km/h * 1.5.
  assert.equal(first.params.ego_init_speed, 19.444444)
  assert.equal(last.params.overtaker_init_speed, 45.833333)
  assert.equal(first.params.egostarts, 50)
})

test('a distribution without its scenario file still imports, with a note', () => {
  const b = xoscRuns([{ name: 'sweep.xosc', text: PARAM_SET }])
  assert.equal(b.runs.length, 12)
  assert.deepEqual(Object.keys(b.runs[0].params).sort(), ['egospeed', 'hostvehicle', 'targetspeedfactor', 'targetvehicle'])
  assert.match(b.notes[0], /cut-in\.xosc, which is not in this import/)
})

test('stochastic distributions give ODD bounds, not runs', () => {
  const text = `<OpenSCENARIO><FileHeader revMajor="1" revMinor="2" date="2026-01-01T00:00:00" description="Monte Carlo" author="qa"/>
  <ParameterValueDistribution><ScenarioFile filepath="cut-in.xosc"/>
    <Stochastic numberOfTestRuns="200" randomSeed="7">
      <StochasticDistribution parameterName="EgoSpeed"><UniformDistribution><Range lowerLimit="60" upperLimit="130"/></UniformDistribution></StochasticDistribution>
      <StochasticDistribution parameterName="TargetSpeedFactor"><NormalDistribution expectedValue="1.2" variance="0.01"><Range lowerLimit="0.9" upperLimit="1.6"/></NormalDistribution></StochasticDistribution>
    </Stochastic>
  </ParameterValueDistribution></OpenSCENARIO>`
  const b = xoscRuns([{ name: 'mc.xosc', text }, { name: 'cut-in.xosc', text: CUT_IN }])
  assert.equal(b.runs.length, 1)
  assert.match(b.notes[0], /EgoSpeed, TargetSpeedFactor stochastically \(200 test runs\)/)
  const odd = xoscOdd(b.parsed.map(p => p.x), b.runs)
  const speed = odd.find(d => d.key === 'egospeed')!
  assert.deepEqual([speed.min, speed.max], [60, 130])
})

test('exported distributions use the declared parameter names and re-import unchanged', () => {
  const b = xoscRuns([{ name: 'cut-in_parameter_set.xosc', text: PARAM_SET }, { name: 'cut-in.xosc', text: CUT_IN }])
  const odd = xoscOdd(b.parsed.map(p => p.x), b.runs)
  const recs = b.runs.slice(0, 3).map((r, i) => ({ id: `REC-00${i + 1}`, params: r.params, kind: 'gap' as const, newCells: 1, reason: '' }))
  const out = recsToXosc(odd, recs, 'cut-in.xosc', '2026-11-15T00:00:00')
  assert.ok(out.includes('parameterRef="EgoSpeed"') && out.includes('parameterRef="HeadwayTime_LaneChange"'))
  // Derived dimensions are not parameters the scenario declares, so they must not be assigned.
  assert.ok(!/parameterRef="(ego_init_speed|road_network|egospeed)"/.test(out))
  const back = xoscRuns([{ name: 'next.xosc', text: out }, { name: 'cut-in.xosc', text: CUT_IN }])
  assert.deepEqual(back.runs.map(r => r.params), b.runs.slice(0, 3).map(r => r.params))
})

test('scenario_runner --json: boolean criteria, the Duration entry and optional criteria', () => {
  // Layout of ResultOutputProvider._write_to_reportjson: one object per scenario, success as a boolean.
  const j = JSON.stringify({
    scenario: 'FollowLeadingVehicle', success: false, criteria: [
      { name: 'RunningStopTest', actor: 'lincoln.mkz_2017-221', optional: false, expected: 0, actual: 0, success: true },
      { name: 'CollisionTest', actor: 'lincoln.mkz_2017-221', optional: false, expected: 0, actual: 1, success: false },
      { name: 'KeepLaneTest', actor: 'lincoln.mkz_2017-221', optional: true, expected: 0, actual: 2, success: false },
      { name: 'Duration', actor: 'all', optional: false, expected: 60, actual: 60.05000089481473, success: false },
    ],
  }, null, 4)
  assert.equal(detect('FollowLeadingVehicle.json', j), 'carla-json')
  const [r] = parseCarla(j)
  assert.equal(r.outcome, 'fail')
  assert.equal(r.reason, 'CollisionTest: 1 (expected 0); Duration: 60.050001 (expected 60)')
  assert.equal(r.metrics.collision, true)
  const pass = parseCarla(JSON.stringify({ scenario: 'FollowLeadingVehicle', success: true, criteria: [{ name: 'CollisionTest', optional: false, expected: 0, actual: 0, success: true }, { name: 'KeepLaneTest', optional: true, expected: 0, actual: 1, success: false }] }))[0]
  assert.equal(pass.outcome, 'pass')
  assert.equal(pass.metrics.collision, false)
  // The scenario tree name matches the .xosc file name, which is the run id.
  const base = xoscRuns([{ name: 'FollowLeadingVehicle.xosc', text: CARLA_XOSC }]).runs
  const a = attachResults(base, [r])
  assert.equal(a.matched, 1)
  assert.equal(a.runs[0].outcome, 'fail')
})

test('leaderboard checkpoint: route status and infractions', () => {
  const j = JSON.stringify({ _checkpoint: { global_record: {}, progress: [2, 2], records: [
    { index: 0, route_id: 'RouteScenario_0_rep0', status: 'Completed', num_infractions: 0, infractions: { collisions_layout: [], collisions_pedestrian: [], collisions_vehicle: [], red_light: [], route_timeout: [] }, scores: { score_route: 100, score_penalty: 1, score_composed: 100 }, meta: { route_length: 912.4, duration_game: 110.5, duration_system: 301.2 } },
    { index: 1, route_id: 'RouteScenario_1_rep0', status: 'Failed - Agent timed out', num_infractions: 2, infractions: { collisions_vehicle: ['Agent collided against object with type=vehicle.audi.tt and id=412 at (x=88.1, y=130.2, z=0.03)'], red_light: [], route_timeout: ['Route timeout.'] }, scores: { score_route: 41.2, score_penalty: 0.6, score_composed: 24.72 } },
  ] }, entry_status: 'Finished', eligible: true, sensors: [], values: [], labels: [] })
  assert.equal(detect('simulation_results.json', j), 'carla-json')
  const res = parseCarla(j)
  assert.deepEqual(res.map(r => r.outcome), ['pass', 'fail'])
  assert.equal(res[1].scenario, 'RouteScenario_1_rep0')
  assert.equal(res[1].metrics.collision, true)
  assert.match(res[1].reason!, /Agent timed out; collisions_vehicle ×1; route_timeout ×1/)
})

test('esmini dat2csv: version banner, entity names and the extended column set', () => {
  const text = `Version: 2.37, OpenDRIVE: ../xodr/e6mini.xodr, 3DModel: ../models/e6mini.osgb GIT REV: v2.37.11
time, id, name, x, y, z, h, p, r, roadId, laneId, offset, t, s, speed, wheel_angle, wheel_rot
0.000, 0, Ego, 8.17, 53.91, -0.03, 1.57, 0.00, 0.00, 0, -3, 0.00, -8.00, 50.00, 30.00, 0.00, 0.00
0.000, 1, OverTaker, 4.67, 28.91, -0.01, 1.57, 0.00, 0.00, 0, -2, 0.00, -4.50, 25.00, 36.00, 0.00, 0.00
0.100, 0, Ego, 8.17, 56.91, -0.03, 1.57, 0.00, 0.00, 0, -3, 0.00, -8.00, 53.00, 30.00, 0.00, 5.11
0.100, 1, OverTaker, 4.67, 32.51, -0.01, 1.57, 0.00, 0.00, 0, -2, 0.00, -4.50, 28.60, 36.00, 0.00, 6.13
`
  assert.equal(detect('cut-in.csv', text), 'trajectory-csv')
  const t = parseTrajectories(text, 'cut-in')
  assert.deepEqual(t.issues, [])
  assert.equal(t.degrees, false)
  const rows = t.byRun.get('cut-in')!
  assert.deepEqual([...new Set(rows.map(r => r.id))], ['Ego', 'OverTaker'])
  // "time" is the clock; the later "t" column is the lateral road coordinate.
  assert.deepEqual(rows.map(r => r.t), [0, 0, 0.1, 0.1])
  assert.equal(rows[0].v, 30)
  assert.equal(toTracks(rows).ego.id, 'Ego')
})

test('esmini --csv_logger: one column block per entity, box centre offset applied', () => {
  const cols = (n: number) => ['Entity_Name [-]', 'Entity_ID [-]', 'Current_Speed [m/s]', 'Wheel_Angle [deg]', 'Wheel_Rotation [-]', 'bb_x [m]', 'bb_y [m]', 'bb_z [m]', 'bb_length [m]', 'bb_width [m]', 'bb_height [m]', 'World_Position_X [m]', 'World_Position_Y [m]', 'World_Position_Z [m]', 'World_Heading_Angle [rad]'].map(c => `#${n} ${c}`)
  const ent = (name: string, id: number, v: number, x: number, y: number, h: number) => [name, id, v, 0, 0, 1.4, 0, 0.75, 5.04, 2, 1.5, x, y, 0, h]
  const text = [
    ['Index [-]', 'TimeStamp [s]', ...cols(1), ...cols(2), ''].join(', '),
    [0, 0, ...ent('Ego', 0, 20, 0, 0, 0), ...ent('Target', 1, 10, 40, 0, 0), ''].join(', '),
    [1, 0.5, ...ent('Ego', 0, 20, 10, 0, 0), ...ent('Target', 1, 10, 45, 0, 0), ''].join(', '),
    [2, 1, ...ent('Ego', 0, 20, 20, 0, Math.PI / 2), ...ent('Target', 1, 10, 50, 0, 0), ''].join(', '),
  ].join('\n') + '\n'
  assert.equal(detect('full_log.csv', text), 'trajectory-csv')
  const t = parseTrajectories(text, 'full_log')
  assert.deepEqual(t.issues, [])
  const rows = t.byRun.get('full_log')!
  assert.equal(rows.length, 6)
  assert.deepEqual([rows[0].id, rows[0].x, rows[0].len, rows[0].wid, rows[0].v], ['Ego', 1.4, 5.04, 2, 20])
  // Heading 90 degrees: the 1.4 m offset points along +y.
  assert.ok(Math.abs(rows[4].x - 20) < 1e-9 && Math.abs(rows[4].y - 1.4) < 1e-9)
  // Rear-end closing at 10 m/s: 40 m between reference points less one 5.04 m car leaves 34.96 m, so 3.5 s.
  const m = computeMetrics(rows.filter(r => r.t === 0)).metrics
  assert.equal(m.minDist, 34.96)
  assert.equal(m.ttc, 3.5)
})

test('the ego is found by CARLA role name, and camelCase names read as words', () => {
  const rows = [{ t: 0, id: 'npc_12', x: 30, y: 0, h: 0, v: 5 }, { t: 0, id: 'hero', x: 0, y: 0, h: 0, v: 10 }]
  assert.equal(toTracks(rows).ego.id, 'hero')
  assert.equal(pretty('HeadwayTime_LaneChange'), 'Headway Time Lane Change')
  assert.equal(pretty('ego_speed_kmh'), 'Ego speed kmh')
  assert.equal(pretty('TTC'), 'TTC')
})

test('a trajectory file with no usable rows is rejected with a reason', () => {
  assert.throws(() => parseTrajectories('time,actor_id,x,y,heading\n,ego,1,1,0\n', 'r'), /No usable trajectory rows/)
})
