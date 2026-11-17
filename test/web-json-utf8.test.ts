import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { Readable } from 'node:stream'
import { test } from 'node:test'

// Exercise each real page parser without starting the service or calling PostHog.
for (const page of ['replays', 'admin', 'connect', 'dashboards', 'privacy', 'surveyspage']) {
    const source = readFileSync(`src/service/${page}.ts`, 'utf8')
    const start = source.indexOf('async function readJson(')
    const code = stripTypeScriptTypes(source.slice(start, source.indexOf('\n}', start) + 2))
    const readJson = new Function('bad', 'object', code + '\nreturn readJson')(
        (message: string) => { throw new Error(message) }, (value: unknown) => value,
    ) as (req: Readable) => Promise<unknown>
    test(`${page}: JSON body preserves multibyte characters across arbitrary HTTP chunks`, async () => {
        const expected = { text: 'José 李明华 😀', note: 'updated' }
        const bytes = Buffer.from(JSON.stringify(expected))
        const chunks = Array.from(bytes, byte => Buffer.from([byte]))
        assert.deepEqual(await readJson(Readable.from(chunks)), expected)
    })
}
