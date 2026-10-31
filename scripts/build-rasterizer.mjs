// Bundles PostHog's session-replay rasterizer (from a PostHog checkout) into vendor/.
//
//   POSTHOG_SRC=/root/posthog-mcp-trial node scripts/build-rasterizer.mjs
//
// Only PostHog's own TypeScript is bundled. npm packages (puppeteer, puppeteer-capture, pino, ...)
// stay external and resolve from this project's node_modules, so at runtime nothing depends on
// the PostHog checkout. The player page (common/replay-headless/dist/player.html) is copied too.
import { build } from 'esbuild'
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const src = resolve(process.env.POSTHOG_SRC || '/root/posthog-mcp-trial')
const rasterizerDir = join(src, 'nodejs/src/session-replay/recording-rasterizer')
const playerHtml = join(src, 'common/replay-headless/dist/player.html')

for (const p of [rasterizerDir, playerHtml]) {
    if (!existsSync(p)) {
        console.error(`Missing ${p}`)
        if (p === playerHtml) {
            console.error(
                'Build the player first:\n' +
                    `  cd ${src} && CI=1 pnpm --filter=@posthog/replay-headless... install --frozen-lockfile\n` +
                    `  cd ${src}/common/replay-headless && node build.mjs`
            )
        }
        process.exit(1)
    }
}

const vendor = join(root, 'vendor')
mkdirSync(vendor, { recursive: true })

// The entry re-exports just what lib/clip.ts needs.
const entry = `
export { BrowserPool } from '${rasterizerDir}/capture/browser-pool'
export { rasterizeFile } from '${rasterizerDir}/rasterize-file'
`

await build({
    stdin: { contents: entry, resolveDir: rasterizerDir, loader: 'ts', sourcefile: 'rasterizer-entry.ts' },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    outfile: join(vendor, 'rasterizer.cjs'),
    // keepNames makes esbuild wrap functions in a __name() helper. Puppeteer serialises some of
    // those functions into the page, where __name does not exist, and the render fails.
    keepNames: false,
    alias: {
        '~': join(src, 'nodejs/src'),
        '@posthog/replay-headless/protocol': join(src, 'common/replay-headless/src/protocol.ts'),
    },
    tsconfigRaw: { compilerOptions: { experimentalDecorators: true } },
    // Everything that is not PostHog source is an npm package from this project.
    plugins: [
        {
            name: 'stderr-logger',
            setup(b) {
                b.onResolve({ filter: /(^|\/)logger$/ }, (args) => {
                    const target = resolve(args.resolveDir, args.path)
                    if (args.path.startsWith('~') || target === join(rasterizerDir, 'logger')) {
                        if (args.path.startsWith('~') && !args.path.endsWith('recording-rasterizer/logger')) return undefined
                        return { path: join(root, 'scripts/rasterizer-logger.ts') }
                    }
                    return undefined
                })
            },
        },
        {
            name: 'externalize-npm',
            setup(b) {
                b.onResolve({ filter: /^[^./~]/ }, (args) => {
                    if (args.path.startsWith('@posthog/replay-headless')) return undefined
                    if (args.path.startsWith('/')) return undefined
                    return { path: args.path, external: true }
                })
            },
        },
    ],
    logLevel: 'warning',
})

copyFileSync(playerHtml, join(vendor, 'player.html'))
writeFileSync(
    join(vendor, 'BUILD_INFO.json'),
    JSON.stringify({ posthog_src: src, built_at: new Date().toISOString() }, null, 2) + '\n'
)
console.log(`Built ${join(vendor, 'rasterizer.cjs')} and copied player.html`)
