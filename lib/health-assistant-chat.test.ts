import assert from 'node:assert/strict';
import test from 'node:test';
import { HealthAssistantChatError, MAX_ASSISTANT_HISTORY_BYTES, parseAssistantHistory, validAssistantText } from './health-assistant-chat.ts';

const pair = (user = '继续', assistant = '先前回答') => [{ role: 'user', content: user }, { role: 'assistant', content: assistant }];
const invalid = (raw: unknown) => assert.throws(() => parseAssistantHistory(raw), (error) => {
  assert.ok(error instanceof HealthAssistantChatError);
  assert.equal((error.message + JSON.stringify(error)).includes('PRIVATE'), false);
  return true;
});

test('optional and complete history is copied into role/content-only messages', () => {
  assert.deepEqual(parseAssistantHistory(undefined), []);
  assert.deepEqual(parseAssistantHistory([]), []);
  const raw = [...pair('  怎样改善睡眠？  ', '可以先观察每天的入睡时间。\n第二行'), ...pair('补充一点', '后一轮回答')];
  const parsed = parseAssistantHistory(raw);
  assert.deepEqual(parsed[0], { role: 'user', content: '怎样改善睡眠？' });
  assert.notEqual(parsed, raw);
  assert.notEqual(parsed[0], raw[0]);
  raw[0].content = 'changed';
  assert.equal(parsed[0].content, '怎样改善睡眠？');
  assert.equal(parsed.length, 4);
});

test('Unicode lengths and ordinary formatting obey role-specific limits', () => {
  assert.equal(parseAssistantHistory(pair('😀'.repeat(1000), '😀'.repeat(6000)))[0].content.length, 2000);
  assert.equal(validAssistantText('😀'.repeat(10000), 10000), true);
  // A valid character count can still exceed the independent UTF-8 budget.
  invalid(pair('a', '😀'.repeat(10000)));
});

test('history rejects incomplete pairs, unexpected roles, extra properties and control characters', () => {
  for (const raw of [null, {}, 'PRIVATE', [{ role: 'user', content: 'PRIVATE' }],
    [{ role: 'assistant', content: 'a' }, { role: 'user', content: 'b' }],
    [{ role: 'user', content: 'a' }, { role: 'user', content: 'b' }],
    [{ role: 'system', content: 'PRIVATE' }, { role: 'assistant', content: 'b' }],
    [{ role: 'tool', content: 'PRIVATE' }, { role: 'assistant', content: 'b' }],
    [{ role: 'user', content: 'a', tools: [] }, { role: 'assistant', content: 'b' }],
    [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b', system: 'PRIVATE' }],
    pair('x'.repeat(1001)), pair('😀'.repeat(1001)), pair('a', 'x'.repeat(10001)),
    pair('  '), pair('a', '\t\r\n '), pair('PRIVATE\u0000'), pair('PRIVATE\u007f'), pair('a', 'PRIVATE\u0085'),
    [...pair(), ...pair(), ...pair(), ...pair(), ...pair()]]) invalid(raw);
  assert.equal(validAssistantText('正常\t缩进\n换行\r回车😀', 1000), true);
  assert.equal(validAssistantText('😀'.repeat(1000), 1000), true);
  assert.equal(validAssistantText('😀'.repeat(1001), 1000), false);
  assert.equal(parseAssistantHistory(pair('a', 'b'.repeat(10000)))[1].content.length, 10000);
});

test('the 32,000-byte boundary counts serialized UTF-8 including role metadata', () => {
  const history = [...pair('a', 'b'), ...pair('a', 'b'), ...pair('a', 'b'), ...pair('a', 'b')];
  const bytes = () => new TextEncoder().encode(JSON.stringify(history)).byteLength;
  let remaining = MAX_ASSISTANT_HISTORY_BYTES - bytes();
  for (let index = 1; index < history.length; index += 2) {
    const added = Math.min(10000 - history[index].content.length, remaining);
    history[index].content += 'x'.repeat(added);
    remaining -= added;
  }
  assert.equal(bytes(), MAX_ASSISTANT_HISTORY_BYTES);
  assert.equal(parseAssistantHistory(history).length, 8);
  history[7].content += 'x';
  invalid(history);
  invalid([...pair('a', '字'.repeat(6000)), ...pair('a', '字'.repeat(6000))]);
});

test('validation rejects sparse arrays and non-data shapes without executing their getters', () => {
  let getters = 0;
  const content = { role: 'user', get content() { getters++; return 'PRIVATE'; } };
  invalid([content, { role: 'assistant', content: 'b' }]);
  const inherited = Object.create({ role: 'user', content: 'PRIVATE' });
  invalid([inherited, { role: 'assistant', content: 'b' }]);
  invalid(new Array(2));
  const history = pair();
  Object.defineProperty(history, '0', { get() { getters++; return { role: 'user', content: 'PRIVATE' }; } });
  invalid(history);
  const extra = pair();
  Object.defineProperty(extra, 'secret', { value: 'PRIVATE' });
  invalid(extra);
  assert.equal(getters, 0);
});
