import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { once } from 'node:events'
import puppeteer from 'puppeteer'
import { DatabaseSync } from 'node:sqlite'
import { admin } from './fixtures.mjs'
import { posthogServer } from './posthog.mjs'
import { statusServer } from './status.mjs'
import { seedDb } from './seed.mjs'
import { shots, tabs, surveyStates, shotName } from './routes.mjs'

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const out = resolve((process.argv[2] === '--' ? process.argv[3] : process.argv[2]) || 'screens/ui')
const temp = await mkdtemp(join(tmpdir(), 'lens-ui-shots-'))
const hog = posthogServer()
const status = statusServer()
let lens, browser
const sleep = ms => new Promise(r => setTimeout(r, ms))
const clearRows = (file, tables) => { const db = new DatabaseSync(file); for (const table of tables) db.exec(`DELETE FROM ${table}`); db.close() }
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
      TRIAGE_DB: join(temp, 'triage.db'), TRIAGE_ENV_FILE: join(temp, 'empty.env'), CLIP_OUT_DIR: join(temp, 'clips'), SERVICE_PORT: String(lensPort), SERVICE_PUBLIC_URL: origin,
      POSTHOG_HOST: `http://127.0.0.1:${hogPort}`, POSTHOG_PUBLIC_HOST: `http://127.0.0.1:${hogPort}`,
      POSTHOG_PROJECT_ID: '1', POSTHOG_PROJECT_TOKEN: 'phc_screen', POSTHOG_PERSONAL_API_KEY: 'phx_screen', POSTHOG_SURVEY_API_KEY: 'phx_screen',
      STATUS_URL: `http://127.0.0.1:${statusPort}`, STATUS_PASSWORD: '', APP_EVENTS_FILE: 'config/app-events.reval.json',
      FEATURE_JIRA: 'off', FEATURE_LENS_MCP: 'on', FEATURE_POSTHOG_MCP: 'off', FEATURE_SURVEYS: 'on',
    },
  })
  let errors = ''
  lens.stderr.on('data', c => { errors += String(c); if (errors.length > 30000) errors = errors.slice(-30000) })
  await ready(origin + '/healthz').catch(e => { throw new Error(`${e.message}\n${errors}`) })
  seedDb(join(temp, 'triage.db'))
  browser = await puppeteer.launch({ headless: 'shell', args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  for (const width of [1440, 375]) for (const theme of ['dark', 'light']) {
    const page = await browser.newPage()
    await page.setViewport({ width, height: 900, deviceScaleFactor: 1 })
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme }])
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
          const button = buttons.find(b => b.textContent?.trim().toLowerCase().startsWith(label.toLowerCase()))
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
      const emptyTables = { replays: ['clip_holders', 'clips'], pinned: ['pinned_graphs'], connect: ['mcp_tokens'], admin: ['people', 'mcp_tokens', 'clip_holders', 'clips', 'audit'] }[spec.name]
      if (emptyTables) {
        clearRows(join(temp, 'triage.db'), emptyTables)
        await page.goto(origin + spec.path, { waitUntil: 'networkidle2', timeout: 30000 })
        await sleep(300)
        await capture(page, spec, theme, width, 'empty')
        seedDb(join(temp, 'triage.db'))
      }
      if (['replays', 'connect', 'admin', 'system', 'live', 'surveys'].includes(spec.name)) {
        // Loading: data requests are held open, so the page shows its skeleton (and, after 1 s, the centred logo).
        const hold = request => {
          const path = new URL(request.url()).pathname
          if (path.startsWith('/replays/') && /\/api(\/|$)/.test(path) || path.startsWith('/status')) return
          request.continue()
        }
        await page.evaluate(() => { try { localStorage.clear(); sessionStorage.clear() } catch {} })
        await page.setCacheEnabled(false)
        await page.setRequestInterception(true)
        page.on('request', hold)
        await page.goto(origin + spec.path, { waitUntil: 'domcontentloaded', timeout: 30000 })
        await sleep(1600)
        await capture(page, spec, theme, width, 'loading')
        page.off('request', hold)
        await page.goto('about:blank')
        await page.setRequestInterception(false)
        await page.setCacheEnabled(true)
      }
      if (['replays', 'connect', 'admin', 'system'].includes(spec.name)) {
        const onRequest = request => {
          const path = new URL(request.url()).pathname
          if (path.startsWith('/replays/') && path.includes('/api/')) request.respond({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Fixture service unavailable' }) })
          else request.continue()
        }
        await page.setRequestInterception(true)
        page.on('request', onRequest)
        await page.goto(origin + spec.path, { waitUntil: 'networkidle2', timeout: 30000 })
        await sleep(300)
        await capture(page, spec, theme, width, 'error')
        page.off('request', onRequest)
        await page.setRequestInterception(false)
      }
      if (spec.name === 'live' || spec.name === 'surveys') for (const mode of ['empty', 'error']) {
        hog.setMode(mode)
        const stateResponse = await page.goto(origin + spec.path, { waitUntil: 'networkidle2', timeout: 30000 })
        if (!stateResponse?.ok()) throw new Error(`${spec.path} ${mode}: HTTP ${stateResponse?.status()}`)
        await sleep(450)
        await capture(page, spec, theme, width, mode)
        hog.setMode('data')
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
