// Example tickets for the demo board, written the way client services and risk reviewers write.
// All names, companies and addresses are invented (example domains).
export const EXAMPLES = [
    {
        button: 'Client bug: PDF export stuck',
        type: 'RCI',
        summary: 'Brightwater Logistics cannot export invoices to PDF',
        description:
            'Ben Okafor (ben.okafor@brightwater.example) called this afternoon. When he exports the selected invoices to PDF the page sits on "Preparing PDF…" and nothing downloads. He tried several times. They need the statements for month end, so this is urgent for them.',
        reporter: { displayName: 'Priya (Client Services)', emailAddress: 'priya.cs@acme.example', timeZone: 'Europe/London' },
    },
    {
        button: 'Vague ticket: client name only',
        type: 'RCI',
        summary: 'Nordlicht says invoices are broken',
        description: 'Client called. Said downloading their invoices does not work this week. No more detail, they were in a hurry.',
        reporter: { displayName: 'Sam (Client Services)', emailAddress: 'sam.cs@acme.example', timeZone: 'Europe/Berlin' },
    },
    {
        button: 'No error: report shows zero',
        type: 'RCI',
        summary: 'Cobalt Health: revenue report shows $0 for the quarter',
        description: 'Maya at Cobalt Health says the revenue report shows 0 for quarter to date. She refreshed it a few times and switched ranges. There is no error on screen, it just looks wrong.',
        reporter: { displayName: 'Priya (Client Services)', emailAddress: 'priya.cs@acme.example', timeZone: 'America/New_York' },
    },
    {
        button: 'MMT risk review',
        type: 'MMT Risk',
        summary: 'Risk review: invoice PDF export after the 2.14.0 release',
        description: 'Please assess exposure of the invoices export flow following the 2.14.0 release. Which clients are affected, how often, and is it getting worse?',
        reporter: { displayName: 'Jordan (Risk)', emailAddress: 'jordan.risk@acme.example', timeZone: 'Europe/London' },
    },
]
