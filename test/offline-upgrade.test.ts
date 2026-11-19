import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, chmodSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { test as nodeTest } from 'node:test'

// These check the install scripts, which the PostHog Lens image leaves out (deploy/lens/Dockerfile.dockerignore):
// the kit build runs the tests inside that image, where they skip.
const test = (name: string, fn: () => void) => nodeTest(name, { skip: !existsSync('deploy/install.sh') && 'install scripts are not in this image' }, fn)

for (const file of ['deploy/install.sh', 'deploy/offline/no-internet.sh']) {
    test(`${file} quotes systemd paths`, () => {
        const fn = readFileSync(file, 'utf8').match(/systemd_arg\(\) \{[\s\S]*?\n\}/)![0]
        const result = execFileSync('bash', ['-c', `${fn}\nsystemd_arg "$1"`, '--', '/srv/PostHog Lens/%name/$cash/"quote"/back\\slash'], { encoding: 'utf8' })
        assert.equal(result, '"/srv/PostHog Lens/%%name/$$cash/\\"quote\\"/back\\\\slash"')
    })
}

for (const restart of [false, true]) {
    test(`partial backup ${restart ? 'retakes every artifact after restart' : 'resumes without dumping a stopped database'}`, () => {
        const dir = mkdtempSync(join(tmpdir(), 'lens-backup-'))
        try {
            mkdirSync(join(dir, 'state'))
            mkdirSync(join(dir, 'backup'))
            writeFileSync(join(dir, 'identity'), 'original')
            writeFileSync(join(dir, 'running'), 'yes')
            writeFileSync(join(dir, 'fail'), 'yes')
            const source = readFileSync('deploy/migrate/posthog-upgrade.sh', 'utf8')
            const body = source.slice(source.indexOf('# StartedAt changes'), source.indexOf('# ---------------------------------------------------------------- 4 source'))
            const harness = `set -Eeuo pipefail
cd "$1"
BACKUP_DIR="$PWD/backup" STATE="$PWD/state" PROJECT=posthog HELPER_IMAGE=helper
phase() { return 0; }
say() { :; }
remember() { :; }
finish() { :; }
docker() {
 case "$1 $2" in
 'ps -aq') echo container ;;
 'ps -q') [ ! -f running ] || echo container ;;
 'inspect -f') cat identity ;;
 'volume ls') printf 'a\\nb\\n' ;;
 'run --rm') printf '1\\t/v\\n' ;;
 *) return 2 ;;
 esac
 return 0
}
dc() { rm -f running; }
watch_run() { local log="$1"; shift 2; "$@" > "$log" 2>&1; }
tar() { cat identity > "$BACKUP_DIR/install-files.tgz"; }
dump_pg() {
 [ -f running ] || return 99
 cat identity >> dumps
 { cat identity; echo 'PostgreSQL database cluster dump complete'; } | gzip > "$BACKUP_DIR/pg_dumpall.sql.gz.partial"
}
tar_volume() {
 if [ "$1" = b ] && [ -f fail ]; then return 1; fi
 cat identity > "$BACKUP_DIR/volumes/$1.tar.partial"
}
make_sums() { (cd "$BACKUP_DIR"; sha256sum pg_dumpall.sql.gz install-files.tgz volumes/*.tar > SHA256SUMS.partial); }
${body}`
            writeFileSync(join(dir, 'run.sh'), harness)
            assert.equal(spawnSync('bash', [join(dir, 'run.sh'), dir]).status, 1)
            rmSync(join(dir, 'fail'))
            if (restart) {
                writeFileSync(join(dir, 'identity'), 'restarted')
                writeFileSync(join(dir, 'running'), 'yes')
            }
            execFileSync('bash', [join(dir, 'run.sh'), dir])
            assert.equal(readFileSync(join(dir, 'dumps'), 'utf8'), restart ? 'originalrestarted' : 'original')
            for (const path of ['install-files.tgz', 'volumes/a.tar', 'volumes/b.tar']) {
                assert.equal(readFileSync(join(dir, 'backup', path), 'utf8'), restart ? 'restarted' : 'original')
            }
            execFileSync('sha256sum', ['-c', 'SHA256SUMS'], { cwd: join(dir, 'backup') })
        } finally { rmSync(dir, { recursive: true, force: true }) }
    })
}

// Rollback after an interrupted backup must refuse before touching anything, and must never unpack a backup
// over a volume it could not remove. A fake docker records every call; no real container or volume is used.
test('rollback refuses an incomplete backup and a volume it cannot remove', () => {
    const path = { join, resolve }
    const script = path.resolve('deploy/migrate/posthog-upgrade.sh')
    const setup = (opts: { archives: string[]; sums: boolean; stuck?: string }) => {
        const dir = mkdtempSync(path.join(tmpdir(), 'rollback-'))
        const bin = path.join(dir, 'bin'); mkdirSync(bin)
        const log = path.join(dir, 'docker.log')
        // inspect succeeds (the volume still exists) only for the stuck one; everything else succeeds silently.
        writeFileSync(path.join(bin, 'docker'), `#!/bin/bash\necho "$*" >> ${JSON.stringify(log)}\n[ "$1 $2" = "compose version" ] && exit 0\nif [ "$1 $2" = "volume inspect" ]; then [ "$3" = ${JSON.stringify(opts.stuck || '')} ] && exit 0; exit 1; fi\nexit 0\n`)
        chmodSync(path.join(bin, 'docker'), 0o755)
        const ph = path.join(dir, 'posthog'); mkdirSync(ph)
        writeFileSync(path.join(ph, '.env'), ''); writeFileSync(path.join(ph, 'docker-compose.yml'), '')
        const state = path.join(ph, 'upgrade-state'), backup = path.join(ph, 'upgrade-backup')
        mkdirSync(path.join(state, 'done'), { recursive: true }); mkdirSync(path.join(backup, 'volumes'), { recursive: true })
        writeFileSync(path.join(state, 'project'), 'posthog\n'); writeFileSync(path.join(state, 'volume_backup'), 'yes\n')
        execFileSync('tar', ['-czf', path.join(backup, 'install-files.tgz'), '-T', '/dev/null'])
        writeFileSync(path.join(backup, 'volumes', 'list.txt'), 'posthog_clickhouse-data\nposthog_postgres-data\n')
        for (const v of opts.archives) writeFileSync(path.join(backup, 'volumes', `${v}.tar`), 'x')
        if (opts.sums) execFileSync('bash', ['-c', 'sha256sum install-files.tgz volumes/*.tar > SHA256SUMS'], { cwd: backup })
        return { run: () => spawnSync('bash', [script, 'rollback', '--yes'], { cwd: ph, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ASSUME_YES: '1' }, encoding: 'utf8' }), log }
    }
    const calls = (log: string) => existsSync(log) ? readFileSync(log, 'utf8') : ''
    // A listed volume without its archive: refused, nothing stopped or removed.
    let t = setup({ archives: ['posthog_clickhouse-data'], sums: false })
    let r = t.run()
    assert.equal(r.status, 1); assert.match(r.stdout + r.stderr, /no archive for volume posthog_postgres-data/)
    assert.doesNotMatch(calls(t.log), /down|volume rm/)
    // Every archive present but no checksums from this version of the script: the backup did not finish.
    t = setup({ archives: ['posthog_clickhouse-data', 'posthog_postgres-data'], sums: false })
    r = t.run()
    assert.equal(r.status, 1); assert.match(r.stdout + r.stderr, /did not finish/)
    assert.doesNotMatch(calls(t.log), /down|volume rm/)
    // Complete backup, but a volume that cannot be removed: stops before unpacking anything over it.
    t = setup({ archives: ['posthog_clickhouse-data', 'posthog_postgres-data'], sums: true, stuck: 'posthog_clickhouse-data' })
    r = t.run()
    assert.equal(r.status, 1, r.stdout + r.stderr); assert.match(r.stdout + r.stderr, /could not be removed/)
    assert.doesNotMatch(calls(t.log), /volume create|tar -xf/)
})
