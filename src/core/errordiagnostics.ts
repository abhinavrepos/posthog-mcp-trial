import { randomUUID } from 'node:crypto'
import { openSync, writeSync, closeSync, fchmodSync, constants } from 'node:fs'

/** Diagnostics accessible to the launching agent contain server-authored text only. */
export function errorDiagnostic(error: unknown, tool: string, kind = 'internal', correlation_id: string = randomUUID(), status?: number) {
    // Fixed messages already satisfy standard/private masking, including in open mode. Never
    // copy an upstream message, SQL, identity, amount, stack or file path onto stdio.
    console.error('Lens error', {correlation_id, tool: /^[\w:-]{1,80}$/.test(tool) ? tool : 'unknown', error_kind: kind, http_status: status ?? null, message:'Operation failed.'})
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
