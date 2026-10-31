// The demo world: Acme Portal's B2B clients, their users, and the screens of the app.
// The demo app, the session generator and the history seeder all read from here, so a ticket
// that says "Brightwater can't export" refers to the same client everywhere.

export type Region = 'EU' | 'UK' | 'US' | 'APAC'
export type Plan = 'starter' | 'growth' | 'enterprise'

export interface DemoUser {
    email: string
    name: string
    role: 'admin' | 'finance' | 'viewer'
}

export interface DemoClient {
    id: string // stable client id, also the PostHog group key
    name: string
    region: Region
    plan: Plan
    currencies: string[] // invoices in more than one currency hit the planted export bug
    version: '26.9.0' | '26.10.0' // release the client is on now (see release-plan.ts for history)
    users: DemoUser[]
}

export interface Screen {
    path: string
    name: string
    aliases: string[] // words people use for it in tickets
}

export const SCREENS: Screen[] = [
    { path: '/dashboard', name: 'Dashboard', aliases: ['dashboard', 'home', 'overview', 'landing'] },
    {
        path: '/invoices',
        name: 'Invoices',
        aliases: ['invoice', 'invoices', 'billing', 'pdf', 'export', 'download', 'statement'],
    },
    { path: '/clients', name: 'Clients', aliases: ['client list', 'customers', 'accounts', 'contacts'] },
    {
        path: '/reports/revenue',
        name: 'Revenue report',
        aliases: ['revenue', 'report', 'reports', 'revenue report', 'forecast', 'chart'],
    },
    { path: '/settings', name: 'Settings', aliases: ['settings', 'preferences', 'profile', 'team', 'users'] },
]

const u = (email: string, name: string, role: DemoUser['role'] = 'finance'): DemoUser => ({ email, name, role })

export const CLIENTS: DemoClient[] = [
    // EU clients on 26.10.0 with multi-currency invoices: these hit the export regression.
    {
        id: 'brightwater',
        name: 'Brightwater Logistics',
        region: 'EU',
        plan: 'enterprise',
        currencies: ['EUR', 'GBP', 'USD'],
        version: '26.10.0',
        users: [
            u('ben.okafor@brightwater.example', 'Ben Okafor'),
            u('sofia.marin@brightwater.example', 'Sofia Marín', 'admin'),
            u('lukas.weber@brightwater.example', 'Lukas Weber', 'viewer'),
        ],
    },
    {
        id: 'nordlicht',
        name: 'Nordlicht Energie',
        region: 'EU',
        plan: 'growth',
        currencies: ['EUR', 'SEK'],
        version: '26.10.0',
        users: [u('anna.lind@nordlicht.example', 'Anna Lind'), u('jonas.berg@nordlicht.example', 'Jonas Berg', 'admin')],
    },
    {
        id: 'verdant',
        name: 'Verdant Foods BV',
        region: 'EU',
        plan: 'growth',
        currencies: ['EUR', 'GBP'],
        version: '26.10.0',
        users: [u('pieter.devries@verdant.example', 'Pieter de Vries'), u('emma.jansen@verdant.example', 'Emma Jansen')],
    },
    {
        id: 'alpenrose',
        name: 'Alpenrose Hotels',
        region: 'EU',
        plan: 'enterprise',
        currencies: ['EUR', 'CHF'],
        version: '26.10.0',
        users: [u('marco.keller@alpenrose.example', 'Marco Keller'), u('lea.huber@alpenrose.example', 'Lea Huber', 'viewer')],
    },
    // On 26.10.0, single currency: unaffected, which is what proves the bug is currency-specific.
    {
        id: 'cobalt',
        name: 'Cobalt Health',
        region: 'US',
        plan: 'enterprise',
        currencies: ['USD'],
        version: '26.10.0',
        users: [u('maya.chen@cobalthealth.example', 'Maya Chen'), u('raj.patel@cobalthealth.example', 'Raj Patel', 'admin')],
    },
    {
        id: 'harbor',
        name: 'Harbor & Pine',
        region: 'US',
        plan: 'growth',
        currencies: ['USD'],
        version: '26.10.0',
        users: [u('olivia.grant@harborpine.example', 'Olivia Grant')],
    },
    {
        id: 'kestrel',
        name: 'Kestrel Aerospace',
        region: 'UK',
        plan: 'enterprise',
        currencies: ['GBP'],
        version: '26.10.0',
        users: [u('tom.ashby@kestrel.example', 'Tom Ashby'), u('priya.nair@kestrel.example', 'Priya Nair', 'admin')],
    },
    {
        id: 'summit',
        name: 'Summit Outdoor Co',
        region: 'US',
        plan: 'starter',
        currencies: ['USD'],
        version: '26.10.0',
        users: [u('jake.morris@summitoutdoor.example', 'Jake Morris', 'admin')],
    },
    {
        id: 'tidewater',
        name: 'Tidewater Marine',
        region: 'APAC',
        plan: 'growth',
        currencies: ['AUD'],
        version: '26.10.0',
        users: [u('chloe.wu@tidewater.example', 'Chloe Wu'), u('liam.oconnor@tidewater.example', "Liam O'Connor")],
    },
    {
        id: 'quarry',
        name: 'Quarry Lane Studios',
        region: 'UK',
        plan: 'starter',
        currencies: ['GBP'],
        version: '26.10.0',
        users: [u('isla.reid@quarrylane.example', 'Isla Reid', 'admin')],
    },
    // Still on 26.9.0. Two of these are EU and multi-currency: they do NOT hit the bug,
    // which is how the version comparison pins it on the 26.10.0 release.
    {
        id: 'meridian',
        name: 'Meridian Partners',
        region: 'EU',
        plan: 'enterprise',
        currencies: ['EUR', 'USD'],
        version: '26.9.0',
        users: [u('claire.dubois@meridian.example', 'Claire Dubois'), u('henri.martin@meridian.example', 'Henri Martin')],
    },
    {
        id: 'oakridge',
        name: 'Oakridge Legal',
        region: 'EU',
        plan: 'growth',
        currencies: ['EUR', 'GBP'],
        version: '26.9.0',
        users: [u('niamh.byrne@oakridge.example', 'Niamh Byrne')],
    },
    {
        id: 'pinnacle',
        name: 'Pinnacle Retail',
        region: 'US',
        plan: 'enterprise',
        currencies: ['USD'],
        version: '26.9.0',
        users: [u('daniel.reyes@pinnacle.example', 'Daniel Reyes'), u('grace.kim@pinnacle.example', 'Grace Kim', 'viewer')],
    },
    {
        id: 'lumen',
        name: 'Lumen Analytics',
        region: 'US',
        plan: 'growth',
        currencies: ['USD'],
        version: '26.9.0',
        users: [u('ethan.brooks@lumen.example', 'Ethan Brooks')],
    },
    {
        id: 'redwood',
        name: 'Redwood Capital',
        region: 'US',
        plan: 'enterprise',
        currencies: ['USD'],
        version: '26.9.0',
        users: [u('sarah.lopez@redwoodcap.example', 'Sarah Lopez'), u('mike.chang@redwoodcap.example', 'Mike Chang')],
    },
    {
        id: 'saffron',
        name: 'Saffron Travel',
        region: 'APAC',
        plan: 'starter',
        currencies: ['SGD'],
        version: '26.9.0',
        users: [u('arjun.mehta@saffron.example', 'Arjun Mehta', 'admin')],
    },
    {
        id: 'granite',
        name: 'Granite Works',
        region: 'UK',
        plan: 'growth',
        currencies: ['GBP'],
        version: '26.9.0',
        users: [u('oliver.hughes@graniteworks.example', 'Oliver Hughes')],
    },
    {
        id: 'beacon',
        name: 'Beacon Schools Trust',
        region: 'UK',
        plan: 'starter',
        currencies: ['GBP'],
        version: '26.9.0',
        users: [u('fiona.campbell@beacon.example', 'Fiona Campbell')],
    },
    {
        id: 'atlas',
        name: 'Atlas Freight',
        region: 'US',
        plan: 'growth',
        currencies: ['USD'],
        version: '26.9.0',
        users: [u('noah.wilson@atlasfreight.example', 'Noah Wilson'), u('ava.thompson@atlasfreight.example', 'Ava Thompson')],
    },
    {
        id: 'coral',
        name: 'Coral Bay Resorts',
        region: 'APAC',
        plan: 'growth',
        currencies: ['AUD', 'NZD'],
        version: '26.9.0',
        users: [u('mia.taylor@coralbay.example', 'Mia Taylor')],
    },
]

export const BUGGY_VERSION = '26.10.0'

/** The planted regression: 26.10.0 breaks PDF export when an invoice batch mixes currencies. */
export function hitsExportBug(client: DemoClient): boolean {
    return client.version === BUGGY_VERSION && client.currencies.length > 1
}

export function clientById(id: string): DemoClient | undefined {
    return CLIENTS.find((c) => c.id === id)
}

export function clientForEmail(email: string): { client: DemoClient; user: DemoUser } | undefined {
    const e = email.trim().toLowerCase()
    for (const client of CLIENTS) {
        const user = client.users.find((x) => x.email === e)
        if (user) return { client, user }
    }
    return undefined
}

// ------------------------------------------------------------------ the wider client base
// The 20 clients above are the named ones the demo app, the recorded sessions and the example
// tickets use. These 100 more give the usage history a realistic size (about 120 clients and
// 1,000 users). They are generated the same way every time, and every name is invented.
const PREFIX = [
    'Aster', 'Bramble', 'Calder', 'Dunmore', 'Elmstead', 'Fairhaven', 'Glenrock', 'Halcyon', 'Ironbridge', 'Juniper',
    'Kingsmere', 'Larchmont', 'Marlowe', 'Northgate', 'Oakhurst', 'Pemberton', 'Quayside', 'Ravensworth', 'Silverbirch', 'Thornbury',
    'Upland', 'Vantage', 'Westbrook', 'Yarrow', 'Zephyr', 'Ashgrove', 'Beckett', 'Coldwater', 'Driftwood', 'Everly',
    'Foxglove', 'Greystone', 'Hollin', 'Ingleby', 'Lindqvist', 'Mistral', 'Nightingale', 'Orchard', 'Penrose', 'Rosemont',
]
const SUFFIX = ['Holdings', 'Engineering', 'Media', 'Pharma', 'Telecom', 'Mining', 'Shipping', 'Textiles', 'Labs', 'Group', 'Industries', 'Utilities', 'Agritech', 'Aviation', 'Insurance', 'Chemicals', 'Motors', 'Brewing', 'Systems', 'Clinics']
const FIRST = ['Alex', 'Amara', 'Ben', 'Chen', 'Dana', 'Elena', 'Felix', 'Grace', 'Hugo', 'Isha', 'Jonas', 'Kira', 'Liam', 'Maya', 'Nils', 'Olga', 'Priya', 'Rafael', 'Sana', 'Tomas', 'Uma', 'Victor', 'Wen', 'Yara', 'Zoe', 'Arjun', 'Bea', 'Carlos', 'Ines', 'Kofi']
const LAST = ['Ahmed', 'Berg', 'Costa', 'Dubois', 'Evans', 'Fischer', 'Garcia', 'Hansen', 'Ito', 'Jensen', 'Kumar', 'Larsen', 'Moreau', 'Novak', 'Okoro', 'Patel', 'Quinn', 'Rossi', 'Schmidt', 'Tanaka', 'Usman', 'Varga', 'Walsh', 'Yilmaz', 'Zhang']

function seeded(seed: number): () => number {
    let s = seed >>> 0 || 1
    return () => {
        s ^= s << 13
        s ^= s >>> 17
        s ^= s << 5
        return ((s >>> 0) % 1_000_000) / 1_000_000
    }
}

function wider(count: number): DemoClient[] {
    const r = seeded(20261026)
    const out: DemoClient[] = []
    const used = new Set<string>()
    for (let i = 0; out.length < count; i++) {
        const name = `${PREFIX[(i * 7) % PREFIX.length]} ${SUFFIX[(i * 3 + Math.floor(i / PREFIX.length)) % SUFFIX.length]}`
        if (used.has(name)) continue
        used.add(name)
        const id = name.toLowerCase().replace(/[^a-z]+/g, '-')
        const region = (['EU', 'EU', 'EU', 'UK', 'UK', 'US', 'US', 'US', 'APAC', 'APAC'] as Region[])[Math.floor(r() * 10)]
        const plan = (['enterprise', 'enterprise', 'growth', 'growth', 'growth', 'growth', 'starter', 'starter', 'starter', 'starter'] as Plan[])[Math.floor(r() * 10)]
        const home = { EU: 'EUR', UK: 'GBP', US: 'USD', APAC: 'AUD' }[region]
        const currencies = r() < (region === 'EU' ? 0.3 : 0.12) ? [home, region === 'EU' ? 'GBP' : 'EUR'] : [home]
        const size = plan === 'enterprise' ? 12 + Math.floor(r() * 18) : plan === 'growth' ? 5 + Math.floor(r() * 9) : 2 + Math.floor(r() * 4)
        const domain = `${id.replace(/-/g, '')}.example`
        const users: DemoUser[] = []
        for (let k = 0; k < size; k++) {
            const first = FIRST[Math.floor(r() * FIRST.length)]
            const last = LAST[Math.floor(r() * LAST.length)]
            const email = `${first}.${last}${k}@${domain}`.toLowerCase()
            users.push(u(email, `${first} ${last}`, k === 0 ? 'admin' : r() < 0.25 ? 'viewer' : 'finance'))
        }
        out.push({ id, name, region, plan, currencies, version: r() < 0.5 ? '26.10.0' : '26.9.0', users })
    }
    return out
}

export const WIDER_CLIENTS: DemoClient[] = wider(100)
/** Every client in the usage history: the named 20 first, then the wider base. */
export const ALL_CLIENTS: DemoClient[] = [...CLIENTS, ...WIDER_CLIENTS]
