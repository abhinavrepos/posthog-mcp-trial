/* Lens survey chains. Readable ES2017; no storage, DOM observers or external requests. */
(function (factory) {
    try {
        var api = factory();
        if (typeof module === 'object' && module.exports) module.exports = api;
        else if (typeof window !== 'undefined') api.install(window);
    } catch (_) { /* A failed extension must never prevent surveys. */ }
}(function () {
    'use strict';
    var MAX_TEXT = 8192;
    function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
    function text(value) {
        if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') return null;
        var result = String(value);
        return result.length <= MAX_TEXT ? result : null;
    }
    function finite(value) { return typeof value === 'number' && Number.isFinite(value); }

    // Native RegExp has no execution deadline. Accept a conservative, bounded subset:
    // no quantified groups, backreferences, lookarounds, or multiple variable repeats.
    // This prevents customer JSON from introducing catastrophic backtracking on the UI thread.
    function regex(pattern) {
        if (pattern.length > 256 || /\\[1-9]|\(\?/.test(pattern)) return null;
        var atoms = pattern.replace(/\\./g, 'X').replace(/\[[^\]]*\]/g, 'X');
        if (/\)[*+?{]/.test(atoms)) return null;
        var repeats = atoms.match(/[*+]|\{[^}]*\}/g) || [];
        if (repeats.length > 1 || atoms.indexOf('{') !== -1) return null;
        return new RegExp(pattern);
    }
    function matcher(raw) {
        if (!object(raw) || typeof raw.event !== 'string' || !raw.event.length || raw.event.length > 256) return null;
        if (raw.event[0] === '$' || raw.event.indexOf('lens_chain:') === 0) return null;
        var props = raw.properties === undefined ? {} : raw.properties;
        if (!object(props) || Object.keys(props).length > 50) return null;
        var filters = [];
        for (var key of Object.keys(props)) {
            var filter = props[key];
            if (!object(filter) || !/^(exact|is_not|icontains|not_icontains|regex|not_regex)$/.test(filter.operator) ||
                !Array.isArray(filter.values) || !filter.values.length || filter.values.length > 50) return null;
            var values = [];
            for (var value of filter.values) {
                var string = text(value);
                if (string === null) return null;
                if (filter.operator === 'regex' || filter.operator === 'not_regex') {
                    var compiled = regex(string);
                    if (!compiled) return null;
                    values.push(compiled);
                } else values.push(string);
            }
            filters.push({ key: key, operator: filter.operator, values: values });
        }
        return { event: raw.event, filters: filters };
    }
    // Version 2 chains may carry an audience; an engine without audiences refuses them, so it never
    // shows a client-limited survey to everyone. Which clients a chain runs for: { clients: ["ACME"], distinctIdPart: 3, separator: "|" } reads the
    // client from the user id (Reval: ENV|SITE|CLIENT|USER); { clients, eventProperty: "client_id" } from
    // each event. Compared without case. Absent: every client. Invalid: the chain is refused (false).
    function audienceOf(raw) {
        if (raw === undefined || raw === null) return null;
        if (!object(raw) || !Array.isArray(raw.clients) || !raw.clients.length || raw.clients.length > 500) return false;
        var clients = [];
        for (var c of raw.clients) { var t = text(c); if (t === null || !t.length) return false; clients.push(t.toLowerCase()); }
        if (raw.eventProperty !== undefined) {
            if (typeof raw.eventProperty !== 'string' || !raw.eventProperty.length || raw.eventProperty.length > 200) return false;
            return { clients: clients, eventProperty: raw.eventProperty };
        }
        var part = raw.distinctIdPart, sep = raw.separator === undefined ? '|' : raw.separator;
        if (!finite(part) || part < 1 || part > 20 || Math.floor(part) !== part || typeof sep !== 'string' || sep.length !== 1) return false;
        return { clients: clients, part: part, separator: sep };
    }
    function inAudience(audience, event, distinctId) {
        if (!audience) return true;
        var value;
        if (audience.eventProperty) value = object(event.properties) ? text(event.properties[audience.eventProperty]) : null;
        else value = typeof distinctId === 'string' ? (distinctId.split(audience.separator)[audience.part - 1] || null) : null;
        return value !== null && audience.clients.indexOf(String(value).toLowerCase()) !== -1;
    }
    function normalizeChain(raw) {
        try {
            if (!object(raw) || (raw.version !== 1 && raw.version !== 2) || typeof raw.id !== 'string' || !/^[a-z0-9-]{1,40}$/.test(raw.id) ||
                !Array.isArray(raw.steps) || raw.steps.length < 1 || raw.steps.length > 10) return null;
            var steps = raw.steps.map(matcher);
            if (steps.some(function (step) { return !step; })) return null;
            var within = raw.withinSeconds;
            if (within !== undefined && (!finite(within) || within <= 0 || within > Number.MAX_SAFE_INTEGER / 1000)) return null;
            var resets = raw.resetOn === undefined ? [] : raw.resetOn;
            if (!Array.isArray(resets) || resets.length > 100) return null;
            resets = resets.map(matcher);
            if (resets.some(function (step) { return !step; })) return null;
            var ready = raw.ready === undefined ? {} : raw.ready;
            if (!object(ready)) return null;
            for (var flag of ['documentComplete', 'noVisibleMask']) {
                if (ready[flag] !== undefined && typeof ready[flag] !== 'boolean') return null;
            }
            var wait = ready.maxWaitMs === undefined ? 10000 : ready.maxWaitMs;
            if (!finite(wait) || wait < 0 || wait > Number.MAX_SAFE_INTEGER) return null;
            var audience = audienceOf(raw.audience);
            if (audience === false) return null;
            return { id: raw.id, steps: steps, resetOn: resets, withinMs: within === undefined ? Infinity : within * 1000, audience: audience,
                ready: { documentComplete: ready.documentComplete !== false, noVisibleMask: ready.noVisibleMask !== false, maxWaitMs: wait } };
        } catch (_) { return null; }
    }
    function matches(step, event) {
        if (step.event !== event.event) return false;
        var props = object(event.properties) ? event.properties : {};
        return step.filters.every(function (filter) {
            if (!Object.prototype.hasOwnProperty.call(props, filter.key) || props[filter.key] == null) return false;
            var raw = props[filter.key], candidates;
            if (Array.isArray(raw)) {
                if (raw.length > 100 || raw.some(function (item) { return text(item) === null; })) return false;
                candidates = [text(raw.join(','))].concat(raw.map(text));
            } else candidates = [text(raw)];
            if (candidates.some(function (candidate) { return candidate === null; })) return false;
            var op = filter.operator;
            var positive = candidates.some(function (candidate) {
                return filter.values.some(function (value) {
                    if (op === 'regex' || op === 'not_regex') return value.test(candidate);
                    if (op === 'icontains' || op === 'not_icontains') return candidate.toLowerCase().indexOf(value.toLowerCase()) !== -1;
                    return candidate === value;
                });
            });
            return op === 'is_not' || op === 'not_icontains' || op === 'not_regex' ? !positive : positive;
        });
    }
    function createMachine() {
        var states = new Map(), sequence = 0;
        function reset(state) { state.index = 0; state.started = 0; state.pending = 0; }
        return {
            setSurveys: function (surveys) {
                try {
                    if (!Array.isArray(surveys)) return;
                    var next = new Map();
                    for (var survey of surveys) {
                        try {
                            if (!object(survey) || !survey.start_date || survey.end_date !== null) continue;
                            var raw = survey.conditions && survey.conditions.lensChain;
                            var chain = normalizeChain(raw);
                            if (!chain || next.has(chain.id)) continue; // One event for a shared id; first valid definition wins.
                            var signature = JSON.stringify(raw), old = states.get(chain.id);
                            next.set(chain.id, old && old.signature === signature ? old :
                                { chain: chain, signature: signature, index: 0, started: 0, pending: 0 });
                        } catch (_) { /* Ignore only this malformed survey. */ }
                    }
                    states = next;
                } catch (_) { /* Keep the last good snapshot. */ }
            },
            consume: function (event, now, distinctId) {
                var completed = [];
                try {
                    if (!object(event) || typeof event.event !== 'string' || !finite(now) ||
                        event.event[0] === '$' || event.event.indexOf('lens_chain:') === 0) return completed;
                    states.forEach(function (state, id) {
                        try {
                            var chain = state.chain;
                            if (chain.resetOn.some(function (step) { return matches(step, event); })) { reset(state); return; }
                            if (state.pending) return;
                            if (!inAudience(chain.audience, event, distinctId)) return;
                            if (state.index && now - state.started > chain.withinMs) reset(state);
                            if (!matches(chain.steps[state.index], event)) return;
                            if (!state.index) state.started = now;
                            state.index++;
                            if (state.index === chain.steps.length) {
                                state.pending = ++sequence;
                                completed.push({ id: id, token: state.pending, ready: chain.ready });
                            }
                        } catch (_) { reset(state); }
                    });
                } catch (_) { /* Ignore malformed captured events. */ }
                return completed;
            },
            pending: function (id, token) {
                try { var state = states.get(id); return !!state && state.pending === token; } catch (_) { return false; }
            },
            finish: function (id, token) {
                try {
                    var state = states.get(id);
                    if (!state || state.pending !== token) return false;
                    reset(state);
                    return true;
                } catch (_) { return false; }
            }
        };
    }
    function isReady(root, options) {
        try {
            var doc = root.document;
            if (!doc || (options.documentComplete && doc.readyState !== 'complete')) return false;
            if (options.noVisibleMask) {
                var masks = doc.querySelectorAll('.x-mask, .x-mask-msg');
                for (var i = 0; i < masks.length; i++) {
                    var mask = masks[i];
                    if (mask.offsetWidth > 0 || mask.offsetHeight > 0) {
                        var style = root.getComputedStyle(mask);
                        if (style.visibility !== 'hidden' && style.display !== 'none') return false;
                    }
                }
            }
            return true;
        } catch (_) { return false; }
    }
    function install(root) {
        try {
            var extensions = root.__PosthogExtensions__, original = extensions && extensions.generateSurveys;
            if (typeof original !== 'function' || original.__lensSurveyEngine) return;
            var instances = new WeakMap();
            function debug(instance, error) {
                try { if (instance.config && instance.config.debug === true && root.console) root.console.debug('Lens survey engine', error); } catch (_) {}
            }
            function attach(instance) {
                try {
                    if (!instance || instances.has(instance) || typeof instance.on !== 'function' || typeof instance.getSurveys !== 'function') return;
                    var machine = createMachine();
                    instances.set(instance, machine);
                    var getSurveys = instance.getSurveys;
                    // Observe core/renderer survey loads too, preserving arguments, this and return values.
                    instance.getSurveys = function (callback) {
                        try {
                            var args = Array.prototype.slice.call(arguments);
                            args[0] = function (surveys) {
                                try { machine.setSurveys(surveys); } catch (error) { debug(instance, error); }
                                try { if (typeof callback === 'function') return callback.apply(this, arguments); } catch (error) { debug(instance, error); }
                            };
                            return getSurveys.apply(this, args);
                        } catch (error) { debug(instance, error); }
                    };
                    function refresh() {
                        try { instance.getSurveys(function () {}); } catch (error) { debug(instance, error); }
                        try { root.setTimeout(refresh, 60000); } catch (error) { debug(instance, error); }
                    }
                    function wait(completion) {
                        var started = Date.now();
                        function poll() {
                            try {
                                if (!machine.pending(completion.id, completion.token)) return;
                                var elapsed = Date.now() - started;
                                if (elapsed > completion.ready.maxWaitMs) { machine.finish(completion.id, completion.token); return; }
                                if (isReady(root, completion.ready)) {
                                    // Finish before capture: it can synchronously invoke eventCaptured again.
                                    if (machine.finish(completion.id, completion.token)) instance.capture('lens_chain:' + completion.id, { $lens_chain_id: completion.id });
                                } else if (elapsed >= completion.ready.maxWaitMs) machine.finish(completion.id, completion.token);
                                else root.setTimeout(poll, 100);
                            } catch (error) { machine.finish(completion.id, completion.token); debug(instance, error); }
                        }
                        // Let the event's other listeners (including ExtJS) finish before checking the DOM.
                        try { root.setTimeout(poll, 0); } catch (error) { machine.finish(completion.id, completion.token); debug(instance, error); }
                    }
                    instance.on('eventCaptured', function (event) {
                        var who;
                        try { who = instance.get_distinct_id(); } catch (_) { who = undefined; }
                        try { machine.consume(event, Date.now(), who).forEach(wait); } catch (error) { debug(instance, error); }
                    });
                    refresh();
                } catch (error) { debug(instance, error); }
            }
            var wrapped = function (instance) {
                try { attach(instance); } catch (_) {}
                try { return original.apply(this, arguments); } catch (error) { debug(instance, error); }
            };
            wrapped.__lensSurveyEngine = true;
            extensions.generateSurveys = wrapped;
        } catch (_) { /* Preserve the original renderer if the hook is unavailable. */ }
    }
    return { normalizeChain: normalizeChain, createMachine: createMachine, isReady: isReady, install: install };
}));
