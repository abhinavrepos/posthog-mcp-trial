// Small text helpers shared by client and screen resolution.

const STOP = new Set([
    'the', 'a', 'an', 'and', 'or', 'of', 'for', 'to', 'in', 'on', 'at', 'is', 'are', 'was', 'were', 'it', 'they', 'we',
    'their', 'our', 'with', 'from', 'this', 'that', 'can', 'cant', 'not', 'when', 'client', 'customer', 'user', 'team',
    'ltd', 'inc', 'co', 'llc', 'bv', 'gmbh', 'plc',
])

/**
 * Light stemmer. It only removes plural endings, and it applies the same rule to both sides of a
 * comparison, so "invoices" and "invoice" both become "invoice".
 */
export function stem(word: string): string {
    const w = word.toLowerCase()
    if (w.length > 4 && w.endsWith('ies')) return w.slice(0, -3) + 'y'
    if (w.length > 4 && (w.endsWith('sses') || w.endsWith('shes') || w.endsWith('ches') || w.endsWith('xes'))) return w.slice(0, -2)
    if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us')) return w.slice(0, -1)
    return w
}

export function tokens(text: string, { keepStop = false } = {}): string[] {
    return (text.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').match(/[a-z0-9]+/g) || [])
        .filter((t) => keepStop || !STOP.has(t))
        .map(stem)
}

/** Does `phrase` (as stemmed tokens) appear contiguously in `haystack` tokens? */
export function containsPhrase(haystack: string[], phrase: string[]): boolean {
    if (!phrase.length || phrase.length > haystack.length) return false
    outer: for (let i = 0; i <= haystack.length - phrase.length; i++) {
        for (let j = 0; j < phrase.length; j++) if (haystack[i + j] !== phrase[j]) continue outer
        return true
    }
    return false
}

export const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g

export function emailsIn(text: string): string[] {
    return [...new Set((text.match(EMAIL_RE) || []).map((e) => e.toLowerCase()))]
}
