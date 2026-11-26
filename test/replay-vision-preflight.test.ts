import assert from 'node:assert/strict'
import test from 'node:test'
import {mkdtempSync, writeFileSync, rmSync, mkdirSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {spawnSync} from 'node:child_process'

test('recording doctor reports only fixed states for missing, mismatched and healthy secrets', () => {
  const dir=mkdtempSync(join(tmpdir(),'rv-doctor-'))
  try {
    const bin=join(dir,'bin');mkdirSync(bin)
    writeFileSync(join(bin,'docker'),`#!/bin/sh
if [ "$1" = compose ]; then echo abc; elif [ "$1" = inspect ]; then
  case "$2" in
    -f) case "$3" in *State.Running*) echo true;; *) printf 'RECORDING_API_JWT_SECRET=%s\\n' "\${MOCK_CONTAINER_SECRET:-}";; esac;;
  esac
fi
`,{mode:0o700})
    writeFileSync(join(bin,'curl'),`#!/bin/sh
case " $* " in *-w*) printf 200;; esac
`,{mode:0o700})
    const env={...process.env,PATH:`${bin}:${process.env.PATH}`,POSTHOG_PERSONAL_API_KEY:'private-api-key',POSTHOG_PROJECT_ID:'1',REPLAY_VISION_PROBE_SESSION:'session-id'}
    const doctor=join(process.cwd(),'deploy/posthog/recording-api-doctor.sh')
    const check=(secret:string,container:string)=>{
      writeFileSync(join(dir,'.env'),`RECORDING_API_JWT_SECRET=${secret}\n`)
      const r=spawnSync('bash',[doctor,dir],{env:{...env,MOCK_CONTAINER_SECRET:container},encoding:'utf8'})
      assert.equal(r.stderr,'')
      assert.ok(!r.stdout.includes('private-api-key'))
      assert.ok(!r.stdout.includes('top-secret'))
      return r.stdout.trim()
    }
    assert.equal(check('',''),'missing')
    assert.equal(check('top-secret','different'),'mismatch')
    assert.equal(check('top-secret','top-secret'),'configured')
  } finally {rmSync(dir,{recursive:true,force:true})}
})
