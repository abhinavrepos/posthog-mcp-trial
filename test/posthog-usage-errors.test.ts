import assert from 'node:assert/strict'
import { test } from 'node:test'
import { posthogFailure, posthogPublicMessage, posthogUsageMessage } from '../src/mcp/posthog-error.ts'
import { toolError } from '../src/mcp/toolerror.ts'

const mcpError = (text: string) => ({ isError: true, content: [{ type: 'text', text }] })

test('a wrongly formed PostHog command becomes a fixed correction, classified as validation, not "unavailable"', () => {
    const e = posthogFailure(mcpError('Error: [exec]: "query-trends" is a tool, not a command. Invoke it as: call query-trends <json_input>.'))
    assert.match(e.message, /^PostHog command format: "query-trends" is a tool\. Use: call query-trends <json_input>\. Run "tools"/)
    assert.equal(posthogPublicMessage(e.message), e.message, 'survives job persistence')
    const r = toolError(e, 'posthog_exec')
    assert.equal(r.kind, 'validation')
    assert.match(r.result.content[0].text, /call query-trends <json_input>/)
})

test('unknown commands, invalid input and SQL errors map to fixed messages; upstream text is never echoed raw', () => {
    assert.match(posthogUsageMessage('Unknown command: frobnicate')!, /^PostHog does not know that command\./)
    assert.match(posthogUsageMessage('Invalid input: expected object, received string at db.internal:5432')!, /^PostHog rejected the input for this command\./)
    const sql = posthogUsageMessage('HogQL error: Syntax error at line 1: unexpected FORM near "SELECT count() FORM events" <script>alert(1)</script> host=10.0.0.5')!
    assert.match(sql, /^PostHog could not run the SQL: Syntax error/)
    assert.doesNotMatch(sql, /[<>]script|"|\\/)
    assert.ok(sql.length < 260)
    for (const m of [posthogUsageMessage('Unknown command: x')!, posthogUsageMessage('validation error')!, sql]) assert.equal(posthogPublicMessage(m), m)
    // A forged message that only looks like ours is not public.
    assert.equal(posthogPublicMessage('PostHog could not run the SQL: "secret". Fix the query and retry.'), undefined)
})

test('real outages, auth failures and timeouts keep their existing messages', () => {
    assert.equal(posthogFailure('fetch failed ECONNREFUSED').message, 'PostHog is unavailable. Retry later.')
    assert.match(posthogFailure(mcpError('request failed'), 403).message, /refused access/)
    assert.match(posthogFailure('Code: 241. memory limit exceeded').message, /ran out of memory/)
    assert.equal(posthogUsageMessage('everything is fine'), undefined)
})

test("PostHog's own max-execution-time limit says so and points to Lens rollup tools, classified as capacity", () => {
    const e = posthogFailure({ isError: true, content: [{ type: 'text', text: 'Error: [query-funnel]: Request failed: Path: POST /api/environments/2/query/ Status Code: 504 (Gateway Timeout) Error Message: {"type":"server_error","detail":"Query has hit the max execution time before completing."}' }] })
    assert.match(e.message, /own time limit; repeating it will not help/)
    assert.match(e.message, /workflow_completion/)
    assert.doesNotMatch(e.message, /environments\/2|server_error/)
    assert.equal(posthogPublicMessage(e.message), e.message)
    assert.equal(toolError(e, 'posthog_exec').kind, 'capacity')
})
