export function elementLabel(chain: string): string | undefined {
    if (!chain) return undefined
    const first = chain.split(';')[0]
    const text = /(?:^|:)text="((?:[^"\\]|\\.)*)"/.exec(first)?.[1]
    if (text?.trim()) return `"${text.trim()}"`
    const attr = /attr__data-attr="([^"]*)"/.exec(first)?.[1]
    if (attr) return `[data-attr=${attr}]`
    const id = /attr__id="([^"]*)"/.exec(first)?.[1]
    if (id) return `#${id}`
    const tag = /^([a-z0-9]+)/i.exec(first)?.[1]
    return tag ? `<${tag}>` : undefined
}
