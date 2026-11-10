// The Dashboards pages: placeholder until Agent 2 fills it in.
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Viewer } from './access.ts'
export async function handleDashboards(_req: IncomingMessage, res: ServerResponse, _url: URL, _v: Viewer): Promise<boolean> {
    res.writeHead(503, { 'content-type': 'text/plain' })
    res.end('Dashboards are not built yet.')
    return true
}
