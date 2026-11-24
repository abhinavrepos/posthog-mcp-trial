import assert from 'node:assert/strict'
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { parseAppEvents } from '../src/core/appevents.ts'
import { config } from '../src/core/config.ts'
import { compileSurvey, type SurveySpec } from '../src/core/surveys.ts'
import { FLOWS, sampleUser } from '../tools/reval-sim/flows.ts'
import { SCREENS } from '../tools/reval-sim/screens.ts'

const reg = parseAppEvents(JSON.parse(readFileSync('config/app-events.reval.json', 'utf8')))
const spec = (steps: SurveySpec['steps']): SurveySpec => ({ name: 'Reval check', questions: [{ type: 'rating', text: 'How was it?' }], steps })

test('Reval screen table covers 100 distinct openable screens and report event IDs', () => {
    assert.ok(SCREENS.filter(s => !s.stuck).length >= 100)
    assert.equal(new Set(SCREENS.map(s => s.menu)).size, SCREENS.length)
    for (const s of SCREENS) {
        assert.ok(s.name && s.event && s.buttons.length && s.loadMs >= 0 && s.settleMs >= 0)
        if (s.kind === 'report') {
            assert.equal(s.event, s.menu.slice('report:'.length))
            assert.ok(s.param && s.result && s.id === s.result)
        }
    }
    assert.equal(SCREENS.find(s => s.menu === 'report:LinkListReqv')?.event, 'LinkListReqv')
})

test('Reval flows have valid screen actions and explicit outcomes', () => {
    assert.ok(FLOWS.length >= 25)
    const byMenu = new Map(SCREENS.map(s => [s.menu, s]))
    const known = (key: string) => byMenu.get(key) || SCREENS.find(s => s.event === key)
    for (const flow of FLOWS) {
        assert.ok(flow.acts.some(a => a[0] === 'expect'), flow.name)
        for (const act of flow.acts) {
            if (act[0] === 'open') assert.ok(byMenu.has(act[1]), `${flow.name}: ${act[1]}`)
            if (act[0] === 'press') {
                const s = known(act[1].replace(/#result$/, ''))
                assert.ok(s, `${flow.name}: ${act[1]}`)
                assert.ok(s!.buttons.includes(act[2]) || (act[1].endsWith('#result') && ['Export', 'XLSX Export', 'CSV Export'].includes(act[2])), `${flow.name}: ${act[2]}`)
            }
            if (act[0] === 'field') assert.ok(known(act[1])?.fields?.includes(act[2]), `${flow.name}: ${act[2]}`)
            if (act[0] === 'tab') assert.ok(known(act[1])?.tabs?.includes(act[2]), `${flow.name}: ${act[2]}`)
            if (act[0] === 'expect') {
                assert.ok(!!act[1].none !== !!act[1].shown, `${flow.name}: ambiguous expectation`)
                for (const k of act[1].shown || []) assert.ok(flow.surveys[k], `${flow.name}: ${k}`)
            }
        }
        for (const definition of Object.values(flow.surveys)) {
            const compiled = compileSurvey(definition.spec, { reg, clientIds: definition.clients })
            assert.equal(compiled.problems.filter(p => p.level === 'error').length, 0, flow.name)
        }
    }
})

test('Lens warns when Reval report Ext IDs or titles are mistaken for emitted IDs', () => {
    for (const wrong of ['DlgHedgeDesigListReport', 'Hedge Designation']) {
        const problems = compileSurvey(spec([{ opens: wrong }]), { reg, clientIds: ['SEM'] }).problems
        assert.ok(problems.some(p => p.level === 'warning' && p.text.includes('LinkListReqv')), wrong)
    }
    assert.ok(!compileSurvey(spec([{ opens: 'LinkListReqv' }]), { reg, clientIds: ['SEM'] }).problems.some(p => p.where.startsWith('steps')))
})

test('Lens warns about Reval client targeting and impossible repeated OPEN', () => {
    const old = config.properties.clientFromDistinctId
    try {
        config.properties.clientFromDistinctId = 0
        const problems = compileSurvey(spec([{ opens: 'DlgTradeList' }, { opens: 'DlgDetailIRSwap' }, { opens: 'DlgTradeList' }, { button: 'Export' }]), { reg, clientIds: ['SEM'] }).problems
        assert.ok(problems.some(p => p.where === 'clients' && p.text.includes('CLIENT_FROM_DISTINCT_ID=3')))
        assert.ok(problems.some(p => p.where === 'steps[2]' && p.text.includes('twice')))
        assert.ok(problems.some(p => p.where === 'steps[3]' && p.text.includes('XLSX Export')))
    } finally { config.properties.clientFromDistinctId = old }
})

test('sample users straddle the fixed PostHog audience bucket', () => {
    assert.notEqual(sampleUser('sample-chain', true), sampleUser('sample-chain', false))
})

test('verified 1.454.2 SDK builds with the early capture hook when vendor is present', { skip: !existsSync('/root/briefs/reval-vendor/posthog-js/dist/array.js') || process.env.REVAL_BUILD_TEST !== '1' }, () => {
    const out = mkdtempSync(join(tmpdir(), 'reval-build-'))
    try {
        execFileSync(process.execPath, ['deploy/posthog/survey-engine/build.mjs', '/root/briefs/reval-vendor/posthog-js/dist/surveys.js', out, 'Survey by ION', '/root/briefs/reval-vendor/posthog-js/dist/array.js'])
        const js = readFileSync(join(out, 'array.js'), 'utf8')
        assert.match(js, /__lensSurveyCapture/)
        assert.match(readFileSync(join(out, 'surveys.js'), 'utf8'), /Lens survey chains/)
    } finally { rmSync(out, { recursive: true, force: true }) }
})
