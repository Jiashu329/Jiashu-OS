import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { normalizeUserCoverUrl, UserCoverError } from '../lib/douban-cover-selection.ts';
import { writeUserCover } from './douban-cover-selection-store.ts';
import { commitDoubanStep, readDoubanRecord, startDoubanRun, writeDoubanConnection, type DoubanDatabase } from './douban-store.ts';
import { listDoubanLibrary, writeDoubanLocalRecord } from './douban-library-store.ts';
import { previewDoubanReset, commitDoubanReset } from './douban-reset-store.ts';
import { saveDoubanSubjectMetadata } from './douban-metadata-store.ts';

const NOW='2026-11-15T08:00:00.000Z', NEXT='2026-11-15T08:01:00.000Z', URL='https://images.example.com/poster.jpg';
const key={profileId:'profile',domain:'screen' as const,subjectId:'1'};
function fixture(t:TestContext){
 const sqlite=new DatabaseSync(':memory:'),directory=new globalThis.URL('../drizzle/',import.meta.url);
 for(const name of readdirSync(directory).filter(name=>/^\d+.*\.sql$/.test(name)).sort())sqlite.exec(readFileSync(new globalThis.URL(name,directory),'utf8'));
 t.after(()=>sqlite.close());
 const db={prepare(sql:string){const statement=sqlite.prepare(sql);let values:SQLInputValue[]=[];const bound={bind(...args:unknown[]){values=args as SQLInputValue[];return bound;},async first<T>(){return statement.get(...values)as T??null;},async all<T>(){return{results:statement.all(...values)as T[]};},execute(){return{results:statement.columns().length?statement.all(...values):(statement.run(...values),[])};}};return bound;},async batch(statements:Array<{execute():unknown}>){sqlite.exec('BEGIN');try{const result=statements.map(statement=>statement.execute());sqlite.exec('COMMIT');return result;}catch(error){sqlite.exec('ROLLBACK');throw error;}}}as unknown as DoubanDatabase;
 const add=(owner='alice')=>sqlite.prepare(`INSERT INTO douban_items(user_id,profile_id,domain,subject_id,kind,title,url,cover_url,source,observed_at,created_at,updated_at,details_json)VALUES(?,?,'screen','1','movie','synthetic','https://movie.douban.com/subject/1/','https://img1.doubanio.com/view/photo/public/p1.jpg','browser',?,?,?,?)`).run(owner,key.profileId,NOW,NOW,NOW,JSON.stringify({summary:'简介',directors:['导演']}));
 add();return{db,sqlite,add};
}
function command(revision=0){return{...key,expectedDataEpoch:0,expectedLocalRevision:revision,mode:'url' as const,url:URL};}

test('manual links accept canonical public HTTPS only, without widening the official image fetch boundary',()=>{
 assert.equal(normalizeUserCoverUrl(URL+'#fragment'),URL);
 assert.equal(normalizeUserCoverUrl('https://IMAGES.example.com:443/poster.jpg'),URL);
 for(const value of ['http://images.example.com/a.jpg','javascript:alert(1)','data:image/png,abc','https://user:password@images.example.com/a','https://127.0.0.1/a','https://2130706433/a','https://0x7f000001/a','https://[::1]/a','https://10.0.0.1/a','https://localhost/a','https://x.local/a','https://x.internal/a','https://x.test/a','https://images.example.com:8443/a','https://images.example.com/a\n.jpg','https://images.example.com/a\\b','https://images.example.com/'+ '书'.repeat(300)])assert.throws(()=>normalizeUserCoverUrl(value),UserCoverError,value);
});

test('saving and restoring a manual cover uses local revisions and preserves imported cover metadata and notes',async t=>{
 const f=fixture(t);await writeDoubanLocalRecord(f.db,'alice',{...key,expectedDataEpoch:0,expectedLocalRevision:0,note:'个人备注',tags:['标签'],hidden:false});
 const before=await readDoubanRecord(f.db,'alice',key),saved=await writeUserCover(f.db,'alice',command(1));
 assert.deepEqual(saved.cover,{mode:'url',url:URL,revision:2});assert.equal(saved.local.note,'个人备注');assert.deepEqual(saved.local.tags,['标签']);assert.equal(saved.coverUrl,before!.coverUrl);assert.equal(saved.updatedAt,before!.updatedAt);
 assert.equal((await listDoubanLibrary(f.db,'alice',{missing:true})).total,0);
 const restored=await writeUserCover(f.db,'alice',{...command(2),mode:'original',url:undefined});
 assert.deepEqual(restored.cover,{mode:'original',revision:3});assert.equal(restored.coverUrl,before!.coverUrl);assert.equal(restored.local.note,'个人备注');
});

test('manual covers survive browser synchronization and an exact retry does not increment local revisions twice',async t=>{
 const f=fixture(t);await writeUserCover(f.db,'alice',command());
 const retry=await writeUserCover(f.db,'alice',command());assert.equal(retry.local.revision,1);
 const connection=await writeDoubanConnection(f.db,'alice','profile',0,NOW),run=await startDoubanRun(f.db,'alice',connection.revision,{},NOW);
 await commitDoubanStep(f.db,'alice',{runId:run.id,expectedRevision:run.revision,connectionRevision:connection.revision,items:[{domain:'screen',subjectId:'1',kind:'movie',title:'updated',url:'https://movie.douban.com/subject/1/',coverUrl:'https://img1.doubanio.com/view/photo/public/p2.jpg',rating:null,comment:null,markedDate:null,publishedAt:null,source:'browser'}],state:{},status:'completed',now:NEXT});
 const after=(await listDoubanLibrary(f.db,'alice')).items[0];assert.equal(after.title,'updated');assert.deepEqual(after.cover,{mode:'url',url:URL,revision:1});
 await saveDoubanSubjectMetadata(f.db,'alice',after,{kind:'movie',coverUrl:'https://img1.doubanio.com/view/photo/public/p3.jpg',details:{summary:'更新简介'}},'2026-11-15T08:02:00.000Z',0);
 const enriched=(await listDoubanLibrary(f.db,'alice')).items[0];assert.equal(enriched.coverUrl,'https://img1.doubanio.com/view/photo/public/p3.jpg');assert.deepEqual(enriched.cover,{mode:'url',url:URL,revision:1});
});

test('owner, local revision and reset epochs fence manual cover writes, and cover edits invalidate old clear previews',async t=>{
 const f=fixture(t),preview=await previewDoubanReset(f.db,'alice');
 await assert.rejects(writeUserCover(f.db,'bob',command()),{status:404});
 await writeUserCover(f.db,'alice',command());
 await assert.rejects(writeUserCover(f.db,'alice',{...command(),url:'https://images.example.com/other.jpg'}),{status:409});
 await assert.rejects(commitDoubanReset(f.db,'alice',{expectedEpoch:0,expectedPreviewHash:preview.previewHash,requestId:'11111111-1111-4111-8111-111111111111',confirmed:true,now:NEXT}),{status:409});
 const current=await previewDoubanReset(f.db,'alice');await commitDoubanReset(f.db,'alice',{expectedEpoch:0,expectedPreviewHash:current.previewHash,requestId:'22222222-2222-4222-8222-222222222222',confirmed:true,now:NEXT});
 f.add();await assert.rejects(writeUserCover(f.db,'alice',command()),{code:'DOUBAN_DATA_EPOCH_CONFLICT'});
 assert.equal(f.sqlite.prepare('SELECT local_cover_url AS url FROM douban_items').get()?.url,null);
});
