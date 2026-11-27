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
export interface TimelineItem { event_id: string; offset_ms: number; raw_offset_ms: number; window_id: string; frame_id?: number; kind: TimelineKind; source: 'rrweb'|'app'; x?: number; y?: number; node_id?: number; tag?: string; role?: string; label?: string; screen?: string; screen_name?: string; navigation_reason?: 'open'|'return'; state_change?: 'menu'; scroll_y?: number; scroll_id?: number; error_text?: string; error_kind?: 'visible'|'console'|'exception'|'network'; interaction?: number }
export interface Coverage { state: 'complete'|'partial'|'oversize'; lines: number; bad_lines: number; full_snapshot_seen: boolean; meta_seen: boolean; pointer_seen: boolean; click_seen: boolean; dom_seen: boolean; input_masked: boolean; iframe_seen: boolean; iframe_unseen: boolean; canvas_unseen: boolean; clock_anomaly: boolean; truncated: boolean; reasons: string[] }
export interface Timeline { items: TimelineItem[]; coverage: Coverage; start_time: string; width: number; height: number; screens: string[] }
interface NodeInfo { parent: number; tag: string; role: string; label: string; label_rank: number; attrs: string; field?: string; dom_id?: string; for_id?: string; frame_x?:number;frame_y?:number }
/** Precedence of label-bearing attributes; child text ranks 0. Attribute mutations update a label of equal or lower rank. */
const LABEL_ATTRS: [string, number][] = [['aria-label',3],['data-label',2],['title',1]]
const rec = (v: unknown): Raw | undefined => v && typeof v === 'object' && !Array.isArray(v) ? v as Raw : undefined
const finite = (v: unknown): number | undefined => typeof v === 'number' && Number.isFinite(v) ? v : undefined
const safeId = (v: unknown): number | undefined => { const n=finite(v); return n !== undefined && Number.isSafeInteger(n) ? n : undefined }
/** Labels the application vocabulary adds for one analysis (APP_EVENTS_FILE: buttons, fields, tabs, screen names). Set per readTimeline call. */
let APP_LABELS = new Set<string>()
function safeLabel(v: unknown): string {
    if (typeof v !== 'string' || v.length > 100) return ''
    const s = v.trim().replace(/\s+/g,' ').replace(/\s*:$/,'') // Ext field labels end with a ':' separator
    return LABELS.has(s) || APP_LABELS.has(s) ? s : ''
}
/** Screen key for an application screen event (e.g. Reval PageView with dialog_id/dialog_name): "<visible name>:screen". */
export function appScreenKey(dialog: string, name?: string): string {
    const n = (name && !/^(unknown|undefined|null)$/i.test(name) ? name : dialog).trim().replace(/\s+/g, ' ').slice(0, 80).toLowerCase()
    return `${n || 'unknown'}:screen`
}
/** One application event as the timeline uses it; screen/nav/error/notice are resolved from APP_EVENTS_FILE by the caller. */
export interface AppEventInput { timestamp: string; event: string; path?: string; screen?: string; screen_name?: string; nav?: 'open' | 'close'; error?: boolean; notice?: boolean; success?: boolean; completion?: boolean }
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
/** The label text the user SEES for a form field: a <label> (or its text) inside the field's container, keyed by the
 * nearest ancestor with a schema field name (data-fieldname). Updated as labels change (e.g. a relabelled field). */
function noteVisibleLabel(labelNode:number, text:string, map:Map<number,NodeInfo>, visible:Map<number,string>):void {
    let id=labelNode
    for(let depth=0;depth<6&&id;depth++){const n=map.get(id);if(!n)return;if(n.field){visible.set(id,text);return}id=n.parent}
}
function nodeWalk(root: unknown, map: Map<number,NodeInfo>, labels: Map<number,string>, budget:{n:number}, parent=0, visible:Map<number,string>=new Map(), labelFor:Map<string,string>=new Map()): boolean {
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
        if(id!==undefined) {if(!map.has(id)){if(budget.n>=MAX_NODES)return false;budget.n++}map.set(id,{parent:p,tag,role:String(a.role||'').slice(0,30),label,label_rank,attrs,field:fieldLabel(a['data-fieldname'])||undefined,dom_id:typeof a.id==='string'&&a.id.length<=120?a.id:undefined,for_id:tag==='label'&&typeof a.for==='string'&&a.for.length<=120?a.for:undefined,frame_x:finite(Number(a.rr_left)),frame_y:finite(Number(a.rr_top))});if(label)labels.set(p,labels.has(p)&&labels.get(p)!==label?'':label)
            if(label&&tag==='label'){noteVisibleLabel(id,label,map,visible);if(typeof a.for==='string'&&a.for.length<=120)labelFor.set(a.for,label)}
            else if(label&&!tag){
                // Label text can arrive after its element, nested in spans (Ext builds DOM incrementally): find the <label> ancestor.
                let q=p;for(let depth=0;depth<4&&q;depth++){const anc=map.get(q);if(!anc)break;if(anc.tag==='label'){noteVisibleLabel(q,label,map,visible);if(anc.for_id)labelFor.set(anc.for_id,label);break}q=anc.parent}
            }}
        const children=Array.isArray(n.childNodes)?n.childNodes:[]
        if(stack.length+children.length>MAX_NODES)return false
        for(let i=children.length-1;i>=0;i--) stack.push([children[i],id??p])
    }
    return true
}
const isMenuClass=(cls:string)=>/\bx-menu(?:-|\b)/.test(cls)
function isMenuNode(value:unknown):boolean {
    const pending=[value]
    for(let i=0;i<pending.length&&i<1000;i++){
        const node=rec(pending[i]);if(!node)continue
        if(isMenuClass(String(rec(node.attributes)?.class||'')))return true
        if(Array.isArray(node.childNodes))pending.push(...node.childNodes.slice(0,Math.min(100,1000-pending.length)))
    }
    return false
}
function visibleState(root:unknown):{error:boolean;mask:boolean;maskId?:number} {
    const queue=[root]
    for(let i=0;i<queue.length&&i<3000;i++){
        const n=rec(queue[i]);if(!n)continue
        const a=rec(n.attributes)||{}, cls=typeof a.class==='string'?a.class:''
        // Hidden when added (Ext keeps hidden components such as the message box's progress bar): neither an error nor a wait.
        if(a['aria-hidden']==='true'||(typeof a.style==='string'&&/display:\s*none/.test(a.style))||/\bx-hidden(-display|-offsets|-clip)?\b/.test(cls))continue
        if(a.role==='alert'||/\b(msgprint|has-error|invalid-feedback)\b/.test(cls)||a['aria-invalid']==='true')return {error:true,mask:false}
        // Ext: a LoadMask is a component (x-mask + x-component); a modal window's backdrop is a bare x-mask (not a wait).
        if((/\bx-mask\b/.test(cls)&&/\bx-component\b/.test(cls))||/\b(freeze|freeze-message-container|loading-overlay)\b/.test(cls)||a.id==='freeze'||a.role==='progressbar')return {error:false,mask:true,maskId:safeId(n.id)}
        if(Array.isArray(n.childNodes))for(const child of n.childNodes){if(queue.length>=3000)break;queue.push(child)}
    }
    return {error:false,mask:false}
}
export async function readTimeline(file: string, metadata: {start_time:string;app_events?:AppEventInput[];labels?:string[]}): Promise<Timeline> {
    APP_LABELS = new Set((metadata.labels ?? []).filter((x) => typeof x === 'string' && x.length <= 60).slice(0, 2000))
    const coverage:Coverage={state:'complete',lines:0,bad_lines:0,full_snapshot_seen:false,meta_seen:false,pointer_seen:false,click_seen:false,dom_seen:false,input_masked:true,iframe_seen:false,iframe_unseen:false,canvas_unseen:true,clock_anomaly:false,truncated:false,reasons:[]}
    const items:TimelineItem[]=[], maps=new Map<string,Map<number,NodeInfo>>(), labelMaps=new Map<string,Map<number,string>>(), visibleMaps=new Map<string,Map<number,string>>(), labelForMaps=new Map<string,Map<string,string>>(), screens=new Set<string>()
    const budget={n:0},nodeBudget={n:0}, start=Date.parse(metadata.start_time), validStart=Number.isFinite(start)?start:0
    let width=0,height=0,previous=-Infinity,rawBytes=0,skipNodes=false
    /** Loading overlays per window: node id -> currently shown. Ext hides a form-submit mask (style/aria-hidden) and reuses it. */
    const masks=new Map<string,Map<number,boolean>>()
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
        const visible=visibleMaps.get(windowId)??new Map<number,string>();visibleMaps.set(windowId,visible)
        const labelFor=labelForMaps.get(windowId)??new Map<string,string>();labelForMaps.set(windowId,labelFor)
        if(maps.size>32){coverage.state='oversize';coverage.truncated=true;coverage.reasons.push('window_cap');break}
        const base={event_id:`${coverage.lines}`,offset_ms:offset,raw_offset_ms:raw,window_id:windowId,source:'rrweb' as const}
        const target=(id:unknown):{node_id?:number;tag?:string;role?:string;label?:string;frame_id?:number;frame_x:number;frame_y:number}=>{const n=map.get(safeId(id)??NaN);if(!n)return {frame_x:0,frame_y:0};
            // Precedence: an explicit aria-label/data-label/title, then the label the user sees on the field's container, then own text, then the schema name.
            let seen=(n.dom_id&&labelFor.get(n.dom_id))||'';for(let q:number|undefined=safeId(id),depth=0;q&&depth<8&&!seen;depth++){seen=visible.get(q)??'';q=map.get(q)?.parent}
            // labels.get(self): text children that arrived after the element itself (incremental DOM, e.g. an Ext button's span).
            let label=(n.label_rank>0?n.label:'')||seen||n.label||labels.get(safeId(id)!)||n.field||'';let parent=n.parent,frameId:number|undefined,frameX=0,frameY=0;for(let depth=0;depth<32&&parent;depth++){const ancestor=map.get(parent);if(!label&&depth<3)label=ancestor?.label||labels.get(parent)||'';if(!label&&depth<6&&ancestor?.field)label=ancestor.field;if(ancestor?.tag==='iframe'){frameId=parent;coverage.iframe_seen=true;if(ancestor.frame_x===undefined||ancestor.frame_y===undefined){if(!coverage.reasons.includes('iframe_offset_unknown'))coverage.reasons.push('iframe_offset_unknown')}else{frameX+=ancestor.frame_x;frameY+=ancestor.frame_y}}parent=ancestor?.parent??0}return {node_id:safeId(id),tag:n.tag,role:n.role,label:label||undefined,frame_id:frameId,frame_x:frameX,frame_y:frameY} }
        try {
          const d=rec(typeof e.data==='string'?await inflate(e.data,budget):e.data)
          if(!d)throw new Error('data_shape')
          if(type===4) {coverage.meta_seen=true;width=finite(d.width)??width;height=finite(d.height)??height;const key=screenKey(String(d.href||'/'));screens.add(key);items.push({...base,kind:'navigation',screen:key})}
          else if(type===2) {
            const node=await inflate(d.node,budget)
            nodeBudget.n-=map.size;map.clear();labels.clear();visible.clear();labelFor.clear()
            if(!nodeWalk(node,map,labels,nodeBudget,0,visible,labelFor)){coverage.state='oversize';coverage.reasons.push('node_cap');skipNodes=true;nodeBudget.n-=map.size;map.clear();labels.clear();visible.clear();labelFor.clear()}
            else {coverage.full_snapshot_seen=true;coverage.dom_seen=true}
            items.push({...base,kind:'mutation'})
          } else if(type===3) {
            const source=d.source
            if(source===0) {
                for(const field of ['adds','removes','texts','attributes']) d[field]=await inflate(d[field],budget)
                let menuChanged=false
                if(!skipNodes && Array.isArray(d.adds)) for(const add of d.adds.slice(0,MAX_NODES)) {const a=rec(add); if(!a?.node)continue;if(isMenuNode(a.node))menuChanged=true; if(!nodeWalk(a.node,map,labels,nodeBudget,safeId(a.parentId)??0,visible,labelFor)){skipNodes=true;coverage.state='oversize';coverage.reasons.push('node_cap');nodeBudget.n-=map.size;map.clear();labels.clear();visible.clear();labelFor.clear();break}const state=visibleState(a.node);if(state.error)items.push({...base,event_id:`${coverage.lines}:e${items.length}`,kind:'error',error_kind:'visible',error_text:'visible validation error'});if(state.mask){const id=state.maskId;if(id!==undefined){const set=masks.get(windowId)??new Map<number,boolean>();set.set(id,true);masks.set(windowId,set)}items.push({...base,event_id:`${coverage.lines}:w${items.length}`,kind:'coverage',label:'wait_start'})}}
                // Text changes on existing text nodes (frameworks set button/label text this way): relabel the node and its parent.
                if(!skipNodes&&Array.isArray(d.texts))for(const change of d.texts.slice(0,MAX_NODES)){const c=rec(change),id=safeId(c?.id),node=id!==undefined?map.get(id):undefined;if(!node)continue;const l=safeLabel(c?.value);node.label=l;if(l){labels.set(node.parent,l);let q=node.parent;for(let depth=0;depth<4&&q;depth++){const anc=map.get(q);if(!anc)break;if(anc.tag==='label'){noteVisibleLabel(q,l,map,visible);if(anc.for_id)labelFor.set(anc.for_id,l);break}q=anc.parent}}else if(labels.has(node.parent))labels.delete(node.parent)}
                if(Array.isArray(d.removes))for(const removed of d.removes.slice(0,MAX_NODES)){const id=safeId(rec(removed)?.id);const node=id!==undefined?map.get(id):undefined;if(node&&isMenuClass(node.attrs))menuChanged=true;const shown=id!==undefined?masks.get(windowId)?.get(id):undefined;if(id!==undefined)masks.get(windowId)?.delete(id);if(shown)items.push({...base,event_id:`${coverage.lines}:x${items.length}`,kind:'coverage',label:'wait_end'});if(id!==undefined&&map.delete(id))nodeBudget.n--}
                if(Array.isArray(d.attributes))for(const change of d.attributes.slice(0,MAX_NODES)){const c=rec(change),attrs=rec(c?.attributes);if(!attrs)continue;const maskId=safeId(c?.id),maskSet=masks.get(windowId);if(maskId!==undefined&&maskSet?.has(maskId)){const was=maskSet.get(maskId)!,st=attrs.style,ah=attrs['aria-hidden'];const hidden=ah==='true'||(typeof st==='string'&&/display:\s*none/.test(st))||(!!st&&typeof st==='object'&&(st as Raw).display==='none');const shownNow=ah==='false'||(typeof st==='string'&&!/display:\s*none/.test(st)&&ah!=='true')||(!!st&&typeof st==='object'&&(st as Raw).display===false);if(was&&hidden){maskSet.set(maskId,false);items.push({...base,event_id:`${coverage.lines}:x${items.length}`,kind:'coverage',label:'wait_end'})}else if(!was&&shownNow&&!hidden){maskSet.set(maskId,true);items.push({...base,event_id:`${coverage.lines}:w${items.length}`,kind:'coverage',label:'wait_start'})}}const node=map.get(safeId(c?.id)??NaN);if(node){if(('aria-expanded' in attrs && (node.role==='button'||/\bx-btn\b/.test(node.attrs)||isMenuClass(node.attrs))) || (isMenuClass(node.attrs) && ('style' in attrs || 'class' in attrs || 'aria-hidden' in attrs)))menuChanged=true;if(typeof attrs.class==='string')node.attrs=attrs.class;const before=node.label;for(const [k,r] of LABEL_ATTRS){if(!(k in attrs)||r<node.label_rank)continue;const l=safeLabel(attrs[k]);if(l){node.label=l;node.label_rank=r;break}if(attrs[k]===null&&r===node.label_rank){node.label='';node.label_rank=0}}if(before&&node.label!==before&&labels.get(node.parent)===before){if(node.label)labels.set(node.parent,node.label);else labels.delete(node.parent)}}const cls=typeof attrs.class==='string'?attrs.class:'';if(attrs['aria-invalid']==='true'||/\b(has-error|msgprint|invalid-feedback)\b/.test(cls)){items.push({...base,event_id:`${coverage.lines}:a${items.length}`,kind:'error',error_kind:'visible',error_text:'visible validation error'});break}}
                coverage.dom_seen=true;items.push({...base,kind:'mutation',...(menuChanged?{state_change:'menu' as const}:{})})
            } else if((source===1||source===6) && Array.isArray(d.positions)) { // 6 = TouchMove, same shape as MouseMove
                for(const p of d.positions.slice(0,10_000)){const q=rec(p);if(!q)continue;const x=finite(q.x),y=finite(q.y);if(x===undefined||y===undefined)continue;const {frame_x,frame_y,...targetInfo}=target(q.id),pTime=t+(finite(q.timeOffset)??0),pRaw=pTime-validStart;items.push({...base,event_id:`${coverage.lines}:${items.length}`,offset_ms:Math.max(0,pRaw),raw_offset_ms:pRaw,kind:'pointer',x:x+frame_x,y:y+frame_y,...targetInfo});coverage.pointer_seen=true}
            } else if(source===2) {const x=finite(d.x),y=finite(d.y),{frame_x,frame_y,...targetInfo}=target(d.id);items.push({...base,kind:finite(d.type)===5?'focus':'click',interaction:finite(d.type),...(x===undefined?{}:{x:x+frame_x}),...(y===undefined?{}:{y:y+frame_y}),...targetInfo});coverage.click_seen=true}
            else if(source===3) items.push({...base,kind:'scroll',scroll_id:safeId(d.id),scroll_y:finite(d.y),...target(d.id)})
            else if(source===5) items.push({...base,kind:'input_activity',...target(d.id)})
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
    const openStack:{key:string;name?:string}[]=[]
    for(const [i,app] of (metadata.app_events||[]).slice(0,500).entries()){
        const ms=Date.parse(app.timestamp)-validStart;if(!Number.isFinite(ms))continue
        if(app.event==='$pageview'&&app.path){const key=screenKey(app.path);screens.add(key);items.push({event_id:`app:${i}`,offset_ms:Math.max(0,ms),raw_offset_ms:ms,window_id:'app',kind:'navigation',source:'app',screen:key})}
        else if(app.event==='$exception')items.push({event_id:`app:${i}`,offset_ms:Math.max(0,ms),raw_offset_ms:ms,window_id:'app',kind:'error',error_kind:'exception',source:'app',error_text:'exception event'})
        // Application screen events (APP_EVENTS_FILE): an OPEN navigates to the screen; a CLOSE returns to the most recently
        // opened screen that is still open (Ext MDI re-activates it without an event). Message boxes are visible errors.
        else if(app.screen&&app.nav==='open'){const at=openStack.findIndex(x=>x.key===app.screen);if(at>=0)openStack.splice(at,1);openStack.push({key:app.screen,name:app.screen_name});screens.add(app.screen);items.push({event_id:`app:${i}`,offset_ms:Math.max(0,ms),raw_offset_ms:ms,window_id:'app-screen',kind:'navigation',source:'app',screen:app.screen,screen_name:app.screen_name,navigation_reason:'open'})}
        else if(app.screen&&app.nav==='close'){if(app.success)items.push({event_id:`app:${i}:success`,offset_ms:Math.max(0,ms),raw_offset_ms:ms,window_id:'app',kind:'app_action',source:'app',label:'screen_close',screen:app.screen});const at=openStack.findLastIndex(x=>x.key===app.screen);if(at>=0){const wasActive=at===openStack.length-1;openStack.splice(at,1);const back=openStack.at(-1);if(wasActive&&back)items.push({event_id:`app:${i}`,offset_ms:Math.max(0,ms),raw_offset_ms:ms,window_id:'app-screen',kind:'navigation',source:'app',screen:back.key,screen_name:back.name,navigation_reason:'return'})}}
        else if(app.screen&&app.completion)items.push({event_id:`app:${i}`,offset_ms:Math.max(0,ms),raw_offset_ms:ms,window_id:'app',kind:'app_action',source:'app',label:'screen_complete',screen:app.screen})
        else if(app.success)items.push({event_id:`app:${i}`,offset_ms:Math.max(0,ms),raw_offset_ms:ms,window_id:'app',kind:'app_action',source:'app',label:'save_success'});else if(app.error)items.push({event_id:`app:${i}`,offset_ms:Math.max(0,ms),raw_offset_ms:ms,window_id:'app',kind:'error',error_kind:'visible',source:'app',error_text:'application message'})
    }
    if(!coverage.full_snapshot_seen || !coverage.meta_seen || skipNodes || coverage.bad_lines/Math.max(1,coverage.lines)>.01) {if(coverage.state==='complete')coverage.state='partial';if(!coverage.full_snapshot_seen)coverage.reasons.push('missing_snapshot')}
    if(items.length*160>20*1024*1024){items.length=Math.floor(20*1024*1024/160);coverage.state='oversize';coverage.truncated=true;coverage.reasons.push('timeline_cap')}
    // An app with its own screen events (APP_EVENTS_FILE, e.g. Reval: one page, the URL never changes) defines screens by
    // those events; URL-derived navigation (rrweb Meta, $url_changed, $pageview) would only add a meaningless "/" visit.
    if((metadata.app_events||[]).some((a)=>a.nav==='open')){
        for(let i=items.length-1;i>=0;i--)if(items[i]!.kind==='navigation'&&items[i]!.window_id!=='app-screen')items.splice(i,1)
        screens.clear();for(const it of items)if(it.kind==='navigation'&&it.screen)screens.add(it.screen)
    }
    items.sort((a,b)=>a.offset_ms-b.offset_ms) // app events are merged in after the rrweb stream; stable sort keeps stream order
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
            ...(e.label && (LABELS.has(e.label) || APP_LABELS.has(e.label)) || (e.label && /^[A-Z][A-Za-z ]{0,40}$/.test(e.label)) ? { label: e.label } : {}),
            ...(e.tag && SAFE_TAG.test(e.tag) ? { tag: e.tag } : {}), ...(e.role && SAFE_ROLE.test(e.role) ? { role: e.role } : {}),
            ...(e.x !== undefined ? { x: round(e.x), y: round(e.y) } : {}), ...(e.scroll_y !== undefined ? { scroll_y: round(e.scroll_y) } : {}),
            ...(e.kind === 'error' ? { error: e.error_kind ?? 'unknown' } : {}), ...(e.kind === 'navigation' && e.screen ? { screen: e.screen.slice(0, 80) } : {}),
            ...(e.kind === 'coverage' && e.label ? { label: e.label === 'wait_start' ? 'overlay shown' : e.label === 'wait_end' ? 'overlay removed' : undefined } : {}),
        }))
    const coverage = [t.coverage.state, ...t.coverage.reasons.slice(0, 4)].filter((x) => x !== 'complete')
    return { center_ms: center, start_ms: start, end_ms: end, events, dropped_pointer_samples: dropped, coverage }
}
