import { Code, Link } from './ui.tsx'

const TABLE = `run_id,scenario,event,weather,lighting,road,ego_speed,gap,rel_speed,min_ttc,min_distance,max_decel,collision,result
C1-0001,cut_in_straight,cut_in,clear,day,straight,84,31.5,-6,3.42,6.1,2.3,false,pass
C1-0002,lead_brake_curve,lead_brake,rain,dusk,curve,97,12.0,-22,0.0,0.0,4.9,true,fail`

const CARLA_CMD = `# scenario_runner (0.9.x): one JSON result file per scenario
python scenario_runner.py --scenario CutIn_1 --reloadWorld --output \\
  --json --outputDir results/
# or a whole OpenSCENARIO file
python scenario_runner.py --openscenario cut_in.xosc --json --outputDir results/`

const CARLA_LOG = `# Log a trajectory CSV from a CARLA client while the scenario runs
import csv, math, carla
client = carla.Client('localhost', 2000); world = client.get_world()
out = csv.writer(open('trajectory_run.csv', 'w', newline=''))
out.writerow(['run_id', 'time', 'actor_id', 'x', 'y', 'heading_deg', 'speed', 'length', 'width'])
RUN = 'C1-0001'
def on_tick(snap):
    for a in world.get_actors().filter('vehicle.*'):
        t = a.get_transform(); v = a.get_velocity(); bb = a.bounding_box.extent
        role = a.attributes.get('role_name', str(a.id))
        # CARLA is left-handed (y points right): flip y and yaw for a standard x-forward, y-left frame
        out.writerow([RUN, round(snap.timestamp.elapsed_seconds, 3), 'ego' if role == 'hero' else a.id,
                      t.location.x, -t.location.y, -t.rotation.yaw, math.hypot(v.x, v.y), 2 * bb.x, 2 * bb.y])
world.on_tick(on_tick)`

const ESMINI = `# esmini: headless run with a CSV log of every entity per step
./bin/esmini --headless --osc cut_in.xosc --fixed_timestep 0.05 --csv_logger cut_in_log.csv
# keep the header row with time, id, x, y, h, speed; delete any banner line above it`

const SQL = `-- Export a campaign from a results database (PostgreSQL)
SELECT r.run_id, s.name AS scenario,
       p.params->>'weather' AS weather, (p.params->>'ego_speed')::float AS ego_speed,
       (p.params->>'cut_in_gap')::float AS gap,
       m.min_ttc, m.min_distance, m.max_decel, r.collision,
       CASE WHEN r.passed THEN 'pass' ELSE 'fail' END AS result
FROM sim_runs r
JOIN scenarios s ON s.id = r.scenario_id
JOIN scenario_params p ON p.run_id = r.run_id
LEFT JOIN run_metrics m ON m.run_id = r.run_id
WHERE r.campaign = 'nightly-2026-10-30'
ORDER BY r.run_id;`

export default function Docs() {
  return (
    <section className="page narrow docs">
      <div className="eyebrow">Docs</div>
      <h1>Getting your scenarios and results in</h1>
      <p className="lede">Scenario Coverage reads four kinds of file. Use any of them alone, or combine: a catalog for coverage, results for verdicts, trajectories for metrics you compute yourself.</p>
      <nav className="toc" aria-label="On this page">
        <a href="#tables">Parameter tables</a><a href="#xosc">OpenSCENARIO</a><a href="#carla">CARLA results</a><a href="#traj">Trajectories</a><a href="#metrics">How metrics work</a><a href="#coverage">Coverage and recommendations</a><a href="#assumptions">Assumptions</a>
      </nav>

      <h2 id="tables">1. Scenario parameter tables (CSV or JSON)</h2>
      <p>One row per run. Every column becomes an ODD parameter unless it is recognised as an id, scenario name, result, failure reason or metric; you can change any mapping before importing.</p>
      <Code code={TABLE} label="scenario_runs.csv" />
      <ul>
        <li><b>Result</b> accepts pass/fail, passed/failed, success, true/false, 1/0.</li>
        <li><b>Metrics</b> recognised by name: <code>min_ttc</code>, <code>pet</code>, <code>min_distance</code>, <code>max_decel</code>, <code>max_jerk</code>, <code>lane_offset</code>, <code>collision</code>.</li>
        <li>JSON: an array of runs or <code>{'{ "runs": [...] }'}</code>; nested <code>params</code> and <code>metrics</code> objects are flattened.</li>
        <li>Numeric columns become ranges (5 bins), text columns categories. Edit both on the Data &amp; ODD tab.</li>
        <li>Problems are reported with the source line: non-numeric values in a range column are errors (row skipped); values outside the ODD, unknown categories and duplicate ids are warnings.</li>
      </ul>
      <p>If runs live in a database, export them with a query and save as CSV:</p>
      <Code code={SQL} label="SQL" />

      <h2 id="xosc">2. OpenSCENARIO 1.x (.xosc)</h2>
      <p>Drop one or many concrete scenario files. Each becomes a planned run with its <code>ParameterDeclarations</code> as parameters and each entity&rsquo;s <code>Init</code> <code>AbsoluteTargetSpeed</code> as <code>&lt;entity&gt;_init_speed</code> (m/s; <code>$parameter</code> references are resolved). OpenSCENARIO 1.2 <code>&lt;Range lowerLimit upperLimit&gt;</code> constraints become the ODD bounds. Planned runs count toward coverage of what you intend to test; attach results to them next.</p>

      <h2 id="carla">3. CARLA scenario_runner results (JSON)</h2>
      <Code code={CARLA_CMD} label="shell" />
      <p>Each result has <code>scenario</code>, <code>success</code> and a <code>criteria</code> list. A failed non-optional criterion fails the run (its name and actual value become the reason); <code>CollisionTest</code> with an actual count above zero sets the collision flag. Leaderboard checkpoints (<code>_checkpoint.records</code> with <code>status</code> and <code>infractions</code>) also work. Results attach to an existing campaign by scenario name or run id; anything unmatched is listed before you commit.</p>

      <h2 id="traj">4. Per-run trajectories (CSV)</h2>
      <p>Columns: time (s), actor id, x, y (m), heading, speed (m/s); optional <code>run_id</code> (to put many runs in one file), <code>length</code> and <code>width</code> (m). Without <code>run_id</code> the file name is the run id. Headings in degrees are detected and converted; missing speeds are derived from positions. The ego is the actor whose id contains &ldquo;ego&rdquo;, else the first actor. Default footprints: 21 × 2.6 m for the ego truck, 4.8 × 1.9 m for others.</p>
      <h3>From CARLA</h3>
      <Code code={CARLA_LOG} label="log_trajectory.py" />
      <h3>From esmini</h3>
      <Code code={ESMINI} label="shell" />

      <h2 id="metrics">How the metrics are computed</h2>
      <ul>
        <li><b>TTC</b>: at every ego sample, both actors are projected forward at constant velocity along their headings as oriented bounding boxes (separating-axis test, 20 ms steps, 10 s horizon). The first contact time is the TTC; the run reports the minimum.</li>
        <li><b>PET</b>: the smallest time difference between the two footprints occupying overlapping road (all sample pairs). 0 means a collision.</li>
        <li><b>Min gap</b>: closest edge-to-edge distance between boxes. 0 is a collision.</li>
        <li><b>Max deceleration and jerk</b>: finite differences of the ego speed trace.</li>
        <li><b>Lane offset</b>: largest distance from the ego centre to the lane centreline polyline (the ego&rsquo;s starting lane on a straight road).</li>
      </ul>

      <h2 id="coverage">Coverage, clusters and recommendations</h2>
      <ul>
        <li><b>1-way coverage</b>: share of every parameter&rsquo;s bins with at least one run. <b>Pairwise</b>: share of every bin pair across every two parameters, the standard 2-way combinatorial measure.</li>
        <li><b>Gaps</b> are untested 2-way cells, ranked by how often their two bins fail elsewhere.</li>
        <li><b>Failure rules</b>: a depth-3 decision tree (Gini splits) on all runs; leaves that fail at least twice as often as the campaign (and at least 40%) become &ldquo;fails when&rdquo; rules. <b>Clusters</b>: k-means on normalised parameters (k chosen by silhouette).</li>
        <li><b>Next scenarios</b>: gap-fill runs are picked greedily by new 2-way cells covered, ties broken by maximin distance to everything tested; boundary runs sit between each failing run and its nearest passing run. Export as CSV or an OpenSCENARIO 1.2 <code>ParameterValueDistribution</code> referencing your scenario file.</li>
      </ul>

      <h2 id="assumptions">Default thresholds (as of November 2026)</h2>
      <p>Defaults for new projects, editable per project: TTC 1.5 s, PET 0.5 s, minimum gap 1.0 m, deceleration 5.0 m/s² (hard braking for a loaded tractor-trailer), jerk 12 m/s³, lane offset 0.9 m, lane width 3.7 m (12 ft US interstate lane). These are common starting points in the literature, not regulatory limits; set them to your own safety case.</p>
      <h2>Privacy</h2>
      <p>Files are parsed in your browser. Nothing leaves the device unless you sign in, which syncs the ODD, thresholds, triage and campaign results; trajectory sets over 1.5 MB stay local. The sample programme is synthetic.</p>
      <p><Link href="/app" className="btn primary">Open the app</Link></p>
    </section>
  )
}
