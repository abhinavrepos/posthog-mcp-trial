// Chrome must send literal IP requests through the same allowlist as DNS names.
import { createServer, request } from 'node:http'
import { connect } from 'node:net'
import type { Socket } from 'node:net'

// Each entry is "host" (ports 80 and 443 only) or "host:port" (that port only). Without the port limit an
// allowed name such as localhost would open every service on this machine (the container uses host
// networking): databases, PostHog's internals, Lens itself.
export async function startEgress(hosts: string[]) {
    const hostname = (host: string) => host.trim().replace(/^\[|\]$/g, '').toLowerCase()
    const allowed = new Set<string>()
    for (const entry of hosts.map((h) => h.trim()).filter(Boolean)) {
        let url: URL
        try { url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(entry) ? entry : `http://${entry}`) } catch { continue }
        const host = hostname(url.hostname)
        if (!host) continue
        // The port as written: URL drops a default one (localhost:80 has url.port ''), which must not
        // widen the entry to both ports. A scheme without a port means that scheme's port only.
        const written = /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:\[[^\]]*\]|[^/:]+):(\d+)/i.exec(entry)?.[1]
        const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(entry)?.[1]?.toLowerCase()
        const ports = written ? [String(Number(written))] : scheme === 'https' ? ['443'] : scheme === 'http' ? ['80'] : ['80', '443']
        for (const port of ports) allowed.add(`${host}:${port}`)
    }
    const permits = (url: URL, defaultPort: string) => allowed.has(`${hostname(url.hostname)}:${url.port || defaultPort}`)
    const server = createServer((req, res) => {
        let url: URL
        try { url = new URL(req.url || '') } catch { res.writeHead(403).end(); return }
        if (url.protocol !== 'http:' || !permits(url, '80')) { res.writeHead(403).end(); return }
        const upstream = request(url, { method: req.method, headers: { ...req.headers, host: url.host } }, reply => {
            res.writeHead(reply.statusCode || 502, reply.headers)
            reply.pipe(res)
        })
        upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end() })
        req.on('aborted', () => upstream.destroy())
        res.on('close', () => upstream.destroy())
        req.pipe(upstream)
    })
    const sockets = new Set<Socket>()
    server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {}) })
    server.on('connect', (req, socket, head) => {
        let url: URL
        try { url = new URL('https://' + req.url) } catch { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return }
        if (!permits(url, '443') || url.username || url.password || url.pathname !== '/') { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return }
        const upstream = connect(Number(url.port || 443), url.hostname.replace(/^\[|\]$/g, ''))
        sockets.add(upstream)
        upstream.on('close', () => sockets.delete(upstream))
        upstream.on('connect', () => {
            socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
            if (head.length) upstream.write(head)
            socket.pipe(upstream).pipe(socket)
        })
        upstream.on('error', () => socket.destroy())
        socket.on('error', () => upstream.destroy())
        socket.on('close', () => upstream.destroy())
    })
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', resolve)
    })
    server.unref()
    const address = server.address() as { port: number }
    return {
        url: `http://127.0.0.1:${address.port}`,
        close: () => new Promise<void>(resolve => { for (const socket of sockets) socket.destroy(); server.close(() => resolve()) }),
    }
}
