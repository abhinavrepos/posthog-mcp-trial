import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { connect } from 'node:net'
import { stripTypeScriptTypes } from 'node:module'
import { once } from 'node:events'
import { test } from 'node:test'

// Exercise the entry point's real request boundary without starting its background workers.
const source = readFileSync('src/service/server.ts', 'utf8')
const boundary = source.slice(source.indexOf('const server = createServer'), source.indexOf('\nif (!jiraConfigured()) log'))
const webhook = source.slice(source.indexOf('async function handleWebhook'), source.indexOf('async function serveClip'))
let failLog = false
const server = new Function('createServer', 'compressResponse', 'send', 'log', 'jiraConfigured', 'readRaw', 'verifyWebhookSignature', 'handleReplays',
    stripTypeScriptTypes(webhook + boundary) + '\nreturn server'
)(createServer, () => {}, (res: import('node:http').ServerResponse, status: number, body: unknown) => {
    res.writeHead(status); res.end(typeof body === 'string' ? body : JSON.stringify(body))
}, () => { if (failLog) throw new Error('logging failed') }, () => false, () => { throw new Error('should not read body') }, () => false, () => { throw new Error('handler failed') }) as Server

test('malformed raw request gets 400, health stays live, Jira off gets 503, and handler failures get 500', async () => {
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const port = (server.address() as { port: number }).port
    const request = async (target: string, method = 'GET') => {
        const socket = connect(port, '127.0.0.1')
        await once(socket, 'connect')
        socket.write(`${method} ${target} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
        let body = ''
        for await (const chunk of socket) body += chunk
        return body
    }
    try {
        assert.match(await request('//['), /^HTTP\/1.1 400/)
        assert.match(await request('/healthz'), /^HTTP\/1.1 200/)
        const jira = await request('/webhooks/jira', 'POST')
        assert.match(jira, /^HTTP\/1.1 503/)
        for (const setting of ['FEATURE_JIRA=on', 'JIRA_BASE_URL', 'JIRA_EMAIL', 'JIRA_API_TOKEN']) assert.ok(jira.includes(setting))
        assert.match(await request('/broken'), /^HTTP\/1.1 500/)
        failLog = true
        assert.match(await request('/broken'), /^HTTP\/1.1 500/)
        assert.match(await request('/healthz'), /^HTTP\/1.1 200/)
    } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
})
