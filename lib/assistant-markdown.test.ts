import assert from 'node:assert/strict';
import test from 'node:test';
import { renderAssistantMarkdown } from './assistant-markdown.ts';

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
