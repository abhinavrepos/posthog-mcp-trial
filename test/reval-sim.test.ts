import assert from 'node:assert/strict'
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { parseAppEvents } from '../src/core/appevents.ts'
import { compileSurvey } from '../src/core/surveys.ts'
import { FLOWS, sampleUser } from '../tools/reval-sim/flows.ts'
import { SCREENS } from '../tools/reval-sim/screens.ts'

const reg = parseAppEvents(JSON.parse(readFileSync('config/app-events.reval.json', 'utf8')))

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

test('sample users straddle the fixed PostHog audience bucket', () => {
    assert.notEqual(sampleUser('sample-chain', true), sampleUser('sample-chain', false))
})

for (const [version, vendor] of [['1.454.2', '/root/briefs/reval-vendor'], ['1.450.0', '/root/briefs/reval-vendor-1.450.0']]) {
    test(`verified ${version} SDK builds with the early capture hook when vendor is present`, { skip: !existsSync(join(vendor, 'posthog-js/dist/array.js')) || process.env.REVAL_BUILD_TEST !== '1' }, () => {
        const out = mkdtempSync(join(tmpdir(), 'reval-build-'))
        try {
            execFileSync(process.execPath, ['deploy/posthog/survey-engine/build.mjs', join(vendor, 'posthog-js/dist/surveys.js'), out, 'Survey by ION', join(vendor, 'posthog-js/dist/array.js')])
            const js = readFileSync(join(out, 'array.js'), 'utf8')
            assert.match(js, /__lensSurveyCapture/)
            assert.match(readFileSync(join(out, 'surveys.js'), 'utf8'), /Lens survey chains/)
        } finally { rmSync(out, { recursive: true, force: true }) }
    })
}
