/* Real posthog-js, loaded from the configured host; no mocked recording or signals. */
(async function () {
    const config = window.LAB_CONFIG
    const params = new URLSearchParams(location.search)
    const clientId = params.get('client') || 'LAB1'
    const clientName = params.get('name') || 'Lab Smooth Co'
    const persona = params.get('persona') || 'smooth'
    const c = config.canaries
    const $ = id => document.getElementById(id)
    let dialogId = 'DlgDetailIRSwap', dialogName = 'IR Swap', busy = false
    const script = document.createElement('script')
    script.src = config.host + '/static/array.js'
    script.crossOrigin = 'anonymous'
    script.onerror = () => { window.labError = 'Could not load PostHog SDK' }
    script.onload = () => window.posthog.init(config.token, {
        api_host: config.host,
        opt_out_useragent_filter: true,
        session_recording: { maskAllInputs: false, recordCrossOriginIframes: false },
        capture_pageview: false,
        capture_pageleave: true,
        capture_dead_clicks: true,
        loaded(p) {
            p.register({ client_id: clientId, client_name: clientName, app_version: '27.0.0' })
            p.identify(clientId + ':' + crypto.randomUUID())
            p.startSessionRecording()
            window.labReady = true
        },
    })
    document.head.appendChild(script)
    function capture(event, props) {
        window.posthog.capture(event, { dialog_id: dialogId, dialog_name: dialogName, tab_name: 'Terms', ...props })
    }
    function message(kind, text) {
        const el = document.createElement('div')
        el.textContent = text
        if (kind === 'messagebox') { el.id = 'banner'; el.setAttribute('role', 'alert'); $('messages').replaceChildren(el) }
        else { el.className = 'toast'; document.body.appendChild(el); setTimeout(() => el.remove(), 2200) }
        capture('Event', { dialog_id: kind, dialog_name: 'UNKNOWN', action: 'OPEN', action_name: [text] })
    }
    for (const [id, code, name] of [['open-ir', 'DlgDetailIRSwap', 'IR Swap'], ['open-fx', 'DlgDetailFXTrade', 'FX Trade'], ['open-hedge', 'DlgHedgeDesignation', 'Hedge Designation']]) {
        $(id).onclick = () => {
            dialogId = code; dialogName = name
            $('editor').hidden = false; $('dialog-title').textContent = name
            capture('PageView', { action: 'OPEN', title: 'REVAL 27.0.0' })
        }
    }
    $('close').onclick = () => { capture('PageView', { action: 'CLOSE' }); $('editor').hidden = true }
    const fields = { notional: ['Notional', c.notional], rate: ['Rate', c.rate], counterparty: ['Counterparty', c.counterparty], 'trade-date': ['Trade Date', '2026-11-12'] }
    for (const [id, [label, value]] of Object.entries(fields)) {
        const input = $(id)
        input.value = value
        input.title = c.cash
        input.dataset.sensitive = c.tradeId
        input.setAttribute('aria-label', label + ' ' + c.notional)
        input.addEventListener('input', () => capture('Event', { action: label, control_type: id === 'trade-date' ? 'DATEFIELD' : 'TEXTFIELD' }))
    }
    for (let i = 0; i < 45; i++) {
        const row = document.createElement('tr')
        for (const value of [c.tradeId, c.notional, c.cash, c.rate, c.counterparty]) { const td = document.createElement('td'); td.textContent = value; td.title = c.counterparty; td.dataset.trade = c.tradeId; row.appendChild(td) }
        $('trades').appendChild(row)
    }
    $('trade-form').onsubmit = e => {
        e.preventDefault()
        capture('Event', { action: 'CLICK', control_type: 'BUTTON', action_name: 'Save' })
        if (persona === 'error-looping') {
            message('messagebox', 'Invalid trade ' + Object.values(c).join(' / '))
        } else if (!busy) {
            busy = true
            setTimeout(() => { busy = false; message('toast', 'Saved ' + c.tradeId + ' ' + c.cash) }, persona === 'rage-dead' ? 6000 : 500)
        }
    }
    // Preview deliberately has no handler, mutation, request, or navigation.
})()
