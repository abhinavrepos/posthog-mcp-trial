#!/usr/bin/env node
// Builds the Lens survey renderer from PostHog's own surveys.js:
//   1. the footer "Survey by <PostHog logo>" (a link to posthog.com) becomes plain "Survey by ION",
//   2. the Lens chain engine (engine.js) is appended: ordered condition chains for surveys.
// Writes surveys.js, surveys.js.br, surveys.js.gz and manifest.json into the output folder.
// Every replacement must match exactly once; otherwise this exits 1 and the installer keeps the original.
//
//   node build.mjs <original surveys.js> <output dir> ["Survey by ION"]
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { brotliCompressSync, constants, gzipSync } from 'node:zlib'

const here = dirname(fileURLToPath(import.meta.url))
const [input, outDir, brand = 'Survey by ION'] = process.argv.slice(2)
if (!input || !outDir) {
    console.error('usage: node build.mjs <original surveys.js> <output dir> ["Survey by ION"]')
    process.exit(2)
}
const sha = (s) => createHash('sha256').update(s).digest('hex')
const original = readFileSync(input, 'utf8')
if (original.includes('Lens survey engine')) {
    console.error('The input is already a Lens build; give the original surveys.js from PostHog.')
    process.exit(1)
}

// The footer: <h>("a",{href:"https://posthog.com/surveys"+…,target:"_blank",rel:"noopener",className:"footer-branding",children:["Survey by ",<logo>]})
const FOOTER = /([A-Za-z_$][\w$]*)\("a",\{href:"https:\/\/posthog\.com\/surveys"[\s\S]{0,200}?className:"footer-branding",children:\["Survey by ",[A-Za-z_$][\w$]*\]\}\)/g
const found = original.match(FOOTER) || []
if (found.length !== 1) {
    console.error(`Footer pattern found ${found.length} times (need exactly 1): this PostHog version renders the footer differently. Keeping the original.`)
    process.exit(1)
}
let patched = original.replace(FOOTER, (_m, h) => `${h}("span",{className:"footer-branding",children:${JSON.stringify(brand)}})`)
for (const gone of ['posthog.com/surveys', '"Survey by ",']) {
    if (patched.includes(gone)) {
        console.error(`After patching, "${gone}" is still present. Keeping the original.`)
        process.exit(1)
    }
}

const engine = readFileSync(join(here, 'engine.js'), 'utf8')
const header = `/*! Survey renderer from posthog-js (Copyright PostHog Inc., Apache License 2.0 with MIT-licensed parts;
 * full licence: https://github.com/PostHog/posthog-js/blob/main/LICENSE).
 * Modified by ION for Reval (Lens survey engine): the footer shows ${JSON.stringify(brand).slice(1, -1).replace(/\*\//g, '* /')} as plain text
 * instead of the PostHog logo and link, and Lens condition chains (conditions.lensChain) are added after it.
 * Original sha256 ${sha(original)}. */\n`
const out = `${header}${patched}\n;\n${engine}\n`

mkdirSync(outDir, { recursive: true })
writeFileSync(join(outDir, 'surveys.js'), out)
writeFileSync(join(outDir, 'surveys.js.gz'), gzipSync(out, { level: 9 }))
writeFileSync(join(outDir, 'surveys.js.br'), brotliCompressSync(out, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: out.length } }))
writeFileSync(join(outDir, 'manifest.json'), JSON.stringify({ built: new Date().toISOString(), brand, original_sha256: sha(original), output_sha256: sha(out), bytes: out.length }, null, 2) + '\n')
console.log(`Built ${join(outDir, 'surveys.js')} (${out.length} bytes, footer: "${brand}", chains: on)`)
