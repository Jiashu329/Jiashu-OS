import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { ACCOUNT_SESSION_SCRIPT, renderAccountSessionScript } from './account-session.ts';
import { CLIENT_REQUEST_SCRIPT } from './client-request.ts';

interface AccountSession {
  owner: string; changed: boolean; problem: string; attested: boolean;
  bind(owner: string): boolean;
  readIdentity(): Promise<{ userId: string }>;
  invalidate(): void;
  verify(): Promise<string>;
  request(url: string | URL | Request, options?: RequestInit): Promise<Response>;
}
interface Call { url: string; options: RequestInit }
type SessionBootstrap = { userId: string; displayName: string; email: string; isOwner: boolean };
interface Channel { name: string; closed: boolean; onmessage: ((event: { data: unknown }) => void) | null }
function fixture(options: { pageOwner?: string; bootstrap?: SessionBootstrap; bus?: Channel[]; storage?: Map<string, string>; response?: (call: Call) => Promise<Response> } = {}) {
  const calls: Call[] = [];
  const storageWrites: Array<{ key: string; value: string }> = [];
  const stored = options.storage ?? new Map<string, string>();
  const attributes = new Map<string,string>();
  const events: string[] = [];
  let current = options.pageOwner ?? 'alice';
  let session: (() => Promise<Response>) | null = null;
  const listeners = new Map<string, Array<(event: Event) => void>>();
  class SessionChannel implements Channel {
    name: string; closed = false; onmessage: ((event: { data: unknown }) => void) | null = null;
    constructor(name: string) { this.name = name; options.bus!.push(this); }
    postMessage(data: unknown) { for (const target of options.bus!) if (target !== this && !target.closed && target.name === this.name) target.onmessage?.({ data }); }
    close() { this.closed = true; }
  }
  const sandbox = {
    __JIASHU_PAGE_OWNER__: options.pageOwner,
    __JIASHU_PAGE_SESSION__: options.bootstrap,
    addEventListener(type: string, handler: (event: Event) => void) { const items = listeners.get(type) ?? []; items.push(handler); listeners.set(type, items); },
    document: { documentElement: { setAttribute(key: string, value: string) { attributes.set(key,value); } },
      dispatchEvent(event: Event) { events.push(event.type); } },
    location: new URL('https://synthetic-account.example/health/nutrition'),
    localStorage: { getItem(key: string) { return stored.get(key) ?? null; }, setItem(key: string, value: string) { stored.set(key, value); storageWrites.push({ key, value }); } },
    URL, Headers, Response, AbortController, Event, setTimeout, clearTimeout, BroadcastChannel: options.bus ? SessionChannel : undefined,
    fetch: async (url: string | URL | Request, init: RequestInit = {}) => {
      const call = { url: typeof url === 'object' && 'url' in url ? url.url : String(url), options: init };calls.push(call);
      if (call.url === '/api/session') return session ? session() : Response.json({ userId: current });
      return options.response ? options.response(call) : Response.json({ ok:true }, { headers: { 'X-Account-Owner': current } });
    },
  };
  const context = { ...sandbox, window: sandbox };
  runInNewContext(ACCOUNT_SESSION_SCRIPT, context);
  const guard = (sandbox as typeof sandbox & { JiashuAccountSession: AccountSession }).JiashuAccountSession;
  return { guard, context, calls, attributes, events, storageWrites,
    fire(type: string, values: Record<string, unknown> = {}) { const event = Object.assign(new Event(type), values); for (const handler of listeners.get(type) ?? []) handler(event); },
    account(owner: string) { current=owner; }, identity(run: () => Promise<Response>) { session=run; },
    fetch(url: string | URL | Request, init?: RequestInit) { return sandbox.fetch(url,init); },
  };
}

const bootstrap = (userId = 'alice'): SessionBootstrap => ({ userId, displayName: userId, email: userId + '@example.test', isOwner: userId === 'alice' });

void test('server bootstrap avoids read preflights while every response attests the same immutable owner', async () => {
  const f = fixture({ pageOwner: 'alice', bootstrap: bootstrap() });
  assert.equal(f.guard.attested, true);
  for (const path of ['/api/health', '/api/finance', '/api/life/douban']) assert.equal((await f.fetch(path)).status, 200);
  assert.equal(f.calls.some(call => call.url === '/api/session'), false);
  assert.ok(f.calls.every(call => new Headers(call.options.headers).get('X-Page-Owner') === 'alice'));
  assert.equal(f.attributes.has('data-account-verifying'), false);
});

void test('server-confirmed mutations recheck identity before sending draft bytes and honor the effective Request method', async () => {
  const f = fixture({ pageOwner: 'alice', bootstrap: bootstrap() });
  for (const method of ['GET', 'HEAD', 'OPTIONS']) assert.equal((await f.fetch('/api/health', { method })).status, 200);
  assert.equal(f.calls.some(call => call.url === '/api/session'), false);
  assert.equal((await f.fetch('/api/health', { method: 'POST', body: 'alice-draft' })).status, 200);
  assert.equal(f.calls.filter(call => call.url === '/api/session').length, 1);
  const request = new Request('https://synthetic-account.example/api/health', { method: 'PUT' });
  assert.equal((await f.fetch(request)).status, 200);
  assert.equal(f.calls.filter(call => call.url === '/api/session').length, 2, 'Request.method also requires a fresh check');
  assert.equal((await f.fetch(request, { method: 'GET' })).status, 200);
  assert.equal(f.calls.filter(call => call.url === '/api/session').length, 2, 'an explicit method overrides the Request method');
  f.account('bob');
  const writesBefore = f.calls.filter(call => call.url !== '/api/session').length;
  assert.equal((await f.fetch(request, { method: 'DELETE' })).status, 401);
  assert.equal(f.calls.filter(call => call.url !== '/api/session').length, writesBefore, 'a switched session never receives the previous owner payload');
});

void test('a mismatched bootstrap stays unconfirmed and cannot alter the document owner', async () => {
  const f = fixture({ pageOwner: 'alice', bootstrap: bootstrap('bob') });
  assert.equal(f.guard.attested, false); assert.equal(f.attributes.has('data-account-verifying'), true);
  await f.fetch('/api/health'); assert.equal(f.calls[0].url, '/api/session'); assert.equal(f.guard.owner, 'alice');
});

void test('known sign-out revokes the confirmed client guard while ordinary permission denials keep the account usable', async () => {
  const denied = fixture({ pageOwner: 'alice', bootstrap: bootstrap(), response: async () => Response.json({ code: 'LOCAL_USER_FORBIDDEN' }, { status: 403, headers: { 'X-Account-Owner': 'alice' } }) });
  assert.equal((await denied.fetch('/api/admin/users')).status, 403); assert.equal(denied.guard.changed, false);
  const ended = fixture({ pageOwner: 'alice', bootstrap: bootstrap(), response: async () => Response.json({ code: 'SIGN_IN_REQUIRED' }, { status: 401 }) });
  assert.equal((await ended.fetch('/api/health')).status, 401); assert.equal(ended.guard.changed, true);
  assert.equal(ended.guard.attested, false); assert.deepEqual(ended.events, ['jiashu-account-signed-out']);
});

void test('invalidating a cached document isolates stale verification responses from the fresh restored check', async () => {
  const f = fixture({ pageOwner: 'alice', bootstrap: bootstrap() });
  let finishOld!: (response: Response) => void, finishNew!: (response: Response) => void;
  const resolvers = [() => new Promise<Response>(resolve => { finishOld = resolve; }), () => new Promise<Response>(resolve => { finishNew = resolve; })];
  f.identity(() => resolvers.shift()!());
  const old = f.guard.readIdentity().catch(error => error as { code: string });
  f.fire('pagehide', { persisted: true });
  assert.equal(f.guard.attested, false); assert.equal(f.attributes.has('data-account-verifying'), true);
  const restored = f.guard.readIdentity().catch(error => error as { code: string });
  finishNew(Response.json({ userId: 'bob' }));
  await restored;
  finishOld(Response.json({ userId: 'alice' }));
  await old;
  assert.equal(f.guard.changed, true); assert.equal(f.guard.attested, false); assert.equal(f.guard.owner, 'alice');
});

void test('a superseded old-owner mismatch cannot undo a newer successful same-owner check', async () => {
  const f = fixture({ pageOwner: 'alice', bootstrap: bootstrap() }); let finish!: (response: Response) => void;
  f.identity(() => new Promise(resolve => { finish = resolve; }));
  const old = f.guard.readIdentity().catch(error => error as { code: string });
  f.guard.invalidate(); f.identity(async () => Response.json({ userId: 'alice' }));
  await f.guard.readIdentity(); finish(Response.json({ userId: 'bob' })); await old;
  assert.equal(f.guard.attested, true); assert.equal(f.guard.changed, false);
});

void test('a freshly authorized different-owner tab invalidates late responses without trusting the broadcast as identity', async () => {
  const bus: Channel[] = []; let finish!: (response: Response) => void;
  const alice = fixture({ pageOwner: 'alice', bootstrap: bootstrap(), bus, response: () => new Promise(resolve => { finish = resolve; }) });
  const pending = alice.fetch('/api/overview');
  const bob = fixture({ pageOwner: 'bob', bootstrap: bootstrap('bob'), bus });
  assert.equal(alice.guard.changed, true); assert.equal(bob.guard.changed, false);
  finish(Response.json({ private: 'alice-only' }, { headers: { 'X-Account-Owner': 'alice' } }));
  const withheld = await pending; assert.equal(withheld.status, 401); assert.ok(!(await withheld.text()).includes('alice-only'));
  assert.equal(alice.guard.owner, 'alice'); assert.equal(alice.calls.some(call => call.url === '/api/session'), false);
});

void test('same-owner navigation broadcasts do not hide or invalidate another confirmed page', () => {
  const bus: Channel[] = [];
  const one = fixture({ pageOwner: 'alice', bootstrap: bootstrap(), bus });
  fixture({ pageOwner: 'alice', bootstrap: bootstrap(), bus });
  assert.equal(one.guard.changed, false); assert.equal(one.guard.attested, true); assert.equal(one.events.length, 0);
  one.fire('storage', { key: 'jiashu:session-notice', newValue: JSON.stringify({ kind: 'identity', owner: 'bob' }) });
  assert.equal(one.guard.changed, true); assert.equal(one.guard.owner, 'alice');
});

void test('same-owner identity checks and navigation do not rewrite the durable session notice', async () => {
  const storage = new Map<string, string>();
  const first = fixture({ pageOwner: 'alice', bootstrap: bootstrap(), storage });
  assert.deepEqual(first.storageWrites, [{ key: 'jiashu:session-notice', value: JSON.stringify({ kind: 'identity', owner: 'alice' }) }]);
  await first.guard.readIdentity(); await first.guard.readIdentity();
  assert.equal(first.storageWrites.length, 1, 'background verification cannot create unrelated durable writes');
  const second = fixture({ pageOwner: 'alice', bootstrap: bootstrap(), storage });
  assert.equal(second.storageWrites.length, 0, 'a same-owner page reuses the existing negative-only notice');
  const different = fixture({ pageOwner: 'bob', bootstrap: bootstrap('bob'), storage });
  assert.deepEqual(different.storageWrites, [{ key: 'jiashu:session-notice', value: JSON.stringify({ kind: 'identity', owner: 'bob' }) }]);
  const legacy = fixture({ pageOwner: 'bob', storage });
  await legacy.guard.readIdentity();
  assert.equal(legacy.storageWrites.length, 0, 'legacy identity reads do not publish a navigation notice');
});

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
