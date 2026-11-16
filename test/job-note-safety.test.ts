import assert from 'node:assert/strict'
import { test } from 'node:test'
import { safetyWith, JOB_HANDLE_NOTE } from '../src/core/aisafety.ts'
import { runningResult } from '../src/core/jobs.ts'

test('a job handle keeps its fixed instruction note; a person-written status note is still withheld', () => {
    const handle = safetyWith(runningResult('0123456789abcdef0123456789abcdef'), [])
    assert.equal(handle.note, JOB_HANDLE_NOTE)
    assert.equal(handle.note, 'Call get_job_result with this job_id')
    const rescue = safetyWith({ client: 'C01', status: 'expected', note: 'Spoke to Jane Doe about renewal' }, [])
    assert.equal(rescue.note, '[withheld]')
    // Something that merely looks like a handle but carries other text is still withheld.
    const forged = safetyWith({ status: 'running', job_id: 'x', note: 'Jane Doe said...' }, [])
    assert.equal(forged.note, '[withheld]')
})

test('an app-version filter echo keeps its release label; other filter values are still checked', () => {
    const r = safetyWith({ filters: [{ dimension: 'app_version', op: 'eq', value: 'Reval 26.3' }, { dimension: 'client', op: 'in', value: ['Reval 26.3'] }, { dimension: 'button', op: 'eq', value: '250000' }] }, [])
    assert.equal(r.filters[0].value, 'Reval 26.3')
    assert.equal(r.filters[2].value, '<amount>')
})
