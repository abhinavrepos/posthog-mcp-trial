#!/usr/bin/env node
// For machines without Chrome's desktop libraries (ATK, CUPS, X extensions, ALSA...), where headless Chrome
// cannot start ("error while loading shared libraries: libatk-1.0.so.0"). Headless Chrome links them but does
// not use them to render a page: this builds empty stand-ins with gcc, one library and symbol at a time, until
// Chrome starts. Use only for tests; install the real libraries where you can (apt install libatk1.0-0 ...).
//
//   node tools/reval-sim/chrome-stubs.mjs <chrome binary> <out dir>     → prints the LD_LIBRARY_PATH to use
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [chrome, out] = process.argv.slice(2)
if (!chrome || !out) { console.error('usage: chrome-stubs.mjs <chrome binary> <out dir>'); process.exit(2) }
mkdirSync(out, { recursive: true })
const stateFile = join(out, 'stubs.json')
const libs = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : {}
// Which library a symbol belongs to, by its prefix.
const OWNER = [[/^atk_bridge_/, 'libatk-bridge-2.0.so.0'], [/^atk_/, 'libatk-1.0.so.0'], [/^atspi_/, 'libatspi.so.0'], [/^(cups|ipp|http)/, 'libcups.so.2'],
    [/^XComposite/, 'libXcomposite.so.1'], [/^XDamage/, 'libXdamage.so.1'], [/^XFixes/, 'libXfixes.so.3'], [/^XRR/, 'libXrandr.so.2'], [/^snd_/, 'libasound.so.2'],
    [/^pango_/, 'libpango-1.0.so.0'], [/^cairo_/, 'libcairo.so.2']]
function build(lib) {
    const src = join(out, `${lib}.c`)
    // Every stub returns 0 (NULL, false): nothing headless rendering relies on.
    writeFileSync(src, (libs[lib] || []).map((s) => `long ${s}(void){return 0;}`).join('\n') + '\nint lens_stub_marker;\n')
    execFileSync('gcc', ['-shared', '-fPIC', '-o', join(out, lib), src, `-Wl,-soname,${lib}`])
}
for (const lib of Object.keys(libs)) build(lib)
for (let i = 0; i < 3000; i++) {
    const r = spawnSync(chrome, ['--headless', '--no-sandbox', '--disable-gpu', '--dump-dom', 'data:text/html,<p>ok</p>'], { env: { ...process.env, LD_LIBRARY_PATH: out }, encoding: 'utf8', timeout: 30000 })
    const err = r.stderr || ''
    const missing = /error while loading shared libraries: ([^:]+): cannot open/.exec(err)
    const symbol = /undefined symbol: ([A-Za-z_][\w]*)/.exec(err)
    if (missing) { libs[missing[1]] = libs[missing[1]] || []; build(missing[1]) }
    else if (symbol) {
        const owner = OWNER.find(([re]) => re.test(symbol[1]))
        if (!owner) { console.error(`cannot place symbol ${symbol[1]}:\n${err.slice(0, 500)}`); process.exit(1) }
        libs[owner[1]] = [...new Set([...(libs[owner[1]] || []), symbol[1]])]
        build(owner[1])
    } else if (/<p>ok<\/p>/.test(r.stdout || '')) {
        writeFileSync(stateFile, JSON.stringify(libs, null, 1))
        console.log(out)
        process.exit(0)
    } else { console.error(`Chrome did not start:\n${err.slice(0, 1500)}`); writeFileSync(stateFile, JSON.stringify(libs, null, 1)); process.exit(1) }
    writeFileSync(stateFile, JSON.stringify(libs, null, 1))
}
console.error('gave up after 3000 attempts')
process.exit(1)
