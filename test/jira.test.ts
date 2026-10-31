import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { adfToText, inline, markdownToAdf } from '../src/jira/adf.ts'
import { issueToTicket, signWebhook, verifyWebhookSignature } from '../src/jira/client.ts'
import { renderReport, sparkline } from '../src/core/report.ts'
import type { TriageReport } from '../src/core/triage.ts'

describe('webhook signatures', () => {
    const body = '{"webhookEvent":"jira:issue_created","issue":{"key":"SUP-1"}}'
    test('a correct signature passes; tampering, wrong secret, bad format and no secret fail', () => {
        const sig = signWebhook(body, 'secret')
        assert.equal(verifyWebhookSignature(body, sig, 'secret'), true)
        assert.equal(verifyWebhookSignature(body.replace('SUP-1', 'SUP-2'), sig, 'secret'), false)
        assert.equal(verifyWebhookSignature(body, sig, 'other'), false)
        assert.equal(verifyWebhookSignature(body, sig.replace('sha256=', 'sha1='), 'secret'), false)
        assert.equal(verifyWebhookSignature(body, undefined, 'secret'), false)
        assert.equal(verifyWebhookSignature(body, sig, ''), false)
    })
})

describe('ADF', () => {
    test('inline marks: bold link, link, bold, code, italic; snake_case is not italic', () => {
        const nodes = inline('**[clip](https://x.example/a)** and [replay](https://x.example/b), **P1**, `code`, _note_, client_id')
        const marks = nodes.filter((n) => n.marks).map((n) => [n.text, n.marks!.map((m) => m.type).join('+')])
        assert.deepEqual(marks, [['clip', 'strong+link'], ['replay', 'link'], ['P1', 'strong'], ['code', 'code'], ['note', 'em']])
        assert.ok(nodes.some((n) => n.text?.includes('client_id')))
    })
    test('headings, lists and tables become ADF blocks', () => {
        const doc = markdownToAdf('## Title\n\n- one\n- two\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\ntext')
        assert.deepEqual(doc.content!.map((n) => n.type), ['heading', 'bulletList', 'table', 'paragraph'])
        const table = doc.content![2]
        assert.equal(table.content!.length, 2) // separator row dropped
        assert.equal(table.content![0].content![0].type, 'tableHeader')
    })
    test('ADF to text keeps list items on single lines', () => {
        const text = adfToText(markdownToAdf('Intro\n\n- one\n- two'))
        assert.equal(text, 'Intro\n- one\n- two\n')
    })
})

describe('issue mapping', () => {
    test('issue types pick the flow; other types are left alone', () => {
        const base = { key: 'SUP-9', fields: { summary: 's', description: markdownToAdf('d'), reporter: { emailAddress: 'cs@acme.example', timeZone: 'Europe/Paris' } } }
        assert.equal(issueToTicket({ ...base, fields: { ...base.fields, issuetype: { name: 'RCI' } } })?.kind, 'rci')
        assert.equal(issueToTicket({ ...base, fields: { ...base.fields, issuetype: { name: 'MMT Risk' } } })?.kind, 'risk')
        assert.equal(issueToTicket({ ...base, fields: { ...base.fields, issuetype: { name: 'Story' } } }), undefined)
        const t = issueToTicket({ ...base, fields: { ...base.fields, issuetype: { name: 'RCI' }, customfield_client: { value: 'brightwater' } } })!
        assert.equal(t.fields?.client, 'brightwater')
        assert.equal(t.reporter?.timeZone, 'Europe/Paris')
    })
})

describe('report', () => {
    test('sparkline scales to the max and shows zero as a dot', () => {
        assert.equal(sparkline([0, 1, 8]), '·▁█')
    })
    test('every report carries the marker that stops double-posting', () => {
        const r: TriageReport = {
            ticket: { key: 'SUP-1', kind: 'rci', summary: 's' },
            understood: { other_clients: [], emails: [], window: { from: new Date(), to: new Date(), label: 'the last 7 days', precision: 'none' }, sources: { client: 'text', email: 'none', screen: 'none', time: 'none' }, ai_used: false },
            other_sessions: [],
            severity: { priority: 'P4', score: 0, reasons: [] },
            notes: ['No client could be identified.'],
            elapsed_s: 0.4,
        }
        const md = renderReport(r)
        assert.ok(adfToText(markdownToAdf(md)).includes('ticket-triage'))
        assert.ok(md.includes('No client could be identified.'))
    })
})
