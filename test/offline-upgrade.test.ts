import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

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
