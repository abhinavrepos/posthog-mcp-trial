import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,writeFileSync,readFileSync,existsSync,mkdirSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {execFileSync} from 'node:child_process'

test('uninstaller removes only Signal survey compose overrides and their references',t=>{
    const dir=mkdtempSync(join(tmpdir(),'survey-uninstall-'));t.after(()=>rmSync(dir,{recursive:true,force:true}))
    const bin=join(dir,'bin');mkdirSync(bin)
    writeFileSync(join(bin,'docker'),'#!/bin/sh\nexit 0\n',{mode:0o755})
    writeFileSync(join(dir,'.env'),'COMPOSE_FILE="docker-compose.yml:docker-compose.lens-survey.yml:site.yml:docker-compose.lens-survey-lock.yml"\nEXTRA_COMPOSE_FILES=docker-compose.lens-survey.yml:site.yml:docker-compose.lens-survey-lock.yml\n')
    writeFileSync(join(dir,'docker-compose.lens-survey.yml'),'# Lens survey engine\nservices:\n  web:\n    volumes:\n      - ./lens-survey-engine/surveys.js:/code/staticfiles/surveys.js:ro\n')
    writeFileSync(join(dir,'docker-compose.lens-survey-lock.yml'),'# Lens survey lock\nservices: {}\n')
    writeFileSync(join(dir,'site.yml'),'# unrelated site override\n')
    execFileSync('bash',[resolve('deploy/posthog/survey-engine/apply.sh'),'--remove',dir],{env:{...process.env,PATH:bin+':'+process.env.PATH}})
    assert.equal(existsSync(join(dir,'docker-compose.lens-survey.yml')),false)
    assert.equal(existsSync(join(dir,'docker-compose.lens-survey-lock.yml')),false)
    assert.equal(readFileSync(join(dir,'site.yml'),'utf8'),'# unrelated site override\n')
    assert.equal(readFileSync(join(dir,'.env'),'utf8'),'COMPOSE_FILE="docker-compose.yml:site.yml"\nEXTRA_COMPOSE_FILES=site.yml\n')
    execFileSync('bash',[resolve('deploy/posthog/survey-engine/apply.sh'),'--remove',dir],{env:{...process.env,PATH:bin+':'+process.env.PATH}})
    assert.equal(readFileSync(join(dir,'.env'),'utf8'),'COMPOSE_FILE="docker-compose.yml:site.yml"\nEXTRA_COMPOSE_FILES=site.yml\n')
})

test('uninstaller leaves a foreign compose override with the same name untouched',t=>{
    const dir=mkdtempSync(join(tmpdir(),'survey-foreign-'));t.after(()=>rmSync(dir,{recursive:true,force:true}))
    writeFileSync(join(dir,'.env'),'COMPOSE_FILE="docker-compose.yml:docker-compose.lens-survey.yml"\n')
    writeFileSync(join(dir,'docker-compose.lens-survey.yml'),'# maintained by another service\nservices: {}\n')
    execFileSync('bash',[resolve('deploy/posthog/survey-engine/apply.sh'),'--remove',dir])
    assert.ok(existsSync(join(dir,'docker-compose.lens-survey.yml')))
    assert.match(readFileSync(join(dir,'.env'),'utf8'),/docker-compose\.lens-survey\.yml/)
})
