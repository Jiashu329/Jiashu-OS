import assert from 'node:assert/strict';
import { readFileSync,readdirSync } from 'node:fs';
import { DatabaseSync,type SQLInputValue } from 'node:sqlite';
import test,{type TestContext} from 'node:test';
import { parseIMDbRatingsCommand,syncDoubanIMDbRatings,IMDbRatingsRefreshBusyError,type IMDbRatingsCommand } from './douban-imdb-ratings-store.ts';
import { readDoubanLibraryRecord } from './douban-library-store.ts';
import { doubanDetailsJson,type DoubanDatabase } from './douban-store.ts';
import { IMDbRatingsProviderError,type IMDbRatingsLookupResult } from '../lib/imdb-ratings-provider.ts';
import type { IMDbRating } from '../lib/imdb-rating.ts';
const NOW='2026-11-15T08:00:00.000Z',OLD='2026-11-14T07:00:00.000Z',NEXT='2026-11-15T09:00:00.000Z';
const REQUEST='11111111-2222-4333-8444-555555555555';
const item=(subjectId:string,imdbId='tt1234567')=>({profileId:'profile',domain:'screen' as const,subjectId,expectedUpdatedAt:NOW,expectedImdbId:imdbId});
const command=(items=[item('1'),item('2','tt7654321')],requestId=REQUEST):IMDbRatingsCommand=>({requestId,expectedDataEpoch:0,confirmed:true,items});
const rating=(imdbId:string,checkedAt=NEXT):IMDbRating=>({imdbId,rating:8.4,ratingCount:4321,source:'imdb-datasets',checkedAt,datasetDate:'2026-11-14'});
function fixture(t:TestContext){
 const sqlite=new DatabaseSync(':memory:'),directory=new URL('../drizzle/',import.meta.url);for(const name of readdirSync(directory).filter(name=>/^\d+.*\.sql$/.test(name)).sort())sqlite.exec(readFileSync(new URL(name,directory),'utf8'));t.after(()=>sqlite.close());let queries=0,beforeBatch:(()=>void)|null=null;
 const db={prepare(sql:string){queries++;const statement=sqlite.prepare(sql);let values:SQLInputValue[]=[];const bound={bind(...args:unknown[]){values=args as SQLInputValue[];return bound;},async first<T>(){return statement.get(...values) as T??null;},async all<T>(){return{results:statement.all(...values) as T[]};},execute(){return{results:statement.columns().length?statement.all(...values):(statement.run(...values),[])};}};return bound;},async batch(statements:Array<{execute():unknown}>){beforeBatch?.();beforeBatch=null;sqlite.exec('BEGIN');try{const result=statements.map(statement=>statement.execute());sqlite.exec('COMMIT');return result;}catch(error){sqlite.exec('ROLLBACK');throw error;}}} as unknown as DoubanDatabase;
 const insert=(subjectId:string,imdbId:string,user='alice')=>sqlite.prepare(`INSERT INTO douban_items(user_id,profile_id,domain,subject_id,kind,title,url,cover_url,rating,source,observed_at,created_at,updated_at,details_json,local_note,local_tags_json,local_hidden,local_revision,local_cover_url)
 VALUES(?, 'profile','screen',?,'movie','合成电影',?, 'https://img1.doubanio.com/view/photo/public/p1.jpg',4,'browser',?,?,?,?,'保留备注','["标签"]',0,3,'https://images.example.com/manual.jpg')`).run(user,subjectId,'https://movie.douban.com/subject/'+subjectId+'/',NOW,NOW,NOW,doubanDetailsJson({imdbId,doubanRating:9.1,summary:'简介',directors:['导演']}));
 insert('1','tt1234567');insert('2','tt7654321');insert('3','tt2345678');
 return{db,sqlite,insert,queries:()=>queries,beforeBatch(hook:()=>void){beforeBatch=hook;}};
}
function lookupFor(calls:string[][],missingIds:string[]=[]){return async(ids:readonly string[]):Promise<IMDbRatingsLookupResult>=>{calls.push([...ids]);return{ratings:ids.filter(id=>!missingIds.includes(id)).map(id=>rating(id)),missingIds:ids.filter(id=>missingIds.includes(id)),checkedAt:NEXT,datasetDate:'2026-11-14'};};}
test('one public scan fills this personal library and an immutable receipt replays without another download or source write',async t=>{
 const f=fixture(t),calls:string[][]=[];const saved=await syncDoubanIMDbRatings(f.db,'alice',command(),{now:NEXT,lookup:lookupFor(calls)});
 assert.equal(calls.length,1);assert.deepEqual(new Set(calls[0]),new Set(['tt1234567','tt7654321','tt2345678']));assert.deepEqual(saved.receipt,{requestId:REQUEST,requested:2,updated:2,missing:0,checkedAt:NEXT});assert.equal(saved.items[0].imdb?.rating,8.4);assert.equal(saved.items[0].details?.doubanRating,9.1);assert.equal(saved.items[0].rating,4);assert.equal(saved.items[0].local.revision,3);assert.equal(saved.items[0].cover.mode,'url');assert.equal(saved.items[0].coverUrl,'https://img1.doubanio.com/view/photo/public/p1.jpg');
 const retried=await syncDoubanIMDbRatings(f.db,'alice',command(),{now:NEXT,lookup:async()=>{throw new Error('must not query');}});assert.deepEqual(retried.receipt,saved.receipt);assert.equal(retried.items[0].updatedAt,NEXT);
 const third=await syncDoubanIMDbRatings(f.db,'alice',command([item('3','tt2345678')],'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'),{now:NEXT,lookup:async()=>{throw new Error('cache must satisfy');}});assert.equal(third.items[0].imdb?.rating,8.4);assert.ok(f.queries()<48);assert.equal(f.sqlite.prepare('SELECT count(*) n FROM imdb_ratings_refresh_leases').get()?.n,0);
});
test('a completed missing result preserves an old successful score and stores a negative cache without inventing zero',async t=>{
 const f=fixture(t);f.sqlite.prepare('UPDATE douban_items SET imdb_rating_json=? WHERE subject_id=\'1\'').run(JSON.stringify(rating('tt1234567',OLD)));
 const saved=await syncDoubanIMDbRatings(f.db,'alice',command(),{now:NEXT,lookup:lookupFor([],['tt1234567','tt7654321'])});assert.equal(saved.receipt.updated,0);assert.equal(saved.receipt.missing,2);assert.equal(saved.items[0].imdb?.checkedAt,OLD);assert.equal(saved.items[1].imdb,null);assert.equal(saved.items[1].updatedAt,NOW);
 const again=await syncDoubanIMDbRatings(f.db,'alice',command(undefined,'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff'),{now:NEXT,lookup:async()=>{throw new Error('negative cache must satisfy');}});assert.equal(again.receipt.missing,2);assert.equal(again.items[0].imdb?.rating,8.4);
});
test('owner, all source versions, IMDb identity and reset epochs are verified before the public lookup',async t=>{
 const f=fixture(t);let calls=0;const options={now:NEXT,lookup:async():Promise<IMDbRatingsLookupResult>=>{calls++;throw new Error('not called');}};
 for(const [owner,body]of[['bob',command()],['alice',command([item('1','tt0000001')])],['alice',command([{...item('1'),expectedUpdatedAt:NEXT}])]]as const)await assert.rejects(syncDoubanIMDbRatings(f.db,owner,body,options),{code:'DOUBAN_RECORD_CONFLICT'});
 f.sqlite.exec(`INSERT INTO douban_data_resets VALUES('alice',1,'request','hash','{}','${NOW}','${NOW}')`);await assert.rejects(syncDoubanIMDbRatings(f.db,'alice',command(),options),{code:'DOUBAN_DATA_EPOCH_CONFLICT'});assert.equal(calls,0);assert.equal(f.sqlite.prepare('SELECT count(*) n FROM douban_imdb_ratings_receipts').get()?.n,0);
});
test('a source failure or an active lease cannot erase scores, cache a partial scan or acknowledge a successful receipt',async t=>{
 const f=fixture(t);await assert.rejects(syncDoubanIMDbRatings(f.db,'alice',command(),{now:NEXT,lookup:async()=>{throw new IMDbRatingsProviderError('IMDB_UNAVAILABLE');}}),{code:'IMDB_UNAVAILABLE'});assert.equal(f.sqlite.prepare('SELECT count(*) n FROM imdb_ratings_cache').get()?.n,0);assert.equal(f.sqlite.prepare('SELECT count(*) n FROM imdb_ratings_refresh_leases').get()?.n,0);
 f.sqlite.prepare('INSERT INTO imdb_ratings_refresh_leases VALUES(?,?,?)').run('official-dataset','other','2026-11-15T10:00:00.000Z');await assert.rejects(syncDoubanIMDbRatings(f.db,'alice',command(),{now:NEXT,lookup:async()=>{throw new Error('must not fetch');}}),IMDbRatingsRefreshBusyError);assert.equal(f.sqlite.prepare('SELECT count(*) n FROM douban_imdb_ratings_receipts').get()?.n,0);
});
test('a changed member during lookup fences the entire write while retaining only public cache',async t=>{
 const f=fixture(t);f.beforeBatch(()=>f.sqlite.prepare('UPDATE douban_items SET updated_at=? WHERE subject_id=\'2\'').run(NEXT));await assert.rejects(syncDoubanIMDbRatings(f.db,'alice',command(),{now:NEXT,lookup:lookupFor([])}),{code:'DOUBAN_RECORD_CONFLICT'});assert.equal(f.sqlite.prepare('SELECT count(*) n FROM douban_items WHERE imdb_rating_json<>\'{}\'').get()?.n,0);assert.equal(f.sqlite.prepare('SELECT count(*) n FROM douban_imdb_ratings_receipts').get()?.n,0);assert.ok(Number(f.sqlite.prepare('SELECT count(*) n FROM imdb_ratings_cache').get()?.n)>0);
});
test('a reset during the scan cannot resurrect user records or receipts',async t=>{
 const f=fixture(t);await assert.rejects(syncDoubanIMDbRatings(f.db,'alice',command(),{now:NEXT,lookup:async ids=>{f.sqlite.exec(`DELETE FROM douban_items WHERE user_id='alice';INSERT INTO douban_data_resets VALUES('alice',1,'request','hash','{}','${NEXT}','${NEXT}')`);return lookupFor([])(ids);}}),{code:'DOUBAN_DATA_EPOCH_CONFLICT'});assert.equal(f.sqlite.prepare('SELECT count(*) n FROM douban_items').get()?.n,0);assert.equal(f.sqlite.prepare('SELECT count(*) n FROM douban_imdb_ratings_receipts').get()?.n,0);
});
test('request identities cannot be reused for another payload and a changed IMDb hides older ratings',async t=>{
 const f=fixture(t);await syncDoubanIMDbRatings(f.db,'alice',command(),{now:NEXT,lookup:lookupFor([])});await assert.rejects(syncDoubanIMDbRatings(f.db,'alice',command([item('3','tt2345678')]),{now:NEXT,lookup:lookupFor([])}),{code:'IMDB_RATINGS_REQUEST_CONFLICT'});
 f.sqlite.prepare('UPDATE douban_items SET details_json=? WHERE subject_id=\'1\'').run(doubanDetailsJson({imdbId:'tt9999999'}));assert.equal((await readDoubanLibraryRecord(f.db,'alice',item('1')))?.imdb,null);await assert.rejects(syncDoubanIMDbRatings(f.db,'alice',command(),{now:NEXT,lookup:lookupFor([])}),{code:'DOUBAN_RECORD_CONFLICT'});
});
test('duplicate-key and browser-supplied ratings never reach the batch store',()=>{for(const body of[{...command(),items:[item('1'),item('1')]},{...command(),items:[{...item('1'),rating:9.9}]},{...command(),items:[{...item('1'),domain:'book'}]},{...command(),items:[{...item('1'),expectedUpdatedAt:'2026-11-15T08:00:00Z'}]}])assert.throws(()=>parseIMDbRatingsCommand(body),{code:'INVALID_DOUBAN_INPUT'});});
test('concurrent local edits survive a ratings scan and duplicate batches write one immutable receipt',async t=>{
 const f=fixture(t);const lookup=async(ids:readonly string[])=>{f.sqlite.exec("UPDATE douban_items SET local_note='扫描期间编辑',local_revision=4,local_cover_url='https://images.example.com/updated.jpg' WHERE subject_id='1'");return lookupFor([])(ids);};
 const first=await syncDoubanIMDbRatings(f.db,'alice',command(),{now:NEXT,lookup});assert.equal(first.items[0].local.note,'扫描期间编辑');assert.equal(first.items[0].local.revision,4);assert.equal(first.items[0].cover.mode,'url');
 const body=command([item('3','tt2345678')],'cccccccc-dddd-4eee-8fff-111111111111'),options={now:NEXT,lookup:async():Promise<IMDbRatingsLookupResult>=>{throw new Error('cache already complete');}};
 const [left,right]=await Promise.all([syncDoubanIMDbRatings(f.db,'alice',body,options),syncDoubanIMDbRatings(f.db,'alice',body,options)]);assert.deepEqual(left.receipt,right.receipt);assert.equal(left.items[0].updatedAt,NEXT);assert.equal(right.items[0].updatedAt,NEXT);assert.equal(f.sqlite.prepare('SELECT count(*) n FROM douban_imdb_ratings_receipts WHERE request_id=?').get(body.requestId)?.n,1);
});
