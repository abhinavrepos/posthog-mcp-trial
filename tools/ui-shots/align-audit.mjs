import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
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
import { shots, tabs, surveyStates } from './routes.mjs'

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const out = resolve((process.argv[2] === '--' ? process.argv[3] : process.argv[2]) || 'screens/align-audit')
const findings = []
const threshold = 1.5
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
async function capture(page, spec, theme, width, state) {
  const rows = await page.evaluate((threshold) => {
    const selectors = [
      'button', 'a.btn', 'a.button', 'summary', 'select', 'input:not([type=hidden]):not([type=checkbox]):not([type=radio])',
      '[role=tab]', '.chip', '.pill', '.badge', '.st', '.status', '.kpi', '.tile', '.stat',
      'th', 'td', '.status-panel', '.banner', '.alert', '.note', '.conf', '.avatar',
      'header nav a', '.acct-menu a', '.empty', '.empty-state', '.rq-empty', '[role=status]',
      '[role=alert]', '.toast', 'dialog', '[role=dialog]',
    ].join(',')
    const visible = el => {
      const style = getComputedStyle(el), box = el.getBoundingClientRect()
      return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0 && box.width > 0 && box.height > 0 && el.getClientRects().length > 0
    }
    const path = el => {
      const parts = []
      for (let node = el; node?.nodeType === 1 && parts.length < 7; node = node.parentElement) {
        let part = node.localName
        if (node.id) { parts.unshift(`${part}#${CSS.escape(node.id)}`); break }
        if (node.classList.length) part += '.' + [...node.classList].slice(0, 2).map(x => CSS.escape(x)).join('.')
        const siblings = node.parentElement && [...node.parentElement.children].filter(x => x.localName === node.localName)
        if (siblings?.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`
        parts.unshift(part)
      }
      return parts.join(' > ')
    }
    const center = r => ({ x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 })
    const union = rects => ({ left: Math.min(...rects.map(r => r.left)), right: Math.max(...rects.map(r => r.right)), top: Math.min(...rects.map(r => r.top)), bottom: Math.max(...rects.map(r => r.bottom)) })
    const results = []
    for (const el of document.querySelectorAll(selectors)) {
      if (!visible(el) || el.closest('[aria-hidden=true],.sr-only')) continue
      const style = getComputedStyle(el), box = el.getBoundingClientRect()
      const content = { left: box.left + parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft), right: box.right - parseFloat(style.borderRightWidth) - parseFloat(style.paddingRight), top: box.top + parseFloat(style.borderTopWidth) + parseFloat(style.paddingTop), bottom: box.bottom - parseFloat(style.borderBottomWidth) - parseFloat(style.paddingBottom) }
      const composite = el.matches('.kpi,.tile,.stat,.status-panel,.banner,dialog,[role=dialog]')
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
      const textRects = [], text = []
      while (walker.nextNode()) {
        const node = walker.currentNode
        if (!node.textContent.trim()) continue
        if (node.parentElement?.closest('[hidden],[aria-hidden=true],.sr-only')) continue
        const range = document.createRange(); range.selectNodeContents(node)
        for (const rect of range.getClientRects()) if (rect.width && rect.height) textRects.push(rect)
        text.push(node.textContent.trim())
      }
      const icons = [...el.querySelectorAll('svg,.ico, img, i, [class*=icon]')].filter(icon => visible(icon) && !icon.closest('[aria-hidden=true]'))
      const iconRects = icons.map(icon => icon.getBoundingClientRect())
      const nativeControl = el.matches('input,select')
      if (nativeControl) {
        // Native controls do not expose their rendered value as a text node.
        // Use their computed font and content box as an explicit estimate.
        const value = el.value || el.placeholder || el.getAttribute('aria-label') || ''
        if (value) {
          const probe = document.createElement('span')
          probe.textContent = value
          probe.style.cssText = `position:fixed;left:-10000px;top:0;white-space:pre;font:${style.font};letter-spacing:${style.letterSpacing};`
          document.body.append(probe)
          const height = probe.getBoundingClientRect().height
          probe.remove()
          const lineHeight = Number.parseFloat(style.lineHeight) || height
          const y = center(content).y
          textRects.push({ left: content.left, right: content.left + Math.min(content.right - content.left, 1), top: y - lineHeight / 2, bottom: y + lineHeight / 2 })
          text.push(value)
        }
      }
      if (!textRects.length && !iconRects.length) continue
      const all = union([...textRects, ...iconRects])
      const vertical = center(all).y - center(content).y
      const centeredX = style.textAlign === 'center' || ((style.display.includes('flex') || style.display.includes('grid')) && (style.justifyContent === 'center' || style.placeItems.includes('center')))
      const horizontal = centeredX ? center(all).x - center(content).x : null
      const iconText = textRects.length && iconRects.length ? Math.max(0, ...iconRects.map(icon => {
        const sameRow = textRects.filter(rect => Math.abs(center(rect).y - center(icon).y) <= Math.max(rect.height, icon.height))
        return sameRow.length ? Math.min(...sameRow.map(rect => Math.abs(center(rect).y - center(icon).y))) : 0
      })) : 0
      const singleLine = textRects.length === 1 && !composite
      const baselineGap = singleLine ? Math.abs((textRects[0].top - content.top) - (content.bottom - textRects[0].bottom)) : 0
      const offsets = { vertical: +vertical.toFixed(2), horizontal: horizontal === null ? null : +horizontal.toFixed(2), iconText: +iconText.toFixed(2), baselineGap: +baselineGap.toFixed(2) }
      if (Math.max(Math.abs(vertical), Math.abs(horizontal || 0), iconText, baselineGap > 2 ? baselineGap : 0) > threshold) {
        results.push({ selector: path(el), text: text.join(' ').replace(/\s+/g, ' ').slice(0, 120), offsets, measurement: nativeControl ? 'native-control-estimate' : 'rendered-range' })
      }
    }
    return results
  }, threshold)
  findings.push(...rows.map(row => ({ page: spec.name, state: state || 'default', theme, width, ...row,
    worstOffset: Math.max(...Object.values(row.offsets).filter(v => typeof v === 'number').map(Math.abs)) })))
  console.log(`${spec.name}/${state || 'default'} ${theme}: ${rows.length} findings`)
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
  for (const width of [1440]) for (const theme of ['dark', 'light']) {
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

findings.sort((a, b) => b.worstOffset - a.worstOffset)
await writeFile(join(out, 'align-audit.json'), JSON.stringify({ threshold, findings }, null, 2) + '\n')
const lines = [`Alignment audit at 1440 px; threshold ${threshold} px`, `${findings.length} findings`, '', ...findings.map(f => `${f.worstOffset.toFixed(2).padStart(6)} px  ${f.page}/${f.state}/${f.theme}  ${f.selector}\n         ${JSON.stringify(f.offsets)}  ${f.text}`)]
await writeFile(join(out, 'align-audit.txt'), lines.join('\n') + '\n')
console.log(`Reports: ${join(out, 'align-audit.json')} and ${join(out, 'align-audit.txt')}`)
