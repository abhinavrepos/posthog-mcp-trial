import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { once } from 'node:events'
import puppeteer from 'puppeteer'
import { admin } from './fixtures.mjs'
import { posthogServer } from './posthog.mjs'
import { statusServer } from './status.mjs'
import { seedDb, seedTasks } from './seed.mjs'
import { shots, tabs, surveyStates, shotName } from './routes.mjs'

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const out = resolve((process.argv[2] === '--' ? process.argv[3] : process.argv[2]) || 'screens/ui')
const temp = await mkdtemp(join(tmpdir(), 'lens-ui-shots-'))
const hog = posthogServer()
const status = statusServer()
let lens, browser
const sleep = ms => new Promise(r => setTimeout(r, ms))
const listen = async server => { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return server.address().port }
const availablePort = async () => { const { createServer } = await import('node:net'); const s = createServer(); const p = await listen(s); await new Promise(r => s.close(r)); return p }
async function ready(url) {
  for (let i = 0; i < 100; i++) { if (lens.exitCode !== null) throw new Error(`Lens exited with ${lens.exitCode}`); try { if ((await fetch(url)).ok) return } catch {} await sleep(100) }
  throw new Error('Lens did not start within 10 seconds')
}
async function capture(page, spec, theme, width, tab) {
  const file = join(out, shotName(spec.name, tab, theme, width))
  await page.screenshot({ path: file, fullPage: true })
  console.log(file)
}
try {
  await mkdir(out, { recursive: true })
  const hogPort = await listen(hog), statusPort = await listen(status), lensPort = await availablePort()
  const origin = `http://127.0.0.1:${lensPort}`
  lens = spawn(process.execPath, ['--import', 'tsx', 'src/service/server.ts'], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env,
      TRIAGE_DB: join(temp, 'triage.db'), TRIAGE_ENV_FILE: join(temp, 'empty.env'), TASKS_DB: join(temp, 'tasks.db'), CLIP_OUT_DIR: join(temp, 'clips'), SERVICE_PORT: String(lensPort), SERVICE_PUBLIC_URL: origin,
      POSTHOG_HOST: `http://127.0.0.1:${hogPort}`, POSTHOG_PUBLIC_HOST: `http://127.0.0.1:${hogPort}`,
      POSTHOG_PROJECT_ID: '1', POSTHOG_PROJECT_TOKEN: 'phc_screen', POSTHOG_PERSONAL_API_KEY: 'phx_screen', POSTHOG_SURVEY_API_KEY: 'phx_screen',
      STATUS_URL: `http://127.0.0.1:${statusPort}`, STATUS_PASSWORD: '', APP_EVENTS_FILE: '',
      FEATURE_JIRA: 'off', FEATURE_LENS_MCP: 'off', FEATURE_POSTHOG_MCP: 'off', FEATURE_SURVEYS: 'on',
    },
  })
  let errors = ''
  lens.stderr.on('data', c => { errors += String(c); if (errors.length > 30000) errors = errors.slice(-30000) })
  await ready(origin + '/healthz').catch(e => { throw new Error(`${e.message}\n${errors}`) })
  seedDb(join(temp, 'triage.db'))
  seedTasks(join(temp, 'tasks.db'))
  browser = await puppeteer.launch({ headless: 'shell', args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  for (const width of [1440, 375]) for (const theme of ['dark', 'light']) {
    const page = await browser.newPage()
    await page.setViewport({ width, height: 900, deviceScaleFactor: 1 })
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme }])
    // Both UI generations support media preference. New UI additionally supports data-theme.
    await page.evaluateOnNewDocument(value => { document.documentElement.dataset.theme = value }, theme)
    await page.setCookie({ name: 'sessionid', value: admin.session, url: origin })
    for (const spec of shots) {
      if (spec.signedOut) await page.deleteCookie({ name: 'sessionid', url: origin })
      else await page.setCookie({ name: 'sessionid', value: admin.session, url: origin })
      const response = await page.goto(origin + spec.path, { waitUntil: 'networkidle2', timeout: 30000 })
      if (!response?.ok()) throw new Error(`${spec.path}: HTTP ${response?.status()}`)
      await sleep(500)
      await capture(page, spec, theme, width)
      const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth)
      if (scrollWidth > width + 2) console.warn(`Horizontal page overflow: ${spec.name} ${theme} ${width}px viewport, ${scrollWidth}px document`)
      for (const tab of tabs[spec.name] || []) {
        const clicked = await page.evaluate(label => {
          const buttons = [...document.querySelectorAll('[role=tab], [data-tab]')]
          const button = buttons.find(b => b.textContent?.trim().toLowerCase() === label.toLowerCase())
          if (!button) return false
          button.click(); return true
        }, tab)
        if (clicked) { await sleep(180); await capture(page, spec, theme, width, tab) }
      }
      if (spec.name === 'surveys') for (const state of surveyStates) {
        const clicked = await page.evaluate(value => {
          const button = document.querySelector(`[data-status="${value}"]`)
          if (!button) return false
          button.click()
          document.querySelector('#list .item')?.click()
          return true
        }, state)
        if (clicked) { await sleep(250); await capture(page, spec, theme, width, state) }
      }
    }
    await page.close()
  }
} finally {
  await browser?.close().catch(() => {})
  if (lens) { lens.kill('SIGTERM'); await Promise.race([once(lens, 'exit'), sleep(2000)]).catch(() => {}) }
  await new Promise(r => hog.close(r))
  await new Promise(r => status.close(r))
  await rm(temp, { recursive: true, force: true })
}
