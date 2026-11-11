# Scenario Coverage

A coverage and results analyzer for autonomous-driving scenario testing. Import a scenario catalog and simulation results, measure how much of the operational design domain (ODD) you have actually tested, compute safety metrics from trajectories, find where the stack fails, and export the next scenarios to run.

**Live:** https://scenario-coverage.vercel.app

## The pain

Simulators produce runs faster than anyone can review them. Coverage lives in spreadsheets, failures in log folders, and the next campaign gets planned from memory. Safety and simulation engineers need to answer three questions quickly: what have we not tested, where does it fail, and what should we run next.

## Features

- **Import**: scenario parameter tables (CSV/JSON), OpenSCENARIO 1.x `.xosc` (ParameterDeclarations, Range constraints, entities, Init speeds), CARLA scenario_runner result JSON, and per-run trajectory CSVs. Format detection, column mapping, validation with line numbers.
- **ODD editor**: ranges with bins and categories (weather, lighting, road type, speeds, actor types, cut-in gap).
- **Coverage**: 1-way and pairwise (2-way combinatorial) coverage, a heatmap for every parameter pair, and a risk-ranked gap list.
- **Metrics from motion**: TTC with oriented bounding boxes, post-encroachment time, minimum gap, peak deceleration and jerk, lane offset from a centreline polyline; pass/fail against your thresholds.
- **Failures**: k-means clusters on normalised parameters plus decision-tree rules ("fails when gap < 33 m and relative speed < -18 km/h"), and a triage worklist with status and notes.
- **Next scenarios**: maximin space-filling over untested cells and boundary sampling near failures; export CSV or an OpenSCENARIO 1.2 ParameterValueDistribution.
- **History**: campaigns as dated snapshots, cumulative coverage trend, side-by-side campaign compare.
- **Replay**: top-down replay of any run with trajectories and a live TTC readout.
- Printable coverage report, optional accounts with cloud sync (local-first), light and dark themes.

The sample is a synthetic highway trucking programme: 600 closed-loop runs in three campaigns, all generated.

## Run locally

```
npm install
npm run dev      # http://localhost:5173
npm test         # engine tests
npm run build
```

Cloud sync is optional and reads `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` from `.env`.
