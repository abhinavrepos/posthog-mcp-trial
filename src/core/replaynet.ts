export function clockShift(pairs: { ts: string; ctime?: number }[]): number {
    const d = pairs.filter((p) => p.ctime && p.ctime > 1e12).map((p) => p.ctime! - Date.parse(p.ts)).sort((a, b) => a - b)
    return d.length ? d[Math.floor(d.length / 2)] : 0
}
