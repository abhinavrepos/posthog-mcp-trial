// Lab-only server; isolated database and port. No history processing.
import { mkdirSync } from 'node:fs'
const ROOT=new URL('..',import.meta.url).pathname.replace(/\/$/,'')
mkdirSync('/tmp/lens-task-u-lab',{recursive:true})
Object.assign(process.env,{LENS_ROOT:ROOT,TRIAGE_DB:'/tmp/lens-task-u-lab/main.db',APP_EVENTS_FILE:'config/app-events.reval.json',SERVICE_PORT:'18371',SERVICE_PUBLIC_URL:'http://127.0.0.1:18371',MCP_TOKEN:'task-u-lab-token',CLIP_LINK_SECRET:'task-u-lab-0123456789abcdef',POSTHOG_HOST:'http://posthog.fake',POSTHOG_PUBLIC_HOST:'http://posthog.fake',POSTHOG_PROJECT_ID:'1',POSTHOG_PERSONAL_API_KEY:'phx_fake',CLIENT_FROM_DISTINCT_ID:'0',FEATURE_JIRA:'off'})
await import('../src/service/server.ts')
