import { test, expect, newProject, importTable, drop, example, kpi, section, downloaded, issues, FOUR } from './fixtures.ts'

test('example table: formats, line-numbered problems and column mapping', async ({ page }) => {
  await newProject(page)
  await drop(page, example('scenario_runs.csv'))
  await expect(page.getByText('detected Scenario parameter table (CSV) · 60 rows')).toBeVisible()
  await expect(page.getByText('No problems found.')).toBeVisible()
  await page.getByRole('button', { name: 'Import 60 runs' }).click()
  // The file lists 50 runs with a result and 10 still to run.
  await expect(kpi(page, 'Failure rate')).toContainText('judged runs · 10 not run yet')
})

test('CSV with a BOM, CRLF, quotes and semicolons reads like the plain file', async ({ page }) => {
  await newProject(page)
  await importTable(page, 'bom.csv', '﻿' + FOUR.replace(/,/g, ';').replace('rain;day', '"rain";"day"').replace(/\n/g, '\r\n'))
  await expect(kpi(page, 'Pairwise ODD coverage')).toContainText('11 of 24 2-way cells')
})

test('JSON table with nested params matches the CSV', async ({ page }) => {
  await newProject(page)
  const rows = FOUR.trim().split('\n').slice(1).map(l => l.split(','))
  await importTable(page, 'runs.json', JSON.stringify({ runs: rows.map(r => ({ run_id: r[0], params: { weather: r[1], light: r[2], gap: Number(r[3]) }, metrics: { min_ttc: r[4] ? Number(r[4]) : null, min_distance: r[5] ? Number(r[5]) : null } })) }))
  await expect(kpi(page, 'Pairwise ODD coverage')).toContainText('11 of 24 2-way cells')
  await expect(kpi(page, 'Failure rate')).toContainText('2 of 3 judged runs')
})

test('bad cells are reported with their line and bad rows are skipped', async ({ page }) => {
  await newProject(page)
  const good = Array.from({ length: 20 }, (_, i) => `g${i},${i % 2 ? 'rain' : 'dry'},${i},pass`).join('\n')
  await drop(page, { name: 'bad.csv', text: `run_id,weather,gap,result\n${good}\nx1,rain,fast,pass\ng0,rain,5,maybe\n` })
  await expect(issues(page)).toContainText('line 22Gap "fast" is not a number.')
  await expect(issues(page)).toContainText('line 23Result "maybe" is not a recognised pass/fail value; treated as not reported.')
  await expect(issues(page)).toContainText('line 23Duplicate run id g0; kept the later row under g0-23.')
  await expect(page.getByRole('button', { name: 'Import 21 runs (skip 1)' })).toBeEnabled()
})

test('CARLA results attach to the matching runs and their failure is listed', async ({ page }) => {
  await newProject(page)
  await importTable(page, 'scenario_runs.csv', example('scenario_runs.csv').text.toString())
  await section(page, 'Data & ODD')
  await drop(page, example('carla_results.json'))
  await expect(page.getByText('CARLA results for 10 scenarios, 1 failed.')).toBeVisible()
  await expect(page.getByText('10 matched · 0 unmatched')).toBeVisible()
  await page.getByRole('button', { name: 'Import results' }).click()
  await expect(page.locator('.worklist tr', { hasText: 'EX-0056' })).toContainText('Collision')
  await section(page, 'Overview')
  // All 60 runs now have a verdict.
  await expect(kpi(page, 'Failure rate')).toContainText('of 60 judged runs')
})

test('leaderboard results need a completed route with no infractions', async ({ page }) => {
  await newProject(page)
  await importTable(page, 'runs.csv', 'run_id,weather,light\nR1,rain,day\nR2,dry,night\nR3,dry,day\n')
  await section(page, 'Data & ODD')
  await drop(page, { name: 'results.json', text: JSON.stringify({ _checkpoint: { records: [
    { route_id: 'R1', status: 'Completed', infractions: { collisions_vehicle: [] } },
    { route_id: 'R2', status: 'Completed', infractions: { collisions_vehicle: ['hit'] } },
    { route_id: 'R3', status: 'Failed - Agent timed out', infractions: {} }] } }) })
  await expect(page.getByText('3 scenarios, 2 failed')).toBeVisible()
  await page.getByRole('button', { name: 'Import results' }).click()
  await expect(page.locator('.worklist tr', { hasText: 'R2' })).toContainText('Collision')
  await expect(page.locator('.worklist tr', { hasText: 'R3' })).toContainText('Failed - Agent timed out')
})

test('example trajectory: measured, replayed and matched by run id', async ({ page }) => {
  await newProject(page)
  await importTable(page, 'scenario_runs.csv', example('scenario_runs.csv').text.toString())
  await section(page, 'Data & ODD')
  await drop(page, example('trajectory_run.csv'))
  await expect(page.getByText('headings in degrees (converted)')).toBeVisible()
  await page.getByRole('button', { name: 'Compute metrics and save' }).click()
  await expect(page.locator('.replay-stage svg')).toBeVisible()
  await page.getByRole('button', { name: 'Pause' }).click()
  await expect(page.getByRole('button', { name: 'Play' })).toBeVisible()
})

test('esmini dat2csv is read as written and asks for the ego footprint', async ({ page }) => {
  await newProject(page)
  await drop(page, { name: 'cut-in.csv', text: 'Version: 2, OpenDRIVE: e6mini.xodr, 3D model: e6mini.osgb\ntime, id, name, x, y, z, h, p, r, speed, wheel_angle, wheel_rot\n0.000, 0, Ego, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 20.0, 0.0, 0.0\n0.000, 1, Target, 60.0, 0.0, 0.0, 0.0, 0.0, 0.0, 20.0, 0.0, 0.0\n1.000, 0, Ego, 20.0, 0.0, 0.0, 0.0, 0.0, 0.0, 20.0, 0.0, 0.0\n1.000, 1, Target, 80.0, 0.0, 0.0, 0.0, 0.0, 0.0, 20.0, 0.0, 0.0\n' })
  await page.getByRole('button', { name: 'Passenger car' }).click()
  await page.getByRole('button', { name: 'Compute metrics and save' }).click()
  await expect(page.getByText('New project. Import a scenario table')).toHaveCount(0)
})

test('gap list, worklist and recommendations download', async ({ page }) => {
  await newProject(page)
  await importTable(page, 'four.csv', FOUR)
  await section(page, 'Coverage')
  const gaps = await downloaded(page, 'Download CSV')
  expect(gaps.name).toBe('coverage-gaps.csv')
  expect(gaps.text.split('\n')[0]).toBe('parameter_a,bin_a,parameter_b,bin_b,priority')
  expect(gaps.text.trim().split('\n')).toHaveLength(1 + 13)
  await section(page, 'Failures')
  await page.getByLabel('Status of r1').selectOption('triaged')
  await expect(page.getByLabel('Status of r1')).toHaveValue('triaged')
  await page.getByLabel('Note for r1').fill('say "hi", ok')
  await page.getByLabel('Note for r1').blur()
  // The note is saved in the background; the export carries it once it is.
  await expect(async () => {
    const work = await downloaded(page, 'Download CSV')
    expect(work.text).toContain('r1,r1,rain,day,0,TTC 1.00 s < 1.5 s,1,triaged,"say ""hi"", ok"')
  }).toPass()
  await section(page, 'Next scenarios')
  const recs = await downloaded(page, 'Download CSV')
  expect(recs.text.split('\n')[0]).toBe('id,weather,light,gap,kind,reason')
  expect(recs.text).toContain('REC-001,')
})

test('the OpenSCENARIO export imports again as the same runs', async ({ page }) => {
  await newProject(page)
  await drop(page, example('cut_in_sweep.xosc'), example('cut_in.xosc'))
  await page.getByRole('button', { name: 'Import 24 scenarios' }).click()
  await section(page, 'Next scenarios')
  await page.getByLabel('Scenario file referenced in the distribution').fill('cut_in.xosc')
  const x = await downloaded(page, 'Download OpenSCENARIO')
  const sets = x.text.match(/<ParameterValueSet>/g)!.length
  expect(x.text).toContain('parameterRef="rel_speed"')
  expect(x.text).not.toContain('init_speed')
  await section(page, 'Data & ODD')
  await drop(page, { name: 'recommended-scenarios.xosc', text: x.text }, example('cut_in.xosc'))
  await expect(page.getByText(`${sets} planned runs`)).toBeVisible()
  await expect(page.getByText('ego_speed, gap, rel_speed, weather, lighting').first()).toBeVisible()
})

test('settings export contains the project and only the project', async ({ page }) => {
  await newProject(page)
  await importTable(page, 'four.csv', FOUR)
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Settings' }).click()
  const out = JSON.parse((await downloaded(page, 'Export all my data (JSON)')).text)
  expect(Object.keys(out)).toEqual(['app', 'exportedAt', 'projects'])
  expect(out.projects).toHaveLength(1)
  expect(out.projects[0].campaigns[0].runs.map((r: { id: string }) => r.id)).toEqual(['r1', 'r2', 'r3', 'r4'])
})

const REJECTED: [string, string, string | Buffer, RegExp][] = [
  ['empty file', 'empty.csv', '', /Could not read empty\.csv: The file has a header but no data rows/],
  ['header only', 'head.csv', 'run_id,weather\n', /The file has a header but no data rows/],
  ['truncated JSON', 'cut.json', '{"runs":[{"id":"a","weather":"ra', /Could not read cut\.json/],
  ['truncated CARLA results', 'cut.json', '[{"scenario":"a","success":true,"criteria":[{"name":"Coll', /Could not read cut\.json/],
  ['JSON without runs', 'x.json', '{"hello":1}', /Expected a JSON array of runs/],
  ['trajectory without rows', 't.csv', 'time,actor_id,x,y\n', /The trajectory file has no data rows/],
  ['trajectory of text', 't.csv', 'time,actor_id,x,y\na,ego,b,c\n', /No usable trajectory rows/],
]
for (const [what, name, text, message] of REJECTED) test(`${what} is refused with a reason`, async ({ page }) => {
  await newProject(page)
  await drop(page, { name, text })
  await expect(page.getByRole('alert')).toHaveText(message)
  await expect(page.getByRole('button', { name: /^Import \d/ })).toHaveCount(0)
})

test('an .xosc without an OpenSCENARIO root cannot be imported', async ({ page }) => {
  await newProject(page)
  await drop(page, { name: 'x.xosc', text: '<html><body>nope</body></html>' })
  await expect(page.getByText('x.xosc: Not an OpenSCENARIO file')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Import 0 scenarios' })).toBeDisabled()
})

test('a table whose columns are all ignored cannot be imported', async ({ page }) => {
  await newProject(page)
  await drop(page, { name: 'ids.csv', text: 'run_id,result\na,pass\n' })
  await expect(issues(page)).toContainText('No column is mapped to an ODD parameter')
  await expect(page.getByRole('button', { name: /^Import 1 runs/ })).toBeDisabled()
})
