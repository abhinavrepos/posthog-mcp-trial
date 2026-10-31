/* Acme Portal browser code. Plain JS, inlined into every page by demo-app/server.ts. */
;(function () {
    var A = window.ACME
    var ph = A.posthog

    // Standard posthog-js loader snippet, pointed at the self-hosted instance.
    // prettier-ignore
    !function(t,e){var o,n,p,r;e.__SV||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement("script")).type="text/javascript",p.crossOrigin="anonymous",p.async=!0,p.src=s.api_host+"/static/array.js",(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r);var u=e;for(void 0!==a?u=e[a]=[]:a="posthog",u.people=u.people||[],u.toString=function(t){var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e},u.people.toString=function(){return u.toString(1)+".people (stub)"},o="init capture register register_once register_for_session unregister opt_out_capturing has_opted_out_capturing opt_in_capturing reset isFeatureEnabled getFeatureFlag onFeatureFlags identify setPersonProperties group resetGroups setPersonPropertiesForFlags resetPersonPropertiesForFlags setGroupPropertiesForFlags resetGroupPropertiesForFlags captureException".split(" "),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);

    posthog.init(ph.token, {
        api_host: ph.host,
        person_profiles: 'identified_only',
        capture_pageview: true,
        capture_pageleave: true,
        capture_exceptions: true,
        capture_dead_clicks: true,
        enable_recording_console_log: true,
        // Demo only: the traffic generator drives headless Chrome, which posthog-js drops as a
        // bot by default. A real deployment would leave this out.
        opt_out_useragent_filter: true,
        session_recording: { maskAllInputs: true },
        loaded: function (p) {
            p.identify(A.user.email, { email: A.user.email, name: A.user.name, role: A.user.role })
            p.group('company', A.client.id, {
                name: A.client.name,
                region: A.client.region,
                plan: A.client.plan,
                app_version: A.client.version,
            })
        },
    })
    // Super properties: every event carries the client and release, so queries never need a join.
    posthog.register({
        client_id: A.client.id,
        client_name: A.client.name,
        client_region: A.client.region,
        client_plan: A.client.plan,
        app_version: A.client.version,
    })

    function $(id) {
        return document.getElementById(id)
    }
    function sleep(ms) {
        return new Promise(function (r) {
            setTimeout(r, ms)
        })
    }

    // ---------------------------------------------------------------- Invoices: PDF export
    // 2.14.0 converts every line to the base currency before building the PDF totals. The API
    // only returns a rate for the base currency, so any second currency throws.
    function convertToBase(line, rates) {
        return line.amount * Number(rates[line.currency].toFixed(6))
    }
    function buildPdfTotals(data) {
        if (A.client.version === '2.14.0') {
            return data.lines.reduce(function (sum, line) {
                return sum + convertToBase(line, data.rates)
            }, 0)
        }
        // 2.13.2 printed one subtotal per currency and never converted.
        var per = {}
        data.lines.forEach(function (l) {
            per[l.currency] = (per[l.currency] || 0) + l.amount
        })
        return per
    }

    var exporting = false
    async function exportPdf() {
        if (exporting) return // a stuck export swallows further clicks, so users rage-click
        exporting = true
        var status = $('export-status')
        status.textContent = 'Preparing PDF…'
        status.className = 'status busy'
        var ids = Array.prototype.map
            .call(document.querySelectorAll('.pick:checked'), function (el) {
                return el.dataset.id
            })
            .join(',')
        posthog.capture('invoice_export_started', { invoice_count: ids.split(',').length })
        var res = await fetch('/api/invoices/export?ids=' + encodeURIComponent(ids))
        var data = await res.json()
        await sleep(600)
        var totals = buildPdfTotals(data) // throws on 2.14.0 with mixed currencies
        status.textContent = 'PDF ready — invoices.pdf'
        status.className = 'status ok'
        posthog.capture('invoice_export_completed', {
            invoice_count: data.lines.length,
            currencies: Object.keys(typeof totals === 'object' ? totals : { [data.base]: 1 }),
        })
        exporting = false
    }

    var exportBtn = $('export-pdf')
    if (exportBtn) {
        exportBtn.addEventListener('click', function () {
            // The rejection is left unhandled on purpose: that is the bug, and posthog-js's
            // exception autocapture records it as an $exception.
            exportPdf()
        })
    }
    var search = $('search')
    if (search) {
        search.addEventListener('input', function () {
            var q = search.value.toLowerCase()
            document.querySelectorAll('.grid tbody tr').forEach(function (tr) {
                tr.style.display = tr.textContent.toLowerCase().indexOf(q) >= 0 ? '' : 'none'
            })
        })
    }

    // ---------------------------------------------------------------- Revenue report
    async function loadRevenue() {
        var range = $('range').value
        $('rev-total').textContent = '…'
        $('rev-count').textContent = '…'
        var res = await fetch('/api/reports/revenue?range=' + range)
        var data = await res.json()
        $('rev-total').textContent = data.currency + ' ' + data.total.toLocaleString('en-US')
        $('rev-count').textContent = String(data.count)
        var trend = $('trend')
        trend.innerHTML = ''
        for (var i = 0; i < 12; i++) {
            var bar = document.createElement('div')
            bar.className = 'bar'
            bar.style.height = (data.total ? 20 + ((i * 37) % 70) : 2) + '%'
            trend.appendChild(bar)
        }
        posthog.capture('revenue_report_loaded', { range: range, total: data.total, invoice_count: data.count })
    }
    if ($('refresh')) {
        $('refresh').addEventListener('click', loadRevenue)
        $('range').addEventListener('change', loadRevenue)
        loadRevenue()
    }

    // ---------------------------------------------------------------- Settings
    if ($('save')) {
        $('save').addEventListener('click', async function () {
            $('save-status').textContent = 'Saving…'
            await sleep(400)
            $('save-status').textContent = 'Saved'
            posthog.capture('settings_saved')
        })
    }
})()
