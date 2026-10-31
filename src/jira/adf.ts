// Markdown → Atlassian Document Format (Jira Cloud REST v3 comments), and ADF → plain text (to read
// ticket descriptions). Covers what reports use: headings, paragraphs, bullet lists, tables,
// **bold**, _italic_, `code` and [links](url).

export interface AdfNode {
    version?: 1
    type: string
    attrs?: Record<string, unknown>
    content?: AdfNode[]
    text?: string
    marks?: { type: string; attrs?: Record<string, unknown> }[]
}

export function inline(text: string): AdfNode[] {
    const out: AdfNode[] = []
    const re = /\*\*\[([^\]]+)\]\(([^)\s]+)\)\*\*|\[([^\]]+)\]\(([^)\s]+)\)|\*\*([^*]+)\*\*|`([^`]+)`|(?<![A-Za-z0-9])_([^_]+)_(?![A-Za-z0-9])/g
    let last = 0
    let m: RegExpExecArray | null
    const push = (t: string, marks?: AdfNode['marks']) => {
        if (t) out.push(marks?.length ? { type: 'text', text: t, marks } : { type: 'text', text: t })
    }
    while ((m = re.exec(text))) {
        push(text.slice(last, m.index))
        if (m[1]) push(m[1], [{ type: 'strong' }, { type: 'link', attrs: { href: m[2] } }])
        else if (m[3]) push(m[3], [{ type: 'link', attrs: { href: m[4] } }])
        else if (m[5]) push(m[5], [{ type: 'strong' }])
        else if (m[6]) push(m[6], [{ type: 'code' }])
        else if (m[7]) push(m[7], [{ type: 'em' }])
        last = m.index + m[0].length
    }
    push(text.slice(last))
    return out
}

const para = (text: string): AdfNode => ({ type: 'paragraph', content: inline(text) })

export function markdownToAdf(md: string): AdfNode {
    const lines = md.split('\n')
    const content: AdfNode[] = []
    for (let i = 0; i < lines.length; ) {
        const line = lines[i]
        if (!line.trim()) {
            i++
            continue
        }
        const h = /^(#{1,6})\s+(.*)$/.exec(line)
        if (h) {
            content.push({ type: 'heading', attrs: { level: h[1].length }, content: inline(h[2]) })
            i++
            continue
        }
        if (/^\s*[-*]\s+/.test(line)) {
            const items: AdfNode[] = []
            while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
                items.push({ type: 'listItem', content: [para(lines[i].replace(/^\s*[-*]\s+/, ''))] })
                i++
            }
            content.push({ type: 'bulletList', content: items })
            continue
        }
        if (line.trim().startsWith('|')) {
            const rows: string[][] = []
            while (i < lines.length && lines[i].trim().startsWith('|')) {
                const cells = lines[i].trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim())
                if (!cells.every((c) => /^:?-{3,}:?$/.test(c))) rows.push(cells)
                i++
            }
            content.push({
                type: 'table',
                attrs: { isNumberColumnEnabled: false, layout: 'default' },
                content: rows.map((cells, r) => ({
                    type: 'tableRow',
                    content: cells.map((c) => ({ type: r === 0 ? 'tableHeader' : 'tableCell', content: [para(c)] })),
                })),
            })
            continue
        }
        // A paragraph runs until a blank line or another block starts.
        const buf: string[] = []
        while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|\s*[-*]\s+|\s*\|)/.test(lines[i])) buf.push(lines[i++])
        content.push(para(buf.join(' ')))
    }
    return { version: 1, type: 'doc', content }
}

/** ADF → plain text, for reading descriptions. Each block ends with exactly one newline. */
export function adfToText(node: AdfNode | string | null | undefined): string {
    if (!node) return ''
    if (typeof node === 'string') return node
    const kids = () => (node.content || []).map((c) => adfToText(c)).join('')
    switch (node.type) {
        case 'text':
            return node.text || ''
        case 'hardBreak':
            return '\n'
        case 'mention':
            return String(node.attrs?.text || '')
        case 'paragraph':
        case 'heading':
            return kids().trimEnd() + '\n'
        case 'listItem':
            // The paragraph inside already ends the line.
            return '- ' + kids()
        case 'tableRow':
            return (node.content || []).map((c) => adfToText(c).trim()).join(' | ') + '\n'
        case 'codeBlock':
            return kids() + '\n'
        default:
            return kids()
    }
}
