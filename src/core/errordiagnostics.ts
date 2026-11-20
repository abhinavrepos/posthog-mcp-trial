import { randomUUID } from 'node:crypto'
import { openSync, writeSync, closeSync, fchmodSync, constants } from 'node:fs'

const cleanMessage = (error: unknown): string => {
    try {
        // An MCP tool error ({content:[{text}], isError}) carries its reason in the text blocks.
        const blocks = error && typeof error === 'object' && Array.isArray((error as { content?: unknown }).content)
            ? (error as { content: { text?: unknown }[] }).content.map(c => typeof c?.text === 'string' ? c.text : '').join(' ') : ''
        let text = error instanceof Error ? error.message : typeof error === 'string' ? error : blocks
        text = text.split(/\n|HogQL:|\bSELECT\b|\bINSERT\b|\bFROM\s+\w/i)[0]            // no query text
        text = text.replace(/(?:file:\/\/)?(?:\/[\w.@-]+){2,}(?::\d+(?::\d+)?)?/g, '[path]') // no file paths
        text = text.replace(/\b(?:(?:phx|phc)_|sk-)[\w-]+|\b(Bearer|Basic)\s+\S+/gi, '[redacted]')
        return text.slice(0, 200) || 'Operation failed.'
    } catch { return 'Operation failed.' }
}
/** Diagnostics accessible to the launching agent contain server-authored text only. */
export function errorDiagnostic(error: unknown, tool: string, kind = 'internal', correlation_id: string = randomUUID(), status?: number) {
    // copy an upstream message, SQL, identity, amount, stack or file path onto stdio.
    // Operators still need to know what failed: the error's type and a cleaned message (query text and paths cut,
    console.error('Lens error', {correlation_id, tool: /^[\w:-]{1,80}$/.test(tool) ? tool : 'unknown', error_kind: kind, http_status: status ?? null,
        error_type: error instanceof Error && /^[A-Za-z]{1,40}$/.test(error.name) ? error.name : typeof error, message: cleanMessage(error)})
    const file = process.env.LENS_DEBUG_ERRORS_FILE
    if (!file) return
    const redact = (text: string) => {
        for(const [key,value] of Object.entries(process.env)) {
            if(/(?:KEY|TOKEN|PASSWORD|SECRET|CREDENTIAL|AUTHORIZATION)/i.test(key) && value && value.length >= 4) text=text.replaceAll(value,'[redacted]')
        }
        return text
        .replace(/\b(Bearer|Basic)\s+[^\s"',;]+/gi, '$1 [redacted]')
        .replace(/((?:api[_-]?key|token|password|secret|authorization)["']?\s*[:=]\s*)[^\s,;}]+/gi, '$1[redacted]')
        .replace(/\b(?:(?:phx|phc)_|sk-)[\w-]+/g,'[redacted]')
        .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi,'$1[redacted]@')
    }
    let fd: number | undefined
    try {
        fd = openSync(file, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600)
        fchmodSync(fd,0o600)
        writeSync(fd, JSON.stringify({correlation_id, tool, kind, status, detail: redact(error instanceof Error ? error.stack || error.message : typeof error === 'string' ? error : JSON.stringify(error))})+'\n')
    } catch { /* A broken administrator sink must never fall back to raw stderr. */ }
    finally { if(fd !== undefined) closeSync(fd) }
}
