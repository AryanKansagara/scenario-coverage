import { test, expect, newProject, importTable, drop, example, kpi, section, odd, FOUR } from './fixtures.ts'

// Every number in this file was worked out on paper from the documented definitions.

test('coverage, failure rate and gaps of a four-run table', async ({ page }) => {
  await newProject(page)
  await importTable(page, 'four.csv', FOUR)
  // gap spans 0 to 30 in 5 bins of 6 m: 0 is bin 1, 13 is bin 3, 30 is bin 5.
  // 1-way: weather 2/2, light 2/2, gap 3/5 = 7/9 = 77.8%.
  await expect(kpi(page, '1-way coverage').locator('b')).toHaveText('77.8%')
  // weather x light 4/4; weather x gap: rain-1, clear-3, rain-5 = 3/10; light x gap: day-1, day-3, night-5, night-3 = 4/10.
  // Together 11/24 = 45.8%, 13 gaps.
  await expect(kpi(page, 'Pairwise ODD coverage')).toContainText('45.8%')
  await expect(kpi(page, 'Pairwise ODD coverage')).toContainText('11 of 24 2-way cells')
  await expect(kpi(page, 'Untested 2-way gaps').locator('b')).toHaveText('13')
  // r1 fails on TTC 1.0 < 1.5, r3 on gap 0.5 < 1.0, r2 passes, r4 has no result: 2 of 3 = 66.7%.
  await expect(kpi(page, 'Failure rate')).toContainText('66.7%')
  await expect(kpi(page, 'Failure rate')).toContainText('2 of 3 judged runs · 1 not run yet')
  await section(page, 'Failures')
  await expect(page.locator('.worklist tbody tr')).toHaveCount(2)
  await expect(page.locator('.worklist')).toContainText('TTC 1.00 s < 1.5 s')
  await expect(page.locator('.worklist')).toContainText('Min gap 0.50 m < 1 m')
})

test('a bound moved in the ODD editor rebins the runs', async ({ page }) => {
  await newProject(page)
  await importTable(page, 'four.csv', FOUR)
  await section(page, 'Data & ODD')
  await odd(page, 'gap').getByLabel('Bins for gap').fill('3')
  await odd(page, 'gap').getByLabel('Maximum gap').fill('15')
  await section(page, 'Overview')
  // 0 to 15 in 3 bins of 5 m: 0 is bin 1, 13 is bin 3, 30 is outside. 1-way 2 + 2 + 2 of 7 = 85.7%.
  await expect(kpi(page, '1-way coverage').locator('b')).toHaveText('85.7%')
  // weather x light 4/4, weather x gap: rain-1, clear-3 = 2/6, light x gap: day-1, day-3, night-3 = 3/6: 9/16 = 56.3%.
  await expect(kpi(page, 'Pairwise ODD coverage')).toContainText('9 of 16 2-way cells')
  await expect(kpi(page, 'Untested 2-way gaps')).toContainText('1 runs outside the ODD')
})

const CAR = 'run_id,time,actor_id,x,y,heading_rad,speed,length,width\n'
/** The ego closes on a slower car, drifts 0.4 m left and brakes from 20 to 17 m/s in the last second. */
const CLOSING = CAR + [[0, 0, 0, 20, 45.05], [1, 20, 0, 20, 55.05], [2, 40, 0.4, 17, 65.05]]
  .map(([t, x, y, v, lead]) => `T1,${t},ego,${x},${y},0,${v},4.8,1.9\nT1,${t},lead,${lead},0,0,10,4.8,1.9\n`).join('')

test('TTC, gap, braking, jerk and lane offset of a three-sample trajectory', async ({ page }) => {
  await newProject(page)
  await importTable(page, 'runs.csv', 'run_id,weather,gap\nT1,rain,40\nT2,dry,50\n')
  await section(page, 'Data & ODD')
  await drop(page, { name: 'traj.csv', text: CLOSING })
  await expect(page.getByText('1 match existing runs by id')).toBeVisible()
  await page.getByRole('button', { name: 'Compute metrics and save' }).click()
  const metric = (name: string) => page.locator('.metric', { has: page.locator('small', { hasText: name }) }).locator('b')
  // Edge to edge the gap is 40.25, 30.25 and 20.25 m. TTC is 40.25/10, 30.25/10, then 20.25/7 = 2.893 s,
  // reported at the first 20 ms step after contact: 2.90 s.
  await expect(metric('Min TTC')).toHaveText('2.90')
  await expect(metric('Min gap')).toHaveText('20.25')
  // 20 to 17 m/s in 1 s; the acceleration goes from 0 to -3 m/s2 in 1 s.
  await expect(metric('Max decel')).toHaveText('3.00')
  await expect(metric('Max jerk')).toHaveText('3.00')
  await expect(metric('Lane offset')).toHaveText('0.40')
  // The ego (x up to 40, half length 2.4) never reaches road the lead stood on (from 45.05 - 2.4).
  await expect(metric('Min PET')).toHaveText('—')
  await expect(page.locator('.badge.pass')).toHaveText('pass')
})

test('a rear-end overlap is a collision and fails the run', async ({ page }) => {
  await newProject(page)
  await drop(page, { name: 'traj.csv', text: CAR + 'T1,0,ego,0,0,0,10,4.8,1.9\nT1,0,lead,10,0,0,0,4.8,1.9\nT1,1,ego,10,0,0,10,4.8,1.9\nT1,1,lead,10,0,0,0,4.8,1.9\n' })
  await page.getByRole('button', { name: 'Compute metrics and save' }).click()
  await importTable(page, 'runs.csv', 'run_id,weather,gap\nT2,rain,40\nT3,dry,50\n')
  await expect(kpi(page, 'Failure rate')).toContainText('1 of 1 judged runs · 2 not run yet')
  await section(page, 'Failures')
  await expect(page.locator('.worklist tbody tr')).toContainText('Collision; TTC 0.00 s < 1.5 s')
})

test('the example sweep expands to 24 planned runs with hand-counted coverage', async ({ page }) => {
  await newProject(page)
  await drop(page, example('cut_in_sweep.xosc'), example('cut_in.xosc'))
  // 2 value sets x 3 speeds x 4 gaps (10, 25, 40, 55).
  await expect(page.getByText('24 planned runs')).toBeVisible()
  await page.getByRole('button', { name: 'Import 24 scenarios' }).click()
  // Bins: ego_speed 60-105 by 9: 72, 88, 104 = 3/5. gap 5-60 by 11: 10, 25, 40, 55 = 4/5. rel_speed -30..10 by 8: -8 = 1/5.
  // Ego init 20, 24.4, 28.9 m/s in 20-30 by 2 = 3/5. Car init 17.8, 22.2, 26.7 in 15-30 by 3 = 3/5. weather 2/2, lighting 2/2.
  // 18 of 29 = 62.1%.
  await expect(kpi(page, '1-way coverage').locator('b')).toHaveText('62.1%')
  // Planned runs carry no verdict.
  await expect(kpi(page, 'Failure rate')).toContainText('0 of 0 judged runs · 24 not run yet')
})

test('campaign history: cumulative coverage and the comparison of two campaigns', async ({ page }) => {
  await newProject(page)
  await importTable(page, 'a.csv', 'run_id,weather,light,min_ttc\na1,rain,day,4\na2,clear,night,1\n', { label: 'First', date: '2026-01-01' })
  await section(page, 'Data & ODD')
  await importTable(page, 'b.csv', 'run_id,weather,light,min_ttc\nb1,rain,night,1\nb2,rain,day,1\nb3,rain,day,3\nb4,rain,day,3\n', { label: 'Second', date: '2026-02-01' })
  await section(page, 'History')
  const row = (n: string) => page.getByRole('row', { name: new RegExp(`^${n} `) })
  // One pair of 2 x 2 cells. First covers rain-day and clear-night (50%), 1 of 2 fails.
  await expect(row('First')).toContainText('50.0%50.0%')
  // Second adds rain-night: 3 of 4 cells cumulative. 2 of its 4 runs fail.
  await expect(row('Second')).toContainText('75.0%50.0%')
  // Second alone covers rain-night and rain-day. Rain-night is new, clear-night is only in First.
  await expect(kpi(page, 'Newly covered cells')).toContainText('1')
  await expect(kpi(page, 'Newly covered cells')).toContainText('1 cells only the baseline touched')
  await expect(kpi(page, 'Together').locator('b')).toHaveText('75.0%')
})
