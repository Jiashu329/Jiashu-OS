import assert from 'node:assert/strict';
import test from 'node:test';
import { AIProviderError, callNutritionNeedsAssistant, NUTRITION_NEEDS_SYSTEM_PROMPT, readAIConfiguration } from './ai-provider.ts';
import { calculateNutritionNeeds, type NutritionNeedsInput } from './nutrition-needs.ts';

const KEY = 'synthetic-private-needs-key';
const input: NutritionNeedsInput = { age: 30, heightCm: 175, weightKg: 70, sex: 'male', activity: 'moderate', goal: 'maintain' };
const explanation = '基础代谢是静息状态的能量参考，维持需求还考虑了日常活动。活动水平选择会影响估算，实际需要可结合长期体重变化复核。日常饮食可搭配主食、蛋白质食物、蔬菜与适量油脂。';
function completion(answer: string) {
  return Response.json({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: answer } }] });
}

test('needs AI sends only the explicit profile and server-calculated estimate to the shared provider', async () => {
  let calls = 0;
  const result = await callNutritionNeedsAssistant(readAIConfiguration({ MINIMAX_API_KEY: KEY }), input, { fetch: async (url, options) => {
    calls++;
    assert.equal(url, 'https://api.minimax.cn/v1/chat/completions');
    assert.equal(new Headers(options?.headers).get('Authorization'), 'Bearer ' + KEY);
    const body = JSON.parse(String(options?.body));
    assert.deepEqual(body.messages.map((message: { role: string }) => message.role), ['system', 'user']);
    assert.equal(body.messages[0].content, NUTRITION_NEEDS_SYSTEM_PROMPT);
    assert.deepEqual(JSON.parse(body.messages[1].content), { profile: input, estimate: calculateNutritionNeeds(input) });
    assert.equal(body.tools, undefined);
    assert.doesNotMatch(body.messages[1].content, /userId|history|PRIVATE|email|apiKey/);
    return completion(explanation);
  } });
  assert.equal(calls, 1);
  assert.equal(result.answer, explanation);
  assert.equal(result.provider, 'MiniMax');
  assert.doesNotMatch(JSON.stringify(result), new RegExp(KEY));
});

test('a missing/forged configuration or client-supplied calorie overrides cannot reach MiniMax', async () => {
  let calls = 0;
  const fetch: typeof globalThis.fetch = async () => { calls++; return completion(explanation); };
  const config = readAIConfiguration({ MINIMAX_API_KEY: KEY });
  for (const configuration of [readAIConfiguration({}), { ...config }]) {
    await assert.rejects(callNutritionNeedsAssistant(configuration, input, { fetch }), (error: unknown) => error instanceof AIProviderError && error.code === 'AI_NOT_CONFIGURED');
  }
  await assert.rejects(callNutritionNeedsAssistant(config, { ...input, calories: 1 } as NutritionNeedsInput, { fetch }));
  await assert.rejects(callNutritionNeedsAssistant(config, { ...input, age: 10 }, { fetch }));
  assert.equal(calls, 0);
});

test('AI cannot introduce numerical targets or oversized/unsafe interpretation text', async () => {
  for (const answer of ['每天改成 800 kcal。', '建议每天８００千卡。', '字'.repeat(1601), '内容\u0000结束']) {
    await assert.rejects(callNutritionNeedsAssistant(readAIConfiguration({ MINIMAX_API_KEY: KEY }), input,
      { fetch: async () => completion(answer) }), (error: unknown) => error instanceof AIProviderError && error.code === 'AI_NEEDS_INVALID_RESPONSE');
  }
});

test('a provider outage keeps its safe classification and does not expose the body or profile in errors', async (context) => {
  context.mock.method(console, 'warn', () => {});
  await assert.rejects(callNutritionNeedsAssistant(readAIConfiguration({ MINIMAX_API_KEY: KEY }), input,
    { fetch: async () => new Response('PRIVATE-UPSTREAM ' + KEY, { status: 503 }) }), (error: unknown) => {
      assert.ok(error instanceof AIProviderError);
      assert.equal(error.status, 502);
      assert.doesNotMatch(JSON.stringify(error), /PRIVATE-UPSTREAM|synthetic-private-needs-key|heightCm|weightKg/);
      return true;
    });
});
