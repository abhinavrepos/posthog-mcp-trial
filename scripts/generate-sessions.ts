// Records real browser sessions in Acme Portal so PostHog has replays, exceptions and rage clicks.
//
//   pnpm sessions                      # the standard demo mix (16 sessions, 4 at a time)
//   pnpm sessions --count 4 --only brightwater
//
// Chrome runs headless. posthog-js would drop it as a bot; the demo app turns that filter off
// with `opt_out_useragent_filter` (see demo-app/public/app.js).
import { parseArgs } from 'node:util'

import puppeteer, { type Browser, type Page } from 'puppeteer'

import { CLIENTS, hitsExportBug, type DemoClient, type DemoUser } from '../src/core/catalog.ts'

const { values } = parseArgs({
    options: {
        url: { type: 'string', default: process.env.DEMO_APP_URL || 'http://localhost:3000' },
        count: { type: 'string', default: '16' },
        concurrency: { type: 'string', default: '4' },
        only: { type: 'string' }, // client id
    },
})
const BASE = values.url!
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const jitter = (ms: number) => ms * (0.7 + Math.random() * 0.6)

interface Plan {
    client: DemoClient
    user: DemoUser
    scenario: 'export' | 'revenue' | 'browse'
}

/** The standard mix: every EU client on 26.10.0 hits the bug, Cobalt has its silent report issue. */
function demoPlans(count: number): Plan[] {
    const by = (id: string, email?: string): Pick<Plan, 'client' | 'user'> => {
        const client = CLIENTS.find((c) => c.id === id)!
        return { client, user: client.users.find((u) => u.email === email) || client.users[0] }
    }
    const fixed: Plan[] = [
        { ...by('brightwater', 'ben.okafor@brightwater.example'), scenario: 'export' },
        { ...by('brightwater', 'sofia.marin@brightwater.example'), scenario: 'export' },
        { ...by('nordlicht'), scenario: 'export' },
        { ...by('verdant'), scenario: 'export' },
        { ...by('alpenrose'), scenario: 'export' },
        { ...by('cobalt', 'maya.chen@cobalthealth.example'), scenario: 'revenue' },
        { ...by('meridian'), scenario: 'export' }, // EU, multi-currency, 26.9.0: works
        { ...by('kestrel'), scenario: 'export' }, // 26.10.0, single currency: works
    ]
    const others = CLIENTS.filter((c) => !['brightwater', 'cobalt'].includes(c.id))
    const plans = [...fixed]
    for (let i = 0; plans.length < count; i++) {
        const client = others[i % others.length]
        plans.push({ client, user: client.users[i % client.users.length], scenario: (['browse', 'export', 'revenue'] as const)[i % 3] })
    }
    return plans.slice(0, count)
}

async function moveAndClick(page: Page, selector: string) {
    const el = await page.waitForSelector(selector, { visible: true, timeout: 10_000 })
    const box = await el!.boundingBox()
    if (box) {
        await page.mouse.move(box.x + box.width / 2 + (Math.random() * 6 - 3), box.y + box.height / 2 + (Math.random() * 4 - 2), { steps: 12 })
        await sleep(jitter(250))
    }
    await el!.click()
}

async function go(page: Page, path: string) {
    await page.goto(BASE + path, { waitUntil: 'networkidle2' })
    await sleep(jitter(1500))
    await page.mouse.wheel({ deltaY: 300 })
    await sleep(jitter(800))
    await page.mouse.wheel({ deltaY: -300 })
}

async function runSession(browser: Browser, plan: Plan, n: number) {
    const ctx = await browser.createBrowserContext()
    const page = await ctx.newPage()
    await page.setViewport({ width: 1280, height: 760 })
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e instanceof Error ? e.message : String(e)))
    try {
        await page.goto(BASE + '/login', { waitUntil: 'networkidle2' })
        await page.select('#email', plan.user.email)
        await sleep(jitter(600))
        await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle2' }), moveAndClick(page, '#signin')])
        await sleep(jitter(2500))

        if (plan.scenario === 'export') {
            await go(page, '/invoices')
            await moveAndClick(page, '#search')
            await page.keyboard.type('INV', { delay: 120 })
            await sleep(jitter(900))
            for (let i = 0; i < 3; i++) await page.keyboard.press('Backspace')
            await sleep(jitter(700))
            await moveAndClick(page, '#export-pdf')
            await sleep(3500)
            if (hitsExportBug(plan.client)) {
                // Stuck on "Preparing PDF…": the user clicks again, fast, then gives up.
                for (let i = 0; i < 5; i++) {
                    await page.click('#export-pdf')
                    await sleep(140)
                }
                await sleep(jitter(4000))
                await page.click('#export-pdf')
                await sleep(jitter(3000))
            }
            await go(page, '/dashboard')
        } else if (plan.scenario === 'revenue') {
            await go(page, '/reports/revenue')
            await sleep(3000)
            const repeats = plan.client.id === 'cobalt' ? 4 : 1
            for (let i = 0; i < repeats; i++) {
                await moveAndClick(page, '#refresh')
                await sleep(jitter(3200))
            }
            if (plan.client.id === 'cobalt') {
                await page.select('#range', 'mtd')
                await sleep(2500)
                await page.select('#range', 'qtd')
                await sleep(3500)
            }
            await go(page, '/invoices')
        } else {
            await go(page, '/clients')
            await go(page, '/settings')
            await moveAndClick(page, '#save')
            await sleep(jitter(1500))
            await go(page, '/dashboard')
        }
        // posthog-js flushes on a timer and on unload; give it time before the page closes.
        await sleep(6000)
        console.log(`#${n} ${plan.client.name} / ${plan.user.email} / ${plan.scenario}${errors.length ? ` (page error: ${errors[0]})` : ''}`)
    } finally {
        await page.close({ runBeforeUnload: true })
        await sleep(1500)
        await ctx.close()
    }
}

const count = Number(values.count)
let plans = demoPlans(Math.max(count, values.only ? 1 : count))
if (values.only) {
    const client = CLIENTS.find((c) => c.id === values.only)
    if (!client) throw new Error(`unknown client ${values.only}`)
    plans = Array.from({ length: count }, (_, i) => ({ client, user: client.users[i % client.users.length], scenario: hitsExportBug(client) ? 'export' : 'revenue' }) as Plan)
}

const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] })
try {
    const queue = plans.map((p, i) => [p, i + 1] as const)
    const workers = Array.from({ length: Number(values.concurrency) }, async () => {
        for (let item = queue.shift(); item; item = queue.shift()) {
            try {
                await runSession(browser, item[0], item[1])
            } catch (e) {
                console.error(`#${item[1]} failed: ${(e as Error).message}`)
            }
        }
    })
    await Promise.all(workers)
} finally {
    await browser.close()
}
