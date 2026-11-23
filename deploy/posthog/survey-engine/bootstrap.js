/* Included in the hosted SDK and the lazy renderer. Keep only an in-memory startup history. */
(function () {
    'use strict';
    // Reval can capture a ribbon action before setting Ext.loggedOut. Check the event
    // name and exact values in these action/label fields, without scanning other properties.
    var logoutFields = ['action', 'action_name', 'label', '$event_type', 'event_type'];
    function isLogout(event) {
        if (!event) return false;
        if (typeof event.event === 'string' && /logout/i.test(event.event)) return true;
        var props = event.properties;
        return props && logoutFields.some(function (field) {
            var value = props[field];
            return typeof value === 'string' && value.toLowerCase() === 'logout';
        });
    }
    function install(root) {
        if (typeof root.__lensSurveyCapture === 'function') return root.__lensSurveyCapture;
        var instances = new WeakMap(), maxAge = 300000;
        root.__lensSurveyCapture = function (instance) {
            try {
                var state = instances.get(instance);
                if (state) return state;
                var history = [], identity, receive, invalidate, resetting = false, generation = 0;
                var extLoggedOut = false, awaitingIdentify = false;
                function discard(reason) {
                    history = [];
                    generation++;
                    try { if (invalidate) invalidate(reason); } catch (_) {}
                }
                function logout(reason) {
                    // The SDK can still report the old ID as identified during logout.
                    awaitingIdentify = true;
                    discard(reason);
                }
                function current(identifiedId) {
                    var loggedOut = !!(root.Ext && root.Ext.loggedOut === true), wasLoggedOut = extLoggedOut;
                    extLoggedOut = loggedOut;
                    if (loggedOut && !wasLoggedOut) logout('Ext.loggedOut');
                    var who;
                    try {
                        var id = !resetting && instance.get_distinct_id();
                        if (typeof id === 'string' && id && id !== '$posthog_cookieless' &&
                            (typeof instance._isIdentified === 'function' ? instance._isIdentified() :
                                typeof instance.get_property === 'function' && instance.get_property('$user_state') === 'identified')) who = id;
                    } catch (_) {}
                    if (identity !== who) {
                        identity = who;
                        discard(who ? 'identity changed' : 'user is anonymous');
                    }
                    if (who && who === identifiedId) awaitingIdentify = false;
                    return loggedOut || awaitingIdentify ? undefined : who;
                }
                state = {
                    current: current,
                    listen: function (listener, onInvalidate) {
                        if (receive) return;
                        var who = current(), now = Date.now(), pending = history, replayGeneration = generation;
                        history = [];
                        receive = listener;
                        invalidate = onInvalidate;
                        pending.forEach(function (item) {
                            if (item.who === who && current() === who && generation === replayGeneration && now - item.time <= maxAge) {
                                receive(item.event, item.time, item.who);
                            }
                        });
                    }
                };
                instance.on('eventCaptured', function (event) {
                    try {
                        var who = current(), now = Date.now();
                        if (isLogout(event)) return logout('logout event');
                        if (!who) return;
                        if (receive) return receive(event, now, who);
                        if (!event || typeof event.event !== 'string' || event.event[0] === '$' ||
                            event.event.indexOf('lens_chain:') === 0) return;
                        while (history.length && now - history[0].time > maxAge) history.shift();
                        if (history.length === 256) history.shift();
                        history.push({ event: event, time: now, who: who });
                    } catch (_) { /* The capture listener must never interrupt PostHog. */ }
                });
                instances.set(instance, state);
                // identify() can change an already-identified ID without emitting $identify.
                var identify = instance.identify;
                if (typeof identify === 'function') instance.identify = function () {
                    if (this !== instance) return identify.apply(this, arguments);
                    current();
                    var identifiedId;
                    try {
                        var result = identify.apply(this, arguments);
                        identifiedId = typeof arguments[0] === 'number' ? String(arguments[0]) : arguments[0];
                        return result;
                    } finally { current(identifiedId); }
                };
                // reset() can restore the very same ID with SDK bootstrap options.
                var reset = instance.reset;
                if (typeof reset === 'function') instance.reset = function () {
                    if (this !== instance || resetting) return reset.apply(this, arguments);
                    resetting = true;
                    identity = undefined;
                    discard('PostHog reset');
                    try { return reset.apply(this, arguments); } finally { resetting = false; current(); }
                };
                return state;
            } catch (_) { /* The SDK can still initialize without Lens. */ }
        };
        return root.__lensSurveyCapture;
    }
    try {
        if (typeof module === 'object' && module && module.exports) module.exports = install;
        else if (typeof window !== 'undefined') install(window);
    } catch (_) { /* Leave the SDK running even when Lens cannot install. */ }
}());
