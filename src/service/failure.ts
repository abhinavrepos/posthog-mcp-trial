/** Safe last-resort response when a page handler or its storage fails before writing headers. */
export function publicRequestFailure(path: string | undefined, error: unknown): { status: number; body: string | { error: string } } {
    const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined
    const storage = typeof code === 'string' && /^SQLITE_(?:BUSY|LOCKED|FULL|READONLY|CORRUPT|NOTADB|IOERR)(?:_|$)/.test(code)
    const page = !!path && /^\/replays(?:\/(?:live|surveys|pinned|admin|connect|system))?\/?$/.test(path)
    const message = storage ? 'Lens storage is unavailable. Reload shortly; if it persists, contact a Lens administrator.'
        : 'This page is temporarily unavailable. Reload shortly; if it persists, contact a Lens administrator.'
    return { status: storage ? 503 : 500, body: page ? message : { error: storage ? message : 'The request could not complete. Try again shortly.' } }
}
