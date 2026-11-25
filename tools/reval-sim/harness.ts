// The Reval simulation's harness: the two servers, Lens pointed at the stand-in PostHog, a headless Chrome
// that opens the simulated Reval, and helpers to act like a user and to see whether a survey showed.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import puppeteer, { type Browser, type BrowserContext, type Page } from 'puppeteer'

import { RevalServer, StandInPostHog } from './server.ts'

// REVAL_CHROME_LIBS, or run/chrome-libs when chrome-stubs.mjs made it.
const chromeLibs = () => process.env.REVAL_CHROME_LIBS || (existsSync(join(import.meta.dirname, '../../run/chrome-libs/stubs.json')) ? join(import.meta.dirname, '../../run/chrome-libs') : '')

export interface Sim { reval: RevalServer; posthog: StandInPostHog; browser: Browser; lens: typeof import('../../src/core/surveys.ts'); config: typeof import('../../src/core/config.ts')['config']; stop(): Promise<void> }

/** Servers, Lens and Chrome. Lens reads its settings at import, so they are set before it is loaded. */
export async function startSim(opts: { buildDir: string; headless?: boolean }): Promise<Sim> {
    const posthog = await new StandInPostHog(StandInPostHog.build(opts.buildDir)).start()
    const reval = await new RevalServer().start()
    Object.assign(process.env, {
        POSTHOG_HOST: posthog.url, POSTHOG_PROJECT_ID: '1', POSTHOG_PERSONAL_API_KEY: 'phx_sim_read', POSTHOG_SURVEY_API_KEY: 'phx_sim_survey',
        APP_EVENTS_FILE: join(import.meta.dirname, '../../config/app-events.reval.json'), FEATURE_SURVEYS: 'on', CLIENT_FROM_DISTINCT_ID: process.env.CLIENT_FROM_DISTINCT_ID ?? '3',
        DISTINCT_ID_SEPARATOR: '|',
    })
    const { config } = await import('../../src/core/config.ts')
    // Settings may already have been read (a test run imports config earlier): set them here as well.
    Object.assign(config.posthog, { host: posthog.url, projectId: '1', personalApiKey: 'phx_sim_read', surveyApiKey: 'phx_sim_survey', surveyGate: '' })
    config.surveys.enabled = true
    config.properties.distinctIdSeparator = '|'
    const lens = await import('../../src/core/surveys.ts')
    const browser = await puppeteer.launch({
        headless: opts.headless === false ? false : 'shell',
        args: ['--no-sandbox', '--disable-gpu', '--disable-blink-features=AutomationControlled', '--disable-dev-shm-usage', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
        protocolTimeout: 120_000,
        // REVAL_CHROME_LIBS: extra libraries for Chrome (e.g. the stand-ins from chrome-stubs.mjs).
        ...(chromeLibs() ? { env: { ...process.env, LD_LIBRARY_PATH: [chromeLibs(), process.env.LD_LIBRARY_PATH].filter(Boolean).join(':') } } : {}),
    })
    return {
        reval, posthog, browser, lens, config,
        async stop() { await browser.close().catch(() => {}); await reval.stop(); await posthog.stop() },
    }
}

// The page's clock can be moved forward (a day later, a week later): Date and Date.now follow a stored offset.
const CLOCK = `(() => {
    const Real = Date;
    const off = () => { try { return Number(localStorage.getItem('__simClockOffset') || 0) } catch (_) { return 0 } };
    class SimDate extends Real { constructor(...a) { if (a.length) super(...a); else super(Real.now() + off()); } static now() { return Real.now() + off(); } }
    window.Date = SimDate;
})()`

export interface Visit {
    page: Page
    ctx: BrowserContext
    errors: string[]
    projectId: string
    close(): Promise<void>
}

export async function visit(sim: Sim, projectId: string, who: { client: string; user: string; init?: number; speed?: number; ph?: string; refreshMs?: number }): Promise<Visit> {
    const ctx = await sim.browser.createBrowserContext()
    const page = await ctx.newPage()
    await page.setViewport({ width: 1366, height: 820 })
    // posthog-js drops events from user agents it takes for bots (HeadlessChrome): look like the desktop Chrome Reval's users have.
    // (It also reads navigator.webdriver, off with --disable-blink-features=AutomationControlled, and the brands.)
    const major = /Chrome\/(\d+)/.exec(await sim.browser.userAgent())?.[1] || '148'
    await page.setUserAgent({
        userAgent: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`,
        userAgentMetadata: { brands: [{ brand: 'Chromium', version: major }, { brand: 'Google Chrome', version: major }], platform: 'Windows', platformVersion: '10.0.0', architecture: 'x86', model: '', mobile: false },
    })
    const errors: string[] = []
    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warn') errors.push(`console.${m.type()}: ${m.text().slice(0, 300)}`) })
    page.on('pageerror', (e) => errors.push(`pageerror: ${String(e).slice(0, 300)}`))
    page.on('requestfailed', (r) => { const f = r.failure()?.errorText || ''; if (!/ERR_ABORTED/.test(f)) errors.push(`requestfailed: ${r.url().slice(0, 120)} ${f}`) })
    page.on('response', (r) => { if (r.status() >= 400) errors.push(`http ${r.status()}: ${r.url().slice(0, 120)}`) })
    await page.evaluateOnNewDocument(CLOCK)
    if (who.refreshMs !== undefined) await page.evaluateOnNewDocument(`window.__lensSurveyRefreshMs = ${Number(who.refreshMs)}`)
    const q = new URLSearchParams({ token: sim.posthog.tokenFor(projectId), ph: who.ph || sim.posthog.url, client: who.client, user: who.user, init: String(who.init ?? 300), speed: String(who.speed ?? 1) })
    await page.goto(`${sim.reval.url}/?${q}`, { waitUntil: 'load' })
    await page.waitForFunction('!!window.Reval && !!window.__viewportAt', { timeout: 30_000 })
    return { page, ctx, errors, projectId, close: () => ctx.close().catch(() => {}) }
}

/** Surveys on screen now: the popover's host element, with a visible question inside its shadow root. */
export function surveysOnScreen(page: Page): Promise<string[]> {
    return page.evaluate(() => {
        const out: string[] = []
        document.querySelectorAll('[class^="PostHogSurvey-"]').forEach((host) => {
            const root = (host as HTMLElement).shadowRoot
            if (!root) return
            const visible = Array.from(root.querySelectorAll('.survey-form, .survey-question')).some((e) => {
                const r = (e as HTMLElement).getBoundingClientRect(), cs = getComputedStyle(e as HTMLElement)
                return r.width > 50 && r.height > 20 && r.bottom > 0 && r.top < innerHeight && cs.display !== 'none' && cs.visibility !== 'hidden' && parseFloat(cs.opacity) > 0.5
            })
            if (visible) out.push(String((host as HTMLElement).className).replace(/^PostHogSurvey-/, '').split(' ')[0])
        })
        return out
    })
}

/** Close the survey with its cross (a real click inside the shadow root). */
export async function dismissSurvey(page: Page): Promise<boolean> {
    const handle = await page.evaluateHandle(() => {
        for (const host of document.querySelectorAll('[class^="PostHogSurvey-"]')) {
            const b = (host as HTMLElement).shadowRoot?.querySelector('button[aria-label="Close survey"]')
            if (b) return b
        }
        return null
    })
    const el = handle.asElement()
    if (!el) return false
    await (el as import('puppeteer').ElementHandle<Element>).click()
    return true
}

/** Answer the survey on screen: the top rating, then Submit, then close the thank-you box. Real clicks. */
export async function answerSurvey(page: Page): Promise<boolean> {
    const find = (what: 'rating' | 'submit' | 'close') => page.evaluateHandle((w) => {
        for (const host of document.querySelectorAll('[class^="PostHogSurvey-"]')) {
            const root = (host as HTMLElement).shadowRoot
            if (!root) continue
            const buttons = Array.from(root.querySelectorAll('button')) as HTMLButtonElement[]
            const hit = w === 'rating' ? buttons.filter((b) => /^\d+$/.test((b.textContent || '').trim())).pop()
                : w === 'submit' ? root.querySelector('.form-submit') as HTMLButtonElement | null
                : root.querySelector('button[aria-label="Close survey"]') as HTMLButtonElement | null
            if (hit) return hit
        }
        return null
    }, what)
    const click = async (what: 'rating' | 'submit' | 'close') => {
        const el = (await find(what)).asElement() as import('puppeteer').ElementHandle<Element> | null
        if (!el) return false
        await el.click()
        return true
    }
    if (!(await click('rating'))) return false
    await sleep(150)
    if (!(await click('submit'))) return false
    await sleep(800)
    await click('close') // the thank-you box, if it is still there
    return true
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
