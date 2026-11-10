import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'

// A throwaway database and clips folder. These have to be set before the modules load.
const dir = mkdtempSync(join(tmpdir(), 'triage-db-'))
process.env.TRIAGE_DB = join(dir, 'test.db')
process.env.CLIP_OUT_DIR = join(dir, 'clips')
mkdirSync(process.env.CLIP_OUT_DIR)
const { db, one, run } = await import('../src/core/db.ts')
const { config } = await import('../src/core/config.ts')
const access = await import('../src/service/access.ts')
const replays = await import('../src/service/replays.ts')
after(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
})

const DAY = 86_400_000
const clip = (name: string) => {
    writeFileSync(join(config.clip.outDir, name), Buffer.alloc(2048))
    return { name, session_id: name.split('_')[0], start_offset_s: 10, end_offset_s: 40 }
}
const age = (name: string, days: number) => run('UPDATE clips SET last_requested_at = ? WHERE name = ?', new Date(Date.now() - days * DAY).toISOString(), name)

describe('database', () => {
    test('uses the throwaway clips folder', () => assert.equal(config.clip.outDir, process.env.CLIP_OUT_DIR))

    test('roles: default, set, change, reset, each one in the activity log', () => {
        assert.equal(access.roleOf('pm@acme.example', false), 'none')
        access.setPerson('PM@acme.example', 'watch', 'admin@acme.example')
        access.setPerson('pm@acme.example', 'download', 'admin@acme.example', 'Payments PM')
        assert.equal(access.roleOf('pm@acme.example', false), 'download')
        assert.equal(access.roleOf('pm@acme.example', true), 'admin', 'PostHog admins are always admin')
        access.removePerson('pm@acme.example', 'admin@acme.example')
        assert.equal(access.roleOf('pm@acme.example', false), 'none')
        assert.deepEqual(
            access.readAudit({ action: 'access.' }).map((e) => [e.action, e.before]),
            [
                ['access.role_removed', 'download'],
                ['access.role_set', 'watch'],
                ['access.role_set', null],
            ]
        )
        assert.throws(() => run("INSERT INTO people VALUES ('x@y.z', 'superuser', null, 'a', 'b')"), 'unknown roles are refused')
    })

    test('System page: admins always, others only when ticked, apart from the clip role', () => {
        const ops = 'ops@acme.example'
        assert.equal(access.canSeeSystem({ role: 'admin', system: false }), true, 'admins always see it')
        assert.equal(access.canSeeSystem({ role: 'download', system: false }), false)
        assert.equal(access.hasSystemGrant(ops), false)

        access.setSystemAccess('OPS@acme.example', true, 'admin@acme.example')
        assert.equal(access.hasSystemGrant(ops), true)
        assert.equal(access.canSeeSystem({ role: 'none', system: access.hasSystemGrant(ops) }), true, 'no clip access, but the System page')

        // Changing or resetting the clip role leaves the System page as it was.
        access.setPerson(ops, 'watch', 'admin@acme.example')
        access.removePerson(ops, 'admin@acme.example')
        assert.equal(access.hasSystemGrant(ops), true)

        access.setSystemAccess(ops, true, 'admin@acme.example') // no change: not logged again
        access.setSystemAccess(ops, false, 'admin@acme.example')
        assert.equal(access.hasSystemGrant(ops), false)
        assert.deepEqual(
            access.readAudit({ action: 'access.system_set' }).map((e) => [e.person, e.system]),
            [
                [ops, false],
                [ops, true],
            ]
        )
    })

    test('settings persist', () => {
        access.setAccessSettings({ default_role: 'watch', allow_share_links: false }, 'admin@acme.example')
        assert.deepEqual([access.loadAccess().default_role, access.loadAccess().allow_share_links], ['watch', false])
    })

    test('activity search matches person, action or details, and % is literal', () => {
        access.audit('ana@acme.example', 'clip.viewed', { clip: 'abc_10-20.mp4' })
        assert.equal(access.readAudit({ q: 'ANA@' }).length, 1)
        assert.equal(access.readAudit({ q: 'abc_10' }).length, 1)
        assert.equal(access.readAudit({ q: '%' }).length, 0)
    })

    test('the same clip made by two people is stored once, and both have it', () => {
        replays.storeClip(clip('s1_10-40.mp4'), { client: 'Brightwater' }, 'ana@acme.example')
        replays.storeClip(clip('s1_10-40.mp4'), { client: 'Brightwater' }, 'bo@acme.example')
        const c = replays.getClip('s1_10-40.mp4')!
        assert.deepEqual(c.holders.sort(), ['ana@acme.example', 'bo@acme.example'])
        assert.equal(c.created_by, 'ana@acme.example')
        assert.equal(one<{ n: number }>('SELECT COUNT(*) AS n FROM clips')!.n, 1)
        assert.equal(replays.listClips({ holder: 'bo@acme.example' }).length, 1)
        assert.equal(replays.listClips({ holder: 'cy@acme.example' }).length, 0)
        const st = replays.storage()
        assert.equal(st.bytes, 2048, 'counted once in the total')
        assert.equal(st.per_person.length, 2)
    })

    test('an unsaved clip is deleted after 14 days; asking again restarts the clock', () => {
        replays.storeClip(clip('s2_10-40.mp4'), {}, 'ana@acme.example')
        age('s2_10-40.mp4', 13)
        replays.pruneOldClips()
        assert.ok(replays.getClip('s2_10-40.mp4'), 'kept at 13 days')
        age('s2_10-40.mp4', 15)
        replays.storeClip(clip('s2_10-40.mp4'), {}, 'bo@acme.example')
        replays.pruneOldClips()
        assert.ok(replays.getClip('s2_10-40.mp4'), 'kept: asked for again')
        age('s2_10-40.mp4', 15)
        replays.pruneOldClips()
        assert.equal(replays.getClip('s2_10-40.mp4'), undefined, 'deleted after 15 days')
    })

    test('a saved clip is kept until everyone unsaves it, then gets 14 more days', () => {
        replays.storeClip(clip('s3_10-40.mp4'), {}, 'ana@acme.example')
        replays.setSaved('s3_10-40.mp4', 'ana@acme.example', true)
        replays.setSaved('s3_10-40.mp4', 'bo@acme.example', true)
        assert.equal(replays.getClip('s3_10-40.mp4')!.expires_at, undefined)
        age('s3_10-40.mp4', 100)
        replays.pruneOldClips()
        assert.ok(replays.getClip('s3_10-40.mp4'), 'saved clips survive')
        replays.setSaved('s3_10-40.mp4', 'ana@acme.example', false)
        age('s3_10-40.mp4', 100)
        replays.pruneOldClips()
        assert.ok(replays.getClip('s3_10-40.mp4'), 'bo still has it saved')
        replays.setSaved('s3_10-40.mp4', 'bo@acme.example', false)
        const c = replays.getClip('s3_10-40.mp4')!
        assert.ok(Date.parse(c.expires_at!) > Date.now() + 13 * DAY, 'unsaving starts a fresh 14 days')
    })

    test('MP4 files no clip row knows about are cleaned up after 14 days', () => {
        const f = join(config.clip.outDir, 'stray_0-30.mp4')
        writeFileSync(f, 'x')
        const old = (Date.now() - 15 * DAY) / 1000
        utimesSync(f, old, old)
        replays.pruneOldClips()
        assert.throws(() => utimesSync(f, old, old))
    })

    test('deleting a clip removes who had it', () => {
        assert.equal(replays.deleteClip('s1_10-40.mp4'), true)
        assert.equal(one<{ n: number }>("SELECT COUNT(*) AS n FROM clip_holders WHERE clip_name = 's1_10-40.mp4'")!.n, 0)
    })
})
