// Records real browser sessions in Acme Portal so PostHog has replays, exceptions and rage clicks.
//
//   pnpm sessions                      # the standard demo mix (16 sessions, 4 at a time)
//   pnpm sessions --count 4 --only brightwater
//   pnpm sessions --count 1000 --concurrency 10 --mixed
//                                      # every client and user; each session a random chain of 3 to 6
//                                      # activities (invoices, PDF export, revenue report, clients,
//                                      # settings, dashboard), so no two sessions look the same
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
        mixed: { type: 'boolean', default: false },
    },
})
const BASE = values.url!
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const jitter = (ms: number) => ms * (0.7 + Math.random() * 0.6)

interface Plan {
    client: DemoClient
    user: DemoUser
    scenario: 'export' | 'revenue' | 'browse' | 'mixed'
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

/** Every client and every one of its users in turn, each session a random chain of activities. */
function mixedPlans(count: number): Plan[] {
    return Array.from({ length: count }, (_, i) => {
        const client = CLIENTS[i % CLIENTS.length]
        return { client, user: client.users[Math.floor(i / CLIENTS.length) % client.users.length], scenario: 'mixed' as const }
    })
}

type Activity = (page: Page, plan: Plan) => Promise<void>
const ACTIVITIES: Record<string, Activity> = {
    'search invoices': async (page) => {
        await go(page, '/invoices')
        await moveAndClick(page, '#search')
        await page.keyboard.type(['INV', 'INV-20', 'paid', 'overdue'][Math.floor(Math.random() * 4)], { delay: 110 })
        await sleep(jitter(1200))
        await page.keyboard.down('Control')
        await page.keyboard.press('a')
        await page.keyboard.up('Control')
        await page.keyboard.press('Backspace')
        await sleep(jitter(700))
    },
    'export PDF': async (page, plan) => {
        await go(page, '/invoices')
        await moveAndClick(page, '#export-pdf')
        await sleep(3500)
        if (hitsExportBug(plan.client)) {
            for (let i = 0; i < 5; i++) {
                await page.click('#export-pdf')
                await sleep(140)
            }
            await sleep(jitter(3000))
        }
    },
    'revenue report': async (page, plan) => {
        await go(page, '/reports/revenue')
        await sleep(jitter(2000))
        const refreshes = 1 + Math.floor(Math.random() * (plan.client.id === 'cobalt' ? 4 : 2))
        for (let i = 0; i < refreshes; i++) {
            await moveAndClick(page, '#refresh')
            await sleep(jitter(2500))
        }
        if (Math.random() < 0.5) {
            await page.select('#range', Math.random() < 0.5 ? 'mtd' : 'qtd')
            await sleep(jitter(2500))
        }
    },
    clients: async (page) => {
        await go(page, '/clients')
        await page.mouse.wheel({ deltaY: 500 })
        await sleep(jitter(1200))
    },
    'save settings': async (page) => {
        await go(page, '/settings')
        await moveAndClick(page, '#save')
        await sleep(jitter(1500))
    },
    dashboard: async (page) => {
        await go(page, '/dashboard')
        await sleep(jitter(1500))
    },
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

        let did: string = plan.scenario
        if (plan.scenario === 'mixed') {
            const names = Object.keys(ACTIVITIES).sort(() => Math.random() - 0.5).slice(0, 3 + Math.floor(Math.random() * 4))
            for (const name of names) await ACTIVITIES[name](page, plan)
            did = names.join(', ')
        } else if (plan.scenario === 'export') {
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
        console.log(`#${n} ${plan.client.name} / ${plan.user.email} / ${did}${errors.length ? ` (page error: ${errors[0]})` : ''}`)
    } finally {
        await page.close({ runBeforeUnload: true })
        await sleep(1500)
        await ctx.close()
    }
}

const count = Number(values.count)
let plans = values.mixed ? mixedPlans(count) : demoPlans(Math.max(count, values.only ? 1 : count))
if (values.only) {
    const client = CLIENTS.find((c) => c.id === values.only)
    if (!client) throw new Error(`unknown client ${values.only}`)
    plans = Array.from({ length: count }, (_, i) => ({ client, user: client.users[i % client.users.length], scenario: values.mixed ? 'mixed' : hitsExportBug(client) ? 'export' : 'revenue' }) as Plan)
}

// chrome-headless-shell: the build deploy/install.sh checks that it starts on this machine.
const browser = await puppeteer.launch({ headless: 'shell', args: ['--no-sandbox'] })
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
