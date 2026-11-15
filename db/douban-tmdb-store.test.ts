import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { readDoubanLibraryRecord, listDoubanLibrary } from './douban-library-store.ts';
import { confirmDoubanTMDBItem, readDoubanTMDBItem, saveDoubanTMDBCover } from './douban-tmdb-store.ts';
import { doubanDetailsJson, type DoubanDatabase } from './douban-store.ts';

const NOW = '2026-11-15T08:00:00.000Z', NEXT = '2026-11-15T08:01:00.000Z';
const key = { profileId: 'profile', domain: 'screen' as const, subjectId: '1' };
const command = { ...key, expectedUpdatedAt: NOW, expectedDataEpoch: 0 };
const cover = { imdbId: 'tt1234567', mediaType: 'movie' as const, tmdbId: 42, posterPath: '/synthetic.jpg', language: 'zh' as const, matchedAt: NOW };
function fixture(t: TestContext) {
  const sqlite = new DatabaseSync(':memory:'), directory = new URL('../drizzle/', import.meta.url);
  for (const name of readdirSync(directory).filter(name => /^\d+.*\.sql$/.test(name)).sort()) sqlite.exec(readFileSync(new URL(name, directory), 'utf8'));
  t.after(() => sqlite.close());
  const db = { prepare(sql: string) { const statement = sqlite.prepare(sql); let values: SQLInputValue[] = [];
    const bound = { bind(...args: unknown[]) { values = args as SQLInputValue[]; return bound; }, async first<T>() { return statement.get(...values) as T ?? null; }, async all<T>() { return { results: statement.all(...values) as T[] }; },
      execute() { return { results: statement.columns().length ? statement.all(...values) : (statement.run(...values), []) }; } }; return bound;
  }, async batch(statements: Array<{ execute(): unknown }>) { sqlite.exec('BEGIN'); try { const result = statements.map(statement => statement.execute()); sqlite.exec('COMMIT'); return result; } catch (error) { sqlite.exec('ROLLBACK'); throw error; } } } as unknown as DoubanDatabase;
  sqlite.prepare(`INSERT INTO douban_items(user_id,profile_id,domain,subject_id,kind,title,url,cover_url,rating,source,observed_at,created_at,updated_at,details_json,local_note,local_tags_json,local_hidden,local_revision,local_cover_url)
    VALUES('alice','profile','screen','1','movie','synthetic','https://movie.douban.com/subject/1/',NULL,4,'browser',?,?,?,?,'保留备注','["保留标签"]',0,3,'https://images.example.com/manual.jpg')`)
    .run(NOW, NOW, NOW, doubanDetailsJson({ imdbId: cover.imdbId, summary: '简介', directors: ['导演'] }));
  return { db, sqlite };
}
test('matches persist independently while preserving manual links, source metadata and local revisions', async t => {
  const f = fixture(t), old = await readDoubanTMDBItem(f.db, 'alice', command), saved = await saveDoubanTMDBCover(f.db, 'alice', old, cover, 0, NEXT);
  assert.equal(saved.changed, true); assert.deepEqual(saved.item.tmdb, cover); assert.equal(saved.item.coverUrl, null); assert.equal(saved.item.rating, 4);
  assert.deepEqual(saved.item.cover, { mode: 'url', revision: 3, url: 'https://images.example.com/manual.jpg' });
  assert.deepEqual(saved.item.local, { revision: 3, note: '保留备注', tags: ['保留标签'], hidden: false });
  assert.equal(saved.item.updatedAt, NEXT); assert.equal(saved.item.observedAt, NEXT);
  const retry = await readDoubanTMDBItem(f.db, 'alice', command); assert.deepEqual(retry.tmdb, cover);
  assert.equal((await saveDoubanTMDBCover(f.db, 'alice', retry, cover, 0, NEXT)).changed, false);
  assert.equal((await listDoubanLibrary(f.db, 'alice', { missing: true })).total, 0);
});
test('active matches require current IMDb and compatible movie or TV classification', async t => {
  const f = fixture(t); f.sqlite.prepare('UPDATE douban_items SET tmdb_cover_json=?').run(JSON.stringify(cover));
  assert.deepEqual((await readDoubanLibraryRecord(f.db, 'alice', key))?.tmdb, cover);
  f.sqlite.exec("UPDATE douban_items SET kind='series',local_cover_url=NULL");
  assert.equal((await readDoubanLibraryRecord(f.db, 'alice', key))?.tmdb, null);
  assert.equal((await listDoubanLibrary(f.db, 'alice', { missing: true })).total, 1);
  await assert.rejects(saveDoubanTMDBCover(f.db, 'alice', await readDoubanTMDBItem(f.db, 'alice', command), cover, 0), { code: 'INVALID_DOUBAN_INPUT' });
  f.sqlite.prepare("UPDATE douban_items SET kind='movie',details_json=?").run(JSON.stringify({ imdbId: 'tt7654321', summary: '简介', directors: ['导演'] }));
  assert.equal((await readDoubanLibraryRecord(f.db, 'alice', key))?.tmdb, null);
  await assert.rejects(saveDoubanTMDBCover(f.db, 'alice', await readDoubanTMDBItem(f.db, 'alice', command), cover, 0), { code: 'INVALID_DOUBAN_INPUT' });
});
test('owner, exact source versions and data resets fence both lookup reads and writes', async t => {
  const f = fixture(t), old = await readDoubanTMDBItem(f.db, 'alice', command);
  await assert.rejects(readDoubanTMDBItem(f.db, 'bob', command), { status: 404 });
  await assert.rejects(readDoubanTMDBItem(f.db, 'alice', { ...command, expectedUpdatedAt: NEXT }), { code: 'DOUBAN_RECORD_CONFLICT' });
  f.sqlite.prepare('UPDATE douban_items SET updated_at=?').run(NEXT);
  await assert.rejects(saveDoubanTMDBCover(f.db, 'alice', old, cover, 0, NEXT), { code: 'DOUBAN_RECORD_CONFLICT' });
  await assert.rejects(confirmDoubanTMDBItem(f.db, 'alice', old, 0), { code: 'DOUBAN_RECORD_CONFLICT' });
  f.sqlite.prepare('INSERT INTO douban_data_resets(user_id,data_epoch,last_request_id,last_request_hash,last_receipt_json,created_at,updated_at)VALUES(?,1,?,?,?, ?,?)')
    .run('alice', 'synthetic-request', 'synthetic-hash', '{}', NEXT, NEXT);
  await assert.rejects(readDoubanTMDBItem(f.db, 'alice', { ...command, expectedUpdatedAt: NEXT }), { code: 'DOUBAN_DATA_EPOCH_CONFLICT' });
  await assert.rejects(saveDoubanTMDBCover(f.db, 'alice', old, cover, 0, NEXT), { code: 'DOUBAN_DATA_EPOCH_CONFLICT' });
  assert.equal(f.sqlite.prepare('SELECT tmdb_cover_json AS value FROM douban_items').get()?.value, '{}');
});
test('a concurrent local edit survives lookup and a concurrent saved match acknowledges an unknown result', async t => {
  const f = fixture(t), old = await readDoubanTMDBItem(f.db, 'alice', command);
  f.sqlite.exec("UPDATE douban_items SET local_note='同步期间修改',local_revision=4");
  const saved = await saveDoubanTMDBCover(f.db, 'alice', old, cover, 0, NEXT);
  assert.equal(saved.item.local.note, '同步期间修改'); assert.equal(saved.item.local.revision, 4);
  const raced = await saveDoubanTMDBCover(f.db, 'alice', old, cover, 0, NEXT);
  assert.equal(raced.changed, false); assert.equal(raced.item.updatedAt, NEXT); assert.equal(raced.item.local.revision, 4);
});
test('legacy records without IMDb remain discoverable even with an original cover', async t => {
  const f = fixture(t); f.sqlite.prepare('UPDATE douban_items SET details_json=?,cover_url=?').run(JSON.stringify({ summary: '简介', directors: ['导演'] }), 'https://img1.doubanio.com/view/photo/public/p1.jpg');
  assert.equal((await listDoubanLibrary(f.db, 'alice', { missing: true })).total, 1);
});
