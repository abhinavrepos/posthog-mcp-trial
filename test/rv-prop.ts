// Minimal seeded property-testing helpers (fast-check is not a dependency of this repo).
// Every failure reports the seed and iteration so a case can be replayed exactly.
export type Rng = { int(lo: number, hi: number): number; float(lo: number, hi: number): number; pick<T>(xs: readonly T[]): T; bool(p?: number): boolean; shuffle<T>(xs: T[]): T[] }

export function rng(seed: number): Rng {
    let a = seed >>> 0
    const next = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
    const r: Rng = {
        int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
        float: (lo, hi) => lo + next() * (hi - lo),
        pick: (xs) => xs[Math.floor(next() * xs.length)]!,
        bool: (p = 0.5) => next() < p,
        shuffle: (xs) => { const out = xs.slice(); for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(next() * (i + 1)); [out[i], out[j]] = [out[j]!, out[i]!] } return out },
    }
    return r
}

export function forAll(runs: number, seed: number, body: (r: Rng, i: number) => void): void {
    for (let i = 0; i < runs; i++) {
        const r = rng(seed * 1_000_003 + i)
        try { body(r, i) } catch (e) { throw new Error(`property failed at seed=${seed} iteration=${i}: ${e instanceof Error ? e.message : String(e)}`) }
    }
}

/** Odd values that break naive numeric code. */
export const NASTY = [NaN, Infinity, -Infinity, -1, 0, -0, 1e308, Number.MAX_SAFE_INTEGER, 0.5, 2 ** 31] as const
