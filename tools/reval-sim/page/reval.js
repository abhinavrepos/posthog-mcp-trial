/* The simulated Reval: one Ext JS classic page (one Ext.container.Viewport, the URL never changes) whose
   screens come from tools/reval-sim/screens.ts. It sends exactly the events real Reval sends, with its
   masks and timings (see /root/briefs/reval-sim.md). window.Reval is the handle the driver uses. */
/* global Ext, posthog */
(function () {
    'use strict';
    var cfg = window.REVAL_CFG;
    var byMenu = {}, byEvent = {};
    cfg.screens.forEach(function (s) { byMenu[s.menu] = s; if (!byEvent[s.event]) byEvent[s.event] = s; });
    var speed = cfg.speed || 1;
    function later(fn, ms) { return setTimeout(fn, Math.round(ms * speed)); }
    var log = window.__revalLog = [];

    // Reval's tracker: posthog.capture(category, {dialog_id, dialog_name, tab_name, action, action_name, control_type}).
    // Before initPostHog runs there is no posthog at all, and the events are lost (as in Reval).
    function track(category, props) {
        log.push({ t: Date.now(), category: category, props: props, posthog: !!window.posthog });
        if (window.posthog && typeof window.posthog.capture === 'function') window.posthog.capture(category, props);
    }

    var userCfg = { env: cfg.env, site: cfg.site, client: cfg.client, user: cfg.user };
    function distinctId(u) { return [u.env, u.site, u.client, u.user].join('|'); }

    // ---------------------------------------------------------------- PostHog: the standard async snippet
    function initPostHog() {
        /* eslint-disable */
        !function(t,e){var o,n,p,r;e.__SV||(window.posthog && window.posthog.__loaded)||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement("script")).type="text/javascript",p.crossOrigin="anonymous",p.async=!0,p.src=s.api_host.replace(".i.posthog.com","-assets.i.posthog.com")+"/static/array.js",(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r);var u=e;for(void 0!==a?u=e[a]=[]:a="posthog",u.people=u.people||[],u.toString=function(t){var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e},u.people.toString=function(){return u.toString(1)+".people (stub)"},o="init Ts Ms bs capture Ue calculateEventProperties Rs register register_once register_for_session unregister unregister_for_session Ds getFeatureFlag getFeatureFlagPayload isFeatureEnabled reloadFeatureFlags updateEarlyAccessFeatureEnrollment getEarlyAccessFeatures on onFeatureFlags onSurveysLoaded onSessionId getSurveys getActiveMatchingSurveys renderSurvey displaySurvey cancelPendingSurvey canRenderSurvey canRenderSurveyAsync identify setPersonProperties group resetGroups setPersonPropertiesForFlags resetPersonPropertiesForFlags setGroupPropertiesForFlags resetGroupPropertiesForFlags reset get_distinct_id getGroups get_session_id get_session_replay_url alias set_config startSessionRecording stopSessionRecording sessionRecordingStarted captureException loadToolbar get_property getSessionProperty Ls As createPersonProfile Os ks Bs opt_in_capturing opt_out_capturing has_opted_in_capturing has_opted_out_capturing get_explicit_consent_status is_capturing clear_opt_in_out_capturing Cs debug O Fs getPageViewId captureTraceFeedback captureTraceMetric Ss".split(" "),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);
        /* eslint-enable */
        var u = userCfg;
        posthog.init(cfg.token, {
            api_host: cfg.posthogHost,
            defaults: '2025-05-24',
            person_profiles: 'identified_only',
            request_headers: { PostHog: 'true' },
            loaded: function (ph) {
                window.__identifiedAt = Date.now();
                ph.identify(distinctId(u), { name: u.user + ' (' + u.client + ')', loginUser: u.user, client: u.client, environment: u.env, siteId: u.site });
            }
        });
        window.__posthogInitAt = Date.now();
    }

    // ---------------------------------------------------------------- masks
    // The viewport-level Ext.LoadMask (z-index 99999), hidden and destroyed once a screen has settled.
    function viewportMask(msg) {
        var m = Ext.create('Ext.LoadMask', { target: viewport, msg: msg || 'Loading...' });
        m.show();
        try { m.getEl().setStyle('z-index', 99999); } catch (_) { /* best effort */ }
        return m;
    }
    function hideAndDestroy(m) { try { m.hide(); m.destroy(); } catch (_) { /* gone */ } }

    // ---------------------------------------------------------------- screens
    var open = {}; // menu -> { screen, cmp (tab or window), param, result }
    var tabs, viewport, logoutPanel;

    function req(menu, cb) {
        Ext.Ajax.request({ url: '/Dialog', method: 'GET', params: { id: menu, ms: Math.round((byMenu[menu].loadMs || 200) * speed) }, success: cb, failure: cb });
    }

    function buttonsFor(s, owner) {
        return s.buttons.map(function (label) {
            return { xtype: 'button', text: label, itemId: 'btn-' + label.replace(/[^A-Za-z0-9]/g, ''), revalLabel: label,
                handler: function () { press(s, label, owner()); } };
        });
    }
    function fieldsFor(s) {
        return (s.fields || []).map(function (label) {
            return { xtype: /Date/.test(label) ? 'datefield' : 'textfield', fieldLabel: label, revalLabel: label, labelWidth: 110, width: 320,
                listeners: { change: { buffer: 50, fn: function () {
                    track('Event', { dialog_id: s.event, dialog_name: s.name, action: label, control_type: /Date/.test(label) ? 'DATEFIELD' : 'TEXTFIELD' });
                } } } };
        });
    }
    function gridFor(s) {
        var data = [];
        for (var i = 0; i < 40; i++) data.push({ id: i + 1, name: s.name + ' row ' + (i + 1), status: i % 3 ? 'Live' : 'Matured', amount: (i * 1234567) % 9999999 });
        return { xtype: 'grid', itemId: 'grid', flex: 1, loadMask: false, title: s.name,
            store: { fields: ['id', 'name', 'status', 'amount'], data: data },
            columns: [{ text: 'Id', dataIndex: 'id', width: 60 }, { text: 'Name', dataIndex: 'name', flex: 1 }, { text: 'Status', dataIndex: 'status' }, { text: 'Amount', dataIndex: 'amount', width: 120 }] };
    }
    function bodyFor(s) {
        var form = { xtype: 'form', itemId: 'form', bodyPadding: 12, border: false, items: fieldsFor(s) };
        if (s.tabs) {
            var inner = Ext.create('Ext.tab.Panel', { itemId: 'inner', flex: 1, items: s.tabs.map(function (t, i) {
                return { title: t, layout: 'fit', items: i === 0 ? [form] : [{ xtype: 'component', html: '<div style="padding:12px">' + t + '</div>' }] };
            }) });
            // Tab changes send PageView OPEN with no dialog id or name, only the tab title.
            inner.on('tabchange', function (_p, tab) { track('PageView', { dialog_id: undefined, dialog_name: undefined, tab_name: tab.title, action: 'OPEN' }); });
            return [inner];
        }
        return s.grid ? [form, gridFor(s)] : [form];
    }

    function openScreen(menu) {
        var s = byMenu[menu];
        if (!s) throw new Error('no screen ' + menu);
        var have = open[menu];
        // Reopening a screen that is still open only focuses it: no new OPEN.
        if (have && have.cmp && !have.cmp.destroyed) {
            if (have.cmp.isWindow) have.cmp.toFront(); else tabs.setActiveTab(have.cmp);
            return 'focused';
        }
        var mask = viewportMask();
        req(menu, function () {
            var cmp;
            if (s.kind === 'tab' || s.kind === 'iframe') {
                var items = s.kind === 'iframe'
                    ? [{ xtype: 'component', itemId: 'frame', flex: 1, autoEl: { tag: 'iframe', src: '/iframe.html?screen=' + encodeURIComponent(s.event), style: 'border:0;width:100%;height:100%' } }]
                    : bodyFor(s);
                cmp = tabs.add({ title: s.name, closable: true, revalMenu: menu, layout: { type: 'vbox', align: 'stretch' }, tbar: s.kind === 'iframe' ? [] : buttonsFor(s, function () { return cmp; }), items: items });
                // One CLOSE per tabbed panel, when the user closes it.
                cmp.on('close', function () { if (!cmp.revalClosed) { cmp.revalClosed = true; track('PageView', { dialog_id: s.event, dialog_name: s.name, action: 'CLOSE' }); } });
                tabs.setActiveTab(cmp);
            } else if (s.kind === 'report') {
                // The parameter dialog: a floating window; its events carry the report menu id.
                cmp = Ext.create('Ext.window.Window', { title: s.name, revalMenu: menu, revalDialog: s.param, width: 460, height: 260, x: 260, y: 90, layout: 'fit', constrain: true,
                    items: [{ xtype: 'form', itemId: 'form', bodyPadding: 12, items: fieldsFor(s) }], buttons: buttonsFor(s, function () { return cmp; }) });
                cmp.show();
            } else {
                cmp = Ext.create('Ext.window.Window', { title: s.name, revalMenu: menu, modal: s.kind === 'modal', width: 480, height: s.grid ? 360 : 240, x: 300, y: 120,
                    layout: { type: 'vbox', align: 'stretch' }, constrain: true, items: bodyFor(s), buttons: buttonsFor(s, function () { return cmp; }) });
                cmp.show();
            }
            open[menu] = { screen: s, cmp: cmp };
            track('PageView', { dialog_id: s.event, dialog_name: s.name, action: 'OPEN' });
            if (!s.stuck) later(function () { hideAndDestroy(mask); }, s.settleMs);
        });
        return 'opening';
    }

    function messageBox(text) {
        Ext.Msg.alert('Reval', text);
        track('Event', { dialog_id: 'messagebox', dialog_name: 'UNKNOWN', action_name: [text] });
    }
    function toast(text) {
        Ext.toast({ html: text, align: 't', closable: false, autoCloseDelay: Math.round(2500 * speed) });
        track('Event', { dialog_id: 'toast', dialog_name: 'UNKNOWN', action_name: [text] });
    }

    function press(s, label, cmp) {
        track('Event', { dialog_id: s.event, dialog_name: s.name, action_name: label, control_type: 'BUTTON' });
        var form = cmp && cmp.down && cmp.down('#form');
        if (label === 'Save' || label === 'Approve' || label === 'Import') {
            // A form submit mask: hidden afterwards but kept (not destroyed).
            var target = form || cmp;
            if (!target.revalSubmitMask) target.revalSubmitMask = Ext.create('Ext.LoadMask', { target: target, msg: 'Saving...' });
            target.revalSubmitMask.show();
            later(function () {
                target.revalSubmitMask.hide();
                var m = s.message || (s.name + ' Updated');
                if (m.charAt(0) === '!') messageBox(m.slice(1)); else toast(m);
            }, 300);
        } else if ((label === 'Run' || label === 'Refresh') && s.kind === 'report') {
            openResult(s);
        } else if (label === 'Run' || label === 'Refresh') {
            var grid = cmp.down('#grid');
            if (grid) { // grids: loadMask false, a custom Ext.LoadMask on explicit loads
                var gm = Ext.create('Ext.LoadMask', { target: grid, msg: 'Loading...' });
                gm.show();
                later(function () { grid.getStore().loadData(grid.getStore().getRange().map(function (r) { return r.getData(); })); gm.hide(); gm.destroy(); }, s.loadMs);
            }
            if (s.stuck) viewportMask('Loading archive...'); // never goes away
        } else if (label === 'Close' || label === 'OK' || label === 'Cancel') {
            if (cmp.isWindow) cmp.close(); else cmp.close();
        }
    }
    // Run in a report's parameter window: the result tab (its Ext dialog), with a custom grid mask.
    function openResult(s) {
        var key = s.menu + '#result';
        var have = open[key];
        if (have && !have.cmp.destroyed) { tabs.setActiveTab(have.cmp); }
        var vm = viewportMask('Running report...');
        req(s.menu, function () {
            var cmp = have && !have.cmp.destroyed ? have.cmp : tabs.add({ title: s.name + ' (result)', closable: true, revalMenu: key, revalDialog: s.result,
                layout: { type: 'vbox', align: 'stretch' }, tbar: ['Export', 'XLSX Export', 'CSV Export'].map(function (label) {
                    return { xtype: 'button', text: label, itemId: 'btn-' + label.replace(/[^A-Za-z0-9]/g, ''), revalLabel: label, handler: function () { press(s, label, cmp); } };
                }), items: [gridFor(s)] });
            cmp.on('close', function () { if (!cmp.revalClosed) { cmp.revalClosed = true; track('PageView', { dialog_id: s.event, dialog_name: s.name, action: 'CLOSE' }); } });
            open[key] = { screen: s, cmp: cmp };
            tabs.setActiveTab(cmp);
            hideAndDestroy(vm);
            var gm = Ext.create('Ext.LoadMask', { target: cmp.down('#grid'), msg: 'Loading...' });
            gm.show();
            later(function () { gm.hide(); gm.destroy(); }, s.loadMs);
        });
    }

    // ---------------------------------------------------------------- logout / login (the SPA stays)
    function logout() {
        Ext.WindowManager.each(function (w) { if (w.isWindow) w.destroy(); });
        Ext.Object.each(open, function (k, v) { if (v.cmp && !v.cmp.destroyed && !v.cmp.isWindow) { v.cmp.revalClosed = true; v.cmp.destroy(); } });
        open = {};
        viewport.down('#main').hide();
        logoutPanel.show();
        window.__loggedIn = false;
    }
    function login(user, client) {
        userCfg = { env: cfg.env, site: cfg.site, client: client || userCfg.client, user: user };
        logoutPanel.hide();
        viewport.down('#main').show();
        viewport.down('#who').setText(distinctId(userCfg));
        // No posthog.reset(): the next identify switches the distinct id.
        if (window.posthog && typeof window.posthog.identify === 'function')
            posthog.identify(distinctId(userCfg), { name: user + ' (' + userCfg.client + ')', loginUser: user, client: userCfg.client, environment: userCfg.env, siteId: userCfg.site });
        window.__loggedIn = true;
    }
    // Client change: a full-page form POST (the page reloads with the new client).
    function changeClient(client, user) {
        var f = document.createElement('form');
        f.method = 'POST'; f.action = location.pathname + location.search;
        [['client', client], ['user', user || userCfg.user]].forEach(function (kv) { var i = document.createElement('input'); i.type = 'hidden'; i.name = kv[0]; i.value = kv[1]; f.appendChild(i); });
        document.body.appendChild(f); f.submit();
    }

    // ---------------------------------------------------------------- the viewport
    Ext.onReady(function () {
        var groups = {};
        cfg.screens.forEach(function (s) { (groups[s.group] = groups[s.group] || []).push({ text: s.name, revalMenu: s.menu, handler: function () { openScreen(s.menu); } }); });
        tabs = Ext.create('Ext.tab.Panel', { region: 'center', itemId: 'mdi', id: 'mdi', items: [{ title: 'Home', html: '<div style="padding:16px">Welcome to Reval</div>' }] });
        logoutPanel = Ext.create('Ext.panel.Panel', { region: 'center', hidden: true, itemId: 'logout', title: 'Logged out', bodyPadding: 20,
            items: [{ xtype: 'component', html: 'You have been logged out.' }] });
        viewport = Ext.create('Ext.container.Viewport', { layout: 'border', items: [
            { region: 'north', xtype: 'toolbar', items: [{ xtype: 'tbtext', text: '<b>REVAL 27.0.0</b>' }].concat(Object.keys(groups).map(function (g) { return { text: g, menu: groups[g] }; }))
                .concat(['->', { xtype: 'tbtext', itemId: 'who', text: distinctId(userCfg) }, { text: 'Logout', handler: logout }]) },
            { region: 'center', xtype: 'container', layout: 'fit', itemId: 'main', items: [tabs] },
            logoutPanel
        ] });
        window.__viewportAt = Date.now();
        window.__loggedIn = true;
        // initPostHog runs after the viewport exists: early screens are opened before identify().
        if (cfg.initDelayMs >= 0) setTimeout(initPostHog, cfg.initDelayMs);
    });

    function screenCmp(key) {
        var o = open[key] || open[(byEvent[key] || {}).menu];
        return o && o.cmp && !o.cmp.destroyed ? o.cmp : null;
    }
    window.Reval = {
        open: openScreen,
        // The DOM id of a visible button, for a real click (masks in the way stop it, as for a user).
        button: function (key, label) {
            var cmp = screenCmp(key);
            if (!cmp) return null;
            var b = cmp.query('button').filter(function (x) { return x.revalLabel === label && x.isVisible(true); })[0];
            return b ? b.getId() : null;
        },
        field: function (key, label, value) {
            var cmp = screenCmp(key);
            var f = cmp && cmp.query('field').filter(function (x) { return x.revalLabel === label; })[0];
            if (!f) return false;
            f.setValue(value);
            return true;
        },
        tab: function (key, title) {
            var cmp = screenCmp(key), inner = cmp && cmp.down('#inner');
            var t = inner && inner.items.findBy(function (x) { return x.title === title; });
            if (!t) return false;
            inner.setActiveTab(t);
            return true;
        },
        mdi: function (key) { var cmp = screenCmp(key); if (cmp && !cmp.isWindow) { tabs.setActiveTab(cmp); return true; } return false; },
        close: function (key) { var cmp = screenCmp(key); if (!cmp) return false; cmp.close(); return true; },
        result: function (menu) { return screenCmp(menu + '#result') ? menu + '#result' : null; },
        message: messageBox,
        toast: toast,
        logout: logout,
        login: login,
        changeClient: changeClient,
        initPostHog: initPostHog,
        distinctId: function () { return distinctId(userCfg); },
        // Visible Ext masks right now (for the driver's own checks).
        masks: function () {
            return Array.prototype.filter.call(document.querySelectorAll('.x-mask'), function (m) {
                var st = getComputedStyle(m); return (m.offsetWidth > 0 || m.offsetHeight > 0) && st.visibility !== 'hidden' && st.display !== 'none';
            }).length;
        },
        modalWindow: function (title) {
            var w = Ext.create('Ext.window.Window', { title: title || 'Confirm', modal: true, width: 320, height: 160, html: '<div style="padding:12px">Are you sure?</div>',
                buttons: [{ text: 'OK', itemId: 'btn-OK', revalLabel: 'OK', handler: function () { w.close(); } }] });
            w.show();
            return w.down('#btn-OK').getId();
        },
        closeModal: function () { var shut = 0; Ext.WindowManager.each(function (w) { if (w.isWindow && w.modal && w.isVisible()) { w.close(); shut++; } }); return shut; },
        msgOk: function () { var b = Ext.Msg.down && Ext.Msg.down('button[itemId=ok]'); if (b && b.isVisible()) { b.el.dom.click(); return true; } Ext.Msg.hide(); return false; },
        log: log
    };
}());
