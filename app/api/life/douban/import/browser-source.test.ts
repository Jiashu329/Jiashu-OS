import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import * as store from '../../../../../db/douban-store.ts';
import * as library from '../../../../../db/douban-library-store.ts';
import * as model from '../../../../../lib/douban.ts';
import * as sync from '../../../../../lib/douban-sync.ts';

type Handler = (request: Request) => Promise<Response>;
function load(path: URL, bindings: Record<string, unknown>, names: string[]) {
  const source = stripTypeScriptTypes(readFileSync(path, 'utf8'), { mode: 'strip' })
    .replace(/^import\s[\s\S]*?;\s*$/gm, '').replace(/^export /gm, '');
  // oxlint-disable-next-line typescript/no-implied-eval -- Inject local test bindings into the Cloudflare route without its runtime-only imports.
  return new Function(...Object.keys(bindings), source + '\nreturn {' + names.join(',') + '};')(...Object.values(bindings)) as Record<string, Handler>;
}
function fixture(t: TestContext) {
  const sqlite = new DatabaseSync(':memory:');
  for (const file of ['0024_douban.sql','0025_douban_data_resets.sql','0027_douban_subject_details.sql','0028_douban_browser_source.sql','0029_douban_library.sql','0030_douban_manual_cover.sql','0031_tmdb_covers_and_settings.sql','0032_imdb_ratings.sql','0033_douban_sync_hints.sql']) {
    sqlite.exec(readFileSync(new URL('../../../../../drizzle/' + file, import.meta.url), 'utf8'));
  }
  t.after(() => sqlite.close());
  const db = {
    prepare(sql: string) {
      const statement = sqlite.prepare(sql); let parameters: SQLInputValue[] = [];
      const bound = {
        bind(...values: unknown[]) { parameters = values as SQLInputValue[]; return bound; },
        async first<T>() { return statement.get(...parameters) as T | undefined ?? null; },
        async all<T>() { return { results: statement.all(...parameters) as T[] }; },
        execute() { return { results: statement.columns().length ? statement.all(...parameters) : (statement.run(...parameters), []) }; },
      };
      return bound;
    },
    async batch(commands: Array<{ execute(): unknown }>) {
      sqlite.exec('BEGIN');
      try { const result = commands.map(command => command.execute()); sqlite.exec('COMMIT'); return result; }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
  } as unknown as D1Database;
  let user: string | null = 'browser-owner';
  const shared = load(new URL('../../../_shared.ts', import.meta.url), { getChatGPTUser: async () => user ? { userId: user } : null }, ['apiUser','json','unauthenticated','invalidOrigin','isSameOrigin']);
  const helpers = load(new URL('../_shared.ts', import.meta.url), { env: { DB: db }, ...shared, ...store, ...model, ...sync }, ['doubanDatabase','doubanGuard','doubanBody','doubanError']);
  const route = load(new URL('./route.ts', import.meta.url), { ...shared, ...helpers, ...store, ...library, ...model, ...sync }, ['POST']).POST;
  return {
    db, signIn(value: string | null) { user = value; },
    post(body: unknown) { return route(new Request('https://synthetic-browser.example/api/life/douban/import', { method: 'POST', headers: { Origin: 'https://synthetic-browser.example', 'Content-Type': 'application/json' }, body: JSON.stringify(body) })); },
  };
}
const record = (source: model.DoubanRecordInput['source'], rating: model.DoubanRecordInput['rating'], comment: string | null): model.DoubanRecordInput => ({
  domain: 'book', subjectId: '12345', kind: 'book', title: 'Browser snapshot', url: model.doubanSubjectUrl('book','12345'), coverUrl: null,
  rating, comment, markedDate: null, publishedAt: null, source,
});
interface SavedPage { receipt: store.DoubanImportReceipt; records: library.DoubanLibraryRecord[] }
async function save(f: ReturnType<typeof fixture>, items: model.DoubanRecordInput[]) {
  const previewResponse = await f.post({ action: 'preview', profile: 'declared-profile', items, expectedDataEpoch: 0 });
  assert.equal(previewResponse.status, 200);
  const { preview } = await previewResponse.json() as { preview: store.DoubanImportPreview };
  const command = { action: 'commit', profile: 'declared-profile', items, expectedDataEpoch: 0, expectedSnapshotHash: preview.snapshotHash, requestId: crypto.randomUUID(), confirmed: true, returnRecords: true };
  const response = await f.post(command); assert.equal(response.status, 200);
  return { command, result: await response.json() as SavedPage };
}

void test('browser import endpoint clears explicit empty fields and returns current records while legacy file imports retain unknown fields', async t => {
  const f = fixture(t);
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('browser page persistence must never read Douban'); });
  await save(f, [record('import',5,'Legacy browser or private file comment')]);
  const cleared = await save(f, [record('browser',null,null)]);
  assert.equal(cleared.result.receipt.updated, 1);
  assert.equal(cleared.result.records[0].imdb, null); assert.equal(cleared.result.records[0].tmdbCoverUrl, null);
  assert.deepEqual(cleared.result.records[0].local, { note: '', tags: [], hidden: false, revision: 0 });
  assert.deepEqual([cleared.result.records[0].source,cleared.result.records[0].rating,cleared.result.records[0].comment], ['browser',null,null]);
  await save(f, [record('browser',4,'New browser comment')]);
  const replay = await f.post(cleared.command); assert.equal(replay.status, 200);
  const replayed = await replay.json() as SavedPage;
  assert.deepEqual(replayed.receipt, cleared.result.receipt);
  assert.deepEqual([replayed.records[0].source,replayed.records[0].rating,replayed.records[0].comment], ['browser',4,'New browser comment']);
  const legacy = await save(f, [record('import',null,null)]);
  assert.deepEqual([legacy.result.records[0].source,legacy.result.records[0].rating,legacy.result.records[0].comment], ['import',4,'New browser comment']);
});

void test('browser persistence remains account isolated and rejects public-source submissions', async t => {
  const f = fixture(t);
  await save(f, [record('browser',5,'Owner private comment')]);
  f.signIn('another-owner');
  const other = await save(f, [record('browser',null,null)]);
  assert.deepEqual([other.result.records[0].rating,other.result.records[0].comment], [null,null]);
  const rejected = await f.post({ action: 'preview', profile: 'declared-profile', expectedDataEpoch: 0, items: [record('collection',1,'Invalid transport')] });
  assert.equal(rejected.status, 400);
  assert.equal((await store.listDoubanRecords(f.db, 'browser-owner')).items[0].comment, 'Owner private comment');
  f.signIn(null);
  assert.equal((await f.post({ action: 'preview' })).status, 401);
});
