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
