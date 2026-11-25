# Scenario Coverage

A coverage and results analyzer for autonomous-driving scenario testing. Import a scenario catalog and simulation results, measure how much of the operational design domain (ODD) you have actually tested, compute safety metrics from trajectories, find where the stack fails, and export the next scenarios to run.

**Live:** https://scenario-coverage.vercel.app

## The pain

Simulators produce runs faster than anyone can review them. Coverage lives in spreadsheets, failures in log folders, and the next campaign gets planned from memory. Safety and simulation engineers need to answer three questions quickly: what have we not tested, where does it fail, and what should we run next.

## Features

- **Import**: scenario parameter tables (CSV/JSON); OpenSCENARIO 1.x `.xosc` scenario files (ParameterDeclarations, `${...}` expressions, value constraints, entities, Init speeds, Init environment, road network) and parameter value distribution files, expanded to one planned run per parameter set; CARLA scenario_runner `--json` results and leaderboard result files; trajectory CSVs including esmini `dat2csv` and `--csv_logger` output as written. Format detection, column mapping, validation with line numbers.
- **ODD editor**: ranges with bins and categories (weather, lighting, road type, speeds, actor types, cut-in gap).
- **Coverage**: 1-way and pairwise (2-way combinatorial) coverage, a heatmap for every parameter pair, and a risk-ranked gap list.
- **Metrics from motion**: TTC with oriented bounding boxes, post-encroachment time, minimum gap, peak deceleration and jerk, lane offset from a centreline polyline; pass/fail against your thresholds.
- **Failures**: k-means clusters on normalised parameters plus decision-tree rules ("fails when gap < 33 m and relative speed < -18 km/h"), and a triage worklist with status and notes.
- **Next scenarios**: maximin space-filling over untested cells and boundary sampling near failures; export CSV or an OpenSCENARIO 1.2 ParameterValueDistribution that assigns the scenario's declared parameter names.
- **History**: campaigns as dated snapshots, cumulative coverage trend, side-by-side campaign compare.
- **Replay**: top-down replay of any run with trajectories and a live TTC readout.
- Printable coverage report, optional accounts with cloud sync (local-first), light and dark themes.

The sample is a synthetic highway trucking programme: 600 closed-loop runs in three campaigns, all generated.

## Formats checked against

Importer tests use fixtures written to match what the tools publish (checked 2026-11-15): the esmini example scenarios (`resources/xosc`, including `cut-in.xosc` with `cut-in_parameter_set.xosc`), the CARLA scenario_runner OpenSCENARIO examples (`srunner/examples`), the scenario_runner JSON report writer (`result_writer.py`), the CARLA leaderboard record layout (`statistics_manager.py`), and the esmini `dat2csv` and `--csv_logger` column layouts. No third-party scenario files are redistributed.

## Known gaps

- OpenSCENARIO story actions, triggers and catalog contents are not interpreted; coverage uses declared parameters, init speeds and the init environment.
- Stochastic parameter distributions set ODD bounds only; the sampled values have to come back in a result table.
- esmini `dat2csv` output has no bounding boxes, so positions stay at the reference point (rear axle) and the ego footprint is asked for at import.
- Lane offset assumes a straight road along the ego's starting lane unless a centreline is supplied in code; curved OpenDRIVE roads are not read.
- CARLA results carry verdicts and collision flags only; TTC and gaps need a trajectory file.
- Trajectory sets over 1.5 MB stay on the device and are not synced.

## Run locally

```
npm install
npm run dev      # http://localhost:5173
npm test         # engine tests
npm run build
npm run test:e2e   # Playwright against the production build (npx playwright install chromium once; E2E_PORT picks the port)
```

Cloud sync is optional and reads `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` from `.env`.
