import { test as base, expect, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'

/** The only other hosts the page asks for: web fonts in index.html. They are answered with an empty stylesheet. */
const FONT_HOSTS = new Set(['fonts.googleapis.com', 'fonts.gstatic.com'])

/** Every page is signed out, cannot reach another host, and must not throw. */
export const test = base.extend<{ guard: void }>({
  guard: [async ({ page, context, baseURL }, use) => {
    const origin = new URL(baseURL!).origin
    const outside: string[] = [], errors: string[] = []
    await context.route(u => /^https?:/.test(u.protocol) && u.origin !== origin, route => {
      const u = new URL(route.request().url())
      if (FONT_HOSTS.has(u.hostname)) return route.fulfill({ contentType: 'text/css', body: '' })
      outside.push(u.href)
      return route.abort()
    })
    page.on('pageerror', e => errors.push(e.message))
    await use()
    expect(errors, 'uncaught page errors').toEqual([])
    expect(outside, 'requests to other hosts').toEqual([])
  }, { auto: true }],
})
export { expect }

export interface Upload { name: string; text: string | Buffer }
export const example = (name: string): Upload => ({ name, text: readFileSync(new URL(`../public/examples/${name}`, import.meta.url)) })

/** Creates an empty project and lands on its Data & ODD tab. */
export async function newProject(page: Page): Promise<string> {
  await page.goto('/app')
  await page.getByRole('button', { name: /^(Import your data|New project)$/ }).first().click()
  await expect(page.getByRole('heading', { name: 'Import', exact: true })).toBeVisible()
  return page.url().match(/\/p\/([\w-]+)/)![1]
}

export const drop = (page: Page, ...files: Upload[]) =>
  page.locator('input[type=file]').setInputFiles(files.map(f => ({ name: f.name, mimeType: 'application/octet-stream', buffer: Buffer.from(f.text) })))

export async function importTable(page: Page, name: string, text: string, opts: { label?: string; date?: string } = {}) {
  await drop(page, { name, text })
  if (opts.label) await page.getByLabel('Campaign name').fill(opts.label)
  if (opts.date) await page.getByLabel('Campaign date').fill(opts.date)
  await page.getByRole('button', { name: /^Import \d+ runs/ }).click()
  await expect(page.locator('.kpis').first()).toBeVisible()
}

export const section = (page: Page, name: string) => page.getByRole('navigation', { name: 'Project sections' }).getByRole('link', { name, exact: true }).click()
export const kpi = (page: Page, name: string) => page.locator('.kpi', { has: page.locator('small', { hasText: new RegExp(`^${name}$`) }) })
export const odd = (page: Page, key: string) => page.locator('.odd-table tbody tr', { has: page.getByRole('cell', { name: key, exact: true }) })
export const issues = (page: Page) => page.locator('.issues')

export async function downloaded(page: Page, button: string): Promise<{ name: string; text: string }> {
  const [d] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: button, exact: true }).first().click()])
  return { name: d.suggestedFilename(), text: readFileSync(await d.path(), 'utf8') }
}

/** Small table used by several specs; its coverage is worked out in hand-worked.spec.ts. */
export const FOUR = 'run_id,weather,light,gap,min_ttc,min_distance,result\nr1,rain,day,0,1.0,,\nr2,clear,day,13,4,,\nr3,rain,night,30,,0.5,\nr4,clear,night,13,,,\n'
