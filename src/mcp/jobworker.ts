import { parentPort } from 'node:worker_threads'
// Keep worker logs off stdio's protocol stream.
console.log = console.error
let bootstrapped = false
let messages = Promise.resolve()
parentPort!.on('message', workerData => { messages = messages.then(() => handle(workerData)) })
async function handle(workerData: any) {
try {
    if (workerData.type === 'stored') {
        const { stored } = await import('../core/ingestmessages.ts')
        stored(workerData)
        return
    }
    if (!bootstrapped) {
        if (process.env.LENS_JOB_BOOTSTRAP) await (await import(process.env.LENS_JOB_BOOTSTRAP)).default()
        bootstrapped = true
    }
    const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js')
    const { registerTools } = await import('./tools.ts')
    const { makeAi } = await import('../core/ai.ts')
    const { refreshRoster } = await import('../core/anonroster.ts')
    const { storedClients } = await import('../core/clientroster.ts')
    // The service refreshes the durable roster. A per-job worker reloads it locally; starting
    // another whole-project roster refresh here would turn a history lookup into a live scan.
    await refreshRoster(0, { knownClients: async () => storedClients() }).catch(() => {})
    const server = new McpServer({ name: 'lens-analysis-worker', version: '1' })
    registerTools(server, makeAi(), workerData.caller, true)
    const registry = server as unknown as { _registeredTools: Record<string, { handler: (args: unknown, extra: unknown) => Promise<unknown> }> }
    const { toolContext } = await import('../core/toolcontext.ts')
    const window = workerData.window ? { ...workerData.window, from: new Date(workerData.window.from), to: new Date(workerData.window.to) } : undefined
    const clients = new Set<string>()
    const result = await toolContext.run({ window, clients, correlationId: workerData.correlationId }, () => registry._registeredTools[workerData.name].handler(workerData.args, { signal: new AbortController().signal, sendNotification: async () => {}, requestId: 0 }))
    const { isPublicToolError } = await import('./publicerror.ts')
    await server.close()
    parentPort!.postMessage({ result, clients: [...clients], publicError: isPublicToolError(result) })
} catch (e) { parentPort!.postMessage({ error: String((e as Error).message) }) }
}
