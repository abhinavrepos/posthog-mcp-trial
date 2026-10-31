// Acme Portal: a small B2B invoicing app used to generate real PostHog traffic for the demo.
// It has a planted regression: on release 26.10.0, exporting a PDF for a batch of invoices in
// more than one currency throws in the browser and the UI hangs on "Preparing PDF…".
//
//   pnpm demo-app            (listens on DEMO_APP_PORT, default 3000)
import { readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { CLIENTS, SCREENS, clientForEmail, type DemoClient, type DemoUser } from '../src/core/catalog.ts'
import { config } from '../src/core/config.ts'

const here = dirname(fileURLToPath(import.meta.url))
const appJs = readFileSync(join(here, 'public/app.js'), 'utf8')
const appCss = readFileSync(join(here, 'public/app.css'), 'utf8')

const PORT = Number(process.env.DEMO_APP_PORT || 3000)

function esc(s: string): string {
    return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

function currentUser(req: IncomingMessage): { client: DemoClient; user: DemoUser } | undefined {
    const m = /(?:^|;\s*)acme_user=([^;]+)/.exec(req.headers.cookie || '')
    return m ? clientForEmail(decodeURIComponent(m[1])) : undefined
}

// Deterministic pseudo-random so a client's invoices look the same on every visit.
function seeded(seed: string): () => number {
    let h = 2166136261
    for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619)
    return () => {
        h = Math.imul(h ^ (h >>> 15), 2246822507)
        h = Math.imul(h ^ (h >>> 13), 3266489909)
        return ((h ^= h >>> 16) >>> 0) / 4294967296
    }
}

function invoicesFor(client: DemoClient) {
    const rnd = seeded(client.id)
    return Array.from({ length: 12 }, (_, i) => {
        const currency = client.currencies[i % client.currencies.length]
        return {
            id: `INV-${client.id.slice(0, 3).toUpperCase()}-${String(1040 + i)}`,
            customer: ['Northwind', 'Contoso', 'Fabrikam', 'Initech', 'Umbrella', 'Globex'][Math.floor(rnd() * 6)],
            currency,
            amount: Math.round(800 + rnd() * 24000),
            status: rnd() > 0.25 ? 'paid' : 'open',
            issued: new Date(Date.now() - (i + 1) * 6 * 86400_000).toISOString().slice(0, 10),
        }
    })
}

function layout(ctx: { client: DemoClient; user: DemoUser }, path: string, title: string, body: string): string {
    const nav = SCREENS.map(
        (s) => `<a href="${s.path}" class="${s.path === path ? 'active' : ''}" data-attr="nav-${s.path.split('/').pop()}">${esc(s.name)}</a>`
    ).join('')
    // Everything the browser needs to identify the user and tag events with client and release.
    const boot = {
        posthog: { host: config.posthog.publicHost, token: config.posthog.projectToken },
        user: { email: ctx.user.email, name: ctx.user.name, role: ctx.user.role },
        client: {
            id: ctx.client.id,
            name: ctx.client.name,
            region: ctx.client.region,
            plan: ctx.client.plan,
            version: ctx.client.version,
            currencies: ctx.client.currencies,
        },
        screen: path,
    }
    return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · Acme Portal</title><style>${appCss}</style></head>
<body>
<header class="top"><div class="brand">◆ Acme Portal</div>
<div class="who"><span>${esc(ctx.client.name)}</span><span class="muted">${esc(ctx.user.name)}</span>
<span class="ver" title="Release">v${ctx.client.version}</span><a href="/logout" data-attr="logout">Log out</a></div></header>
<div class="shell"><nav class="side">${nav}</nav><main><h1>${esc(title)}</h1>${body}</main></div>
<script>window.ACME=${JSON.stringify(boot).replace(/</g, '\\u003c')}</script>
<script>${appJs}</script>
</body></html>`
}

const money = (n: number, c: string) => `${c} ${n.toLocaleString('en-US')}`

const pages: Record<string, (ctx: { client: DemoClient; user: DemoUser }) => [string, string]> = {
    '/dashboard': (ctx) => {
        const inv = invoicesFor(ctx.client)
        const open = inv.filter((i) => i.status === 'open')
        return [
            'Dashboard',
            `<div class="cards">
<div class="card"><div class="k">Open invoices</div><div class="v">${open.length}</div></div>
<div class="card"><div class="k">Issued this quarter</div><div class="v">${inv.length}</div></div>
<div class="card"><div class="k">Currencies</div><div class="v">${ctx.client.currencies.join(' · ')}</div></div></div>
<p><a class="btn" href="/invoices" data-attr="dashboard-go-invoices">Go to invoices</a>
<a class="btn ghost" href="/reports/revenue" data-attr="dashboard-go-revenue">Revenue report</a></p>`,
        ]
    },
    '/invoices': (ctx) => {
        const rows = invoicesFor(ctx.client)
            .map(
                (i) => `<tr><td><input type="checkbox" class="pick" data-id="${i.id}" checked></td><td>${i.id}</td><td>${esc(i.customer)}</td>
<td>${i.issued}</td><td class="num">${money(i.amount, i.currency)}</td><td><span class="pill ${i.status}">${i.status}</span></td></tr>`
            )
            .join('')
        return [
            'Invoices',
            `<div class="toolbar"><input id="search" class="search" placeholder="Search invoices" data-attr="invoice-search">
<button class="btn" id="export-pdf" data-attr="invoice-export-pdf">Export PDF</button>
<span id="export-status" class="status"></span></div>
<table class="grid"><thead><tr><th></th><th>Invoice</th><th>Customer</th><th>Issued</th><th class="num">Amount</th><th>Status</th></tr></thead>
<tbody>${rows}</tbody></table>`,
        ]
    },
    '/clients': (ctx) => {
        const rnd = seeded(ctx.client.id + 'contacts')
        const rows = ['Northwind', 'Contoso', 'Fabrikam', 'Initech', 'Umbrella', 'Globex']
            .map((n) => `<tr><td>${n}</td><td>${Math.floor(rnd() * 30) + 1}</td><td>${ctx.client.currencies[0]}</td></tr>`)
            .join('')
        return [
            'Clients',
            `<table class="grid"><thead><tr><th>Customer</th><th>Invoices</th><th>Currency</th></tr></thead><tbody>${rows}</tbody></table>`,
        ]
    },
    '/reports/revenue': () => [
        'Revenue report',
        `<div class="toolbar"><select id="range" data-attr="revenue-range">
<option value="qtd">Quarter to date</option><option value="mtd">Month to date</option><option value="ytd">Year to date</option></select>
<button class="btn" id="refresh" data-attr="revenue-refresh">Refresh</button></div>
<div id="revenue" class="cards"><div class="card"><div class="k">Revenue</div><div class="v" id="rev-total">…</div></div>
<div class="card"><div class="k">Invoices</div><div class="v" id="rev-count">…</div></div></div>
<div id="trend" class="trend"></div>`,
    ],
    '/settings': (ctx) => [
        'Settings',
        `<form class="form" onsubmit="return false"><label>Company<input value="${esc(ctx.client.name)}" data-attr="settings-company"></label>
<label>Default currency<select data-attr="settings-currency">${ctx.client.currencies.map((c) => `<option>${c}</option>`).join('')}</select></label>
<button class="btn" data-attr="settings-save" id="save">Save</button> <span id="save-status" class="status"></span></form>`,
    ],
}

function loginPage(): string {
    const opts = CLIENTS.map(
        (c) =>
            `<optgroup label="${esc(c.name)}">${c.users.map((u) => `<option value="${u.email}">${esc(u.name)} — ${u.email}</option>`).join('')}</optgroup>`
    ).join('')
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in · Acme Portal</title><style>${appCss}</style></head><body class="login">
<form method="post" action="/login" class="card loginbox"><div class="brand">◆ Acme Portal</div>
<p class="muted">Demo sign-in. Pick a user.</p><select name="email" id="email">${opts}</select>
<button class="btn" type="submit" id="signin">Sign in</button></form></body></html>`
}

function send(res: ServerResponse, status: number, body: string, type = 'text/html; charset=utf-8', extra: Record<string, string> = {}) {
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', ...extra })
    res.end(body)
}

async function readBody(req: IncomingMessage): Promise<string> {
    let data = ''
    for await (const chunk of req) {
        data += chunk
        if (data.length > 10_000) break
    }
    return data
}

const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost')
    const path = url.pathname

    if (path === '/healthz') return send(res, 200, 'ok', 'text/plain')
    if (path === '/login' && req.method === 'POST') {
        const email = new URLSearchParams(await readBody(req)).get('email') || ''
        if (!clientForEmail(email)) return send(res, 400, 'Unknown user', 'text/plain')
        return send(res, 302, '', 'text/plain', {
            location: '/dashboard',
            'set-cookie': `acme_user=${encodeURIComponent(email)}; Path=/; HttpOnly; SameSite=Lax`,
        })
    }
    if (path === '/login') return send(res, 200, loginPage())
    if (path === '/logout') return send(res, 302, '', 'text/plain', { location: '/login', 'set-cookie': 'acme_user=; Path=/; Max-Age=0' })

    const ctx = currentUser(req)
    if (!ctx) return send(res, 302, '', 'text/plain', { location: '/login' })

    // Mock APIs the pages call.
    if (path === '/api/invoices/export') {
        const ids = new Set((url.searchParams.get('ids') || '').split(',').filter(Boolean))
        const lines = invoicesFor(ctx.client).filter((i) => ids.size === 0 || ids.has(i.id))
        // Base-currency rates only. 26.10.0's client code assumes a rate for every currency.
        const rates: Record<string, number> = { [ctx.client.currencies[0]]: 1 }
        return send(res, 200, JSON.stringify({ base: ctx.client.currencies[0], rates, lines }), 'application/json')
    }
    if (path === '/api/reports/revenue') {
        const inv = invoicesFor(ctx.client)
        // Silent issue: for Cobalt Health the quarter-to-date query comes back empty (a
        // fiscal-calendar mismatch). Nothing errors; the report just shows zero.
        const silent = ctx.client.id === 'cobalt' && (url.searchParams.get('range') || 'qtd') === 'qtd'
        const total = silent ? 0 : inv.reduce((s, i) => s + i.amount, 0)
        await new Promise((r) => setTimeout(r, silent ? 2200 : 400))
        return send(
            res,
            200,
            JSON.stringify({ currency: ctx.client.currencies[0], total, count: silent ? 0 : inv.length }),
            'application/json'
        )
    }

    if (path === '/') return send(res, 302, '', 'text/plain', { location: '/dashboard' })
    const page = pages[path]
    if (!page) return send(res, 404, 'Not found', 'text/plain')
    const [title, body] = page(ctx)
    return send(res, 200, layout(ctx, path, title, body))
})

server.listen(PORT, '0.0.0.0', () => console.log(`Acme Portal on http://0.0.0.0:${PORT}`))
