import assert from 'node:assert/strict'
import test from 'node:test'
import { publicRequestFailure } from '../src/service/failure.ts'

test('page and API failures remain readable and hide storage diagnostics', () => {
    const error = Object.assign(new Error('SQLITE_FULL: /srv/private.db secret-token'), { code: 'SQLITE_FULL' })
    const page = publicRequestFailure('/replays/pinned', error)
    assert.equal(page.status, 503)
    assert.equal(typeof page.body, 'string')
    assert.match(page.body as string, /temporarily unavailable|reload/i)
    const api = publicRequestFailure('/replays/admin/api/audit', error)
    assert.equal(api.status, 503)
    assert.match(JSON.stringify(api.body), /storage is unavailable/)
    for (const response of [page, api]) assert.doesNotMatch(JSON.stringify(response), /private\.db|secret-token|SQLITE_FULL|stack/)
})
