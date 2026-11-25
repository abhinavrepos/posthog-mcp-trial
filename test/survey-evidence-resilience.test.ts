import assert from 'node:assert/strict'
import test from 'node:test'
import reval from '../config/app-events.reval.json' with { type: 'json' }
import { parseAppEvents } from '../src/core/appevents.ts'
import { surveyEvidence } from '../src/core/surveychecks.ts'

test('survey evidence warns when a report title is used as its dialog id', async () => {
    const reg = parseAppEvents(reval)
    const chain = { steps: [{ event: 'PageView', properties: { dialog_id: { operator: 'exact', values: ['DlgHedgeDesigListReport'] }, action: { operator: 'exact', values: ['OPEN'] } } }] } as never
    const problems = await surveyEvidence(chain, { reg, query: async query => {
        if (query.includes('count() AS n FROM events')) return [{ n: 20 }]
        if (query.includes('AS opens')) return [{ id: 'LinkListReqv', name: 'Hedge Designation', opens: 20, closes: 0, n: 20 }]
        return []
    } })
    assert.match(problems.map(p => p.text).join(' '), /LinkListReqv|menu id/)
})

test('survey evidence warns when the configured client event property is absent', async () => {
    const reg = parseAppEvents(reval)
    const chain = { steps: [], audience: { clients: ['SEM'], eventProperty: 'client_id' } } as never
    const problems = await surveyEvidence(chain, { reg, query: async () => [{ n: 20, carried: 0, chosen: 0 }] })
    assert.ok(problems.some(p => p.where === 'clients' && /show to no one/.test(p.text)))
})

test('survey evidence outage warning hides upstream paths and secrets', async () => {
    const reg = parseAppEvents(reval)
    const chain = { steps: [{ event: 'PageView', properties: { dialog_id: { operator: 'exact', values: ['LinkListReqv'] }, action: { operator: 'exact', values: ['OPEN'] } } }] } as never
    const problems = await surveyEvidence(chain, { reg, query: async () => { throw Error('unexpected /srv/private/key secret-token') } })
    const text = problems.map(p => p.text).join(' ')
    assert.match(text, /could not check/i)
    assert.doesNotMatch(text, /\/srv\/|secret-token/)
})

const timeout = () => Promise.reject(Object.assign(new Error('timed out'), { name: 'TimeoutError' }))
test('a check that times out is skipped on its own with a warning; the others still report and nothing reads as "matched nothing"', async () => {
    const { foundMismatch } = await import('../src/core/surveychecks.ts')
    const reg = parseAppEvents(reval)
    // Hedge Designation then a misspelt Export: the dialog check times out, the button check answers.
    const chain = { steps: [
        { event: 'PageView', properties: { dialog_id: { operator: 'exact', values: ['LinkListReqv'] }, action: { operator: 'exact', values: ['OPEN'] } } },
        { event: 'Event', properties: { action_name: { operator: 'exact', values: ['Exprot'] }, dialog_id: { operator: 'exact', values: ['LinkListReqv'] } } },
    ] } as never
    const problems = await surveyEvidence(chain, { reg, query: async (query) => {
        if (query.includes('AS opens')) return timeout()
        if (query.includes('count() AS n FROM events WHERE')) return [{ n: 1000 }]
        if (query.includes('AS v, count() AS n') && !query.includes('lower(')) return [{ v: 'Export', n: 500 }, { v: 'Save', n: 300 }]
        return []
    } })
    const text = problems.map((p) => p.text).join('\n')
    assert.match(text, /Check skipped: .*the dialog ids/)
    assert.doesNotMatch(text, /Nobody opened a dialog/, 'a skipped dialog check never claims the dialog is unused')
    assert.match(text, /button labelled "Exprot".*never match/s, 'the button check still reports')
    assert.equal(foundMismatch(problems), true)
    // Every check times out: only skip warnings, never a mismatch.
    const all = await surveyEvidence(chain, { reg, query: timeout as never })
    assert.ok(all.length >= 1 && all.every((p) => /Check skipped|could not check/.test(p.text)), JSON.stringify(all))
    assert.equal(foundMismatch(all), false)
})
