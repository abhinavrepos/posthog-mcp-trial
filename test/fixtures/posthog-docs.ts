import { readFileSync } from 'node:fs'
// Static documentation only: mix3-p*/dictpost-* conversations; tools from mix-p17.
export const posthogDocFixtures = JSON.parse(readFileSync(new URL('./posthog-docs.json', import.meta.url), 'utf8'))
/** Old Lens privacy replaced numeric bounds with <amount>, making some saved schemas invalid JSON.
 * Repair only those numeric positions for the renderer; size measurements retain the original text. */
export function fixtureInfoText(command: string): string {
    return posthogDocFixtures[command].content[0].text.replace(/^inputSchema: (.+)$/m, (_line: string, encoded: string) => {
        const schema = JSON.parse(encoded).replace(/(:)-?<amount>(?=[,}])/g, '$10')
        return `inputSchema: ${JSON.stringify(schema)}`
    })
}
