import { test, expect, newProject, importTable, drop, kpi, section, odd, issues, downloaded } from './fixtures.ts'

// Each test states the right behaviour and is expected to fail until its issue is fixed.
// The fix removes the fail marker. Waits are short because most of these never come true today.
const soon = { timeout: 8_000 }
/** The number is the GitHub issue. SHOW_BUGS=1 runs the tests as normal ones, to see why each fails. */
const bug = (issue: number, name: string, body: Parameters<typeof test>[2]) => (process.env.SHOW_BUGS ? test : test.fail)(`#${issue} ${name}`, body)

bug(2, 'CARLA: a record without a verdict is not a pass', async ({ page }) => {
  await newProject(page)
  await importTable(page, 'r.csv', 'run_id,weather,light\na,rain,day\nb,dry,night\n')
  await section(page, 'Data & ODD')
  await drop(page, { name: 'c.json', text: JSON.stringify([{ scenario: 'a', criteria: [] }, { scenario: 'b', success: false, criteria: [] }]) })
  await page.getByRole('button', { name: 'Import results' }).click()
  await section(page, 'Overview')
  await expect(kpi(page, 'Failure rate')).toContainText('1 of 1 judged runs · 1 not run yet', soon)
})

bug(2, 'CARLA: a later pass does not hide an earlier failure of the same run', async ({ page }) => {
  await newProject(page)
  await importTable(page, 'r.csv', 'run_id,weather,light\na,rain,day\nb,dry,night\n')
  await section(page, 'Data & ODD')
  await drop(page, { name: 'c.json', text: JSON.stringify([{ scenario: 'a', success: false, criteria: [{ name: 'CollisionTest', actual: 1, success: false }] }, { scenario: 'a', success: true, criteria: [{ name: 'CollisionTest', actual: 0, success: true }] }]) })
  await page.getByRole('button', { name: 'Import results' }).click()
  await section(page, 'Overview')
  await expect(kpi(page, 'Failure rate')).toContainText('1 of 1 judged runs', soon)
})

test('#3 table: collision counts and float booleans are collisions', async ({ page }) => {
  await newProject(page)
  await importTable(page, 'r.csv', 'run_id,weather,light,collision\na,rain,day,1.0\nb,dry,night,2\nc,dry,day,0.0\n')
  await expect(kpi(page, 'Failure rate')).toContainText('2 of 3 judged runs', soon)
})

test('#3 table: braking and lane offset with a minus sign are judged by size', async ({ page }) => {
  await newProject(page)
  await importTable(page, 'r.csv', 'run_id,weather,light,max_decel,lane_offset\na,rain,day,-7.2,0\nb,dry,night,-1,-1.4\nc,dry,day,-1,0.2\n')
  await expect(kpi(page, 'Failure rate')).toContainText('2 of 3 judged runs', soon)
})

bug(4, 'trajectories change one campaign only', async ({ page }) => {
  await newProject(page)
  const t = 'run_id,weather,light,min_ttc\na,rain,day,4\nb,dry,night,4\n'
  await importTable(page, 'r.csv', t, { label: 'One', date: '2026-01-01' })
  await section(page, 'Data & ODD')
  await importTable(page, 'r.csv', t, { label: 'Two', date: '2026-02-01' })
  await section(page, 'Data & ODD')
  await drop(page, { name: 't.csv', text: 'run_id,time,actor_id,x,y,heading_rad,speed,length,width\na,0,ego,0,0,0,10,4.8,1.9\na,0,car,10,0,0,0,4.8,1.9\na,1,ego,10,0,0,10,4.8,1.9\na,1,car,10,0,0,0,4.8,1.9\n' })
  await page.getByRole('button', { name: 'Compute metrics and save' }).click()
  await section(page, 'History')
  await expect(page.getByRole('row', { name: /^One / })).toContainText('100.0%0.0%', soon)
  await expect(page.getByRole('row', { name: /^Two / })).toContainText('100.0%50.0%', soon)
})

bug(4, 'a run id used in two campaigns keeps its own verdict', async ({ page }) => {
  await newProject(page)
  await importTable(page, 'r.csv', 'run_id,weather,light,min_ttc\na,rain,day,1\nb,dry,night,4\n', { label: 'One', date: '2026-01-01' })
  await section(page, 'Data & ODD')
  await importTable(page, 'r.csv', 'run_id,weather,light,min_ttc\na,rain,day,4\nb,dry,night,4\n', { label: 'Two', date: '2026-02-01' })
  await section(page, 'Coverage')
  await page.getByRole('button', { name: /Weather rain × Light day/ }).click()
  await expect(page.locator('.table-wrap .badge')).toHaveText(['fail', 'pass'], soon)
})

bug(5, 'a project with one ODD parameter opens', async ({ page }) => {
  await newProject(page)
  await drop(page, { name: 'r.csv', text: 'run_id,weather,min_ttc\na,rain,1\nb,dry,4\n' })
  await page.getByRole('button', { name: /^Import 2 runs/ }).click()
  await expect(kpi(page, '1-way coverage').locator('b')).toHaveText('100.0%', soon)
  await section(page, 'Coverage')
  await expect(page.locator('.ow')).toHaveCount(1, soon)
})

bug(5, 'a fractional bin count does not break the project', async ({ page }) => {
  await newProject(page)
  await importTable(page, 'r.csv', 'run_id,weather,gap,min_ttc\na,rain,0,1\nb,dry,30,4\n')
  await section(page, 'Data & ODD')
  await odd(page, 'gap').getByLabel('Bins for gap').fill('2.5')
  await section(page, 'Overview')
  await expect(kpi(page, '1-way coverage')).toBeVisible(soon)
})

const PLANNED = 'run_id,weather,gap,min_ttc\n' + [...Array(6)].map((_, i) => `f${i},rain,5,1\np${i},rain,8,\nk${i},rain,45,4\n`).join('')
bug(6, 'planned runs are not evidence of passing', async ({ page }) => {
  await newProject(page)
  await importTable(page, 'r.csv', PLANNED)
  // Only gap 5 (fails) and gap 45 (passes) were run; the rule splits halfway between them, at 25.
  await expect(page.locator('.rules li b')).toHaveText(['Fails when Gap < 25'], soon)
  await section(page, 'Next scenarios')
  await expect(page.locator('td', { hasText: /Between failing f\d and passing k\d/ }).first()).toBeVisible(soon)
  await expect(page.locator('td', { hasText: /passing p\d/ })).toHaveCount(0, soon)
})

bug(6, 'a campaign that was not run has no failure rate', async ({ page }) => {
  await newProject(page)
  await importTable(page, 'r.csv', 'run_id,weather,light\na,rain,day\nb,dry,night\n', { label: 'Plan' })
  await section(page, 'History')
  await expect(page.getByRole('row', { name: /^Plan / })).toContainText('100.0%—', { timeout: 8000 })
})

bug(7, 'table: an unclosed quote is an error, not one big cell', async ({ page }) => {
  await newProject(page)
  await drop(page, { name: 'r.csv', text: 'run_id,weather,light\na,"rain,day\nb,dry,night\nc,dry,day\n' })
  await expect(page.getByRole('alert')).toContainText('line 2', soon)
})

bug(7, 'table: rows with the wrong number of cells are skipped', async ({ page }) => {
  await newProject(page)
  await drop(page, { name: 'r.csv', text: 'run_id,weather,gap,result\na,rain,3,5,fail\nb,rain,4\nc,dry,5,fail\nd,dry,6,pass\n' })
  await expect(issues(page)).toContainText('line 2', soon)
  await expect(page.getByRole('button', { name: 'Import 2 runs (skip 2)' })).toBeEnabled(soon)
})

for (const [what, name, data] of [['an Excel workbook', 'r.csv', Buffer.from([0x50, 0x4b, 3, 4, 0x14, 0, 8, 0, 10, 0x61, 0x2c, 0x62, 10, 1, 2])], ['a UTF-16 file', 'r.txt', Buffer.from('﻿run_id\tweather\tlight\r\na\train\tday\r\nb\tdry\tnight\r\n', 'utf16le')], ['an HTML page', 'r.csv', Buffer.from('<!doctype html>\n<html>\n<p>Sign in, please</p>\n</html>\n')]] as const)
  bug(7, `table: ${what} is refused`, async ({ page }) => {
    await newProject(page)
    await drop(page, { name, text: data })
    await expect(page.getByRole('alert')).toContainText(`Could not read ${name}`, soon)
  })

bug(8, 'trajectory: driving straight north has no lane offset', async ({ page }) => {
  await newProject(page)
  await importTable(page, 'r.csv', 'run_id,weather,gap\nT1,rain,40\nT2,dry,50\n')
  await section(page, 'Data & ODD')
  await drop(page, { name: 't.csv', text: 'run_id,time,actor_id,x,y,heading_deg,speed,length,width\n' + [0, 1, 2].map(t => `T1,${t},ego,0,${20 * t},90,20,4.8,1.9\n`).join('') })
  await page.getByRole('button', { name: 'Compute metrics and save' }).click()
  await expect(page.locator('.metric', { hasText: 'Lane offset' }).locator('b')).toHaveText('0.00', soon)
})

bug(10, 'a truncated .xosc is refused', async ({ page }) => {
  await newProject(page)
  await drop(page, { name: 'x.xosc', text: '<?xml version="1.0"?>\n<OpenSCENARIO>\n<ParameterDeclarations><ParameterDeclaration name="A" parameterType="double" value="5"/></ParameterDeclarations>\n<Entities><ScenarioObject name="Eg' })
  await expect(page.getByRole('button', { name: 'Import 0 scenarios' })).toBeDisabled(soon)
})

bug(11, 'dropping two tables does not silently lose one', async ({ page }) => {
  await newProject(page)
  await drop(page, { name: 'a.csv', text: 'run_id,weather,light\na,rain,day\n' }, { name: 'b.csv', text: 'run_id,weather,light\nb,dry,night\n' })
  await expect(page.locator('.data-tab')).toContainText('b.csv', soon)
})

bug(12, 'a JSON table with a success column keeps its parameters', async ({ page }) => {
  await newProject(page)
  await drop(page, { name: 'r.json', text: JSON.stringify([{ id: 'a', weather: 'rain', light: 'day', success: true }, { id: 'b', weather: 'dry', light: 'night', success: false }]) })
  await expect(page.getByText('Scenario parameter table (JSON)')).toBeVisible(soon)
  await page.getByRole('button', { name: /^Import 2 runs/ }).click(soon)
})

bug(13, 'exports do not carry spreadsheet formulas', async ({ page }) => {
  await newProject(page)
  await importTable(page, 'r.csv', 'run_id,scenario,weather,light,min_ttc\na,"=HYPERLINK(""http://x.test"",""go"")",rain,day,1\nb,s,dry,night,4\n')
  await section(page, 'Failures')
  expect((await downloaded(page, 'Download CSV')).text).not.toMatch(/(^|[,"\n])=HYPERLINK/)
})

bug(14, 'a negative ODD bound can be typed', async ({ page }) => {
  await newProject(page)
  await importTable(page, 'r.csv', 'run_id,weather,gap\na,rain,0\nb,dry,30\n')
  await section(page, 'Data & ODD')
  const min = page.getByLabel('Minimum gap')
  await min.press('Control+a')
  await min.pressSequentially('-30', { delay: 150 })
  await expect(min).toHaveValue('-30', soon)
})

bug(15, 'looking at a category with a comma does not split it', async ({ page }) => {
  await newProject(page)
  await importTable(page, 'r.csv', 'run_id,weather,light\na,"rain, heavy",day\nb,dry,night\n')
  await section(page, 'Data & ODD')
  await page.getByLabel('Categories of weather').focus()
  await page.getByLabel('Categories of light').focus()
  await section(page, 'Overview')
  await expect(kpi(page, 'Untested 2-way gaps')).toContainText('all runs inside the ODD', soon)
})

bug(16, 'recommendations reach the middle bins of a small range', async ({ page }) => {
  await newProject(page)
  await importTable(page, 'r.csv', 'run_id,weather,curvature\na,rain,0\nb,dry,0.01\n')
  await section(page, 'Next scenarios')
  // 2 x 5 cells; the gap-fill runs alone can cover all of them.
  await expect(kpi(page, 'After these \\d+ runs').locator('b')).toHaveText('100.0%', soon)
})

bug(9, 'trajectory: a missing heading column is not read as "facing +x"', async ({ page }) => {
  await newProject(page)
  await importTable(page, 'r.csv', 'run_id,weather,gap\nT1,rain,40\nT2,dry,50\n')
  await section(page, 'Data & ODD')
  // Driving north at 10 m/s towards a stopped car 30.2 m ahead, edge to edge.
  await drop(page, { name: 't.csv', text: 'run_id,time,actor_id,x,y,speed,length,width\n' + [0, 1, 2].map(t => `T1,${t},ego,0,${10 * t},10,4.8,1.9\nT1,${t},car,0,35.5,0,4.8,1.9\n`).join('') })
  await expect(issues(page)).toContainText('heading', soon)
})

bug(17, 'a note and a status set right after each other are both kept', async ({ page }) => {
  await newProject(page)
  await importTable(page, 'r.csv', 'run_id,weather,light,min_ttc\na,rain,day,1\nb,dry,night,4\n')
  await section(page, 'Failures')
  await page.getByLabel('Note for a').fill('JIRA-1')
  // Leaving the note and choosing a status before the first save has finished.
  await page.getByLabel('Status of a').evaluate((s: HTMLSelectElement) => { (document.activeElement as HTMLElement).blur(); s.value = 'triaged'; s.dispatchEvent(new Event('change', { bubbles: true })) })
  await expect(page.getByLabel('Status of a')).toHaveValue('triaged')
  await page.reload()
  await expect(page.getByLabel('Status of a')).toHaveValue('triaged')
  await expect(page.getByLabel('Note for a')).toHaveValue('JIRA-1', soon)
})
