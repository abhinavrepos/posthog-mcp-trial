// Offline reproduction: node --import tsx scripts/measure-posthog-docs.ts
import { compactInfo, compactTools } from '../src/mcp/posthog-docs.ts'
import { posthogDocFixtures as fixtures, fixtureInfoText } from '../test/fixtures/posthog-docs.ts'
// Match the original HTTP benchmark's Python json.dumps (spaces and ensure_ascii=True).
function encode(value: any): string {
    if (Array.isArray(value)) return '[' + value.map(encode).join(', ') + ']'
    if (value && typeof value === 'object') return '{' + Object.entries(value).map(([key, item]) => encode(key) + ': ' + encode(item)).join(', ') + '}'
    return JSON.stringify(value).replace(/[^\x00-\x7f]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))
}
console.log('Command | Before chars | After chars')
for (const command of ['info execute-sql', 'info query-trends', 'tools', 'info query-funnel', 'info query-paths']) {
    const tool = command.split(' ')[1]
    const text = tool ? await compactInfo(fixtureInfoText(command), tool, async path => {
        const raw = fixtures[`schema ${tool} ${path}`]?.content[0].text
        return raw ? JSON.parse(raw.replace(/(:)-?<amount>(?=[,}])/g, '$10')).schema : undefined
    }) : compactTools(fixtures[command].content[0].text)
    console.log(`${command} | ${encode(fixtures[command]).length} | ${encode({ content: [{ type: 'text', text }] }).length}`)
}
