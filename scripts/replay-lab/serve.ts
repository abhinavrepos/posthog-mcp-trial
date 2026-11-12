import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { CANARIES } from './canaries.ts'

export function renderPage(html: string, host: string, token: string) {
    const config = JSON.stringify({ host, token, canaries: CANARIES }).replaceAll('<', '\\u003c')
    return html.replace('__LAB_CONFIG__', () => config)
}

export async function startServer(env: NodeJS.ProcessEnv = process.env) {
    const host = env.POSTHOG_HOST?.replace(/\/+$/, '')
    const token = env.POSTHOG_PROJECT_TOKEN
    if (!host || !token) throw new Error('POSTHOG_HOST and POSTHOG_PROJECT_TOKEN are required')
    if (!['http:', 'https:'].includes(new URL(host).protocol)) throw new Error('POSTHOG_HOST must be an HTTP(S) URL')
    const [html, js] = await Promise.all([
        readFile(new URL('./page.html', import.meta.url), 'utf8'),
        readFile(new URL('./app.js', import.meta.url), 'utf8'),
    ])
    const server = createServer((req, res) => {
        const pathname = new URL(req.url || '/', 'http://localhost').pathname
        res.setHeader('Cache-Control', 'no-store')
        if (pathname === '/') {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
            res.end(renderPage(html, host, token))
        } else if (pathname === '/app.js') {
            res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' })
            res.end(js)
        } else { res.writeHead(404); res.end('Not found') }
    })
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('No listening address')
    return {
        url: `http://127.0.0.1:${address.port}`,
        close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
    }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const server = await startServer()
    console.log(`Replay lab: ${server.url}`)
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void server.close() })
}
