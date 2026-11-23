/* Lens survey chains. Readable ES2017; reads posthog-js's survey flags and keeps one key of its own
   (lensSurveyQuiet: surveys the user closed or ignored, and until when to stay quiet; and posthog-js's own seenSurvey_ mark for a survey ignored too often); no DOM observers or external requests. */
(function (factory) {
    try {
        if (typeof module === 'object' && module.exports) module.exports = factory(require('./bootstrap.js'));
        else if (typeof window !== 'undefined') factory().install(window);
    } catch (_) { /* A failed extension must never prevent surveys. */ }
}(function (installCapture) {
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
            var last = steps[steps.length - 1];
            var dialogOpen = last.event === 'PageView' && last.filters.some(function (filter) {
                return filter.key === 'action' && filter.operator === 'exact' && filter.values.length === 1 && filter.values[0] === 'OPEN';
            }) && last.filters.some(function (filter) { return filter.key === 'dialog_id' && filter.operator === 'exact'; });
            return { id: raw.id, steps: steps, resetOn: resets, withinMs: within === undefined ? Infinity : within * 1000, audience: audience, limit: limit,
                gapMs: gap * 3600000, quietMs: quiet * 86400000, maxShows: shows, dialogOpen: dialogOpen,
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
        var states = new Map(), sequence = 0, identity;
        function reset(state) { state.index = 0; state.started = 0; state.pending = 0; }
        function identify(distinctId) {
            if (identity !== distinctId) { states.forEach(reset); identity = distinctId; }
        }
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
            identify: identify,
            reset: function () { states.forEach(reset); },
            setSurveys: function (surveys) {
                try {
                    if (!Array.isArray(surveys)) return;
                    var next = new Map();
                    for (var survey of surveys) {
                        try {
                            if (!object(survey) || survey.archived || !survey.start_date || survey.end_date !== null) continue;
                            var raw = survey.conditions && survey.conditions.lensChain;
                            var chain = normalizeChain(raw);
                            if (!chain || next.has(chain.id)) continue; // One event for a shared id; first valid definition wins.
                            var signature = JSON.stringify(raw), old = states.get(chain.id);
                            var surveyId = typeof survey.id === 'string' ? survey.id : '';
                            var state = old && old.signature === signature && old.surveyId === surveyId ? old :
                                { chain: chain, signature: signature, index: 0, started: 0, pending: 0 };
                            // The survey launched first wins a user both want (one survey at a time).
                            state.surveyId = surveyId;
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
                    identify(distinctId);
                    if (!object(event) || typeof event.event !== 'string' || !finite(now) ||
                        event.event[0] === '$' || event.event.indexOf('lens_chain:') === 0) return completed;
                    states.forEach(function (state, id) {
                        try {
                            var chain = state.chain, clientProperty = chain.audience && chain.audience.eventProperty;
                            var allowed = inAudience(chain.audience, event, distinctId, id);
                            if (!allowed && (!clientProperty || (object(event.properties) &&
                                Object.prototype.hasOwnProperty.call(event.properties, clientProperty)))) reset(state);
                            if (state.pending) return;
                            // resetOn only resets a sequence that is still in progress.
                            if (chain.resetOn.some(function (step) { return matches(step, event); })) { reset(state); return; }
                            if (!allowed) return;
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
    function hidden(root, element) {
        var style = root.getComputedStyle(element), classes = element.classList;
        return style.display === 'none' || style.visibility !== 'visible' || Number(style.opacity) <= 0 ||
            style.contentVisibility === 'hidden' ||
            (classes && (classes.contains('x-hidden-display') || classes.contains('x-hidden-offsets')));
    }
    function visibleMask(root, mask) {
        var rect = mask.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0 || rect.right <= 0 || rect.bottom <= 0 ||
            rect.left >= root.innerWidth || rect.top >= root.innerHeight) return false;
        for (var element = mask; element; element = element.parentElement) if (hidden(root, element)) return false;
        return true;
    }
    function readiness(root, options) {
        try {
            var doc = root.document;
            if (!doc) return 'document unavailable';
            if (options.noVisibleMask) {
                var masks = doc.querySelectorAll('.x-mask, .x-mask-msg');
                for (var i = 0; i < masks.length; i++) if (visibleMask(root, masks[i])) return 'visible loading mask';
            }
            return options.documentComplete && doc.readyState !== 'complete' ? 'document to finish loading' : '';
        } catch (_) { return 'page readiness check failed'; }
    }
    function isReady(root, options) { return !readiness(root, options); }
    function install(root) {
        try {
            var extensions = root.__PosthogExtensions__, original = extensions && extensions.generateSurveys;
            if (typeof original !== 'function' || original.__lensSurveyEngine) return;
            var instances = new WeakMap(), captureStream = installCapture ? installCapture(root) : root.__lensSurveyCapture;
            // The 1.443 renderer factory can construct its manager without starting its first poll.
            var canDeferDisplay = Function.prototype.toString.call(original).indexOf('.startAutomaticDisplay(') !== -1;
            // posthog-js writes seenSurvey_<id> when a user answers or dismisses a survey. Read only.
            function seen(surveyId) {
                try { return !!surveyId && !!root.localStorage && root.localStorage.getItem('seenSurvey_' + surveyId) !== null; } catch (_) { return false; }
            }
            var QUIET_KEY = 'lensSurveyQuiet', firedAt = 0, reserved;
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
                if (!instance || typeof instance.getSurveys !== 'function') return;
                if (instances.has(instance)) return instances.get(instance);
                var stream = captureStream && captureStream(instance);
                if (!stream) return;
                var machine = createMachine(), pending = new Map(), snapshot, cancelNative;
                function report(item, reason) {
                    if (reason === item.reason) return;
                    item.reason = reason;
                    debug(instance, item.id + ': ' + reason);
                }
                function finish(item, reason) {
                    machine.finish(item.id, item.token);
                    if (reserved === item) reserved = null;
                    if (item.timer !== undefined && root.clearTimeout) root.clearTimeout(item.timer);
                    if (pending.get(item.id) === item) {
                        pending.delete(item.id);
                        try { if (reason && item.armed && cancelNative) cancelNative(item.surveyId); }
                        catch (error) { debug(instance, error); }
                    }
                    if (reason) report(item, reason);
                }
                function clearInvalid(reason) {
                    pending.forEach(function (item) {
                        if (!machine.pending(item.id, item.token)) finish(item, reason);
                    });
                }
                function resetIdentity(reason) {
                    machine.reset();
                    clearInvalid(reason);
                }
                // In 1.443 the renderer and receiver both read the internal method, which the
                // public getSurveys also delegates to.
                var source = instance.surveys && typeof instance.surveys.getSurveys === 'function' ? instance.surveys : instance;
                var getSurveys = source.getSurveys;
                source.getSurveys = function (callback) {
                    if (typeof callback !== 'function') return getSurveys.apply(this, arguments);
                    var args = Array.prototype.slice.call(arguments);
                    args[0] = function (surveys, context) {
                        try {
                            if (Array.isArray(surveys) && (!context || context.isLoaded !== false) && surveys !== snapshot) {
                                snapshot = surveys;
                                machine.setSurveys(surveys);
                                clearInvalid('survey definition changed');
                                stream.listen(receive, resetIdentity);
                            }
                        } catch (error) { debug(instance, error); }
                        return callback.apply(this, arguments);
                    };
                    return getSurveys.apply(this, args);
                };
                function registered(name, surveyId) {
                    if (!instance.surveys) return true; // Older integrations with only the public method.
                    var receiver = instance.surveys._surveyEventReceiver;
                    var map = receiver && typeof receiver.getEventToSurveys === 'function' && receiver.getEventToSurveys();
                    var ids = map && map.get(name);
                    return Array.isArray(ids) && ids.indexOf(surveyId) !== -1;
                }
                function quiet(item, info, now) {
                    if (reserved && reserved !== item) return 'another survey is waiting to display';
                    return quietReason(info.chain, info.surveyId, now, store(), seen(info.surveyId), info.repeats);
                }
                function audienceAllowed(item, info) {
                    var who = stream.current(), audience = info.chain.audience;
                    if (!who || item.who !== who || !inAudience(audience, item.audienceEvent, who, item.id)) return false;
                    var property = audience && audience.eventProperty;
                    if (property && typeof instance.get_property === 'function') {
                        var value;
                        try { value = instance.get_property(property); } catch (_) { return false; }
                        if (value !== undefined) {
                            var properties = Object.create(null);
                            properties[property] = value;
                            return inAudience(audience, { properties: properties }, who, item.id);
                        }
                    }
                    return true;
                }
                function readyReason(item, now) {
                    return readiness(root, {
                        documentComplete: item.ready.documentComplete && !(item.allowAfterTimeout && now >= item.readyBy),
                        noVisibleMask: true
                    });
                }
                function wait(item, time, who, event) {
                    var info = machine.info(item.id), name = 'lens_chain:' + item.id;
                    var maxWait = item.ready.maxWaitMs;
                    // Existing Reval definitions carry the Lens default of 30 seconds.
                    item.allowAfterTimeout = info.chain.dialogOpen && maxWait === 30000;
                    if (item.allowAfterTimeout) maxWait = 180000;
                    item.readyBy = time + maxWait;
                    item.surveyId = info.surveyId;
                    item.who = who;
                    var property = info.chain.audience && info.chain.audience.eventProperty;
                    var evidence = Object.create(null);
                    if (property) evidence[property] = text(event.properties[property]);
                    item.audienceEvent = { properties: evidence };
                    pending.set(item.id, item);
                    function poll() {
                        try {
                            if (!machine.pending(item.id, item.token)) return;
                            if (!audienceAllowed(item, info)) {
                                if (machine.pending(item.id, item.token)) finish(item, 'user or audience changed');
                                return;
                            }
                            var now = Date.now(), blocked = readyReason(item, now);
                            if (!blocked && !registered(name, info.surveyId)) blocked = 'PostHog activation registration';
                            if ((blocked && now >= item.readyBy) || (!item.allowAfterTimeout && maxWait > 0 && now > item.readyBy)) {
                                return finish(item, 'timed out waiting for ' + (blocked || item.reason || 'readiness'));
                            }
                            if (blocked) {
                                report(item, 'waiting for ' + blocked);
                                item.timer = root.setTimeout(poll, 100);
                                return;
                            }
                            var why = quiet(item, info, now);
                            if (why) return finish(item, 'survey held back: ' + why);
                            // Keep the match until native display. The renderer can poll again after
                            // the readiness deadline and still needs time for any native popup delay.
                            item.armed = true;
                            reserved = item;
                            var survey = snapshot.find(function (survey) { return survey && survey.id === info.surveyId; });
                            var delay = survey && survey.appearance && survey.appearance.surveyPopupDelaySeconds;
                            item.displayBy = Math.max(item.readyBy, now + (finite(delay) && delay > 0 ? delay * 1000 : 0) + 2000);
                            item.timer = root.setTimeout(function () {
                                finish(item, 'timed out waiting for ' + (readyReason(item, Date.now()) || 'PostHog display'));
                            }, Math.min(2147483647, item.displayBy - now));
                            instance.capture(name, { $lens_chain_id: item.id });
                        } catch (error) { finish(item); debug(instance, error); }
                    }
                    // Let ExtJS and the SDK finish the current capture and update the mask/receiver.
                    item.timer = root.setTimeout(poll, 0);
                }
                function finished(surveyId) {
                    if (seen(surveyId)) return true;
                    var st = store(), hit = machine.bySurvey(surveyId);
                    return st.closed.indexOf(surveyId) !== -1 || (!!hit && (st.shown[surveyId] || 0) >= hit.chain.maxShows);
                }
                function receive(event, now, who) {
                    machine.identify(who);
                    if (event && object(event.properties) && /^survey (shown|sent|dismissed)$/.test(event.event)) {
                        var hit = machine.bySurvey(event.properties.$survey_id);
                        if (hit && event.event === 'survey shown') {
                            var item = pending.get(hit.chain.id);
                            if (item && item.armed) { firedAt = now; finish(item); }
                            counted(hit.surveyId, 1);
                            try { if ((store().shown[hit.surveyId] || 0) >= hit.chain.maxShows) root.localStorage.setItem('seenSurvey_' + hit.surveyId, 'true'); } catch (_) {}
                        }
                        if (hit && event.event === 'survey sent') counted(hit.surveyId, 0);
                        if (hit && event.event === 'survey dismissed') { counted(hit.surveyId, 0); closed(hit.surveyId, hit.chain.quietMs, now); }
                    }
                    var completed = machine.consume(event, now, who, finished);
                    clearInvalid('audience client changed');
                    completed.forEach(function (item) { wait(item, now, who, event); });
                }
                function displayBlock(survey, raw) {
                    var info = machine.info(raw.id), item = pending.get(raw.id), now = Date.now();
                    if (!info || info.surveyId !== survey.id || !item || !item.armed ||
                        !machine.pending(item.id, item.token) || now > item.displayBy) return 'Lens activation expired or absent';
                    if (!audienceAllowed(item, info)) {
                        if (machine.pending(item.id, item.token)) finish(item, 'user or audience changed');
                        return 'Lens user or audience changed';
                    }
                    var blocked = readyReason(item, now);
                    if (blocked) { report(item, 'waiting for ' + blocked); return blocked; }
                    var why = quiet(item, info, now);
                    if (why) finish(item, 'survey held back: ' + why);
                    return why;
                }
                function guard(renderer) {
                    if (typeof renderer.cancelSurvey === 'function') cancelNative = renderer.cancelSurvey.bind(renderer);
                    var popover = renderer.handlePopoverSurvey;
                    if (typeof popover === 'function') renderer.handlePopoverSurvey = function (survey, options, automatic) {
                        var raw = survey && survey.conditions && survey.conditions.lensChain;
                        if (raw && displayBlock(survey, raw)) return;
                        // Start a new popup delay if PostHog still has a timestamp for a previous match.
                        if (raw && automatic && automatic.resumeDelayFromActivation) {
                            return popover.call(this, survey, options, Object.assign({}, automatic, { resumeDelayFromActivation: false }));
                        }
                        return popover.apply(this, arguments);
                    };
                    var eligibility = renderer.checkSurveyEligibility;
                    renderer.checkSurveyEligibility = function (survey) {
                        var raw = survey && survey.conditions && survey.conditions.lensChain;
                        var blocked = raw && displayBlock(survey, raw);
                        if (blocked) return { eligible: false, reason: blocked };
                        var result = eligibility.apply(this, arguments), item = raw && pending.get(raw.id);
                        if (item && !result.eligible) report(item, result.reason || 'waiting for PostHog eligibility');
                        return result;
                    };
                }
                instances.set(instance, guard);
                return guard;
            }
            var wrapped = function (instance, enabled) {
                var guard;
                try { guard = attach(instance); } catch (error) { debug(instance, error); }
                if (!guard) return original.apply(this, arguments);
                // Install the guard before the renderer's first synchronous eligibility check.
                var renderer = canDeferDisplay ? original.call(this, instance, false) : original.apply(this, arguments);
                if (renderer && typeof renderer.checkSurveyEligibility === 'function') guard(renderer);
                if (canDeferDisplay && enabled !== false && renderer && typeof renderer.startAutomaticDisplay === 'function') renderer.startAutomaticDisplay();
                else if (!renderer) instance.getSurveys(function () {});
                return renderer;
            };
            wrapped.__lensSurveyEngine = true;
            extensions.generateSurveys = wrapped;
        } catch (_) { /* Preserve the original renderer if the hook is unavailable. */ }
    }
    return { normalizeChain: normalizeChain, createMachine: createMachine, isReady: isReady, quietReason: quietReason, install: install };
}));
