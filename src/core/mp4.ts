import { closeSync, fstatSync, openSync, readSync } from 'node:fs'

/** Read the movie clock, skipping media payloads rather than loading a replay into memory. */
export function mp4Duration(file: string): number {
    const fd = openSync(file, 'r')
    const header = Buffer.alloc(40)
    try {
        let end = fstatSync(fd).size
        for (let at = 0; at + 8 <= end;) {
            const count = readSync(fd, header, 0, header.length, at)
            let size = header.readUInt32BE(0), offset = 8
            if (size === 1) { size = Number(header.readBigUInt64BE(8)); offset = 16 }
            if (size === 0) size = end - at
            if (size < offset || at + size > end) break
            const type = header.toString('ascii', 4, 8)
            if (type === 'moov') { end = at + size; at += offset; continue }
            if (type === 'mvhd') {
                const v1 = header[offset] === 1
                const scaleAt = offset + (v1 ? 20 : 12), durationAt = scaleAt + 4
                if (count < durationAt + (v1 ? 8 : 4)) break
                const scale = header.readUInt32BE(scaleAt)
                const duration = (v1 ? Number(header.readBigUInt64BE(durationAt)) : header.readUInt32BE(durationAt)) / scale
                if (Number.isFinite(duration) && duration > 0) return duration
                break
            }
            at += size
        }
        throw new Error('MP4 has no valid movie duration')
    } finally { closeSync(fd) }
}
