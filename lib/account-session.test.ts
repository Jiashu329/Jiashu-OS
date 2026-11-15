import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { ACCOUNT_SESSION_SCRIPT, renderAccountSessionScript } from './account-session.ts';
import { CLIENT_REQUEST_SCRIPT } from './client-request.ts';

interface AccountSession {
  owner: string; changed: boolean; problem: string;
  bind(owner: string): boolean;
  verify(): Promise<string>;
  request(url: string, options?: RequestInit): Promise<Response>;
}
interface Call { url: string; options: RequestInit }
function fixture(options: { pageOwner?: string; response?: (call: Call) => Promise<Response> } = {}) {
  const calls: Call[] = [];
  const attributes = new Map<string,string>();
  const events: string[] = [];
  let current = 'alice';
  let session: (() => Promise<Response>) | null = null;
  const sandbox = {
    __JIASHU_PAGE_OWNER__: options.pageOwner,
    document: { documentElement: { setAttribute(key: string, value: string) { attributes.set(key,value); } },
      dispatchEvent(event: Event) { events.push(event.type); } },
    location: new URL('https://synthetic-account.example/health/nutrition'),
    URL, Headers, Response, AbortController, Event, setTimeout, clearTimeout,
    fetch: async (url: string, init: RequestInit = {}) => {
      const call = { url: String(url), options: init };calls.push(call);
      if (call.url === '/api/session') return session ? session() : Response.json({ userId: current });
      return options.response ? options.response(call) : Response.json({ ok:true }, { headers: { 'X-Account-Owner': current } });
    },
  };
  const context = { ...sandbox, window: sandbox };
  runInNewContext(ACCOUNT_SESSION_SCRIPT, context);
  const guard = (sandbox as typeof sandbox & { JiashuAccountSession: AccountSession }).JiashuAccountSession;
  return { guard, context, calls, attributes, events,
    account(owner: string) { current=owner; }, identity(run: () => Promise<Response>) { session=run; },
    fetch(url: string, init?: RequestInit) { return sandbox.fetch(url,init); },
  };
}

void test('SSR owner binding blocks an old page first used only after another account signs in',async()=>{
  const f=fixture({pageOwner:'alice'});f.account('bob');
  const response=await f.fetch('/api/health/nutrition',{method:'POST',body:'alice private draft'});
  assert.equal(response.status,401);assert.equal((await response.json() as {code:string}).code,'ACCOUNT_CHANGED');
  assert.equal(f.guard.owner,'alice');assert.equal(f.guard.changed,true);assert.equal(f.guard.bind('bob'),false);
  assert.deepEqual(f.calls.map((call)=>call.url),['/api/session']);
  assert.equal(f.attributes.has('data-account-changed'),true);assert.deepEqual(f.events,['jiashu-account-changed']);
  assert.equal((await f.fetch('/api/health/records',{method:'POST',body:'still alice'})).status,401);
  assert.equal(f.calls.length,1,'a changed document never sends an original-owner payload to the new session');
});

void test('without an SSR identity a standalone renderer neither adopts a session baseline nor changes its requests',async()=>{
  const f=fixture();assert.equal(f.guard.bind('alice'),true);assert.equal(f.guard.owner,'');
  const response=await f.fetch('/api/health/nutrition',{method:'POST',body:'standalone-fixture'});
  assert.equal(response.status,200);assert.deepEqual(f.calls.map((call)=>call.url),['/api/health/nutrition']);
  assert.equal(new Headers(f.calls[0].options.headers).get('X-Page-Owner'),null);
  await assert.rejects(f.guard.verify(),(error:unknown)=>(error as {code:string}).code==='ACCOUNT_SESSION_UNBOUND');
});

void test('bound requests carry the immutable owner, preserve the original payload and coalesce concurrent checks',async()=>{
  const f=fixture({pageOwner:'alice'});
  const [one,two]=await Promise.all([
    f.fetch('/api/finance/accounts',{method:'POST',headers:{'Idempotency-Key':'original-key'},body:'original-bytes'}),
    f.fetch('/api/health'),
  ]);
  assert.equal(one.status,200);assert.equal(two.status,200);
  assert.equal(f.calls.filter((call)=>call.url==='/api/session').length,1);
  const sent=f.calls.find((call)=>call.url==='/api/finance/accounts')!;
  assert.equal(new Headers(sent.options.headers).get('X-Page-Owner'),'alice');
  assert.equal(new Headers(sent.options.headers).get('Idempotency-Key'),'original-key');assert.equal(sent.options.body,'original-bytes');
});

void test('a session change between preflight and response cannot expose the new account data',async()=>{
  let changed=()=>{};
  const f=fixture({pageOwner:'alice',response:async()=>{changed();return Response.json({private:'bob-secret'});}});
  changed=()=>f.account('bob');
  const response=await f.fetch('/api/overview');assert.equal(response.status,401);
  assert.ok(!(await response.text()).includes('bob-secret'));assert.equal(f.guard.owner,'alice');
});

void test('a response from an old in-flight request is withheld if another identity check already marked the document changed',async()=>{
  let finish:((response:Response)=>void)|undefined;
  const f=fixture({pageOwner:'alice',response:()=>new Promise((resolve)=>{finish=resolve;})});
  const pending=f.fetch('/api/health');
  for(let count=0;count<20&&!finish;count++)await new Promise<void>((resolve)=>setImmediate(resolve));
  assert.ok(finish);assert.equal(f.guard.bind('bob'),false);
  finish(Response.json({private:'alice-private'},{headers:{'X-Account-Owner':'alice'}}));
  const response=await pending;assert.equal(response.status,401);assert.ok(!(await response.text()).includes('alice-private'));
});

void test('server owner mismatch is normalized to an auth rejection so pending UI cannot clear its original operation',async()=>{
  const f=fixture({pageOwner:'alice',response:async()=>Response.json({error:'changed',code:'ACCOUNT_CHANGED'},{status:409})});
  const response=await f.fetch('/api/finance/accounts',{method:'POST',body:'original'});
  assert.equal(response.status,401);assert.equal(f.guard.changed,true);
  assert.equal((await response.json() as {code:string}).code,'ACCOUNT_CHANGED');
});

void test('an aborted shared request cannot send a mutation after a delayed identity check eventually resolves',async()=>{
  const f=fixture({pageOwner:'alice'});let finish:((response:Response)=>void)|undefined;
  f.identity(()=>new Promise((resolve)=>{finish=resolve;}));
  const controller=new AbortController();const pending=f.fetch('/api/health/nutrition',{method:'POST',body:'draft',signal:controller.signal});
  controller.abort();finish!(Response.json({userId:'alice'}));
  await assert.rejects(pending,(error:unknown)=>(error as Error).name==='AbortError');
  assert.deepEqual(f.calls.map((call)=>call.url),['/api/session']);
});

void test('a failed identity read leaves original owner bound and a retry can succeed without sending draft bytes early',async()=>{
  const f=fixture({pageOwner:'alice'});f.identity(async()=>Response.json({error:'暂时无法核对使用权限',code:'ACCOUNT_ACCESS_UNAVAILABLE'},{status:503,headers:{'Retry-After':'3'}}));
  assert.equal((await f.fetch('/api/health/nutrition',{method:'POST',body:'private'})).status,503);
  assert.equal(f.guard.owner,'alice');assert.equal(f.guard.changed,false);assert.equal(f.calls.length,1);
  f.identity(async()=>Response.json({userId:'alice'}));assert.equal((await f.fetch('/api/health/nutrition',{method:'POST',body:'private'})).status,200);
  assert.deepEqual(f.events,[]);assert.equal(f.attributes.has('data-account-changed'),false);
  assert.equal(f.calls.at(-1)?.options.body,'private');
});

void test('external requests and the read-only identity endpoint do not receive owner headers',async()=>{
  const f=fixture({pageOwner:'alice'});await f.fetch('https://other.example/resource');await f.fetch('/api/session');
  assert.deepEqual(f.calls.map((call)=>call.url),['https://other.example/resource','/api/session']);
  assert.equal(new Headers(f.calls[0].options.headers).get('X-Page-Owner'),null);
});

void test('requestJSON uses the account guard and preserves auth mismatch codes for all shared business clients',async()=>{
  const f=fixture({pageOwner:'alice'});f.account('bob');
  const request=runInNewContext(CLIENT_REQUEST_SCRIPT+'\nrequestJSON;',f.context) as (url:string,options:RequestInit)=>Promise<unknown>;
  await assert.rejects(request('/api/finance/accounts',{method:'POST',body:'A bytes'}),(error:unknown)=>{
    assert.equal((error as {status:number}).status,401);assert.equal((error as {code:string}).code,'ACCOUNT_CHANGED');return true;
  });
  assert.equal(f.calls.length,1);
});

void test('inline account bootstrap cannot break out of its script and retains only an opaque owner',()=>{
  const html=renderAccountSessionScript('owner</script>\u2028');
  assert.equal((html.match(/<\/script>/g)||[]).length,1);assert.ok(!html.includes('owner</script>'));
  assert.ok(html.includes('owner\\u003c/script>\\u2028'));
});
