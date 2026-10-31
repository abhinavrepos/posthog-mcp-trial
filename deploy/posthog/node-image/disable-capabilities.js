// Appended to PostHog's nodejs/dist/capabilities.js by this image's Dockerfile.
//
// PLUGINS_DISABLED_CAPABILITIES=cdpCyclotronWorker,errorTrackingIngestion turns those jobs off in
// this process, so another container can do them alone. Used for the main "plugins" container:
// its webhook worker shared one event loop with every other plugin consumer, and under load it
// sent webhooks one at a time (about 0.25 s each) until Kafka dropped it from the group.
;(() => {
    const disabled = (process.env.PLUGINS_DISABLED_CAPABILITIES || '').split(',').map((s) => s.trim()).filter(Boolean)
    if (!disabled.length) return
    const original = exports.getPluginServerCapabilities
    exports.getPluginServerCapabilities = function (config) {
        const caps = { ...original(config) }
        for (const name of disabled) {
            if (!(name in caps)) console.warn(`PLUGINS_DISABLED_CAPABILITIES: "${name}" is not a capability of this mode`)
            delete caps[name]
        }
        console.info(`Capabilities turned off by PLUGINS_DISABLED_CAPABILITIES: ${disabled.join(', ')}`)
        return caps
    }
})()
