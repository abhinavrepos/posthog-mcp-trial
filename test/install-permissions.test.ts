import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, mkdirSync, statSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { existsSync } from 'node:fs'
import { test as nodeTest } from 'node:test'

// These check the install scripts, which the Signal image leaves out (deploy/lens/Dockerfile.dockerignore):
// the kit build runs the tests inside that image, where they skip.
const test = (name: string, fn: () => void) => nodeTest(name, { skip: !existsSync('deploy/install.sh') && 'install scripts are not in this image' }, fn)

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

// A re-run (upgrade) found the status page publishing 8090 and stopped: it is its own Compose project
// (lens-status), not PostHog's. Run the real port checks against a fake docker.
test('installer accepts the status page on 8090 and nothing else there', () => {
    const source = readFileSync('deploy/install.sh', 'utf8')
    const fn = source.slice(source.indexOf('status_publishes_port() {'), source.indexOf('\n}\n', source.indexOf('status_publishes_port() {')) + 3)
    const dir = mkdtempSync(join(tmpdir(), 'lens-install-'))
    try {
        const fake = (label: string) => `#!/bin/sh\ncase "$1" in ps) echo c1 ;; inspect) echo '${label}' ;; esac\n`
        const run = (label: string) => {
            execFileSync('bash', ['-c', `cat > "${dir}/docker" <<'X'\n${fake(label)}X\nchmod +x "${dir}/docker"`])
            try { execFileSync('bash', ['-c', `${fn}\nstatus_publishes_port 8090`], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } }); return true } catch { return false }
        }
        assert.equal(run('lens-status/status'), true)
        assert.equal(run('posthog/proxy'), false)
        assert.equal(run('/'), false)
        assert.match(source, /8090:\*docker-proxy\*\)\s*\n\s*status_publishes_port "\$p"/)
    } finally { rmSync(dir, { recursive: true, force: true }) }
})
