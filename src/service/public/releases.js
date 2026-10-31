// The release dashboard's page script. Everything shown comes from /releases/api/view, which
// does the scoring; this file draws it. Text from Jira goes in with textContent, never as HTML.
;(function () {
    'use strict'
    var B = window.BOOT
    var $ = function (id) {
        return document.getElementById(id)
    }
    var NS = 'http://www.w3.org/2000/svg'
    var WEIGHTS = [
        ['reach', 'Reach', 'Share of active clients who used it'],
        ['adoption', 'Adoption', 'How often its new event is used'],
        ['fixes', 'Fixes', 'Errors or rage clicks that went away'],
        ['errors', 'Errors', 'New or more errors on its screen'],
        ['friction', 'Rage clicks', 'More rage clicks on its screen'],
        ['support', 'Support tickets', 'RCI and risk tickets about its screen'],
    ]
    var KIND = { win: 'Win', risk: 'Risk', fix: 'Fixed', info: 'Note' }
    var SOURCE = { person: 'set by a person', component: 'from its Jira component', text: 'from words in the ticket', event: 'matched to a new event', none: 'not linked' }
    var SCREENS = { '/invoices': 'Invoices', '/clients': 'Clients', '/dashboard': 'Dashboard', '/reports/revenue': 'Revenue report', '/settings': 'Settings' }

    var qs = new URLSearchParams(location.search)
    var state = { scope: qs.get('scope') || 'all', compare: qs.get('compare') || '', weights: null, open: null, q: '', sort: 'impact', type: '', showAll: false }
    var data = null
    var areas = null
    var settingsDrawn = false

    // ------------------------------------------------------------------ helpers
    function api(path, opts) {
        opts = opts || {}
        return fetch(path, Object.assign({}, opts, { headers: { 'content-type': 'application/json', 'x-clip-page': '1' } })).then(function (r) {
            return r.json().catch(function () {
                return {}
            }).then(function (b) {
                if (!r.ok) throw new Error(b.error || 'Error ' + r.status)
                return b
            })
        })
    }
    function el(tag, attrs) {
        var e = document.createElement(tag)
        attrs = attrs || {}
        for (var k in attrs) {
            var v = attrs[k]
            if (v == null) continue
            if (k === 'text') e.textContent = v
            else if (k === 'cls') e.className = v
            else if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2), v)
            else if (k === 'style') e.style.cssText = v
            else e.setAttribute(k, v)
        }
        for (var i = 2; i < arguments.length; i++) {
            var c = arguments[i]
            if (c == null || c === false) continue
            e.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c)
        }
        return e
    }
    function sv(tag, attrs, text) {
        var e = document.createElementNS(NS, tag)
        for (var k in attrs || {}) e.setAttribute(k, attrs[k])
        if (text != null) e.textContent = text
        return e
    }
    function clear(node) {
        while (node.firstChild) node.removeChild(node.firstChild)
        return node
    }
    var screenName = function (p) {
        return SCREENS[p] || p || 'its screen'
    }
    var day = function (d) {
        return new Date(d.length === 10 ? d + 'T00:00:00Z' : d).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })
    }
    var ago = function (iso) {
        var m = Math.round((Date.now() - Date.parse(iso)) / 60000)
        return m < 1 ? 'just now' : m < 60 ? m + ' min ago' : m < 1440 ? Math.round(m / 60) + ' h ago' : Math.round(m / 1440) + ' days ago'
    }
    var p100 = function (n, s) {
        return s ? Math.round((n / s) * 1000) / 10 : 0
    }
    /** Chart width in CSS pixels, so text stays 11px on any screen. */
    function widthOf(node, fallback) {
        var w = node && node.clientWidth
        return Math.max(280, Math.round(w || fallback || 640))
    }
    var tip = $('tip')
    function showTip(ev, lines) {
        clear(tip)
        lines.forEach(function (l, i) {
            tip.appendChild(el('div', { style: i === 0 ? 'font-weight:600' : '' }, l))
        })
        tip.style.display = 'block'
        var x = Math.min(ev.clientX + 14, window.innerWidth - tip.offsetWidth - 8)
        var y = ev.clientY + 14 + tip.offsetHeight > window.innerHeight ? ev.clientY - tip.offsetHeight - 10 : ev.clientY + 14
        tip.style.left = x + 'px'
        tip.style.top = y + 'px'
    }
    function hideTip() {
        tip.style.display = 'none'
    }
    function healthBadge(h, reasons) {
        var b = el('span', { cls: 'health', title: (reasons || []).join(', ') || 'No warning signs' }, el('i'), h)
        b.setAttribute('data-h', h)
        b.querySelector('i').style.background = h === 'Healthy' ? 'var(--good)' : h === 'Watch' ? 'var(--warn)' : 'var(--crit)'
        return b
    }
    function jiraLink(key) {
        return el('a', { href: B.jira + '/browse/' + encodeURIComponent(key), target: '_blank', rel: 'noopener', onclick: function (e) { e.stopPropagation() } }, key)
    }

    // ------------------------------------------------------------------ loading
    function load() {
        var w = state.weights ? '&w=' + encodeURIComponent(JSON.stringify(state.weights)) : ''
        var url = '/releases/api/view?scope=' + encodeURIComponent(state.scope) + (state.compare ? '&compare=' + encodeURIComponent(state.compare) : '') + w
        var params = new URLSearchParams()
        if (state.scope !== 'all') params.set('scope', state.scope)
        if (state.compare) params.set('compare', state.compare)
        history.replaceState(null, '', '/releases' + (params.toString() ? '?' + params : ''))
        return api(url).then(function (d) {
            data = d
            render()
        }).catch(function (e) {
            $('status').textContent = e.message
        })
    }
    function render() {
        var v = data.view
        renderScopes()
        renderStatus(v.synced)
        $('title').textContent = v.scope.kind === 'release' ? 'Release ' + v.scope.label : v.scope.label
        $('subtitle').textContent =
            v.scope.kind === 'all' ? 'Every kept release, matched to how clients use the product in PostHog.' : v.scope.kind === 'release' ? 'Its tickets, matched to how clients used the product before and after it shipped.' : v.releases.map(function (r) { return r.name }).join(', ')
        renderKpis()
        renderCompare()
        renderReleaseHead()
        renderFindings()
        renderMap()
        renderTrend()
        renderTickets()
        renderReleases()
        renderGroups()
        renderSliders()
        if (B.isAdmin && !settingsDrawn) renderSettings()
    }

    function renderScopes() {
        var groups = { all: 'Overview', quarter: 'Quarters', group: 'Custom groups', release: 'Releases' }
        ;[$('scope'), $('compare')].forEach(function (sel, n) {
            var current = n ? state.compare : state.scope
            clear(sel)
            if (n) sel.appendChild(el('option', { value: '' }, 'Nothing'))
            Object.keys(groups).forEach(function (kind) {
                var list = data.scopes.filter(function (s) { return s.kind === kind })
                if (!list.length) return
                var og = el('optgroup', { label: groups[kind] })
                list.forEach(function (s) {
                    var o = el('option', { value: s.id }, s.label + (kind === 'quarter' || kind === 'group' ? ' (' + s.releases.length + ')' : ''))
                    if (s.id === current) o.selected = true
                    og.appendChild(o)
                })
                sel.appendChild(og)
            })
        })
    }

    function renderStatus(st) {
        var t = st.running ? 'Syncing with Jira and PostHog…' : st.at ? 'Synced ' + ago(st.at) + (st.result ? ' · ' + st.result.releases.length + ' releases, ' + st.result.tickets + ' tickets, ' + st.result.seconds + ' s' : '') : 'Not synced yet.'
        if (st.error && (!st.at || st.failed_at > st.at)) t += ' · Last sync failed: ' + st.error
        $('status').textContent = t
    }

    // ------------------------------------------------------------------ headline numbers
    function kpiList(v) {
        var k = v.kpis
        return [
            ['Releases', k.releases, null],
            ['Tickets shipped', k.tickets, k.ranked + ' ranked'],
            ['Widest reach', k.clients_reached, 'clients used one new feature'],
            ['New errors', k.new_errors, 'first seen after a release'],
            ['Support tickets', k.support, 'after these releases'],
            ['Releases at risk', k.at_risk, null],
        ]
    }
    function renderKpis() {
        var box = clear($('kpis'))
        var other = data.compare ? kpiList(data.compare) : null
        kpiList(data.view).forEach(function (row, i) {
            var tile = el('div', { cls: 'kpi' }, el('span', { text: row[0] }), el('b', { text: String(row[1]) }))
            if (other) {
                var d = row[1] - other[i][1]
                var worse = /risk|error|support/i.test(row[0]) ? d > 0 : d < 0
                tile.appendChild(el('div', { cls: 'd ' + (d === 0 ? '' : worse ? 'up' : 'down') }, (d > 0 ? '+' : '') + d + ' vs ' + data.compare.scope.label))
            } else if (row[2]) tile.appendChild(el('span', { text: row[2] }))
            box.appendChild(tile)
        })
    }

    function renderCompare() {
        var box = $('compare-box')
        if (!data.compare) return box.classList.add('hidden')
        box.classList.remove('hidden')
        clear(box)
        var a = data.view
        var b = data.compare
        var avg = function (v, f) {
            var xs = v.releases.map(f)
            return xs.length ? Math.round((xs.reduce(function (s, x) { return s + x }, 0) / xs.length) * 10) / 10 : 0
        }
        var rows = [
            ['Tickets shipped', a.kpis.tickets, b.kpis.tickets],
            ['Value (average of ranked tickets)', a.kpis.avg_value, b.kpis.avg_value],
            ['Risk (average of ranked tickets)', a.kpis.avg_risk, b.kpis.avg_risk],
            ['Errors per 1,000 sessions after release', avg(a, function (r) { return r.errors_per_1k }), avg(b, function (r) { return r.errors_per_1k })],
            ['Rage clicks per 1,000 sessions after release', avg(a, function (r) { return r.rage_per_1k }), avg(b, function (r) { return r.rage_per_1k })],
            ['New errors', a.kpis.new_errors, b.kpis.new_errors],
            ['Support tickets', a.kpis.support, b.kpis.support],
            ['Releases at risk', a.kpis.at_risk, b.kpis.at_risk],
        ]
        var tb = el('tbody')
        rows.forEach(function (r) {
            var d = Math.round((r[1] - r[2]) * 10) / 10
            tb.appendChild(el('tr', null, el('td', { text: r[0] }), el('td', { text: String(r[1]) }), el('td', { text: String(r[2]) }), el('td', { text: (d > 0 ? '+' : '') + d })))
        })
        box.appendChild(el('h2', null, a.scope.label + ' compared with ' + b.scope.label))
        box.appendChild(el('div', { cls: 'table-wrap' }, el('table', { cls: 'cmp' }, el('thead', null, el('tr', null, el('th', { text: '' }), el('th', { text: a.scope.label }), el('th', { text: b.scope.label }), el('th', { text: 'Difference' }))), tb)))
    }

    // ------------------------------------------------------------------ one release
    function renderReleaseHead() {
        var box = $('release-head')
        var v = data.view
        if (v.scope.kind !== 'release' || !v.releases[0]) return box.classList.add('hidden')
        var r = v.releases[0]
        box.classList.remove('hidden')
        clear(box)
        var facts = el('div', { cls: 'mini' })
        facts.appendChild(el('div', null, el('div', { cls: 'muted small', text: 'Released' }), el('b', { text: day(r.date) })))
        facts.appendChild(el('div', null, el('div', { cls: 'muted small', text: 'Measured' }), el('b', { text: r.days + ' days after' + (r.open ? ' (still counting)' : '') })))
        if (r.clients_on_version !== null) facts.appendChild(el('div', null, el('div', { cls: 'muted small', text: 'Clients on it' }), el('b', { text: r.clients_on_version + ' of ' + r.clients_active })))
        facts.appendChild(el('div', null, el('div', { cls: 'muted small', text: 'Errors per 1k sessions' }), el('b', { text: r.errors_per_1k_before + ' → ' + r.errors_per_1k })))
        facts.appendChild(el('div', null, el('div', { cls: 'muted small', text: 'Health' }), healthBadge(r.health, r.health_reasons), r.health_reasons.length ? el('div', { cls: 'small muted', text: r.health_reasons.join(', ') }) : null))
        box.appendChild(el('h2', null, r.name + (r.description ? ': ' + r.description : '')))
        box.appendChild(facts)
        if (r.adoption && r.adoption.length > 1) {
            box.appendChild(el('div', { cls: 'small muted', style: 'margin-top:8px' }, 'Clients on ' + r.name + ', week by week'))
            box.appendChild(lineChart(r.adoption.map(function (a) { return { x: a.week, y: a.on, of: a.all } }), { height: 120, width: widthOf(box) - 40, label: function (p) { return [day(p.x), p.y + ' of ' + p.of + ' active clients on ' + r.name] }, max: Math.max.apply(null, r.adoption.map(function (a) { return a.all })) }))
        }
    }

    function lineChart(points, o) {
        var W = o.width || 640
        var H = o.height || 120
        var pad = { l: 34, r: 10, t: 10, b: 22 }
        var max = o.max || Math.max(1, Math.max.apply(null, points.map(function (p) { return p.y })))
        var x = function (i) { return pad.l + (points.length < 2 ? 0 : (i / (points.length - 1)) * (W - pad.l - pad.r)) }
        var y = function (v) { return H - pad.b - (v / max) * (H - pad.t - pad.b) }
        var svg = sv('svg', { viewBox: '0 0 ' + W + ' ' + H, class: 'chart', role: 'img', 'aria-label': o.aria || 'Line chart' })
        ;[0, max].forEach(function (g) {
            svg.appendChild(sv('line', { x1: pad.l, x2: W - pad.r, y1: y(g), y2: y(g), stroke: 'var(--grid)' }))
            svg.appendChild(sv('text', { x: pad.l - 6, y: y(g) + 4, 'text-anchor': 'end' }, String(g)))
        })
        if (o.marker != null) {
            svg.appendChild(sv('line', { x1: x(o.marker), x2: x(o.marker), y1: pad.t, y2: H - pad.b, stroke: 'var(--muted)', 'stroke-dasharray': '3 3' }))
            var nearEnd = x(o.marker) > W - 90
            svg.appendChild(sv('text', { x: x(o.marker) + (nearEnd ? -4 : 4), y: pad.t + 9, 'text-anchor': nearEnd ? 'end' : 'start' }, o.markerLabel || 'release'))
        }
        var d = points.map(function (p, i) { return (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(p.y).toFixed(1) }).join(' ')
        svg.appendChild(sv('path', { d: d + ' L' + x(points.length - 1) + ' ' + (H - pad.b) + ' L' + x(0) + ' ' + (H - pad.b) + 'Z', fill: 'var(--s1)', opacity: 0.12 }))
        svg.appendChild(sv('path', { d: d, fill: 'none', stroke: 'var(--s1)', 'stroke-width': 2, 'stroke-linejoin': 'round' }))
        ;[0, points.length - 1].forEach(function (i) {
            if (points[i]) svg.appendChild(sv('text', { x: x(i), y: H - 6, 'text-anchor': i ? 'end' : 'start' }, day(points[i].x)))
        })
        var hover = sv('circle', { r: 4, fill: 'var(--s1)', stroke: 'var(--card)', 'stroke-width': 2, visibility: 'hidden' })
        svg.appendChild(hover)
        var hit = sv('rect', { x: pad.l, y: 0, width: W - pad.l - pad.r, height: H, fill: 'transparent' })
        hit.addEventListener('mousemove', function (ev) {
            var box = svg.getBoundingClientRect()
            var px = ((ev.clientX - box.left) / box.width) * W
            var i = Math.max(0, Math.min(points.length - 1, Math.round(((px - pad.l) / (W - pad.l - pad.r)) * (points.length - 1))))
            hover.setAttribute('cx', x(i))
            hover.setAttribute('cy', y(points[i].y))
            hover.setAttribute('visibility', 'visible')
            showTip(ev, o.label(points[i]))
        })
        hit.addEventListener('mouseleave', function () {
            hover.setAttribute('visibility', 'hidden')
            hideTip()
        })
        svg.appendChild(hit)
        return svg
    }

    // ------------------------------------------------------------------ findings and charts
    function renderFindings() {
        var ul = clear($('findings'))
        if (!data.view.insights.length) ul.appendChild(el('li', { cls: 'muted' }, 'Nothing stands out yet.'))
        data.view.insights.forEach(function (f) {
            var li = el('li', null, el('span', { cls: 'ico ' + f.kind }, KIND[f.kind]), el('span', { text: f.text }))
            if (f.ticket) {
                li.style.cursor = 'pointer'
                li.title = 'Open ' + f.ticket
                li.addEventListener('click', function () { openTicket(f.ticket) })
            }
            ul.appendChild(li)
        })
    }

    function ranked() {
        var s = data.view.settings
        return data.view.tickets.filter(function (t) { return t.link && !t.hidden && s.ticket_types.indexOf(t.type) >= 0 })
    }

    function renderMap() {
        var box = clear($('map'))
        var pts = ranked()
        if (!pts.length) return box.appendChild(el('div', { cls: 'empty', text: 'No ranked tickets.' }))
        var W = Math.min(720, widthOf(box, 520))
        var H = Math.round(Math.min(380, Math.max(260, W * 0.62)))
        var pad = { l: 40, r: 14, t: 14, b: 34 }
        var x = function (v) { return pad.l + v * (W - pad.l - pad.r) }
        var y = function (v) { return H - pad.b - v * (H - pad.t - pad.b) }
        var svg = sv('svg', { viewBox: '0 0 ' + W + ' ' + H, class: 'chart', role: 'img', 'aria-label': 'Tickets by value and risk' })
        ;[0, 0.5, 1].forEach(function (g) {
            svg.appendChild(sv('line', { x1: x(0), x2: x(1), y1: y(g), y2: y(g), stroke: 'var(--grid)' }))
            svg.appendChild(sv('text', { x: x(0) - 6, y: y(g) + 4, 'text-anchor': 'end' }, String(g * 100)))
            svg.appendChild(sv('text', { x: x(g), y: H - pad.b + 14, 'text-anchor': 'middle' }, String(g * 100)))
        })
        svg.appendChild(sv('line', { x1: x(0.4), x2: x(0.4), y1: y(0), y2: y(1), stroke: 'var(--grid)', 'stroke-dasharray': '4 4' }))
        svg.appendChild(sv('line', { x1: x(0), x2: x(1), y1: y(0.4), y2: y(0.4), stroke: 'var(--grid)', 'stroke-dasharray': '4 4' }))
        svg.appendChild(sv('text', { x: x(0.5) , y: H - 4, 'text-anchor': 'middle' }, 'Value →'))
        svg.appendChild(sv('text', { x: 10, y: y(0.5), transform: 'rotate(-90 10 ' + y(0.5) + ')', 'text-anchor': 'middle' }, 'Risk →'))
        // Quadrant names sit just inside the corners where the dashed lines cross the edges.
        ;[['Problems', 0.01, 1, 'start', 12], ['Watch closely', 0.99, 1, 'end', 12], ['Quiet', 0.01, 0.4, 'start', 14], ['Wins', 0.99, 0.4, 'end', 14]].forEach(function (q) {
            svg.appendChild(sv('text', { x: x(q[1]), y: y(q[2]) + q[4], 'text-anchor': q[3], class: 'lbl', opacity: 0.5 }, q[0]))
        })
        var placed = []
        var free = function (bx) {
            return !placed.some(function (p) { return bx.x < p.x + p.w && p.x < bx.x + bx.w && bx.y < p.y + p.h && p.y < bx.y + bx.h })
        }
        var labels = []
        var top = pts.slice().sort(function (a, b) { return b.scores.impact - a.scores.impact }).slice(0, 5).map(function (t) { return t.key })
        pts.forEach(function (t) {
            var cx = x(t.scores.value)
            var cy = y(t.scores.risk)
            var c = sv('circle', { cx: cx, cy: cy, r: 6, fill: t.scores.direction === 'risk' ? 'var(--s2)' : 'var(--s1)', stroke: 'var(--card)', 'stroke-width': 2, style: 'cursor:pointer' })
            c.addEventListener('mousemove', function (ev) {
                showTip(ev, [t.key + ' · ' + t.release, t.summary, 'Value ' + Math.round(t.scores.value * 100) + ' · Risk ' + Math.round(t.scores.risk * 100) + ' · Impact ' + t.scores.impact])
            })
            c.addEventListener('mouseleave', hideTip)
            c.addEventListener('click', function () { openTicket(t.key) })
            svg.appendChild(c)
            if (top.indexOf(t.key) >= 0) labels.push({ t: t, cx: cx, cy: cy })
        })
        // Direct labels for the five biggest, skipping any that would overlap another label.
        labels.forEach(function (l) {
            var w = l.t.key.length * 6.6
            var left = l.cx > W - 90
            var tries = [[left ? -9 - w : 9, -6], [left ? -9 - w : 9, -20], [left ? -9 - w : 9, 8], [-w / 2, -24]]
            for (var i = 0; i < tries.length; i++) {
                var bx = { x: l.cx + tries[i][0], y: l.cy + tries[i][1], w: w, h: 13 }
                if (free(bx)) {
                    placed.push(bx)
                    svg.appendChild(sv('text', { x: bx.x, y: bx.y + 10, class: 'lbl' }, l.t.key))
                    break
                }
            }
        })
        box.appendChild(svg)
    }

    function renderTrend() {
        var rel = data.view.releases
        var card = $('trend-card')
        if (rel.length < 2) return card.classList.add('hidden')
        card.classList.remove('hidden')
        var box = clear($('trend'))
        var W = widthOf(box, 1100)
        var H = 220
        var pad = { l: 40, r: 14, t: 14, b: 34 }
        var max = Math.max(1, Math.max.apply(null, rel.map(function (r) { return Math.max(r.errors_per_1k, r.errors_per_1k_before) })))
        var step = (W - pad.l - pad.r) / rel.length
        var every = step < 52 ? Math.ceil(52 / step) : 1
        var x = function (i) { return pad.l + step * (i + 0.5) }
        var y = function (v) { return H - pad.b - (v / max) * (H - pad.t - pad.b) }
        var svg = sv('svg', { viewBox: '0 0 ' + W + ' ' + H, class: 'chart', role: 'img', 'aria-label': 'Errors per 1,000 sessions before and after each release' })
        ;[0, Math.round(max / 2), Math.round(max)].forEach(function (g) {
            svg.appendChild(sv('line', { x1: pad.l, x2: W - pad.r, y1: y(g), y2: y(g), stroke: 'var(--grid)' }))
            svg.appendChild(sv('text', { x: pad.l - 6, y: y(g) + 4, 'text-anchor': 'end' }, String(g)))
        })
        rel.forEach(function (r, i) {
            var g = sv('g', { style: 'cursor:pointer' })
            g.appendChild(sv('rect', { x: x(i) - step / 2, y: 0, width: step, height: H, fill: 'transparent' }))
            g.appendChild(sv('line', { x1: x(i), x2: x(i), y1: y(r.errors_per_1k_before), y2: y(r.errors_per_1k), stroke: 'var(--muted)', 'stroke-width': 2, opacity: 0.6 }))
            g.appendChild(sv('circle', { cx: x(i), cy: y(r.errors_per_1k_before), r: 5, fill: 'var(--card)', stroke: 'var(--muted)', 'stroke-width': 2 }))
            g.appendChild(sv('circle', { cx: x(i), cy: y(r.errors_per_1k), r: 6, fill: 'var(--s1)', stroke: 'var(--card)', 'stroke-width': 2 }))
            if (i % every === (rel.length - 1) % every) {
                g.appendChild(sv('text', { x: x(i), y: H - 16, 'text-anchor': 'middle', class: r.health === 'At risk' ? 'lbl' : '' }, r.name))
                if (every === 1) g.appendChild(sv('text', { x: x(i), y: H - 3, 'text-anchor': 'middle' }, r.health === 'Healthy' ? '' : r.health === 'At risk' ? '▲ at risk' : '● watch'))
            }
            g.addEventListener('mousemove', function (ev) {
                showTip(ev, ['Release ' + r.name + ' · ' + day(r.date), 'Errors per 1k sessions: ' + r.errors_per_1k_before + ' before → ' + r.errors_per_1k + ' after', 'Health: ' + r.health + (r.health_reasons.length ? ' (' + r.health_reasons.join(', ') + ')' : ''), 'Click to open'])
            })
            g.addEventListener('mouseleave', hideTip)
            g.addEventListener('click', function () { setScope('r:' + r.name) })
            svg.appendChild(g)
        })
        box.appendChild(svg)
    }

    // ------------------------------------------------------------------ tickets
    function bar(v, cls) {
        var b = el('div', { cls: 'bar ' + cls }, el('i'))
        b.firstChild.style.width = Math.round(v * 100) + '%'
        return el('div', { style: 'display:flex;gap:8px;align-items:center' }, b, el('span', { cls: 'num small', style: 'min-width:22px', text: String(Math.round(v * 100)) }))
    }

    function renderTickets() {
        var s = data.view.settings
        var tsel = $('type')
        var types = {}
        data.view.tickets.forEach(function (t) { types[t.type] = 1 })
        var keep = state.type
        clear(tsel).appendChild(el('option', { value: '' }, state.showAll ? 'All types' : 'All ranked types'))
        Object.keys(types).sort().forEach(function (t) {
            var o = el('option', { value: t }, t + (s.ticket_types.indexOf(t) < 0 ? ' (not ranked)' : ''))
            if (t === keep) o.selected = true
            tsel.appendChild(o)
        })
        var q = state.q.toLowerCase()
        var list = (state.showAll ? data.view.tickets : ranked()).filter(function (t) {
            if (state.type && t.type !== state.type) return false
            if (!q) return true
            return (t.key + ' ' + t.summary + ' ' + (t.link ? (t.link.event || '') + ' ' + screenName(t.link.screen) : '') + ' ' + t.release).toLowerCase().indexOf(q) >= 0
        })
        var key = { impact: function (t) { return t.scores.impact }, value: function (t) { return t.scores.value }, risk: function (t) { return t.scores.risk }, reach: function (t) { return t.usage ? t.usage.clients_after : -1 } }[state.sort]
        list.sort(function (a, b) { return key(b) - key(a) })
        $('tickets-title').textContent = 'Tickets by ' + $('sort').selectedOptions[0].textContent.toLowerCase() + ' (' + list.length + ')'
        var tb = clear($('tickets').tBodies[0])
        if (!list.length) tb.appendChild(el('tr', null, el('td', { colspan: 7, cls: 'empty', text: data.view.releases.length ? 'No tickets match.' : 'No releases yet. ' + (B.canEdit ? 'Click "Sync now" to read them from Jira.' : 'Ask someone to sync.') })))
        list.forEach(function (t, i) {
            var unranked = !t.link || t.hidden || s.ticket_types.indexOf(t.type) < 0
            var linked = t.link ? el('div', null, el('div', null, t.link.event ? el('code', { text: t.link.event }) : screenName(t.link.screen)), el('div', { cls: 'src', text: (t.link.event ? screenName(t.link.screen) + ' · ' : '') + SOURCE[t.link_source] })) : el('span', { cls: 'src', text: t.hidden ? 'hidden' : 'not linked' })
            var tr = el(
                'tr',
                { cls: 'tk', id: 'tk-' + t.key, 'aria-expanded': String(state.open === t.key), onclick: function () { state.open = state.open === t.key ? null : t.key; renderTickets() } },
                el('td', { cls: 'muted small', text: unranked ? '–' : String(i + 1) }),
                el('td', null, el('div', null, jiraLink(t.key), ' ', el('span', { text: t.summary })), el('div', { cls: 'small muted' }, 'Release ' + t.release + ' · ', el('span', { cls: 'type', text: t.type }))),
                el('td', null, linked),
                el('td', { cls: 'num', text: t.usage ? String(t.usage.clients_after) : '–' }),
                el('td', null, bar(t.scores.value, 'v')),
                el('td', null, bar(t.scores.risk, 'r')),
                el('td', { cls: 'num' }, el('b', { text: String(t.scores.impact) }))
            )
            if (unranked) tr.style.opacity = '0.65'
            tb.appendChild(tr)
            if (state.open === t.key) tb.appendChild(el('tr', { cls: 'detail' }, el('td', { colspan: 7 }, detail(t))))
        })
    }

    function detail(t) {
        var box = el('div')
        var rel = data.view.releases.filter(function (r) { return r.name === t.release })[0]
        var sc = t.link && t.link.screen && data.view.screens[t.release] ? data.view.screens[t.release][t.link.screen] : null
        var mini = el('div', { cls: 'mini' })
        var item = function (label, value, note) {
            mini.appendChild(el('div', null, el('div', { cls: 'muted small', text: label }), el('b', { text: value }), note ? el('div', { cls: 'small muted', text: note }) : null))
        }
        if (t.usage) {
            item(t.link.event ? 'Times ' + t.link.event + ' happened' : 'Page views of ' + screenName(t.link.screen), t.usage.before + ' → ' + t.usage.after, rel.days + ' days before → after')
            item('People', t.usage.users_before + ' → ' + t.usage.users_after)
            item('Clients', t.usage.clients_before + ' → ' + t.usage.clients_after, 'of ' + rel.clients_active + ' active')
        }
        if (sc) {
            item('Errors per 100 sessions on ' + screenName(t.link.screen), p100(sc.errors_before, sc.sessions_before) + ' → ' + p100(sc.errors_after, sc.sessions_after), sc.errors_before + ' → ' + sc.errors_after + ' errors')
            item('Rage clicks per 100 sessions', p100(sc.rage_before, sc.sessions_before) + ' → ' + p100(sc.rage_after, sc.sessions_after), sc.rage_before + ' → ' + sc.rage_after + ' rage clicks')
            item('Support tickets after', String(sc.support.length))
        }
        var sc2 = t.scores
        item('Scores', 'Value ' + Math.round(sc2.value * 100) + ' · Risk ' + Math.round(sc2.risk * 100), ['reach', 'adoption', 'fixes', 'errors', 'friction', 'support'].filter(function (k) { return sc2[k] !== null && sc2[k] > 0 }).map(function (k) { return k + ' ' + Math.round(sc2[k] * 100) }).join(' · ') || 'no signals')
        box.appendChild(mini)
        if (t.weekly && t.weekly.length > 1) {
            var relWeek = 0
            t.weekly.forEach(function (w, i) { if (w.week <= rel.date) relWeek = i })
            box.appendChild(el('div', { cls: 'small muted', text: (t.link.event ? t.link.event : 'Page views of ' + screenName(t.link.screen)) + ', week by week' }))
            box.appendChild(lineChart(t.weekly.map(function (w) { return { x: w.week, y: w.n, c: w.clients } }), { height: 110, width: widthOf($('tickets')) - 30, marker: relWeek, markerLabel: t.release, label: function (p) { return ['Week of ' + day(p.x), p.y + ' times, ' + p.c + ' clients'] } }))
        }
        var why = el('p', { cls: 'small' }, el('b', { text: 'Why it is linked this way: ' }), t.link_reason + (t.confidence && t.link_source !== 'person' ? ' (confidence ' + Math.round(t.confidence * 100) + '%).' : '.'))
        box.appendChild(why)
        if (t.link && t.link.screen) {
            box.appendChild(
                el('p', { cls: 'small' }, t.risk_owner ? 'Errors, rage clicks and support tickets on ' + screenName(t.link.screen) + ' after this release count for this ticket' + (t.shares_screen_with.length ? ', shared with ' + t.shares_screen_with.join(', ') + '.' : '.') : 'Problems on ' + screenName(t.link.screen) + ' count for the tickets that changed how it already worked, not for this one.')
            )
        }
        if (sc && sc.support.length) {
            var ul = el('ul', { cls: 'tight small' })
            sc.support.forEach(function (x) { ul.appendChild(el('li', null, jiraLink(x.key), ' ' + x.type + ': ', el('span', { text: x.summary }), ' (' + day(x.created) + ')')) })
            box.appendChild(el('div', { cls: 'small' }, el('b', { text: 'Support tickets about ' + screenName(t.link.screen) + ' after the release' }), ul))
        }
        var errs = rel.new_errors.filter(function (e) { return t.link && e.path === t.link.screen })
        if (errs.length) {
            var ul2 = el('ul', { cls: 'tight small' })
            errs.forEach(function (e) {
                ul2.appendChild(el('li', null, el('span', { text: e.type + (e.message ? ': ' + e.message : '') + ' · ' + e.occurrences + ' times, ' + e.clients + ' clients, first seen ' + day(e.first_seen) + ' ' }), e.url ? el('a', { href: e.url, target: '_blank', rel: 'noopener' }, 'Open in PostHog') : null))
            })
            box.appendChild(el('div', { cls: 'small' }, el('b', { text: 'New errors on ' + screenName(t.link.screen) }), ul2))
        }
        if (B.canEdit) box.appendChild(editor(t))
        return box
    }

    function editor(t) {
        var wrap = el('div', { cls: 'edit' })
        var scr = el('select', { 'aria-label': 'Screen' }, el('option', { value: '' }, 'No screen'))
        var screens = {}
        Object.keys(SCREENS).forEach(function (p) { screens[p] = SCREENS[p] })
        ;(areas ? areas.screens : []).forEach(function (s) { screens[s.path] = screens[s.path] || s.path })
        Object.keys(screens).forEach(function (p) {
            var o = el('option', { value: p }, screens[p] + (screens[p] !== p ? ' (' + p + ')' : ''))
            if (t.link && t.link.screen === p) o.selected = true
            scr.appendChild(o)
        })
        var evs = el('select', { 'aria-label': 'Event' }, el('option', { value: '' }, 'No event (whole screen)'))
        ;(areas ? areas.events.slice().sort(function (a, b) { return a.name < b.name ? -1 : 1 }) : []).forEach(function (e) {
            var o = el('option', { value: e.name }, e.name + ' · first seen ' + day(e.first_seen))
            if (t.link && t.link.event === e.name) o.selected = true
            evs.appendChild(o)
        })
        var risk = el('select', { 'aria-label': 'Screen problems' }, el('option', { value: '' }, 'Automatic'), el('option', { value: 'yes' }, 'Count them for this ticket'), el('option', { value: 'no' }, "Don't count them"))
        var msg = el('span', { cls: 'small' })
        var post = function (path, body) {
            msg.textContent = 'Saving and recounting…'
            msg.className = 'small muted'
            return api('/releases/api/tickets/' + encodeURIComponent(t.key) + path, { method: 'POST', body: JSON.stringify(body) }).then(load).catch(function (e) {
                msg.textContent = e.message
                msg.className = 'small err'
            })
        }
        wrap.appendChild(el('div', null, el('label', { text: 'Screen it changed' }), scr))
        wrap.appendChild(el('div', null, el('label', { text: 'PostHog event for it' }), evs))
        wrap.appendChild(el('div', null, el('label', { text: 'Errors and rage clicks on the screen' }), risk))
        wrap.appendChild(
            el(
                'div',
                { cls: 'btns' },
                el('button', { type: 'button', onclick: function (e) { e.stopPropagation(); post('/link', { screen: scr.value || undefined, event: evs.value || undefined, risk: risk.value ? risk.value === 'yes' : undefined }) } }, 'Save link'),
                t.link_source === 'person' ? el('button', { type: 'button', cls: 'ghost', onclick: function (e) { e.stopPropagation(); post('/link', { reset: true }) } }, 'Back to automatic') : null,
                el('button', { type: 'button', cls: 'ghost', onclick: function (e) { e.stopPropagation(); post('/hide', { hidden: !t.hidden }) } }, t.hidden ? 'Rank it again' : 'Leave out of ranking')
            )
        )
        wrap.appendChild(msg)
        wrap.addEventListener('click', function (e) { e.stopPropagation() })
        return wrap
    }

    function openTicket(key) {
        var t = data.view.tickets.filter(function (x) { return x.key === key })[0]
        if (!t) return
        if (!ranked().some(function (x) { return x.key === key })) state.showAll = true
        $('show-all').checked = state.showAll
        state.q = ''
        $('q').value = ''
        state.type = ''
        state.open = key
        renderTickets()
        var row = $('tk-' + key)
        if (row) row.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }

    // ------------------------------------------------------------------ releases, groups, settings
    function renderReleases() {
        var tb = clear($('releases'))
        $('releases-card').classList.toggle('hidden', data.view.releases.length < 2)
        data.view.releases.slice().reverse().forEach(function (r) {
            tb.appendChild(
                el(
                    'tr',
                    { cls: 'rel', onclick: function () { setScope('r:' + r.name) }, title: 'Open ' + r.name },
                    el('td', null, el('b', { text: r.name }), r.open ? el('span', { cls: 'small muted', text: ' still counting' }) : null),
                    el('td', { text: day(r.date) }),
                    el('td', { cls: 'num', text: String(r.tickets) }),
                    el('td', { cls: 'num', text: r.clients_on_version === null ? '–' : r.clients_on_version + ' / ' + r.clients_active }),
                    el('td', { cls: 'num', text: r.errors_per_1k_before + ' → ' + r.errors_per_1k }),
                    el('td', { cls: 'num', text: r.rage_per_1k_before + ' → ' + r.rage_per_1k }),
                    el('td', { cls: 'num', text: String(r.support) }),
                    el('td', null, healthBadge(r.health, r.health_reasons))
                )
            )
        })
    }

    function renderGroups() {
        var box = clear($('groups'))
        var rels = data.scopes.filter(function (s) { return s.kind === 'release' }).map(function (s) { return s.label }).reverse()
        if (!data.groups.length) box.appendChild(el('p', { cls: 'small muted', text: 'No custom groups yet.' }))
        data.groups.forEach(function (g) {
            box.appendChild(
                el(
                    'div',
                    { style: 'display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:6px 0;border-bottom:1px solid var(--line)' },
                    el('b', { text: g.name }),
                    el('span', { cls: 'small muted', text: g.releases.join(', ') }),
                    el('span', { style: 'flex:1' }),
                    el('button', { type: 'button', cls: 'ghost small', onclick: function () { setScope('g:' + g.id) } }, 'Show'),
                    B.canEdit ? el('button', { type: 'button', cls: 'ghost small', onclick: function () { form(g) } }, 'Edit') : null,
                    B.canEdit
                        ? el('button', { type: 'button', cls: 'ghost small', onclick: function () { if (confirm('Delete the group "' + g.name + '"?')) api('/releases/api/groups/' + g.id, { method: 'DELETE' }).then(load) } }, 'Delete')
                        : null
                )
            )
        })
        var formBox = el('div')
        box.appendChild(formBox)
        function form(g) {
            clear(formBox)
            var name = el('input', { value: g ? g.name : '', placeholder: 'For example: Payments programme', maxlength: 60 })
            var picks = el('div', { cls: 'chips', style: 'margin:8px 0' })
            rels.forEach(function (r) {
                var cb = el('input', { type: 'checkbox', value: r, style: 'width:auto' })
                if (g && g.releases.indexOf(r) >= 0) cb.checked = true
                picks.appendChild(el('label', { cls: 'chip', style: 'display:inline-flex;gap:6px;align-items:center;color:var(--ink)' }, cb, r))
            })
            var msg = el('p', { cls: 'small' })
            formBox.appendChild(el('div', { style: 'margin-top:12px' }, el('label', { text: g ? 'Edit group' : 'New group' }), name, picks, el('div', { cls: 'btns' }, el('button', { type: 'button', onclick: function () {
                var chosen = [].slice.call(picks.querySelectorAll('input:checked')).map(function (c) { return c.value })
                api('/releases/api/groups', { method: 'POST', body: JSON.stringify({ id: g ? g.id : undefined, name: name.value, releases: chosen }) }).then(function (r) { setScope('g:' + r.id) }).catch(function (e) { msg.textContent = e.message; msg.className = 'small err' })
            } }, 'Save group'), el('button', { type: 'button', cls: 'ghost', onclick: function () { clear(formBox); if (B.canEdit) formBox.appendChild(newBtn()) } }, 'Cancel')), msg))
        }
        function newBtn() {
            return el('button', { type: 'button', cls: 'ghost', style: 'margin-top:10px', onclick: function () { form(null) } }, 'New group')
        }
        if (B.canEdit) formBox.appendChild(newBtn())
    }

    function renderSliders() {
        var box = clear($('sliders'))
        var w = data.view.weights
        WEIGHTS.forEach(function (row) {
            var out = el('b', { text: String(w[row[0]]) })
            var input = el('input', { type: 'range', min: 0, max: 10, step: 1, value: w[row[0]], 'aria-label': row[1] })
            var t
            input.addEventListener('input', function () {
                out.textContent = input.value
                clearTimeout(t)
                t = setTimeout(function () {
                    state.weights = Object.assign({}, data.view.weights, (function () { var o = {}; o[row[0]] = Number(input.value); return o })())
                    load()
                }, 250)
            })
            box.appendChild(el('div', null, el('label', null, row[1] + ' ', out), input, el('div', { cls: 'small muted', text: row[2] })))
        })
    }

    function renderSettings() {
        settingsDrawn = true
        var s = data.view.settings
        var box = clear($('settings'))
        var f = {}
        var field = function (key, label, input, help) {
            f[key] = input
            return el('div', null, el('label', { text: label }), input, help ? el('div', { cls: 'small muted', text: help }) : null)
        }
        var months = el('select')
        ;['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'].forEach(function (m, i) {
            var o = el('option', { value: i + 1 }, m)
            if (s.fiscal_start_month === i + 1) o.selected = true
            months.appendChild(o)
        })
        var grid = el('div', { cls: 'edit' })
        grid.appendChild(field('jira_project', 'Jira project with the releases', el('input', { value: s.jira_project }), 'Its versions are the releases.'))
        grid.appendChild(field('keep', 'Releases to keep', el('input', { type: 'number', min: 1, max: 52, value: s.keep }), 'Older ones are deleted at the next sync.'))
        grid.appendChild(field('window_days', 'Days to measure after a release', el('input', { type: 'number', min: 7, max: 120, value: s.window_days }), 'Stops early at the next release.'))
        grid.appendChild(field('fiscal_start_month', 'Year starts in', months, 'January gives calendar quarters.'))
        grid.appendChild(field('ticket_types', 'Ticket types to rank', el('input', { value: s.ticket_types.join(', ') }), 'Comma-separated Jira issue types.'))
        grid.appendChild(field('client_property', 'PostHog property naming the client', el('input', { value: s.client_property })))
        grid.appendChild(field('version_property', 'PostHog property with the release name', el('input', { value: s.version_property }), 'Leave empty to match by dates only.'))
        grid.appendChild(field('screen_reach_factor', 'Reach for whole-screen links', el('input', { type: 'number', min: 0, max: 1, step: 0.1, value: s.screen_reach_factor }), 'A ticket linked to a whole screen did not reach everyone on it. 0.5 counts half.'))
        box.appendChild(grid)
        box.appendChild(field('support_jql', 'Support tickets (JQL)', el('input', { value: s.support_jql }), 'Counted against the screen they mention, in the days after each release.'))
        var mapBox = el('div', { style: 'margin-top:12px' }, el('label', { text: 'Jira components to screens' }), el('div', { cls: 'small muted', text: 'Components not listed are matched to screens by name.' }))
        var rows = el('div')
        var addRow = function (comp, screen) {
            var c = el('input', { value: comp || '', placeholder: 'Component' })
            var sel = el('select')
            Object.keys(SCREENS).forEach(function (p) {
                var o = el('option', { value: p }, SCREENS[p])
                if (p === screen) o.selected = true
                sel.appendChild(o)
            })
            var row = el('div', { cls: 'row', style: 'margin:6px 0' }, el('div', null, c), el('div', null, sel), el('div', { style: 'flex:0;min-width:auto' }, el('button', { type: 'button', cls: 'ghost', onclick: function () { row.remove() } }, 'Remove')))
            row.dataset.map = '1'
            rows.appendChild(row)
        }
        Object.keys(s.component_screens).forEach(function (k) { addRow(k, s.component_screens[k]) })
        mapBox.appendChild(rows)
        mapBox.appendChild(el('button', { type: 'button', cls: 'ghost', onclick: function () { addRow('', '/invoices') } }, 'Add a component'))
        box.appendChild(mapBox)
        var msg = el('p', { cls: 'small' })
        box.appendChild(
            el('p', { cls: 'btns', style: 'margin-top:14px' }, el('button', { type: 'button', onclick: function () {
                var map = {}
                ;[].slice.call(rows.querySelectorAll('[data-map]')).forEach(function (r) {
                    var c = r.querySelector('input').value.trim()
                    if (c) map[c] = r.querySelector('select').value
                })
                var body = {
                    jira_project: f.jira_project.value.trim(),
                    keep: Number(f.keep.value),
                    window_days: Number(f.window_days.value),
                    fiscal_start_month: Number(f.fiscal_start_month.value),
                    ticket_types: f.ticket_types.value.split(',').map(function (x) { return x.trim() }).filter(Boolean),
                    client_property: f.client_property.value.trim(),
                    version_property: f.version_property.value.trim(),
                    screen_reach_factor: Number(f.screen_reach_factor.value),
                    support_jql: f.support_jql.value.trim(),
                    component_screens: map,
                }
                api('/releases/api/settings', { method: 'POST', body: JSON.stringify(body) }).then(function (r) {
                    msg.textContent = r.resync ? 'Saved. Reading Jira and PostHog again with the new settings…' : 'Saved.'
                    msg.className = 'small ok'
                    if (r.resync) waitForSync()
                    else load()
                }).catch(function (e) { msg.textContent = e.message; msg.className = 'small err' })
            } }, 'Save settings')),
        )
        box.appendChild(msg)
    }

    // ------------------------------------------------------------------ wiring
    function setScope(id) {
        state.scope = id
        state.open = null
        if (state.compare === id) state.compare = ''
        window.scrollTo({ top: 0, behavior: 'smooth' })
        load()
    }
    function waitForSync() {
        var poll = function () {
            api('/releases/api/status').then(function (st) {
                renderStatus(st)
                if (st.running) setTimeout(poll, 2000)
                else api('/releases/api/areas').then(function (a) { areas = a }).then(load)
            })
        }
        setTimeout(poll, 800)
    }
    var rt
    window.addEventListener('resize', function () {
        clearTimeout(rt)
        rt = setTimeout(function () {
            if (!data) return
            renderMap()
            renderTrend()
            renderReleaseHead()
            renderTickets()
        }, 200)
    })
    $('scope').addEventListener('change', function () { setScope($('scope').value) })
    $('compare').addEventListener('change', function () { state.compare = $('compare').value; load() })
    $('tune').addEventListener('click', function () {
        var open = $('tune-panel').classList.toggle('open')
        $('tune').setAttribute('aria-expanded', String(open))
    })
    $('reset-w').addEventListener('click', function () { state.weights = null; load() })
    if ($('save-w')) {
        $('save-w').addEventListener('click', function () {
            api('/releases/api/settings', { method: 'POST', body: JSON.stringify({ weights: data.view.weights }) }).then(function () {
                state.weights = null
                $('status').textContent = 'Saved these weights as the default for everyone.'
                load()
            }).catch(function (e) { $('status').textContent = e.message })
        })
    }
    $('copy').addEventListener('click', function () {
        var w = state.weights ? '&w=' + encodeURIComponent(JSON.stringify(state.weights)) : ''
        fetch('/releases/api/summary.md?scope=' + encodeURIComponent(state.scope) + w).then(function (r) { return r.text() }).then(function (t) {
            return navigator.clipboard.writeText(t).then(function () { $('copy').textContent = 'Copied' }, function () {
                var ta = el('textarea', { style: 'width:100%;height:240px;margin-top:10px' })
                ta.value = t
                $('status').after(ta)
            })
        }).then(function () { setTimeout(function () { $('copy').textContent = 'Copy summary' }, 2000) })
    })
    if ($('sync')) {
        $('sync').addEventListener('click', function () {
            $('sync').disabled = true
            api('/releases/api/sync', { method: 'POST' }).then(function (st) { renderStatus(st); waitForSync() }).finally(function () { setTimeout(function () { $('sync').disabled = false }, 3000) })
        })
    }
    var qt
    $('q').addEventListener('input', function () { clearTimeout(qt); qt = setTimeout(function () { state.q = $('q').value.trim(); renderTickets() }, 150) })
    $('sort').addEventListener('change', function () { state.sort = $('sort').value; renderTickets() })
    $('type').addEventListener('change', function () { state.type = $('type').value; renderTickets() })
    $('show-all').addEventListener('change', function () { state.showAll = $('show-all').checked; renderTickets() })

    api('/releases/api/areas').then(function (a) { areas = a }).catch(function () {})
    load().then(function () {
        if (data && data.view.synced.running) waitForSync()
    })
})()
