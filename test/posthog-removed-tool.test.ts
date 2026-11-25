import assert from 'node:assert/strict'
import { test } from 'node:test'
import { posthogFailure, posthogPublicMessage } from '../src/mcp/posthog-error.ts'

test('a tool PostHog removed is reported as a wrong command with the execute-sql hint, not as unavailable', () => {
    const text = 'Error: [exec]: Tool "query-run" was removed. Pick the typed query tool that matches your intent, or use "execute-sql" for arbitrary HogQL. Available query-* tools: query-trends'
    const m = posthogFailure({ content: [{ type: 'text', text }], isError: true }).message
    assert.doesNotMatch(m, /unavailable/)
    assert.match(m, /call execute-sql/)
    assert.equal(posthogPublicMessage(m), m)
})
