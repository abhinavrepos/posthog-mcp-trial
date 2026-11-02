import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'

const dir = mkdtempSync(join(tmpdir(), 'triage-jira-'))
process.env.TRIAGE_DB = join(dir, 'test.db')
const { config, jiraConfigured } = await import('../src/core/config.ts')
const { getIssue } = await import('../src/jira/client.ts')
after(() => rmSync(dir, { recursive: true, force: true }))

describe('Jira is optional', () => {
    const saved = { ...config.jira }
    after(() => Object.assign(config.jira, saved))

    test('connected only with a site, a login and a token', () => {
        Object.assign(config.jira, { baseUrl: '', email: '', apiToken: '' })
        assert.equal(jiraConfigured(), false)
        Object.assign(config.jira, { baseUrl: 'https://acme.atlassian.net', email: 'bot@acme.example' })
        assert.equal(jiraConfigured(), false, 'no token')
        Object.assign(config.jira, { apiToken: 'token' })
        assert.equal(jiraConfigured(), true)
    })

    test('calls fail with a clear message, without any network request, while it is not connected', async () => {
        Object.assign(config.jira, { baseUrl: '', email: '', apiToken: '' })
        await assert.rejects(getIssue('ACP-1'), /Jira is not connected yet: set JIRA_BASE_URL, JIRA_EMAIL and JIRA_API_TOKEN/)
    })
})
