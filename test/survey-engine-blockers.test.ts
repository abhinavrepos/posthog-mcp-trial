import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test, type TestContext } from 'node:test'
const engine = createRequire(import.meta.url)('../deploy/posthog/survey-engine/engine.js')
const installCapture = createRequire(import.meta.url)('../deploy/posthog/survey-engine/bootstrap.js')
const chain = { version: 3, id: 'feedback', steps: [{ event: 'Open' }, { event: 'Save' }],
    audience: { clients: ['ACME'], distinctIdPart: 1, separator: '|' }, ready: { maxWaitMs: 1000 } }
const survey = { id: 'survey-a', start_date: '2026-11-01T00:00:00Z', end_date: null, conditions: { lensChain: chain } }
const ev = (event: string) => ({ event, properties: {} })

test('archived surveys invalidate pending chains even when PostHog retains their start_date', () => {
    const m = engine.createMachine(); m.setSurveys([survey])
    m.consume(ev('Open'), 1, 'ACME|ann')
    const [completion] = m.consume(ev('Save'), 2, 'ACME|ann')
    assert.ok(completion)
    m.setSurveys([{ ...survey, archived: true }])
    assert.equal(m.pending(completion.id, completion.token), false)
    assert.equal(m.info(chain.id), null)
})

test('a different user cannot complete the previous user chain', () => {
    const m = engine.createMachine(); m.setSurveys([survey])
    m.consume(ev('Open'), 1, 'ACME|ann')
    assert.deepEqual(m.consume(ev('Save'), 2, 'ACME|bob'), [])
    m.consume(ev('Open'), 3, 'ACME|bob')
    assert.equal(m.consume(ev('Save'), 4, 'ACME|bob').length, 1)
})

function browser(t: TestContext, ready = 'complete', input = survey) {
    let who = 'ACME|ann', now = 1000000000
    let listener: (event: unknown) => void = () => {}
    const timers: { callback: () => void; ms: number }[] = [], captured: string[] = []
    const storage = new Map<string, string>()
    const root = { __PosthogExtensions__: { generateSurveys: (_instance: unknown) => {} }, document: { readyState: ready, querySelectorAll: () => [] },
        localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) },
        setTimeout: (callback: () => void, ms: number) => timers.push({ callback, ms }) }
    const instance = { on: (_name: string, callback: typeof listener) => { listener = callback },
        getSurveys: (callback: (s: unknown[]) => void) => callback([input]), get_distinct_id: () => who,
        _isIdentified: () => true,
        capture: (name: string) => captured.push(name) }
    t.mock.method(Date, 'now', () => now)
    engine.install(root); root.__PosthogExtensions__.generateSurveys(instance)
    return { root, captured, emit: (event: string) => listener(ev(event)), identify: (id: string) => { who = id },
        tick: (ms: number) => { now += ms; const at = timers.findIndex(timer => timer.ms < 60000); assert.ok(at >= 0); timers.splice(at, 1)[0].callback() } }
}

test('a survey waiting for page readiness cannot fire after the browser changes to an excluded client', (t) => {
    const b = browser(t, 'loading')
    b.emit('Open'); b.emit('Save'); b.tick(0)
    b.identify('BETA|bob'); b.root.document.readyState = 'complete'; b.tick(100)
    assert.deepEqual(b.captured, [])
})

test('max_wait_seconds zero still shows a survey when the page is already ready', (t) => {
    const b = browser(t, 'complete', { ...survey, conditions: { lensChain: { ...chain, ready: { maxWaitMs: 0 } } } })
    b.emit('Open'); b.emit('Save'); b.tick(1)
    assert.deepEqual(b.captured, ['lens_chain:feedback'])
})

const dialogChain = {
    ...chain,
    steps: [{ event: 'PageView', properties: {
        action: { operator: 'exact', values: ['OPEN'] },
        dialog_id: { operator: 'exact', values: ['DlgHedgeDesigListReport'] },
    } }],
    withinSeconds: 600,
    ready: { documentComplete: true, noVisibleMask: true, maxWaitMs: 30000 },
}
const dialogSurvey = { ...survey, conditions: { lensChain: dialogChain, events: { values: [{ name: 'lens_chain:feedback' }] } } }
const trigger = 'lens_chain:feedback'

function dialogBrowser(t: TestContext, input: Omit<typeof dialogSurvey, 'conditions'> & { conditions: unknown } = dialogSurvey) {
    let now = 1000000000, who = 'ACME|ann', ready = 'complete', seq = 0, eligible = true, loaded = false
    let callback: ((definitions: unknown[], context?: { isLoaded: boolean }) => void) | undefined
    const timers = new Map<number, { at: number; fn: () => void }>()
    const registered = new Map<string, string[]>()
    const captured: string[] = [], logs: string[] = [], canceled: string[] = [], resumeDelay: (boolean | undefined)[] = []
    const storage = new Map<string, string>()
    const userProps = new Map<string, unknown>()
    let identified = true
    const listeners: ((event: unknown) => void)[] = []
    const emit = (event: string, properties: object = {}) => listeners.forEach((listener) => listener({ event, properties }))
    const style = { visibility: 'visible', display: 'block', opacity: '1' }
    const rect = { left: 0, top: 0, right: 200, bottom: 200, width: 200, height: 200 }
    const parent = { style: { ...style }, parentElement: null }
    const mask = { style, parentElement: parent, getBoundingClientRect: () => rect }
    let masks: typeof mask[] = []
    const renderer = {
        checkSurveyEligibility: (_survey: unknown): { eligible: boolean; reason?: string } =>
            eligible ? { eligible } : { eligible, reason: 'Survey targeting feature flag is not enabled' },
        cancelSurvey: (id: string) => canceled.push(id),
        handlePopoverSurvey: (_survey: unknown, _options: unknown, automatic: { resumeDelayFromActivation?: boolean }) =>
            resumeDelay.push(automatic.resumeDelayFromActivation),
    }
    const root = {
        __PosthogExtensions__: { generateSurveys: (_instance: unknown, _enabled?: boolean): typeof renderer | undefined => {
            // The test explicitly drives definitions and eligibility.
            return renderer
        } },
        document: { get readyState() { return ready }, querySelectorAll: () => masks },
        innerWidth: 1024, innerHeight: 768,
        console: { debug: (_prefix: string, message: string) => logs.push(message) },
        getComputedStyle: (element: typeof mask) => element.style,
        localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) },
        setTimeout: (fn: () => void, delay: number) => {
            timers.set(++seq, { at: now + delay, fn })
            return seq
        },
        clearTimeout: (id: number) => timers.delete(id),
    }
    const surveys = {
        _surveyEventReceiver: { getEventToSurveys: () => registered },
        getSurveys: (cb: NonNullable<typeof callback>) => {
            if (loaded) cb([input], { isLoaded: true })
            else callback = cb
        },
    }
    const instance = {
        surveys, config: { debug: true }, getSurveys: (cb: NonNullable<typeof callback>) => surveys.getSurveys(cb),
        _isIdentified: () => identified, get_property: (key: string) => userProps.get(key),
        identify: (id: string) => { who = id; identified = true },
        reset: (restore?: string) => { who = restore ?? 'ACME|anonymous'; identified = restore !== undefined },
        get_distinct_id: () => who, on: (_name: string, listener: (event: unknown) => void) => listeners.push(listener),
        capture: (event: string, props: object) => { captured.push(event); emit(event, props) },
    }
    t.mock.method(Date, 'now', () => now)
    engine.install(root)
    const open = (id = 'DlgHedgeDesigListReport') => emit('PageView', { action: 'OPEN', dialog_id: id })
    const close = (id = 'DlgHedgeDesigListReport') => emit('PageView', { action: 'CLOSE', dialog_id: id })
    return {
        captured, logs, storage, rect, style, parent, canceled, resumeDelay, emit, userProps,
        bootstrap: () => installCapture(root)(instance),
        attach: () => { root.__PosthogExtensions__.generateSurveys(instance); surveys.getSurveys(() => {}) },
        load: () => { loaded = true; callback?.([input], { isLoaded: true }) },
        failLoad: () => callback?.([], { isLoaded: false }),
        register: (id = input.id) => registered.set(trigger, [id]),
        open, close, mask: (visible: boolean) => { masks = visible ? [mask] : [] },
        documentReady: (value: string) => { ready = value },
        flags: (value: boolean) => { eligible = value },
        canShow: () => renderer.checkSurveyEligibility(input).eligible,
        schedulePopover: () => renderer.handlePopoverSurvey(input, undefined, { resumeDelayFromActivation: true }),
        shown: () => emit('survey shown', { $survey_id: input.id }),
        identify: (id: string) => instance.identify(id),
        reset: (restore?: string) => instance.reset(restore),
        setIdentity: (id: string, isIdentified = true) => { who = id; identified = isIdentified },
        jump: (ms: number) => {
            now += ms
            for (const [id, timer] of [...timers]) {
                if (timer.at > now) continue
                timers.delete(id)
                timer.fn()
            }
        },
        refreshError: () => {
            loaded = false
            surveys.getSurveys(() => {})
            callback?.([], { isLoaded: false })
        },
        tick: (ms: number) => {
            const end = now + ms
            for (;;) {
                const next = [...timers].sort(([, a], [, b]) => a.at - b.at)[0]
                if (!next || next[1].at > end) break
                const [id, timer] = next
                now = timer.at
                timers.delete(id)
                timer.fn()
            }
            now = end
        },
    }
}

test('first dialog OPEN survives a 45 second mask, waits for document complete, and fires once', (t) => {
    const b = dialogBrowser(t)
    b.register(); b.load(); b.attach(); b.documentReady('loading'); b.mask(true); b.open(); b.open()
    b.tick(45000)
    assert.deepEqual(b.captured, [])
    assert.equal(b.canShow(), false)
    b.mask(false); b.tick(100)
    assert.deepEqual(b.captured, [])
    b.documentReady('complete'); b.tick(100)
    assert.deepEqual(b.captured, [trigger])
    assert.equal(b.canShow(), true)
    b.shown(); b.open(); b.tick(5000)
    assert.equal(b.canShow(), false)
    assert.deepEqual(b.captured, [trigger])
})

test('startup replay survives a failed definitions response and waits for the exact receiver registration', (t) => {
    const b = dialogBrowser(t)
    b.bootstrap(); b.open(); b.attach(); b.failLoad(); b.tick(500)
    b.load(); b.register('another-survey'); b.tick(500)
    assert.deepEqual(b.captured, [])
    assert.ok(b.logs.some((log) => log.includes('waiting for PostHog activation registration')))
    b.register(); b.tick(100)
    assert.deepEqual(b.captured, [trigger])
    assert.equal(b.canShow(), true)
    b.refreshError()
    assert.equal(b.canShow(), true, 'a fetch failure preserves the last good snapshot')
})

test('OPEN after attachment survives CLOSE and another screen before definitions arrive', (t) => {
    const b = dialogBrowser(t)
    b.attach(); b.open(); b.close(); b.open('other-screen'); b.register(); b.load(); b.tick(500)
    assert.deepEqual(b.captured, [trigger])
    assert.equal(b.canShow(), true)
})

test('startup replay does not cross an identity switch or replay an expired OPEN', (t) => {
    const b = dialogBrowser(t)
    b.bootstrap(); b.open(); b.identify('ACME|bob'); b.identify('ACME|ann')
    b.attach(); b.load(); b.register(); b.tick(100)
    assert.deepEqual(b.captured, [])
    const stale = dialogBrowser(t)
    stale.bootstrap(); stale.open(); stale.tick(301000); stale.attach(); stale.load(); stale.register(); stale.tick(100)
    assert.deepEqual(stale.captured, [])
})

test('closing during the mask wait preserves a completed chain, even with a configured resetOn', (t) => {
    const input = { ...dialogSurvey, conditions: {
        ...dialogSurvey.conditions, lensChain: { ...dialogChain, resetOn: [{ event: 'PageView', properties: {
            action: { operator: 'exact', values: ['CLOSE'] },
        } }] },
    } }
    const b = dialogBrowser(t, input)
    b.load(); b.register(); b.attach(); b.mask(true); b.open(); b.tick(40000)
    b.close(); b.open('other-screen'); b.tick(200)
    assert.deepEqual(b.captured, [])
    assert.equal(b.canShow(), false)
    b.mask(false); b.tick(200)
    assert.deepEqual(b.captured, [trigger])
    assert.equal(b.canShow(), true)
})

test('native eligibility rechecks masks and flags, and a dialog change keeps the match', (t) => {
    const b = dialogBrowser(t)
    b.register(); b.load(); b.attach(); b.open(); b.tick(0)
    assert.equal(b.canShow(), true)
    b.schedulePopover()
    assert.deepEqual(b.resumeDelay, [false], 'a prior activation timestamp cannot shorten the native delay')
    b.mask(true)
    assert.equal(b.canShow(), false)
    b.mask(false); b.flags(false)
    assert.equal(b.canShow(), false)
    b.flags(true); b.close('unrelated')
    assert.equal(b.canShow(), true)
    b.open('other-screen')
    assert.equal(b.canShow(), true)
    b.close()
    assert.equal(b.canShow(), true)
    assert.deepEqual(b.canceled, [])
    b.open(); b.tick(100)
    assert.deepEqual(b.captured, [trigger], 'a pending activation is reused across a reopen')
})

test('native display rechecks identity and cancels the active popup delay', (t) => {
    const b = dialogBrowser(t)
    b.register(); b.load(); b.attach(); b.open(); b.tick(0)
    assert.equal(b.canShow(), true)
    b.setIdentity('ACME|bob')
    b.schedulePopover()
    assert.deepEqual(b.resumeDelay, [], 'the final native render entry rejects the stale match')
    assert.deepEqual(b.canceled, [dialogSurvey.id])
    assert.equal(b.canShow(), false)
    b.identify('ACME|ann')
    assert.equal(b.canShow(), false, 'the old match cannot come back under its original ID')
    assert.deepEqual(b.captured, [trigger])
})

test('logout drops deferred and already activated work, including reset to the same ID', (t) => {
    const b = dialogBrowser(t)
    b.register(); b.load(); b.attach(); b.mask(true); b.open(); b.tick(0)
    b.reset(); b.open(); b.identify('ACME|bob'); b.mask(false); b.tick(200)
    assert.deepEqual(b.captured, [])
    assert.equal(b.canShow(), false)
    b.open(); b.tick(0)
    assert.equal(b.canShow(), true)
    b.reset('ACME|bob')
    assert.equal(b.canShow(), false)
    assert.deepEqual(b.canceled, [dialogSurvey.id])
})

test('startup history is wiped by reset and captures from anonymous users are never replayed', (t) => {
    const b = dialogBrowser(t)
    b.bootstrap(); b.open(); b.reset(); b.open(); b.identify('ACME|ann'); b.attach(); b.register(); b.load(); b.tick(100)
    assert.deepEqual(b.captured, [])
    b.open(); b.tick(0)
    b.setIdentity('ACME|ann', false)
    assert.equal(b.canShow(), false, 'anonymous state also invalidates pending work with an unchanged ID')
})

test('logout clears a partial chain even when reset returns the same ID', (t) => {
    const input = { ...dialogSurvey, conditions: { ...dialogSurvey.conditions, lensChain: { ...dialogChain, steps: [
        { event: 'Prepare', properties: dialogChain.steps[0].properties }, ...dialogChain.steps,
    ] } } }
    const b = dialogBrowser(t, input)
    b.register(); b.load(); b.attach()
    b.emit('Prepare', { action: 'OPEN', dialog_id: 'DlgHedgeDesigListReport' })
    b.reset('ACME|ann'); b.open(); b.tick(100)
    assert.deepEqual(b.captured, [])
})

test('native display rejects a changed event-property client on the same identity', (t) => {
    const input = { ...dialogSurvey, conditions: { ...dialogSurvey.conditions, lensChain: {
        ...dialogChain, audience: { clients: ['ACME'], eventProperty: 'client' },
    } } }
    const b = dialogBrowser(t, input)
    const open = () => b.emit('PageView', { action: 'OPEN', dialog_id: 'DlgHedgeDesigListReport', client: 'ACME' })
    b.register(); b.load(); b.attach(); open(); b.tick(0)
    b.emit('Client switched', { client: 'BETA' })
    assert.equal(b.canShow(), false)
    open(); b.tick(0)
    assert.equal(b.canShow(), true)
    b.userProps.set('client', 'BETA')
    assert.equal(b.canShow(), false, 'the native check reads the current registered client too')
})

test('a visible mask that returns before native display blocks the survey after activation', (t) => {
    const b = dialogBrowser(t)
    b.mask(true)
    b.register(); b.load(); b.attach(); b.open(); b.tick(0)
    assert.deepEqual(b.captured, [])
    b.rect.right = 0
    b.tick(100)
    assert.equal(b.canShow(), true)
    b.rect.right = 200; b.style.visibility = 'collapse'
    assert.equal(b.canShow(), true)
    b.style.visibility = 'visible'; b.parent.style.opacity = '0'
    assert.equal(b.canShow(), true)
    b.parent.style.opacity = '1'
    assert.equal(b.canShow(), false)
})

test('Ext JS Classic visibility includes geometry, the mask and its ancestors', () => {
    const visible = { display: 'block', visibility: 'visible', opacity: '1' }
    const viewport = { left: 20, top: 20, right: 40, bottom: 40, width: 20, height: 20 }
    const isBlocked = ({ rect = viewport, css = visible, ancestor = visible, classes = '', ancestorClasses = '' } = {}) => {
        const style = (style: typeof visible, classes: string) => ({
            style, classList: { contains: (name: string) => classes.split(' ').includes(name) },
        })
        const parent = { ...style(ancestor, ancestorClasses), parentElement: null }
        const mask = { ...style(css, classes), parentElement: parent, getBoundingClientRect: () => rect }
        return !engine.isReady({
            innerWidth: 100, innerHeight: 100,
            document: { readyState: 'complete', querySelectorAll: (selector: string) => {
                assert.equal(selector, '.x-mask, .x-mask-msg')
                return [mask]
            } },
            getComputedStyle: (element: typeof parent) => element.style,
        }, dialogChain.ready)
    }
    assert.equal(isBlocked(), true)
    assert.equal(isBlocked({ rect: { ...viewport, left: -10 } }), true, 'a partial intersection counts')
    assert.equal(isBlocked({ css: { ...visible, opacity: '0.01' } }), true)
    for (const css of [
        { display: 'none' }, { visibility: 'hidden' }, { visibility: 'collapse' }, { opacity: '0' },
    ]) {
        assert.equal(isBlocked({ css: { ...visible, ...css } }), false)
        assert.equal(isBlocked({ ancestor: { ...visible, ...css } }), false)
    }
    for (const classes of ['x-hidden-display', 'x-hidden-offsets']) {
        assert.equal(isBlocked({ classes }), false)
        assert.equal(isBlocked({ ancestorClasses: classes }), false)
    }
    for (const rect of [
        { ...viewport, width: 0 }, { ...viewport, height: 0 },
        { ...viewport, left: -10000, right: -9980 }, { ...viewport, top: -10000, bottom: -9980 },
        { ...viewport, left: 100, right: 120 }, { ...viewport, top: 100, bottom: 120 },
    ]) assert.equal(isBlocked({ rect }), false)
})

test('a persistent visible mask times out and debug records why', (t) => {
    const b = dialogBrowser(t)
    b.register(); b.load(); b.attach(); b.open(); b.mask(true); b.tick(180000)
    b.mask(false); b.tick(100)
    assert.deepEqual(b.captured, [])
    assert.ok(b.logs.some((log) => log.includes('timed out waiting for visible loading mask')))
    assert.equal(b.canShow(), false)
})

test('a delayed poll may show after the default deadline when the viewport has no mask', (t) => {
    const b = dialogBrowser(t)
    b.register(); b.load(); b.attach(); b.documentReady('loading'); b.mask(true); b.open(); b.tick(1000)
    b.mask(false); b.jump(180000)
    assert.deepEqual(b.captured, [trigger])
    assert.equal(b.canShow(), true)
})

test('an explicit shorter readiness deadline still applies', (t) => {
    const b = dialogBrowser(t, { ...dialogSurvey, conditions: {
        ...dialogSurvey.conditions, lensChain: { ...dialogChain, ready: { ...dialogChain.ready, maxWaitMs: 1000 } },
    } })
    b.register(); b.load(); b.attach(); b.open(); b.mask(true); b.tick(1000)
    b.mask(false); b.tick(100)
    assert.deepEqual(b.captured, [])
    b.close(); b.open(); b.tick(0)
    assert.deepEqual(b.captured, [trigger])
})

test('existing quiet and dismissal marks still block before activation and before display', (t) => {
    const b = dialogBrowser(t)
    b.register(); b.load(); b.attach()
    b.storage.set('seenSurvey_' + dialogSurvey.id, 'true')
    b.open(); b.tick(0)
    assert.deepEqual(b.captured, [])
    b.storage.clear(); b.open(); b.tick(0)
    assert.deepEqual(b.captured, [trigger])
    b.storage.set('lastSeenSurveyDate', new Date(Date.now()).toISOString())
    assert.equal(b.canShow(), false)
    assert.ok(b.logs.some((log) => log.includes('another survey within the gap')))
})
