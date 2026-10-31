// Replaces the rasterizer's logger in the bundle. Same API, but it writes to stderr: the MCP stdio
// server owns stdout, and a log line there would corrupt the protocol stream.
import pino from 'pino'

export type Logger = pino.Logger

const rootLogger = pino(
    {
        level: process.env.LOG_LEVEL || 'warn',
        formatters: { level: (label) => ({ level: label }) },
        base: { source: 'rasterizer' },
        timestamp: pino.stdTimeFunctions.isoTime,
    },
    pino.destination(2)
)

export function createLogger(bindings: Record<string, unknown> = {}): Logger {
    return Object.keys(bindings).length ? rootLogger.child(bindings) : rootLogger
}
