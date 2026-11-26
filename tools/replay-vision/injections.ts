// Browser-side changes used only in the evaluation proxy. A mark means the
// manipulation actually took effect; a plan alone is never ground truth.
export function injectionScript(caseLiteral:string,delayMs:number):string{return `
(function(){
 const kind=${caseLiteral},dose=${delayMs};window.RV_CASE=kind;window.RV_TRUTH=[];
 function mark(element,phase){window.RV_TRUTH.push({at:Date.now(),kind,screen:location.pathname,element,phase})}
 let renamed=false,dead=false,slow=false,scroll=false,validationCount=0;
 function apply(){
  if(kind==='validation_loop'&&validationCount<2&&!document.querySelector('#rv-validation-save')){const original=[...document.querySelectorAll('.primary-action')].find(x=>/Save/i.test(x.textContent||''));if(original){const r=original.getBoundingClientRect();if(r.width&&r.height){const overlay=document.createElement('button');overlay.id='rv-validation-save';overlay.type='button';overlay.textContent='Save';overlay.setAttribute('aria-label','Save');overlay.style='position:fixed;left:'+r.left+'px;top:'+r.top+'px;width:'+r.width+'px;height:'+r.height+'px;z-index:99999;background:#fff;border:1px solid #aaa';document.body.append(overlay)}}}
  if(kind==='slow_wait'&&!slow&&!document.querySelector('#rv-slow-save')){const original=[...document.querySelectorAll('.primary-action')].find(x=>/Save/i.test(x.textContent||''));if(original){const r=original.getBoundingClientRect();if(r.width&&r.height){const overlay=document.createElement('button');overlay.id='rv-slow-save';overlay.type='button';overlay.textContent='Save';overlay.setAttribute('aria-label','Save');overlay.style='position:fixed;left:'+r.left+'px;top:'+r.top+'px;width:'+r.width+'px;height:'+r.height+'px;z-index:99999;background:#fff;border:1px solid #aaa';document.body.append(overlay)}}}
  if(kind==='hesitation'){const el=document.querySelector('[data-fieldname="due_date"] .control-label');if(el&&el.textContent!=='Effective Value Date'){el.textContent='Effective Value Date';const help=el.parentElement?.querySelector('.help');if(help)help.style.display='none';if(!renamed){renamed=true;mark('Effective Value Date','start')}}}
  if(kind==='dead_button'&&!dead&&document.querySelector('.page-container')){const button=document.createElement('button');button.id='rv-dead-apply';button.type='button';button.className='btn btn-primary';button.textContent='Apply';button.setAttribute('aria-label','Apply');button.style='position:fixed;right:24px;bottom:24px;z-index:99999';document.body.append(button);dead=true;mark('Apply','start')}
  if(kind==='scroll_hunt'&&!scroll&&location.pathname.includes('/item')&&document.querySelector('.page-container')){const box=document.createElement('div');box.id='rv-scroll-list';box.style='position:fixed;top:18%;right:2%;height:60vh;width:280px;overflow:auto;z-index:99999;background:white;border:1px solid #999';for(let i=1;i<=200;i++){const row=document.createElement('div');row.textContent='Item '+i;row.style='height:42px;padding:10px';if(i===190){row.dataset.rvTarget='true';row.setAttribute('aria-label','Item 190')}box.append(row)}document.body.append(box);scroll=true;mark('Item 190','start')}
 }
 document.addEventListener('DOMContentLoaded',()=>{apply();new MutationObserver(apply).observe(document.body,{childList:true,subtree:true})});
 document.addEventListener('click',event=>{
  const target=event.target.closest?.('button,.primary-action');if(!target)return;
  if(kind==='dead_button'&&target.id==='rv-dead-apply'){mark('Apply','click');return}
  if(kind==='validation_loop'&&target.id==='rv-validation-save'&&validationCount<2){validationCount++;
   setTimeout(()=>{const alert=document.createElement('div');alert.setAttribute('role','alert');alert.className='msgprint';alert.textContent='Debit To is required';alert.style='position:fixed;top:12%;left:30%;z-index:99999;background:#fff;border:2px solid #c22;padding:20px';document.body.append(alert);mark('Debit To','error');setTimeout(()=>alert.remove(),1800);if(validationCount===2)target.remove()},0);return}
  if(kind==='slow_wait'&&target.id==='rv-slow-save'&&!slow){slow=true;setTimeout(()=>{target.remove();const wait=document.createElement('div');wait.id='rv-wait';wait.setAttribute('role','progressbar');wait.textContent='Saving…';wait.style='position:fixed;inset:0;z-index:99999;background:#ffffffdd;text-align:center;padding-top:20vh';document.body.append(wait);mark('Save','start');setTimeout(()=>{wait.remove();mark('Save','end');document.querySelector('.primary-action')?.click()},dose||6000)},0);return}
  if(!target.matches('.primary-action')||!/(Save|Submit)/i.test(target.textContent||''))return;
 },true);
})();`}
