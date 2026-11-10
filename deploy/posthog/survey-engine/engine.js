/* Lens survey chains. Readable ES2017; reads posthog-js's survey flags and keeps one key of its own
   (lensSurveyQuiet: surveys the user closed or ignored, and until when to stay quiet; and posthog-js's own seenSurvey_ mark for a survey ignored too often); no DOM observers or external requests. */
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
    // Versions: 2 may carry an audience, 3 also a sample and a surveys-per-user limit. An engine that does
    // not know a version refuses the chain, so it never shows a limited survey to everyone.
    // Audience: { clients: ["ACME"], distinctIdPart: 3, separator: "|" } reads the client from the user id
    // (Reval: ENV|SITE|CLIENT|USER); { clients, eventProperty: "client_id" } from each event. Compared
    // without case. { sample: 33 }: a fixed 33% of users, picked from the user id. Absent: everyone.
    // Invalid: the chain is refused (false).
    function audienceOf(raw, version) {
        if (raw === undefined || raw === null) return null;
        if (!object(raw)) return false;
        var out = {};
        if (raw.sample !== undefined) {
            if (version < 3 || !finite(raw.sample) || raw.sample < 1 || raw.sample > 100) return false;
            out.sample = raw.sample;
        }
        if (raw.clients === undefined) return out.sample ? out : false;
        if (!Array.isArray(raw.clients) || !raw.clients.length || raw.clients.length > 500) return false;
        out.clients = [];
        for (var c of raw.clients) { var t = text(c); if (t === null || !t.length) return false; out.clients.push(t.toLowerCase()); }
        if (raw.eventProperty !== undefined) {
            if (typeof raw.eventProperty !== 'string' || !raw.eventProperty.length || raw.eventProperty.length > 200) return false;
            out.eventProperty = raw.eventProperty;
            return out;
        }
        var part = raw.distinctIdPart, sep = raw.separator === undefined ? '|' : raw.separator;
        if (!finite(part) || part < 1 || part > 20 || Math.floor(part) !== part || typeof sep !== 'string' || sep.length !== 1) return false;
        out.part = part; out.separator = sep;
        return out;
    }
    // FNV-1a: the same user always lands in the same bucket (0-99) for a chain.
    function bucket(value) {
        var h = 0x811c9dc5;
        for (var i = 0; i < value.length; i++) { h ^= value.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
        return h % 100;
    }
    function inAudience(audience, event, distinctId, chainId) {
        if (!audience) return true;
        if (audience.clients) {
            var value;
            if (audience.eventProperty) value = object(event.properties) ? text(event.properties[audience.eventProperty]) : null;
            else value = typeof distinctId === 'string' ? (distinctId.split(audience.separator)[audience.part - 1] || null) : null;
            if (value === null || audience.clients.indexOf(String(value).toLowerCase()) === -1) return false;
        }
        if (audience.sample !== undefined && audience.sample < 100) {
            if (typeof distinctId !== 'string' || !distinctId.length) return false;
            if (bucket(distinctId + '|' + chainId) >= audience.sample) return false;
        }
        return true;
    }
    function normalizeChain(raw) {
        try {
            if (!object(raw) || [1, 2, 3].indexOf(raw.version) === -1 || typeof raw.id !== 'string' || !/^[a-z0-9-]{1,40}$/.test(raw.id) ||
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
            var audience = audienceOf(raw.audience, raw.version);
            if (audience === false) return null;
            if (raw.oneAtATime !== undefined && (raw.version < 3 || typeof raw.oneAtATime !== 'boolean')) return null;
            // maxPerUser: a user takes part in at most this many running surveys at once (oneAtATime = 1).
            var max = raw.maxPerUser;
            if (max !== undefined && (raw.version < 3 || !finite(max) || max < 1 || max > 10 || Math.floor(max) !== max)) return null;
            var limit = max !== undefined ? max : raw.oneAtATime === true ? 1 : 0;
            // Spacing: never two surveys within gapHours (at least 24) for a user; after the user closes a
            // Lens survey with the cross, no Lens survey for quietDaysAfterClose days (default 7).
            var gap = raw.gapHours === undefined ? 24 : raw.gapHours;
            if (!finite(gap) || gap < 24 || gap > 8760) return null;
            var quiet = raw.quietDaysAfterClose === undefined ? 7 : raw.quietDaysAfterClose;
            if (!finite(quiet) || quiet < 0 || quiet > 90) return null;
            // A survey shown this many times without an answer or a close stops coming back (default 2).
            var shows = raw.maxShowsIgnored === undefined ? 2 : raw.maxShowsIgnored;
            if (!finite(shows) || shows < 1 || shows > 10 || Math.floor(shows) !== shows) return null;
            return { id: raw.id, steps: steps, resetOn: resets, withinMs: within === undefined ? Infinity : within * 1000, audience: audience, limit: limit,
                gapMs: gap * 3600000, quietMs: quiet * 86400000, maxShows: shows,
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
        function earlier(a, b) { return a.launched < b.launched || (a.launched === b.launched && a.surveyId < b.surveyId); }
        // Is this user already in as many earlier limited surveys (not finished yet) as this one allows?
        // Then they wait: the next time they do the steps after finishing one, they get this survey.
        function full(state, event, distinctId, seen) {
            var holding = 0;
            states.forEach(function (other, id) {
                if (holding >= state.chain.limit || other === state || !other.chain.limit || !earlier(other, state)) return;
                if (!inAudience(other.chain.audience, event, distinctId, id)) return;
                var done = false;
                try { done = typeof seen === 'function' && !!seen(other.surveyId); } catch (_) { done = false; }
                if (!done) holding++;
            });
            return holding >= state.chain.limit;
        }
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
                            var state = old && old.signature === signature ? old :
                                { chain: chain, signature: signature, index: 0, started: 0, pending: 0 };
                            // The survey launched first wins a user both want (one survey at a time).
                            state.surveyId = typeof survey.id === 'string' ? survey.id : '';
                            state.launched = Date.parse(survey.start_date) || 0;
                            state.repeats = survey.schedule === 'always';
                            next.set(chain.id, state);
                        } catch (_) { /* Ignore only this malformed survey. */ }
                    }
                    states = next;
                } catch (_) { /* Keep the last good snapshot. */ }
            },
            // seen(surveyId): the user has answered or dismissed that survey (posthog-js remembers it).
            consume: function (event, now, distinctId, seen) {
                var completed = [];
                try {
                    if (!object(event) || typeof event.event !== 'string' || !finite(now) ||
                        event.event[0] === '$' || event.event.indexOf('lens_chain:') === 0) return completed;
                    states.forEach(function (state, id) {
                        try {
                            var chain = state.chain;
                            if (chain.resetOn.some(function (step) { return matches(step, event); })) { reset(state); return; }
                            if (state.pending) return;
                            if (!inAudience(chain.audience, event, distinctId, id)) return;
                            if (state.index && now - state.started > chain.withinMs) reset(state);
                            if (!matches(chain.steps[state.index], event)) return;
                            if (!state.index) state.started = now;
                            state.index++;
                            if (state.index === chain.steps.length) {
                                if (chain.limit && full(state, event, distinctId, seen)) { reset(state); return; }
                                state.pending = ++sequence;
                                completed.push({ id: id, token: state.pending, ready: chain.ready });
                            }
                        } catch (_) { reset(state); }
                    });
                } catch (_) { /* Ignore malformed captured events. */ }
                return completed;
            },
            // The chain and survey behind a chain id, or behind a survey id (for "survey dismissed").
            info: function (id) {
                try { var state = states.get(id); return state ? { chain: state.chain, surveyId: state.surveyId, repeats: state.repeats } : null; } catch (_) { return null; }
            },
            bySurvey: function (surveyId) {
                var found = null;
                try { states.forEach(function (state) { if (!found && surveyId && state.surveyId === surveyId) found = { chain: state.chain, surveyId: state.surveyId, repeats: state.repeats }; }); } catch (_) {}
                return found;
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
    // Why a completed chain must not show its survey now, or '' when it may. store: lastSeen (ms, any
    // survey shown, from posthog-js), firedAt (ms, a Lens survey this page), quietUntil (ms), closed
    // (survey ids the user closed with the cross), shown ({survey id: times shown with no reaction}),
    // done (the user answered or closed it; a survey that does not repeat never shows again).
    function quietReason(chain, surveyId, now, store, done, repeats) {
        try {
            if (store.closed && store.closed.indexOf(surveyId) !== -1) return 'closed';
            if (done && !repeats) return 'already answered';
            if (store.shown && store.shown[surveyId] >= (chain.maxShows || 2)) return 'ignored';
            if (store.quietUntil && now < store.quietUntil) return 'quiet after a close';
            var gap = chain.gapMs || 86400000;
            if (store.lastSeen && now - store.lastSeen < gap) return 'another survey within the gap';
            if (store.firedAt && now - store.firedAt < gap) return 'another survey on this page';
            return '';
        } catch (_) { return 'error'; }
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
            // posthog-js writes seenSurvey_<id> when a user answers or dismisses a survey. Read only.
            function seen(surveyId) {
                try { return !!surveyId && !!root.localStorage && root.localStorage.getItem('seenSurvey_' + surveyId) !== null; } catch (_) { return false; }
            }
            var QUIET_KEY = 'lensSurveyQuiet', firedAt = 0;
            function store() {
                var out = { lastSeen: 0, firedAt: firedAt, quietUntil: 0, closed: [], shown: {} };
                try {
                    var t = Date.parse(root.localStorage.getItem('lastSeenSurveyDate') || '');
                    if (finite(t)) out.lastSeen = t;
                    var q = JSON.parse(root.localStorage.getItem(QUIET_KEY) || 'null');
                    if (object(q)) {
                        if (finite(q.until)) out.quietUntil = q.until;
                        if (Array.isArray(q.closed)) out.closed = q.closed.filter(function (x) { return typeof x === 'string'; }).slice(-100);
                        if (object(q.shown)) Object.keys(q.shown).slice(-100).forEach(function (k) { if (finite(q.shown[k])) out.shown[k] = q.shown[k]; });
                    }
                } catch (_) { /* No storage: only the in-page gap applies. */ }
                return out;
            }
            // The user closed a Lens survey with the cross: it never comes back, and Lens stays quiet a while.
            function closed(surveyId, quietMs, now) {
                try {
                    var s = store();
                    var list = s.closed.filter(function (x) { return x !== surveyId; }).concat([surveyId]).slice(-100);
                    root.localStorage.setItem(QUIET_KEY, JSON.stringify({ until: Math.max(s.quietUntil, now + quietMs), closed: list, shown: s.shown }));
                } catch (_) { /* Storage blocked: PostHog's own seen flag still stops this survey. */ }
            }
            // Count shows without a reaction; an answer or a close clears the count.
            function counted(surveyId, delta) {
                try {
                    var s = store();
                    if (delta) s.shown[surveyId] = (s.shown[surveyId] || 0) + 1; else delete s.shown[surveyId];
                    root.localStorage.setItem(QUIET_KEY, JSON.stringify({ until: s.quietUntil, closed: s.closed, shown: s.shown }));
                } catch (_) {}
            }
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
                                    if (!machine.finish(completion.id, completion.token)) return;
                                    var info = machine.info(completion.id), now = Date.now();
                                    var why = info ? quietReason(info.chain, info.surveyId, now, store(), seen(info.surveyId), info.repeats) : 'gone';
                                    if (why) { debug(instance, 'survey held back: ' + why); return; }
                                    firedAt = now;
                                    instance.capture('lens_chain:' + completion.id, { $lens_chain_id: completion.id });
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
                        try {
                            if (event && object(event.properties) && /^survey (shown|sent|dismissed)$/.test(event.event)) {
                                var hit = machine.bySurvey(event.properties.$survey_id);
                                if (hit && event.event === 'survey shown') {
                                    counted(hit.surveyId, 1);
                                    // Shown this often with no answer or close: mark it seen the way posthog-js does
                                    // after an answer, so PostHog does not bring it back either.
                                    try { if ((store().shown[hit.surveyId] || 0) >= hit.chain.maxShows) root.localStorage.setItem('seenSurvey_' + hit.surveyId, 'true'); } catch (_) {}
                                }
                                if (hit && event.event === 'survey sent') counted(hit.surveyId, 0);
                                if (hit && event.event === 'survey dismissed') { counted(hit.surveyId, 0); closed(hit.surveyId, hit.chain.quietMs, Date.now()); }
                            }
                        } catch (error) { debug(instance, error); }
                        // Finished, for the per-user limit: answered, closed, or shown too often with no reaction.
                        var finished = function (surveyId) {
                            if (seen(surveyId)) return true;
                            var st = store(), hit = machine.bySurvey(surveyId);
                            return st.closed.indexOf(surveyId) !== -1 || (!!hit && (st.shown[surveyId] || 0) >= hit.chain.maxShows);
                        };
                        try { machine.consume(event, Date.now(), who, finished).forEach(wait); } catch (error) { debug(instance, error); }
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
    return { normalizeChain: normalizeChain, createMachine: createMachine, isReady: isReady, quietReason: quietReason, install: install };
}));
