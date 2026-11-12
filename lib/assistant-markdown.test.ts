import assert from 'node:assert/strict';
import test from 'node:test';
import { renderAssistantMarkdown } from './assistant-markdown.ts';

test('known date citations become trusted new-tab links while unknown refs, code and nested links remain inert', () => {
  const source={id:'N1-20261110',label:'饮食 <img src=x>',url:'/health/nutrition?date=2026-11-10',from:'2026-11-10',to:'2026-11-10',recordedDays:1,sources:[]};
  const html=renderAssistantMarkdown('证据 [N1-20261110]，未知 [N1-20261109]。代码 `[N1-20261110]`。\n\n[已有链接 [N1-20261110]](https://example.com)',[source]);
  assert.equal((html.match(/class="hc-citation"/g)||[]).length,1);
  assert.match(html,/href="\/health\/nutrition\?date=2026-11-10" target="_blank" rel="noopener noreferrer"/);
  assert.ok(html.includes('[N1-20261109]'));assert.ok(html.includes('<code>[N1-20261110]</code>'));
  assert.doesNotMatch(html,/<img/);
  assert.equal((renderAssistantMarkdown('[N1-20261110]',[{...source,url:'https://foreign.example/private'}]).match(/<a /g)||[]).length,0);
  const disguised=renderAssistantMarkdown('[N1-20261110](https://foreign.example/disguised)',[source]);
  assert.ok(disguised.includes('href="/health/nutrition?date=2026-11-10"'));assert.ok(!disguised.includes('foreign.example'));
  assert.doesNotMatch(renderAssistantMarkdown('[N1-20261109](https://foreign.example/unknown)',[source]), /<a /);
});

test('health answers render Markdown headings, emphasis, lists, tables and fenced code', () => {
  const html = renderAssistantMarkdown('## 本周总结\n\n**睡眠**覆盖 5 天 [H1]。\n\n- 规律作息\n- 补全记录\n\n| 指标 | 观察 |\n| --- | --- |\n| 睡眠 | 7 小时 |\n\n```text\n样本不足不能算作零\n```');
  for (const expected of ['<h2>本周总结</h2>', '<strong>睡眠</strong>', '<ul>', '<table>', '<pre><code class="language-text">', '[H1]']) {
    assert.ok(html.includes(expected), expected);
  }
});

test('raw HTML and malicious URL protocols cannot execute or create active elements', () => {
  const inputs = ['<script>alert(1)</script>', '<img src=x onerror=alert(1)>', '<iframe src="https://example.com"></iframe>',
    '[危险链接](javascript:alert%281%29)', '[危险链接](jav&#x61;script:alert%281%29)', '[危险链接](data:text/html;base64,PHNjcmlwdD4=)',
    '[危险链接](vbscript:msgbox%281%29)', '[危险链接](//example.com)', '<svg onload=alert(1)>'];
  for (const input of inputs) {
    const html = renderAssistantMarkdown(input);
    assert.doesNotMatch(html, /<(?:script|img|iframe|svg)\b/i);
    assert.doesNotMatch(html, /href="(?:javascript|data|vbscript|\/\/)/i);
  }
});

test('remote images stay inert and external links cannot send a referrer or use window.opener', () => {
  const html = renderAssistantMarkdown('![私人记录](https://example.com/track?private=data)\n\n[资料](https://example.com/reference) [来源](/health/records)');
  assert.doesNotMatch(html, /<img\b/i);
  assert.match(html, /rel="noopener noreferrer"/);
  assert.match(html, /referrerpolicy="no-referrer"/);
  assert.match(html, /target="_blank"/);
  assert.match(html, /href="\/health\/records"/);
});

test('plain text, inline code and HTML-like content remain readable and bounded', () => {
  assert.match(renderAssistantMarkdown('`<script>` 与 3 < 5'), /<code>&lt;script&gt;<\/code> 与 3 &lt; 5/);
  assert.ok(renderAssistantMarkdown('字'.repeat(10000)).length < 128 * 1024);
  assert.throws(() => renderAssistantMarkdown('字'.repeat(10001)), RangeError);
});
