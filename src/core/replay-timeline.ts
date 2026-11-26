import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { gunzip } from 'node:zlib'
import { promisify } from 'node:util'

const unzip = promisify(gunzip)
const MAX_LINE = 4 * 1024 * 1024
const MAX_INFLATED = 64 * 1024 * 1024
const MAX_FIELD = 8 * 1024 * 1024
const MAX_EVENTS = 200_000
const MAX_NODES = 80_000
const DEFAULT_LABELS = ['Save','Submit','Cancel','Apply','Help','Customer','Company','Debit To','Posting Date','Effective Value Date','Payment Due Date','Items','Item Name','Search','Quotation','Sales Order','Sales Invoice','Payment Entry','Delivery Note','Item','Accounts Receivable','Calculate','Calculator','Export','Market Data Snapshot','Draft','Save & Submit','Get Items From','Create','New','Add Row','Edit','Delete','Duplicate','Print','Menu','Close','Back','Next','Previous','Filter','Sort','Refresh','Report','Settings']
/** Visible labels allowed to leave the reducer: the default vocabulary plus REPLAY_VISION_LABELS (comma separated). Anything else is private text. */
const LABELS = new Set([...DEFAULT_LABELS, ...String(process.env.REPLAY_VISION_LABELS || '').split(',').map((x) => x.trim()).filter((x) => x && x.length <= 60)])
/** Frappe/ERPNext schema field names (data-fieldname) are code identifiers, not user content: humanize them to a label. */
export function fieldLabel(v: unknown): string {
    if (typeof v !== 'string' || !/^[a-z][a-z0-9_]{0,60}$/.test(v)) return ''
    return v.split('_').filter(Boolean).map((w) => w[0]!.toUpperCase() + w.slice(1)).join(' ')
}
type Raw = Record<string, unknown>
export type TimelineKind = 'pointer'|'click'|'scroll'|'input_activity'|'focus'|'navigation'|'mutation'|'error'|'app_action'|'coverage'
export interface TimelineItem { event_id: string; offset_ms: number; raw_offset_ms: number; window_id: string; frame_id?: number; kind: TimelineKind; source: 'rrweb'|'app'; x?: number; y?: number; node_id?: number; tag?: string; role?: string; label?: string; screen?: string; scroll_y?: number; scroll_id?: number; error_text?: string; error_kind?: 'visible'|'console'|'exception'|'network'; interaction?: number }
export interface Coverage { state: 'complete'|'partial'|'oversize'; lines: number; bad_lines: number; full_snapshot_seen: boolean; meta_seen: boolean; pointer_seen: boolean; click_seen: boolean; dom_seen: boolean; input_masked: boolean; iframe_seen: boolean; iframe_unseen: boolean; canvas_unseen: boolean; clock_anomaly: boolean; truncated: boolean; reasons: string[] }
export interface Timeline { items: TimelineItem[]; coverage: Coverage; start_time: string; width: number; height: number; screens: string[] }
interface NodeInfo { parent: number; tag: string; role: string; label: string; label_rank: number; attrs: string; field?: string; frame_x?:number;frame_y?:number }
/** Precedence of label-bearing attributes; child text ranks 0. Attribute mutations update a label of equal or lower rank. */
const LABEL_ATTRS: [string, number][] = [['aria-label',3],['data-label',2],['title',1]]
const rec = (v: unknown): Raw | undefined => v && typeof v === 'object' && !Array.isArray(v) ? v as Raw : undefined
const finite = (v: unknown): number | undefined => typeof v === 'number' && Number.isFinite(v) ? v : undefined
const safeId = (v: unknown): number | undefined => { const n=finite(v); return n !== undefined && Number.isSafeInteger(n) ? n : undefined }
function safeLabel(v: unknown): string {
    if (typeof v !== 'string' || v.length > 100) return ''
    const s = v.trim().replace(/\s+/g,' ')
    return LABELS.has(s) ? s : ''
}
export function screenKey(route: string, title = ''): string {
    let path = '/'
    try { path = new URL(route, 'http://local.invalid').pathname } catch {}
    const parts=path.split('/').filter(Boolean).map(part=>{try{return decodeURIComponent(part)}catch{return ':invalid'}})
    if (parts[0] === 'desk' && parts[1]) {
        const modules=new Set(['accounts','selling','stock','buying','crm','manufacturing','projects','hr','support'])
        const index=modules.has(parts[1].toLowerCase())?2:1
        const doc=(parts[index]==='query-report'?parts[index+1]||'report':parts[index]).replace(/-/g,' ').toLowerCase()
        const tail=parts[index+1]
        const form=parts[index]==='query-report'||/report/.test(doc)?'report':tail==='new'||tail?.startsWith('new-')?'new':tail?'form':'list'
        return `${doc}:${form}${safeLabel(title) ? ':'+safeLabel(title).toLowerCase() : ''}`
    }
    return '/' + parts.map(x=>/^(?:[0-9a-f]{8}-[0-9a-f-]{27,}|\d{4,}|new-.+)$/i.test(x) ? ':id' : x.toLowerCase()).join('/')
}
export function taskWindow(visits: { screen: string; start_ms: number; end_ms: number }[], success: Set<string>, sessionEnd: number): {start_ms:number;end_ms:number;screen:string}[] {
    const out: {start_ms:number;end_ms:number;screen:string}[]=[]
    for (let i=0;i<visits.length;i++) {
        const v=visits[i]; if (!v) continue
        const limit=Math.min(sessionEnd,v.start_ms+600_000)
        let end=limit
        for(let j=i;j<visits.length;j++) { const u=visits[j]; if(u.start_ms>limit) break; if(success.has(u.screen)){end=u.end_ms;break} }
        out.push({start_ms:v.start_ms,end_ms:end,screen:v.screen})
    }
    return out
}
async function inflate(v: unknown, budget: {n:number}): Promise<unknown> {
    if(typeof v !== 'string' || v.length<2 || v.charCodeAt(0)!==31 || v.charCodeAt(1)!==139) return v
    let out:Buffer
    try{out=await unzip(Buffer.from(v,'latin1'),{maxOutputLength:MAX_FIELD})}
    catch(e){if((e as NodeJS.ErrnoException).code==='ERR_BUFFER_TOO_LARGE')throw new Error('inflated_field_cap');throw e}
    budget.n+=out.length
    if(budget.n>MAX_INFLATED) throw new Error('inflated_cap')
    return JSON.parse(out.toString('utf8'))
}
function nodeWalk(root: unknown, map: Map<number,NodeInfo>, labels: Map<number,string>, budget:{n:number}, parent=0): boolean {
    const stack: [unknown,number][]=[[root,parent]]
    while(stack.length) {
        const [value,p]=stack.pop()!, n=rec(value); if(!n) continue
        const id=safeId(n.id), a=rec(n.attributes)||{}, tag=typeof n.tagName==='string'?n.tagName.toLowerCase().slice(0,30):''
        const attrs=String(a.class||'').slice(0,200)
        let label='',label_rank=0
        for(const [k,r] of LABEL_ATTRS){const l=safeLabel(a[k]);if(l){label=l;label_rank=r;break}}
        if(!label)label=safeLabel(n.textContent)
        if(!label && ['button','label','a','span'].includes(tag)){
            const queue=[...(Array.isArray(n.childNodes)?n.childNodes:[])].slice(0,12)
            let raw=''
            for(let i=0;i<queue.length&&i<30;i++){const child=rec(queue[i]);if(!child)continue;if(typeof child.textContent==='string')raw+=child.textContent.slice(0,100);else if(Array.isArray(child.childNodes))queue.push(...child.childNodes.slice(0,8))}
            label=safeLabel(raw)
        }
        if(id!==undefined) {if(!map.has(id)){if(budget.n>=MAX_NODES)return false;budget.n++}map.set(id,{parent:p,tag,role:String(a.role||'').slice(0,30),label,label_rank,attrs,field:fieldLabel(a['data-fieldname'])||undefined,frame_x:finite(Number(a.rr_left)),frame_y:finite(Number(a.rr_top))});if(label)labels.set(p,labels.has(p)&&labels.get(p)!==label?'':label)}
        const children=Array.isArray(n.childNodes)?n.childNodes:[]
        if(stack.length+children.length>MAX_NODES)return false
        for(let i=children.length-1;i>=0;i--) stack.push([children[i],id??p])
    }
    return true
}
function visibleState(root:unknown):{error:boolean;mask:boolean;maskId?:number} {
    const queue=[root]
    for(let i=0;i<queue.length&&i<3000;i++){
        const n=rec(queue[i]);if(!n)continue
        const a=rec(n.attributes)||{}, cls=typeof a.class==='string'?a.class:''
        if(a.role==='alert'||/\b(msgprint|has-error|invalid-feedback)\b/.test(cls)||a['aria-invalid']==='true')return {error:true,mask:false}
        if(/\b(x-mask|freeze|freeze-message-container|loading-overlay)\b/.test(cls)||a.id==='freeze'||a.role==='progressbar')return {error:false,mask:true,maskId:safeId(n.id)}
        if(Array.isArray(n.childNodes))for(const child of n.childNodes){if(queue.length>=3000)break;queue.push(child)}
    }
    return {error:false,mask:false}
}
export async function readTimeline(file: string, metadata: {start_time:string;app_events?:{timestamp:string;event:string;path?:string}[]}): Promise<Timeline> {
    const coverage:Coverage={state:'complete',lines:0,bad_lines:0,full_snapshot_seen:false,meta_seen:false,pointer_seen:false,click_seen:false,dom_seen:false,input_masked:true,iframe_seen:false,iframe_unseen:false,canvas_unseen:true,clock_anomaly:false,truncated:false,reasons:[]}
    const items:TimelineItem[]=[], maps=new Map<string,Map<number,NodeInfo>>(), labelMaps=new Map<string,Map<number,string>>(), screens=new Set<string>()
    const budget={n:0},nodeBudget={n:0}, start=Date.parse(metadata.start_time), validStart=Number.isFinite(start)?start:0
    let width=0,height=0,previous=-Infinity,rawBytes=0,skipNodes=false
    const masks=new Map<string,Set<number>>()
    const stream=createReadStream(file,{highWaterMark:64*1024})
    try {
      for await (const line of createInterface({input:stream,crlfDelay:Infinity})) {
        coverage.lines++
        rawBytes+=Buffer.byteLength(line)+1
        if(rawBytes>200*1024*1024 || line.length>MAX_LINE || coverage.lines>MAX_EVENTS || items.length>MAX_EVENTS) {coverage.state='oversize';coverage.truncated=true;coverage.reasons.push('raw_cap');break}
        let e:Raw,windowId='main'
        try {
            const parsed=JSON.parse(line)
            if(Array.isArray(parsed)){windowId=String(parsed[0]??'main').slice(0,100);e=rec(parsed[1])??{}}
            else e=rec(parsed)??{}
            if(!Number.isInteger(e.type) || (typeof e.data!=='string'&&!rec(e.data)) || finite(e.timestamp)===undefined) throw new Error('shape')
        } catch {coverage.bad_lines++;skipNodes=true;continue}
        const type=e.type as number,t=e.timestamp as number,raw=t-validStart,offset=Math.max(0,raw)
        if(t<previous || raw<0 || !Number.isFinite(raw))coverage.clock_anomaly=true
        previous=t
        const map=maps.get(windowId)??new Map<number,NodeInfo>(); maps.set(windowId,map)
        const labels=labelMaps.get(windowId)??new Map<number,string>();labelMaps.set(windowId,labels)
        if(maps.size>32){coverage.state='oversize';coverage.truncated=true;coverage.reasons.push('window_cap');break}
        const base={event_id:`${coverage.lines}`,offset_ms:offset,raw_offset_ms:raw,window_id:windowId,source:'rrweb' as const}
        const target=(id:unknown):{node_id?:number;tag?:string;role?:string;label?:string;frame_id?:number;frame_x:number;frame_y:number}=>{const n=map.get(safeId(id)??NaN);if(!n)return {frame_x:0,frame_y:0};let label=n.label||n.field||'';let parent=n.parent,frameId:number|undefined,frameX=0,frameY=0;for(let depth=0;depth<32&&parent;depth++){const ancestor=map.get(parent);if(!label&&depth<3)label=ancestor?.label||labels.get(parent)||'';if(!label&&depth<6&&ancestor?.field)label=ancestor.field;if(ancestor?.tag==='iframe'){frameId=parent;coverage.iframe_seen=true;if(ancestor.frame_x===undefined||ancestor.frame_y===undefined){if(!coverage.reasons.includes('iframe_offset_unknown'))coverage.reasons.push('iframe_offset_unknown')}else{frameX+=ancestor.frame_x;frameY+=ancestor.frame_y}}parent=ancestor?.parent??0}return {node_id:safeId(id),tag:n.tag,role:n.role,label:label||undefined,frame_id:frameId,frame_x:frameX,frame_y:frameY} }
        try {
          const d=rec(typeof e.data==='string'?await inflate(e.data,budget):e.data)
          if(!d)throw new Error('data_shape')
          if(type===4) {coverage.meta_seen=true;width=finite(d.width)??width;height=finite(d.height)??height;const key=screenKey(String(d.href||'/'));screens.add(key);items.push({...base,kind:'navigation',screen:key})}
          else if(type===2) {
            const node=await inflate(d.node,budget)
            nodeBudget.n-=map.size;map.clear();labels.clear()
            if(!nodeWalk(node,map,labels,nodeBudget)){coverage.state='oversize';coverage.reasons.push('node_cap');skipNodes=true;nodeBudget.n-=map.size;map.clear();labels.clear()}
            else {coverage.full_snapshot_seen=true;coverage.dom_seen=true}
            items.push({...base,kind:'mutation'})
          } else if(type===3) {
            const source=d.source
            if(source===0) {
                for(const field of ['adds','removes','texts','attributes']) d[field]=await inflate(d[field],budget)
                if(!skipNodes && Array.isArray(d.adds)) for(const add of d.adds.slice(0,MAX_NODES)) {const a=rec(add); if(!a?.node)continue; if(!nodeWalk(a.node,map,labels,nodeBudget,safeId(a.parentId)??0)){skipNodes=true;coverage.state='oversize';coverage.reasons.push('node_cap');nodeBudget.n-=map.size;map.clear();labels.clear();break}const state=visibleState(a.node);if(state.error)items.push({...base,event_id:`${coverage.lines}:e${items.length}`,kind:'error',error_kind:'visible',error_text:'visible validation error'});if(state.mask){const id=state.maskId;if(id!==undefined){const set=masks.get(windowId)??new Set<number>();set.add(id);masks.set(windowId,set)}items.push({...base,event_id:`${coverage.lines}:w${items.length}`,kind:'coverage',label:'wait_start'})}}
                if(Array.isArray(d.removes))for(const removed of d.removes.slice(0,MAX_NODES)){const id=safeId(rec(removed)?.id);if(id!==undefined&&masks.get(windowId)?.delete(id))items.push({...base,event_id:`${coverage.lines}:x${items.length}`,kind:'coverage',label:'wait_end'});if(id!==undefined&&map.delete(id))nodeBudget.n--}
                if(Array.isArray(d.attributes))for(const change of d.attributes.slice(0,MAX_NODES)){const c=rec(change),attrs=rec(c?.attributes);if(!attrs)continue;const node=map.get(safeId(c?.id)??NaN);if(node){const before=node.label;for(const [k,r] of LABEL_ATTRS){if(!(k in attrs)||r<node.label_rank)continue;const l=safeLabel(attrs[k]);if(l){node.label=l;node.label_rank=r;break}if(attrs[k]===null&&r===node.label_rank){node.label='';node.label_rank=0}}if(before&&node.label!==before&&labels.get(node.parent)===before){if(node.label)labels.set(node.parent,node.label);else labels.delete(node.parent)}}const cls=typeof attrs.class==='string'?attrs.class:'';if(attrs['aria-invalid']==='true'||/\b(has-error|msgprint|invalid-feedback)\b/.test(cls)){items.push({...base,event_id:`${coverage.lines}:a${items.length}`,kind:'error',error_kind:'visible',error_text:'visible validation error'});break}}
                coverage.dom_seen=true;items.push({...base,kind:'mutation'})
            } else if(source===1 && Array.isArray(d.positions)) {
                for(const p of d.positions.slice(0,10_000)){const q=rec(p);if(!q)continue;const x=finite(q.x),y=finite(q.y);if(x===undefined||y===undefined)continue;const {frame_x,frame_y,...targetInfo}=target(q.id),pTime=t+(finite(q.timeOffset)??0),pRaw=pTime-validStart;items.push({...base,event_id:`${coverage.lines}:${items.length}`,offset_ms:Math.max(0,pRaw),raw_offset_ms:pRaw,kind:'pointer',x:x+frame_x,y:y+frame_y,...targetInfo});coverage.pointer_seen=true}
            } else if(source===2) {const x=finite(d.x),y=finite(d.y),{frame_x,frame_y,...targetInfo}=target(d.id);items.push({...base,kind:'click',interaction:finite(d.type),...(x===undefined?{}:{x:x+frame_x}),...(y===undefined?{}:{y:y+frame_y}),...targetInfo});coverage.click_seen=true}
            else if(source===3) items.push({...base,kind:'scroll',scroll_id:safeId(d.id),scroll_y:finite(d.y),...target(d.id)})
            else if(source===5) items.push({...base,kind:'input_activity',...target(d.id)})
            else if(source===6) items.push({...base,kind:'focus',...target(d.id)})
          } else if(type===5) {
            // posthog-js custom events: SPA URL changes arrive as $url_changed/$pageview with an href payload.
            const tag=typeof d.tag==='string'?d.tag:'',payload=rec(d.payload)
            if((tag==='$url_changed'||tag==='$pageview')&&typeof payload?.href==='string'){const key=screenKey(payload.href);screens.add(key);items.push({...base,kind:'navigation',screen:key})}
          } else if(type===6) {
            // Plugin events: keep only the fact of an error, never the console payload or request body.
            const plugin=typeof d.plugin==='string'?d.plugin:'',payload=rec(d.payload)
            if(plugin.startsWith('rrweb/console')&&payload?.level==='error')items.push({...base,kind:'error',error_kind:'console',error_text:'console error'})
            else if(plugin.startsWith('rrweb/network')&&Array.isArray(payload?.requests)&&payload.requests.slice(0,200).some(r=>{const status=finite(rec(r)?.responseStatus);return status!==undefined&&(status===0||status>=500)}))items.push({...base,kind:'error',error_kind:'network',error_text:'failed request'})
          }
        } catch(err) {coverage.bad_lines++;skipNodes=true;coverage.reasons.push(err instanceof Error?err.message.slice(0,40):'decode');if(coverage.reasons.at(-1)?.includes('cap')||coverage.reasons.at(-1)?.includes('length')){coverage.state='oversize';coverage.truncated=true;break}}
      }
    } catch {coverage.state='partial';coverage.reasons.push('stream_error')}
    finally {stream.destroy()}
    for(const [i,app] of (metadata.app_events||[]).slice(0,500).entries()){
        const ms=Date.parse(app.timestamp)-validStart;if(!Number.isFinite(ms))continue
        if(app.event==='$pageview'&&app.path){const key=screenKey(app.path);screens.add(key);items.push({event_id:`app:${i}`,offset_ms:Math.max(0,ms),raw_offset_ms:ms,window_id:'app',kind:'navigation',source:'app',screen:key})}
        else if(app.event==='$exception')items.push({event_id:`app:${i}`,offset_ms:Math.max(0,ms),raw_offset_ms:ms,window_id:'app',kind:'error',error_kind:'exception',source:'app',error_text:'exception event'})
    }
    if(!coverage.full_snapshot_seen || !coverage.meta_seen || skipNodes || coverage.bad_lines/Math.max(1,coverage.lines)>.01) {if(coverage.state==='complete')coverage.state='partial';if(!coverage.full_snapshot_seen)coverage.reasons.push('missing_snapshot')}
    if(items.length*160>20*1024*1024){items.length=Math.floor(20*1024*1024/160);coverage.state='oversize';coverage.truncated=true;coverage.reasons.push('timeline_cap')}
    return {items,coverage,start_time:metadata.start_time,width,height,screens:[...screens]}
}

/** One sanitized ±window around a moment, for the B′ text prompt: safe labels and timings only, no text, values, URLs or ids. */
export interface SanitizedEvent { id: string; t_ms: number; kind: TimelineKind; label?: string; tag?: string; role?: string; x?: number; y?: number; scroll_y?: number; error?: string; screen?: string }
export interface SanitizedWindow { center_ms: number; start_ms: number; end_ms: number; events: SanitizedEvent[]; dropped_pointer_samples: number; coverage: string[] }
const SAFE_TAG = /^[a-z][a-z0-9-]{0,15}$/
const SAFE_ROLE = /^[a-z]{1,20}$/
/**
 * Cut [center−before, center+after] out of a timeline. Pointer samples are thinned to one per
 * 500 ms and coordinates rounded to 25 px; labels are already vocabulary-checked by the reducer.
 */
export function sanitizedWindow(t: Timeline, center: number, before = 20_000, after = 20_000, maxEvents = 160): SanitizedWindow {
    const start = Math.max(0, center - before), end = center + after
    const kept: TimelineItem[] = []
    let lastPointer = -Infinity, dropped = 0
    const lastInput = new Map<string, number>()
    const round = (v?: number) => (v === undefined ? undefined : Math.round(v / 25) * 25)
    // Same edit rule as the detectors: an input counts only on a field the user clicked or focused in this screen visit
    // (ERPNext sets ~200 labelled field values by script on form open). Of a click's rrweb interactions only the click
    // itself and focus are kept (mouse down/up and blur repeat it).
    const engaged = new Set<string>()
    for (const e of t.items) {
        if (e.offset_ms > end) break
        if (e.kind === 'navigation') engaged.clear()
        if ((e.kind === 'click' || e.kind === 'focus') && e.node_id !== undefined) engaged.add(`${e.window_id}|${e.node_id}`)
        if (e.offset_ms < start || e.kind === 'mutation') continue
        if (e.kind === 'input_activity' && (e.node_id === undefined || !engaged.has(`${e.window_id}|${e.node_id}`))) { dropped++; continue }
        if (e.kind === 'click' && e.interaction !== undefined && e.interaction !== 2 && e.interaction !== 5) { dropped++; continue }
        if (e.kind === 'pointer') { if (e.offset_ms - lastPointer < 500) { dropped++; continue } lastPointer = e.offset_ms }
        // Input activity is thinned per label to one event a second: typing is one event per key, and apps such as
        // ERPNext set hundreds of values by script when a form opens, which would otherwise fill the window.
        if (e.kind === 'input_activity') { const k = e.label ?? ''; if (e.offset_ms - (lastInput.get(k) ?? -Infinity) < 1000) { dropped++; continue } lastInput.set(k, e.offset_ms) }
        kept.push(e)
    }
    // Over the cap, keep the events nearest the moment (not the earliest ones), then restore time order.
    const selected = kept.length <= maxEvents ? kept : kept.map((e, i) => ({ e, i })).sort((a, b) => Math.abs(a.e.offset_ms - center) - Math.abs(b.e.offset_ms - center) || a.i - b.i).slice(0, maxEvents).sort((a, b) => a.i - b.i).map((x) => x.e)
    dropped += kept.length - selected.length
    const events: SanitizedEvent[] = selected.map((e) => ({
            id: e.event_id.slice(0, 24), t_ms: Math.round(e.offset_ms), kind: e.kind,
            ...(e.label && LABELS.has(e.label) || (e.label && /^[A-Z][A-Za-z ]{0,40}$/.test(e.label)) ? { label: e.label } : {}),
            ...(e.tag && SAFE_TAG.test(e.tag) ? { tag: e.tag } : {}), ...(e.role && SAFE_ROLE.test(e.role) ? { role: e.role } : {}),
            ...(e.x !== undefined ? { x: round(e.x), y: round(e.y) } : {}), ...(e.scroll_y !== undefined ? { scroll_y: round(e.scroll_y) } : {}),
            ...(e.kind === 'error' ? { error: e.error_kind ?? 'unknown' } : {}), ...(e.kind === 'navigation' && e.screen ? { screen: e.screen.slice(0, 80) } : {}),
            ...(e.kind === 'coverage' && e.label ? { label: e.label === 'wait_start' ? 'overlay shown' : e.label === 'wait_end' ? 'overlay removed' : undefined } : {}),
        }))
    const coverage = [t.coverage.state, ...t.coverage.reasons.slice(0, 4)].filter((x) => x !== 'complete')
    return { center_ms: center, start_ms: start, end_ms: end, events, dropped_pointer_samples: dropped, coverage }
}
