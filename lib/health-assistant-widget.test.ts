import assert from 'node:assert/strict';
import test from 'node:test';
import { Script, runInNewContext } from 'node:vm';
import { renderHealthAssistantWidget } from './health-assistant-widget.ts';
import { HEALTH_CHAT_HISTORY_HELPERS, renderHealthAssistantWidgetScript } from './health-assistant-widget-ui.ts';

const bounded = (messages: Array<{ role: string; content: string }>) => runInNewContext(HEALTH_CHAT_HISTORY_HELPERS + '\nboundedHistory(messages)', { messages, TextEncoder }) as Array<{ role: string; content: string }>;

test('conversation history retains whole successful turns within both message and UTF-8 budgets', () => {
  const messages = Array.from({ length: 12 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: String(index) }));
  assert.deepEqual(JSON.parse(JSON.stringify(bounded(messages))), messages.slice(4));
  const large = messages.map((message) => ({ ...message, content: '健'.repeat(message.role === 'assistant' ? 8000 : 1000) }));
  const result = bounded(large);
  assert.equal(result.length, 2);
  assert.equal(result[0].role, 'user'); assert.equal(result[1].role, 'assistant');
  assert.ok(new TextEncoder().encode(JSON.stringify(result)).byteLength <= 32000);
  assert.equal(bounded([{ role: 'user', content: '健'.repeat(11000) }, { role: 'assistant', content: 'ok' }]).length, 0);
});

test('the emitted module script parses and widget controls have matching accessible dialog relationships', () => {
  const script = renderHealthAssistantWidgetScript();
  new Script(script.replace(/^<script[^>]*>/, '').replace(/<\/script>$/, ''));
  const html = renderHealthAssistantWidget();
  assert.match(html, /aria-controls="health-chat-panel"/);
  assert.match(html, /id="health-chat-panel" role="dialog" aria-modal="false"/);
  assert.match(html, /id="health-chat-messages" role="log"/);
  assert.match(html, /本次问题、对话历史和所选健康摘要发送至 MiniMax/);
});
