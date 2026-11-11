/** Navigation follows URL state, including in the health/sync single-page shell. */
export function renderAppNavigationScript(): string {
  return String.raw`<script type="module">(()=>{
function initNavigation(){const sidebar=document.querySelector('[data-app-sidebar]');if(!sidebar||sidebar.dataset.navigationReady==='true')return;sidebar.dataset.navigationReady='true';
function update(){const path=location.pathname;const group=path==='/finance'||path.startsWith('/finance/')?'finance':path==='/data'||path==='/sync'||path==='/sync-guide'||path.startsWith('/connect-')?'sync':path==='/health'||path.startsWith('/health/')||path==='/settings/ai'?'health':'home';
sidebar.querySelectorAll('[data-navigation-page]').forEach((link)=>{const active=link.dataset.navigationPage===group;link.classList.toggle('active',active);if(active)link.setAttribute('aria-current',path===({home:'/',health:'/health',finance:'/finance',sync:'/sync'})[group]?'page':'true');else link.removeAttribute('aria-current');});
sidebar.querySelectorAll('[data-navigation-group]').forEach((section)=>section.hidden=section.dataset.navigationGroup!==group);
const params=new URLSearchParams(location.search),ledger=params.get('ledger'),currency=params.get('currency');
sidebar.querySelectorAll('[data-context-path]').forEach((link)=>{const target=link.dataset.contextPath;const active=path===target;link.classList.toggle('active',active);if(active)link.setAttribute('aria-current','page');else link.removeAttribute('aria-current');let href=target;if(target==='/finance'||target.startsWith('/finance/')){const query=new URLSearchParams();if(['personal','family'].includes(ledger))query.set('ledger',ledger);if(typeof currency==='string'&&/^(?:[A-Z]{3}|all)$/.test(currency))query.set('currency',currency);if(query.size)href+='?'+query.toString();}link.setAttribute('href',href);});}
const afterAction=()=>queueMicrotask(update);const afterNavigationAction=(event)=>{const target=event.target instanceof Element?event.target.closest('[data-page],[data-ledger],[data-fg-ledger],[data-runway-ledger],[data-review-ledger],[data-check-ledger]'):null;if(target)afterAction();};document.addEventListener('click',afterNavigationAction);document.addEventListener('keydown',afterNavigationAction);document.addEventListener('change',afterAction);window.addEventListener('popstate',update);window.addEventListener('jiashu-navigation',update);update();}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',initNavigation,{once:true});else initNavigation();
})();</script>`;
}
