import { parseArgs } from 'node:util'
import { pathToFileURL } from 'node:url'
import { mkdir, writeFile } from 'node:fs/promises'
import puppeteer, { type Browser, type Page } from 'puppeteer'
import { CANARIES } from './canaries.ts'
import { planSessions, type Plan, type Action } from './planner.ts'
import { startServer } from './serve.ts'

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
async function moveTo(page: Page, selector: string) {
    const el = await page.waitForSelector(selector, { visible: true, timeout: 10_000 })
    if (!el) throw new Error(`Missing ${selector}`)
    await el.scrollIntoView()
    const box = await el.boundingBox()
    await el.dispose()
    if (!box) throw new Error(`No bounding box for ${selector}`)
    const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
    await page.mouse.move(point.x, point.y, { steps: 12 })
    return point
}
async function perform(page: Page, action: Action) {
    switch (action.kind) {
        case 'click': {
            const point = await moveTo(page, action.selector)
            for (let i = 0; i < action.count; i++) { await page.mouse.click(point.x, point.y); await sleep(action.gapMs) }
            break
        }
        case 'type':
            await moveTo(page, action.selector)
            await page.mouse.down(); await page.mouse.up()
            await page.keyboard.down('Control'); await page.keyboard.press('a'); await page.keyboard.up('Control')
            await page.keyboard.type(action.value, { delay: 65 })
            break
        case 'wait': await sleep(action.ms); break
        case 'wheel': await page.mouse.wheel({ deltaY: action.deltaY }); break
        case 'circle': {
            const start = Date.now()
            let step = 0
            while (Date.now() - start < action.ms) {
                const angle = step++ * Math.PI / 2
                await page.mouse.move(640 + Math.cos(angle) * 65, 300 + Math.sin(angle) * 65, { steps: 5 })
                await sleep(65)
            }
            break
        }
    }
}

async function runSession(browser: Browser, base: string, plan: Plan) {
    const context = await browser.createBrowserContext()
    const page = await context.newPage()
    try {
        await page.setViewport({ width: 1280, height: 760 })
        const params = new URLSearchParams({ client: plan.clientId, name: plan.clientName, persona: plan.persona, trade: CANARIES.tradeId, cash: CANARIES.cash })
        await page.goto(`${base}/?${params}`, { waitUntil: 'load', timeout: 30_000 })
        await page.waitForFunction(() => {
            const w = window as unknown as { labReady?: boolean; labError?: string }
            if (w.labError) throw new Error(w.labError)
            return w.labReady
        }, { timeout: 30_000 })
        const started = Date.now()
        const sessionId = await page.evaluate(() => (window as unknown as { posthog: { get_session_id(): string } }).posthog.get_session_id())
        if (!sessionId) throw new Error('PostHog did not return a session ID')
        for (const action of plan.actions) {
            await perform(page, action)
            if (action.kind === 'click' && action.selector === '#save' && plan.persona === 'error-looping') await page.waitForSelector('[role=alert]')
        }
        // Keep non-idle sessions active, leaving the deliberately idle profile untouched.
        while (Date.now() - started < plan.durationMs - 6000) {
            if (plan.persona !== 'idle') await page.mouse.move(150 + (Math.floor((Date.now() - started) / 5000) % 2) * 160, 115, { steps: 16 })
            await sleep(Math.min(5000, Math.max(0, plan.durationMs - 6000 - (Date.now() - started))))
        }
        await sleep(6000) // allow batched recordings/events to leave before unload
        const finalId = await page.evaluate(() => (window as unknown as { posthog: { get_session_id(): string } }).posthog.get_session_id())
        if (finalId !== sessionId) throw new Error('PostHog rotated the session during the run')
        return { session_id: sessionId, client_id: plan.clientId, client_name: plan.clientName, persona: plan.persona, expected: plan.expected, duration_ms: Date.now() - started }
    } finally {
        await page.close({ runBeforeUnload: true }).catch(() => {})
        await sleep(1000)
        await context.close()
    }
}

export async function main(args = process.argv.slice(2)) {
    const { values } = parseArgs({ args, options: {
        sessions: { type: 'string', default: '6' },
        concurrency: { type: 'string', default: '2' },
        clients: { type: 'string', default: 'LAB1,LAB2,LAB3,LAB4,LAB5,LAB6' },
    } })
    const concurrency = Number(values.concurrency)
    if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error('concurrency must be a positive integer')
    const plans = planSessions(Number(values.sessions), values.clients!.split(',').map(c => c.trim()))
    const server = await startServer()
    const results: Awaited<ReturnType<typeof runSession>>[] = []
    const failures: { client_id: string; persona: string; error: string }[] = []
    const output = new URL('./out/', import.meta.url)
    let browser: Browser | undefined
    try {
        browser = await puppeteer.launch({ headless: 'shell', args: ['--no-sandbox'] })
        const activeBrowser = browser
        const queue = [...plans]
        await Promise.all(Array.from({ length: Math.min(concurrency, plans.length) }, async () => {
            for (let plan = queue.shift(); plan; plan = queue.shift()) {
                try {
                    const result = await runSession(activeBrowser, server.url, plan)
                    results.push(result)
                    console.log(`${result.client_id} ${result.persona}: ${result.session_id}`)
                } catch (error) {
                    failures.push({ client_id: plan.clientId, persona: plan.persona, error: String(error) })
                    console.error(`${plan.clientId}: ${String(error)}`)
                }
            }
        }))
    } finally {
        await browser?.close()
        await server.close()
        await mkdir(output, { recursive: true })
        await writeFile(new URL('ground-truth.json', output), JSON.stringify({ version: 1, generated_at: new Date().toISOString(), expected_note: 'Scripted counts and minima; incidental clicks, recording sampling and detector thresholds can affect extracted totals.', sessions: Object.fromEntries(results.map(r => [r.session_id, r])), failures }, null, 2) + '\n')
    }
    if (failures.length) throw new Error(`${failures.length} session(s) failed; see out/ground-truth.json`)
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    await main()
}
