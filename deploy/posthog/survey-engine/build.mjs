#!/usr/bin/env node
// Builds the Lens survey renderer from PostHog's own surveys.js:
//   1. the footer "Survey by <PostHog logo>" (a link to posthog.com) becomes plain "Survey by ION",
//   2. the Lens chain engine (engine.js) is appended: ordered condition chains for surveys.
// Writes the renderer and optionally the hosted SDK, both with .br and .gz variants.
//
//   node build.mjs <original surveys.js> <output dir> ["Survey by ION"] [original array.js]
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { brotliCompressSync, constants, gzipSync } from 'node:zlib'

const here = dirname(fileURLToPath(import.meta.url))
const [input, outDir, brand = 'Survey by ION', corePath] = process.argv.slice(2)
if (!input || !outDir) {
    console.error('usage: node build.mjs <original surveys.js> <output dir> ["Survey by ION"] [original array.js]')
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

// A larger, clearer footer: PostHog's is 11px at 60% opacity. Optional: if PostHog changes this rule,
// the footer keeps PostHog's size and the build goes on.
const FOOTER_CSS = /\.footer-branding\{opacity:\.6;([^{}]*?)font-size:11px;font-weight:500;/g
const css = patched.match(FOOTER_CSS) || []
if (css.length === 1) patched = patched.replace(FOOTER_CSS, '.footer-branding{opacity:.8;$1font-size:13px;font-weight:600;letter-spacing:.02em;padding-top:4px;')
else console.error(`Footer size rule found ${css.length} times (need 1): keeping PostHog's footer size.`)

const bootstrap = readFileSync(join(here, 'bootstrap.js'), 'utf8')
const engine = readFileSync(join(here, 'engine.js'), 'utf8')
const header = `/*! Survey renderer from posthog-js (Copyright PostHog Inc., Apache License 2.0 with MIT-licensed parts;
 * full licence: https://github.com/PostHog/posthog-js/blob/main/LICENSE).
 * Modified by ION for Reval (Lens survey engine): the footer shows ${JSON.stringify(brand).slice(1, -1).replace(/\*\//g, '* /')} as plain text,
 * slightly larger, instead of the PostHog logo and link, and Lens condition chains (conditions.lensChain) are added after it.
 * Original sha256 ${sha(original)}. */\n`
const out = `${header}${patched}\n;\n${bootstrap}\n;\n${engine}\n`

mkdirSync(outDir, { recursive: true })
function writeBundle(name, source) {
    writeFileSync(join(outDir, name), source)
    writeFileSync(join(outDir, name + '.gz'), gzipSync(source, { level: 9 }))
    writeFileSync(join(outDir, name + '.br'), brotliCompressSync(source, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: source.length } }))
}
writeBundle('surveys.js', out)

let coreHash
if (corePath && process.env.SURVEY_EARLY_CAPTURE !== 'off') {
    // The original /code/staticfiles/array.js shipped with the 1.443.0 survey fixture.
    const expected = 'ed7794f94f39bf41227424f0f036d472bdf9d893928dceeb7a88689558109821'
    const bytes = readFileSync(corePath)
    const actual = sha(bytes)
    const core = bytes.toString('utf8')
    const loaded = 'this.config.loaded(this)'
    if (actual === expected && core.split(loaded).length === 2) {
        // Run before the app's loaded callback, even when Lens throws. Keep the SDK call intact.
        const track = 'function(instance){try{if(!instance.config.disable_surveys)window.__lensSurveyCapture(instance)}catch(_){}}(this)'
        const builtCore = `${bootstrap}\n;\n${core.replace(loaded, `(${track},${loaded})`)}\n`
        writeBundle('array.js', builtCore)
        coreHash = sha(builtCore)
    } else {
        console.warn(`PostHog startup hook refused array.js (SHA-256 ${actual}, expected ${expected} and one loaded hook). Serving the original.`)
    }
}
writeFileSync(join(outDir, 'manifest.json'), JSON.stringify({ built: new Date().toISOString(), brand, original_sha256: sha(original), output_sha256: sha(out), bytes: out.length, core_output_sha256: coreHash }, null, 2) + '\n')
console.log(`Built ${join(outDir, 'surveys.js')} (${out.length} bytes, footer: "${brand}"${css.length === 1 ? ' at 13px' : ''}, chains: on)`)
