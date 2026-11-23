// Run node first-open.mjs with Playwright 1.55 and Chromium installed.
// FIRST_OPEN_ARRAY can point to the original 1.443.0 array.js from the PostHog web image.
// FIRST_OPEN_REAL_TIME=1 uses wall-clock waits. The default advances the browser clock.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const beside = (path) => fileURLToPath(new URL(path, import.meta.url))
const token = 'phc_first_open'
const surveyId = 'f7dd26ab-753b-401a-b31a-0a8dd0099fec'
const trigger = 'lens_chain:first-open'
const firstUser = 'ENV|SITE|SEM|first'
const nextUser = 'ENV|SITE|SEM|next'
const exact = (value) => ({ operator: 'exact', values: [value] })
const survey = {
    id: surveyId,
    name: 'Hedge Designation feedback',
    type: 'popover',
    questions: [{ type: 'open', question: 'How was Hedge Designation?' }],
    start_date: '2025-01-01T00:00:00Z',
    end_date: null,
    conditions: {
        events: { values: [{ name: trigger }] },
        lensChain: {
            version: 2,
            id: 'first-open',
            steps: [{
                event: 'PageView',
                properties: { action: exact('OPEN'), dialog_id: exact('DlgHedgeDesigListReport') },
            }],
            withinSeconds: 600,
            audience: { clients: ['SEM'], distinctIdPart: 3 },
            ready: { documentComplete: true, noVisibleMask: true, maxWaitMs: 30000 },
        },
    },
}
const signals = {
    shown: ({ captured }) => captured.filter(({ event }) => event === 'survey shown'),
    activated: ({ captured }) => captured.filter(({ event }) => event === trigger),
}

async function originalCore(work) {
    if (process.env.FIRST_OPEN_ARRAY) return process.env.FIRST_OPEN_ARRAY
    const response = await fetch('https://cdn.jsdelivr.net/npm/posthog-js@1.443.0/dist/array.js',
        { signal: AbortSignal.timeout(20000) })
    assert.ok(response.ok, `Couldn't download the 1.443.0 SDK (HTTP ${response.status}). Set FIRST_OPEN_ARRAY to the original array.js.`)
    const path = join(work, 'array.original.js')
    await writeFile(path, Buffer.from(await response.arrayBuffer()))
    return path
}

async function staticServer(work, corePath) {
    const renderer = join(work, 'renderer')
    await run(process.execPath, [
        beside('../build.mjs'), beside('../fixtures/surveys-1.443.0.original.js'), renderer, 'Survey by ION', corePath,
    ])
    const core = await readFile(join(renderer, 'array.js')).catch((error) => {
        if (error.code !== 'ENOENT') throw error
        return readFile(corePath)
    })
    const assets = new Map([
        ['/', ['text/html; charset=utf-8', await readFile(beside('first-open.html'))]],
        ['/static/array.js', ['application/javascript', core]],
        ['/static/surveys.js', ['application/javascript', await readFile(join(renderer, 'surveys.js'))]],
    ])
    assets.set('/static/1.443.0/surveys.js', assets.get('/static/surveys.js'))
    const server = createServer((request, response) => {
        const path = new URL(request.url, 'http://localhost').pathname
        const file = assets.get(path)
        if (file) {
            response.writeHead(200, { 'Content-Type': file[0], 'Cache-Control': 'no-store' }).end(file[1])
        } else if (path === '/flags/' || path.startsWith('/e/')) {
            request.resume()
            response.writeHead(200, { 'Content-Type': 'application/json' })
                .end(JSON.stringify({ status: 1, flags: {}, featureFlags: {}, featureFlagPayloads: {} }))
        } else if (path === `/array/${token}/config`) {
            response.writeHead(200, { 'Content-Type': 'application/json' }).end('{"surveys":true,"hasFeatureFlags":false}')
        } else {
            response.writeHead(404).end()
        }
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    return server
}

async function scenario(browser, origin, { late = false, delay = 0 }, test) {
    const context = await browser.newContext({ viewport: { width: 1100, height: 800 } })
    let releaseDefinitions
    const definitions = new Promise((resolve) => { releaseDefinitions = resolve })
    if (!late) releaseDefinitions()
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    const realTime = process.env.FIRST_OPEN_REAL_TIME === '1'
    const advance = (ms) => realTime ? page.waitForTimeout(ms) : page.clock.runFor(ms)
    const state = () => page.evaluate(() => reval.state())
    const visible = () => page.locator('.PostHogSurvey-' + surveyId + ' .ph-survey').isVisible()
    const registered = () => page.waitForFunction(({ id, event }) =>
        posthog.surveys?._surveyEventReceiver?.getEventToSurveys().get(event)?.includes(id),
        { id: surveyId, event: trigger }, { timeout: 15000 })
    const open = async () => {
        await page.evaluate(() => reval.open())
        await page.waitForFunction(() => reval.state().masked, undefined, { timeout: 5000 })
    }
    const close = async () => {
        await page.evaluate(() => reval.close())
        await page.waitForFunction(() => {
            const current = reval.state()
            return current.closed && current.captured.some(({ action }) => action === 'CLOSE')
        }, undefined, { timeout: 5000 })
    }
    const checkShown = async () => {
        assert.equal(await visible(), true, 'a real survey popover is visible')
        const current = await state()
        assert.equal(signals.activated(current).length, 1)
        const shown = signals.shown(current)
        assert.equal(shown.length, 1, 'exactly one survey shown')
        assert.equal(shown[0].who, firstUser)
        assert.equal(shown[0].masked, false)
        return current
    }
    try {
        if (!realTime) await page.clock.install()
        await context.route(origin + '/api/surveys/**', async (route) => {
            await definitions
            await route.fulfill({ json: { surveys: [{ ...survey, appearance: { surveyPopupDelaySeconds: delay } }] } })
        })
        await page.goto(origin, { waitUntil: 'domcontentloaded' })
        await page.waitForFunction(() => !!window.reval, undefined, { timeout: 15000 })
        assert.equal(await page.evaluate(() => posthog.version), '1.443.0')
        assert.match(await page.evaluate(() => Ext.getVersion().version), /^6\.0\.0\b/)
        if (late) await page.waitForFunction(() => !!posthog.surveys?._surveyEventReceiver, undefined, { timeout: 15000 })
        else await registered()
        await test({ page, advance, state, visible, open, close, checkShown, registered, releaseDefinitions })
        assert.deepEqual(errors, [], 'browser page errors')
    } finally {
        releaseDefinitions()
        await context.close()
    }
}

const cases = [
    ['a. Slow first open shows once after Ext removes the mask', {}, async ({ open, advance, visible, state, checkShown }) => {
        await open()
        await advance(32000)
        const loading = await state()
        assert.equal(loading.masked, true, 'the actual Ext loading mask outlasts the old 30-second timeout')
        assert.equal(signals.activated(loading).length, 0)
        assert.equal(await visible(), false)
        await advance(16000)
        assert.equal((await checkShown()).masked, false)
    }],
    ['b. Closing before load finishes preserves the match', {}, async ({ close, open, advance, state, checkShown }) => {
        await open()
        await advance(2000)
        await close()
        const closed = await state()
        assert.equal(closed.closed, true)
        assert.equal(closed.loading, true, 'the simulated load is still pending')
        assert.ok(closed.captured.some(({ action }) => action === 'CLOSE'))
        await advance(46000)
        assert.equal((await checkShown()).closed, true)
    }],
    ['c. OPEN before survey definitions is replayed', { late: true }, async ({ open, advance, state, registered, releaseDefinitions, checkShown }) => {
        await open()
        await advance(2000)
        assert.ok((await state()).captured.some(({ action }) => action === 'OPEN'))
        assert.equal(signals.activated(await state()).length, 0)
        releaseDefinitions()
        await registered()
        await advance(46000)
        await checkShown()
    }],
    ['d. Reset and identify while a popover is pending never shows it to the next user', { delay: 8 },
        async ({ page, open, advance, state, visible }) => {
            await open()
            await advance(47000)
            assert.equal(signals.activated(await state()).length, 1, 'the old identity armed the native receiver')
            assert.equal(await visible(), false, 'the native delay is still pending')
            await page.evaluate(() => reval.logout())
            assert.equal(await page.evaluate(() => posthog.get_distinct_id()), nextUser)
            await advance(14000)
            assert.equal(await visible(), false)
            assert.deepEqual(signals.shown(await state()), [])
        }],
    ['e. A mask that returns after activation still blocks native display', { delay: 6 },
        async ({ page, open, advance, state, visible, checkShown }) => {
            await open()
            await advance(46500)
            assert.equal(signals.activated(await state()).length, 1)
            assert.equal(await visible(), false)
            await page.evaluate(() => reval.reload(10000))
            await advance(7500)
            assert.equal((await state()).masked, true)
            assert.equal(await visible(), false)
            assert.deepEqual(signals.shown(await state()), [])
            await advance(12000)
            await checkShown()
        }],
    ['f. Reopen loads in one second without a second activation or display', {},
        async ({ close, open, advance, state, checkShown }) => {
            await open()
            await advance(48000)
            await checkShown()
            await close()
            await open()
            await advance(1250)
            assert.equal((await state()).masked, false)
            await advance(2500)
            await checkShown()
        }],
]

const work = await mkdtemp(join(tmpdir(), 'lens-survey-browser-'))
let server, browser
try {
    const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
    browser = await chromium.launch({ executablePath: process.env.FIRST_OPEN_BROWSER_PATH })
    server = await staticServer(work, await originalCore(work))
    const origin = 'http://127.0.0.1:' + server.address().port
    for (const [name, options, test] of cases) {
        try {
            await scenario(browser, origin, options, test)
            console.log('PASS ' + name)
        } catch (error) {
            console.error('FAIL ' + name + '\n  ' + error.message)
            process.exitCode = 1
        }
    }
} finally {
    if (browser) await browser.close()
    if (server) await new Promise((resolve) => server.close(resolve))
    await rm(work, { recursive: true, force: true })
}
