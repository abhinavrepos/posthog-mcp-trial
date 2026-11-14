import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, mkdirSync, statSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'

test('installer makes data directories private after assigning ownership', () => {
    const source = readFileSync('deploy/install.sh', 'utf8')
    const command = source.split('\n').find(line => line.trim().startsWith('chmod 700 "$APP_DIR"/'))!
    assert.ok(command)
    assert.ok(source.indexOf(command) > source.indexOf('chown -R "$APP_USER:$APP_USER" "$APP_DIR"/{run,logs,clips,.cache}'))
    const dir = mkdtempSync(join(tmpdir(), 'lens-install-'))
    try {
        for (const name of ['run', 'logs', 'clips', '.cache']) mkdirSync(join(dir, name), { mode: 0o755 })
        execFileSync('bash', ['-c', command], { env: { ...process.env, APP_DIR: dir } })
        for (const name of ['run', 'logs', 'clips', '.cache']) assert.equal(statSync(join(dir, name)).mode & 0o777, 0o700)
    } finally { rmSync(dir, { recursive: true, force: true }) }
})
