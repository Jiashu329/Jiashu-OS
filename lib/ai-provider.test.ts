import assert from 'node:assert/strict';
import test from 'node:test';
import { AIProviderError, callHealthAssistant, readAIConfiguration } from './ai-provider.ts';

const API_KEY = 'test-private-minimax-key-do-not-echo';
const configured = (fields = {}) => readAIConfiguration({ MINIMAX_API_KEY: API_KEY, ...fields });
const input = { question: '最近睡眠怎么样？', context: { health: [{ id: 'H1', date: '2026-11-10', sleepHours: 7.5 }], nutrition: [{ id: 'N1', date: '2026-11-10', calories: 1800 }] } };
const completion = (message: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
  choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '11 月 10 日记录了 7.5 小时睡眠 [H1]。', ...message } }],
  ...extra,
});
const jsonResponse = (value: unknown, init?: ResponseInit) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' }, ...init });
const mockResponse = (response: () => Response): typeof fetch => async () => response();
test.beforeEach((context) => { if ('mock' in context) context.mock.method(console, 'warn', () => {}); });
const expectError = (code: string, status?: number) => (error: unknown) => {
  assert.ok(error instanceof AIProviderError);
  assert.equal(error.code, code);
  if (status !== undefined) assert.equal(error.status, status);
  assert.doesNotMatch(error.message, new RegExp(API_KEY));
  assert.doesNotMatch(JSON.stringify(error), new RegExp(API_KEY));
  return true;
};

test('configuration defaults to MiniMax M3 in China and keeps credentials out of inspectable metadata', () => {
  const missing = readAIConfiguration({});
  assert.equal(missing.ready, false);
  assert.equal(missing.provider, 'minimax');
  assert.equal(missing.providerLabel, 'MiniMax');
  assert.equal(missing.model, 'MiniMax-M3');
  assert.equal(missing.region, 'cn');
  assert.match(missing.message, /AI 设置/);
  const ready = configured();
  assert.equal(ready.ready, true);
  assert.equal(Object.isFrozen(ready), true);
  assert.doesNotMatch(JSON.stringify(ready), new RegExp(API_KEY));
  assert.equal(Reflect.ownKeys(ready).some((key) => /key|endpoint/i.test(String(key))), false);
});

test('unsupported providers, arbitrary endpoints, unsafe models and invalid credentials never become ready', () => {
  for (const fields of [
    { AI_PROVIDER: 'openai' }, { AI_PROVIDER: 'https://attacker.test/' },
    { MINIMAX_REGION: 'https://attacker.test/' }, { MINIMAX_REGION: 'us' },
    { MINIMAX_MODEL: 'MiniMax-M3\n' + API_KEY }, { MINIMAX_MODEL: 'https://attacker.test/model' },
    { MINIMAX_MODEL: 'a'.repeat(101) }, { MINIMAX_MODEL: API_KEY },
    { MINIMAX_API_KEY: API_KEY + '\nsecond-line' }, { MINIMAX_API_KEY: API_KEY + ' invalid' },
  ]) {
    const configuration = configured(fields);
    assert.equal(configuration.ready, false);
    assert.doesNotMatch(JSON.stringify(configuration), new RegExp(API_KEY));
  }
  assert.match(configured({ AI_PROVIDER: 'openai' }).message, /仅支持 MiniMax/);
  assert.equal(configured({ AI_PROVIDER: ' MiniMax ', MINIMAX_REGION: ' GLOBAL ', MINIMAX_MODEL: ' MiniMax-M3.1-Flash ' }).ready, true);
});

test('missing or forged configuration stops before any network request', async () => {
  let requests = 0;
  const fetch: typeof globalThis.fetch = async () => { requests++; return jsonResponse(completion()); };
  await assert.rejects(callHealthAssistant(readAIConfiguration({}), input, { fetch }), expectError('AI_NOT_CONFIGURED', 503));
  await assert.rejects(callHealthAssistant({ ...configured() }, input, { fetch }), expectError('AI_NOT_CONFIGURED', 503));
  assert.equal(requests, 0);
});

test('M3 requests only the official endpoint with two messages, bounded output, no tools and disabled thinking', async () => {
  let requests = 0;
  const fetch: typeof globalThis.fetch = async (url, init) => {
    requests++;
    assert.equal(url, 'https://api.minimax.cn/v1/chat/completions');
    assert.equal(init?.method, 'POST');
    assert.equal(init?.redirect, 'manual');
    assert.ok(init?.signal instanceof AbortSignal);
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer ' + API_KEY);
    const body = JSON.parse(init?.body as string);
    assert.equal(body.model, 'MiniMax-M3');
    assert.equal(body.stream, false);
    assert.equal(body.reasoning_split, true);
    assert.equal(body.max_completion_tokens, 4096);
    assert.deepEqual(body.thinking, { type: 'disabled' });
    assert.equal(body.tools, undefined);
    assert.deepEqual(body.messages.map((message: { role: string }) => message.role), ['system', 'user']);
    assert.match(body.messages[0].content, /\[H1\]/);
    assert.match(body.messages[0].content, /\[N1\]/);
    assert.match(body.messages[0].content, /实际日期/);
    assert.match(body.messages[0].content, /不能把缺失记录当作零/);
    assert.match(body.messages[0].content, /不作医疗诊断/);
    assert.match(body.messages[0].content, /没有工具权限/);
    assert.match(body.messages[1].content, /最近睡眠怎么样/);
    assert.match(body.messages[1].content, /2026-11-10/);
    assert.doesNotMatch(init?.body as string, new RegExp(API_KEY));
    return jsonResponse(completion({ reasoning_content: 'THIS IS PRIVATE REASONING' }, { model: API_KEY, usage: { prompt_tokens: 123, completion_tokens: 45, total_tokens: 168 } }));
  };
  const result = await callHealthAssistant(configured(), input, { fetch });
  assert.equal(requests, 1);
  assert.deepEqual(result, { answer: '11 月 10 日记录了 7.5 小时睡眠 [H1]。', provider: 'MiniMax', model: 'MiniMax-M3', usage: { inputTokens: 123, outputTokens: 45 } });
  assert.doesNotMatch(JSON.stringify(result), /REASONING/);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(API_KEY));
});

test('the global M3.1 Flash request enables only supported low-effort thinking settings', async () => {
  const configuration = configured({ MINIMAX_REGION: 'global', MINIMAX_MODEL: 'MiniMax-M3.1-Flash' });
  const result = await callHealthAssistant(configuration, input, { fetch: async (url, init) => {
    assert.equal(url, 'https://api.minimax.io/v1/chat/completions');
    const body = JSON.parse(init?.body as string);
    assert.equal(body.reasoning_effort, 'low');
    assert.equal(body.thinking, undefined);
    assert.equal(body.reasoning_split, true);
    return jsonResponse(completion());
  } });
  assert.equal(result.model, 'MiniMax-M3.1-Flash');
  assert.equal(result.provider, 'MiniMax');
});

test('complete thinking blocks are removed without exposing reasoning fields', async () => {
  const result = await callHealthAssistant(configured(), input, { fetch: mockResponse(() => jsonResponse(completion({
    content: '<think>PRIVATE THOUGHTS</think>\n\n最后的回答 [H1]。<THINK>MORE PRIVATE THOUGHTS</THINK>',
    reasoning_content: 'SEPARATE PRIVATE THOUGHTS',
  }))) });
  assert.equal(result.answer, '最后的回答 [H1]。');
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|reasoning|think/i);
});

test('incomplete, nested or escaped thinking and reasoning-only answers are rejected', async () => {
  for (const content of ['<think>PRIVATE THOUGHTS', 'PRIVATE</think>answer', '<think>outer<think>inner</think>outer</think>answer', '&lt;think&gt;private&lt;/think&gt;answer', '<think>only thinking</think>', '']) {
    await assert.rejects(callHealthAssistant(configured(), input, { fetch: mockResponse(() => jsonResponse(completion({ content, reasoning_content: 'PRIVATE' }))) }), expectError('AI_RESPONSE_INVALID'));
  }
  await assert.rejects(callHealthAssistant(configured(), input, { fetch: mockResponse(() => jsonResponse(completion({ content: null, reasoning_content: 'PRIVATE' }))) }), expectError('AI_RESPONSE_INVALID'));
});

test('HTTP failures never echo provider error bodies or credentials', async () => {
  for (const [status, code, publicStatus] of [[401, 'AI_AUTH_FAILED', 503], [403, 'AI_AUTH_FAILED', 503], [429, 'AI_RATE_LIMITED', 429], [500, 'AI_PROVIDER_UNAVAILABLE', 502], [302, 'AI_PROVIDER_UNAVAILABLE', 502]] as const) {
    await assert.rejects(callHealthAssistant(configured(), input, { fetch: mockResponse(() => jsonResponse({ error: API_KEY }, { status })) }), expectError(code, publicStatus));
  }
});

test('manual redirect handling rejects every 3xx without following the location or retrying', async (context) => {
  const warn = context.mock.method(console, 'warn', () => {});
  const privateLocation = 'https://elsewhere.test/' + API_KEY + '/PRIVATE-HEALTH';
  for (const upstreamStatus of [300, 301, 302, 303, 304, 305, 307, 308, 399]) {
    let requests = 0;
    await assert.rejects(callHealthAssistant(configured(), input, { fetch: async (url, init) => {
      requests++;
      assert.equal(url, 'https://api.minimax.cn/v1/chat/completions');
      assert.equal(init?.redirect, 'manual');
      return new Response(null, { status: upstreamStatus, headers: { Location: privateLocation } });
    } }), (error) => {
      expectError('AI_PROVIDER_UNAVAILABLE', 502)(error);
      assert.ok(error instanceof AIProviderError);
      assert.deepEqual(error.diagnostics, { upstreamStatus, networkReason: 'REDIRECT_BLOCKED' });
      assert.equal(JSON.stringify(error).includes(privateLocation), false);
      return true;
    });
    assert.equal(requests, 1);
  }
  const logged = JSON.stringify(warn.mock.calls.map((call) => call.arguments));
  assert.equal(logged.includes(API_KEY), false);
  assert.equal(logged.includes('PRIVATE-HEALTH'), false);
});

test('HTTP 200 provider errors are still failures and do not echo error metadata', async () => {
  await assert.rejects(callHealthAssistant(configured(), input, { fetch: mockResponse(() => jsonResponse(
    completion({}, { base_resp: { status_code: 1004, status_msg: API_KEY } }),
  )) }), expectError('AI_AUTH_FAILED', 503));
  for (const raw of [
    completion({}, { base_resp: { status_code: '0', status_msg: API_KEY } }),
    completion({}, { base_resp: null }),
    completion({}, { error: { message: API_KEY } }),
  ]) {
    await assert.rejects(callHealthAssistant(configured(), input, { fetch: mockResponse(() => jsonResponse(raw)) }), expectError('AI_PROVIDER_UNAVAILABLE'));
  }
  const result = await callHealthAssistant(configured(), input, { fetch: mockResponse(() => jsonResponse(completion({}, { base_resp: { status_code: 0 } }))) });
  assert.match(result.answer, /7.5/);
});

test('provider business errors preserve bounded diagnostics and fixed classifications for HTTP 200 and non-2xx', async () => {
  const traceId = '12ab34cd56ef7890';
  const mappings = [
    [1004, 'AI_AUTH_FAILED', 503, /身份验证/], [2049, 'AI_AUTH_FAILED', 503, /身份验证/],
    [1008, 'AI_BALANCE_INSUFFICIENT', 502, /余额不足/],
    [2022, 'AI_MODEL_ACCESS_DENIED', 502, /访问权限/], [2061, 'AI_MODEL_ACCESS_DENIED', 502, /访问权限/],
    [2068, 'AI_MODEL_ACCESS_DENIED', 502, /访问权限/],
    [2056, 'AI_RATE_LIMITED', 429, /限额/], [2062, 'AI_RATE_LIMITED', 429, /限额/],
    [2067, 'AI_QUOTA_EXHAUSTED', 502, /额度已用尽/], [2069, 'AI_MODEL_RETIRED', 502, /已下线/],
    [2013, 'AI_INVALID_PARAMETERS', 502, /请求参数/], [9876, 'AI_PROVIDER_UNAVAILABLE', 502, /稍后重试/],
  ] as const;
  for (const [upstreamCode, localCode, status, message] of mappings) {
    for (const upstreamStatus of [200, 400]) {
      const raw = upstreamStatus === 200
        ? { base_resp: { status_code: upstreamCode, status_msg: API_KEY }, trace_id: traceId }
        : { error: { code: String(upstreamCode), message: API_KEY }, trace_id: traceId };
      await assert.rejects(callHealthAssistant(configured(), input, { fetch: mockResponse(() => jsonResponse(raw, { status: upstreamStatus })) }), (error) => {
        expectError(localCode, status)(error);
        assert.ok(error instanceof AIProviderError);
        assert.match(error.message, message);
        assert.deepEqual(error.diagnostics, { upstreamStatus, upstreamCode, traceId });
        assert.equal(Object.isFrozen(error.diagnostics), true);
        return true;
      });
    }
  }
});

test('HTTP authentication and rate-limit classifications take precedence while retaining upstream business codes', async () => {
  for (const [upstreamStatus, localCode, status] of [[401, 'AI_AUTH_FAILED', 503], [403, 'AI_AUTH_FAILED', 503], [429, 'AI_RATE_LIMITED', 429]] as const) {
    await assert.rejects(callHealthAssistant(configured(), input, { fetch: mockResponse(() => jsonResponse({
      error: { code: '1008', message: API_KEY },
    }, { status: upstreamStatus })) }), (error) => {
      expectError(localCode, status)(error);
      assert.ok(error instanceof AIProviderError);
      assert.deepEqual(error.diagnostics, { upstreamStatus, upstreamCode: 1008 });
      return true;
    });
  }
});

test('diagnostics never include raw messages, request data or credentials in errors or production logs', async (context) => {
  const warn = context.mock.method(console, 'warn', () => {});
  const privateQuestion = 'PRIVATE HEALTH QUESTION';
  const privateHealth = 'PRIVATE HEALTH RECORD';
  const privateUpstream = 'PRIVATE UPSTREAM DETAIL';
  const traceId = 'abcdef0123456789';
  await assert.rejects(callHealthAssistant(configured(), { question: privateQuestion, context: { health: privateHealth } }, {
    fetch: mockResponse(() => jsonResponse({
      base_resp: { status_code: 2067, status_msg: `${API_KEY} ${privateQuestion} ${privateHealth} ${privateUpstream}` },
      error: { message: privateUpstream }, trace_id: traceId,
      request: { apiKey: API_KEY, health: privateHealth },
    }, { status: 400 })),
  }), (error) => {
    expectError('AI_QUOTA_EXHAUSTED', 502)(error);
    assert.ok(error instanceof AIProviderError);
    const exposed = JSON.stringify(error) + error.message;
    for (const secret of [API_KEY, privateQuestion, privateHealth, privateUpstream]) assert.equal(exposed.includes(secret), false);
    return true;
  });
  assert.equal(warn.mock.callCount(), 1);
  assert.deepEqual(warn.mock.calls[0].arguments, ['minimax_request_failed', {
    code: 'AI_QUOTA_EXHAUSTED', status: 502, upstreamStatus: 400, upstreamCode: 2067, traceId,
  }]);
  const logged = JSON.stringify(warn.mock.calls[0].arguments);
  for (const secret of [API_KEY, privateQuestion, privateHealth, privateUpstream]) assert.equal(logged.includes(secret), false);
  await callHealthAssistant(configured(), input, { fetch: mockResponse(() => jsonResponse(completion())) });
  assert.equal(warn.mock.callCount(), 1, 'successful calls do not emit failure logs');
});

test('trace diagnostics accept only bounded hex identifiers and exclude a reflected credential', async () => {
  const headerTrace = 'ABCDEF0123456789';
  const bodyTrace = 'fedcba9876543210';
  for (const header of ['trace_id', 'trace-id', 'x-trace-id']) {
    await assert.rejects(callHealthAssistant(configured(), input, { fetch: mockResponse(() => jsonResponse({
      error: { code: '2013' }, trace_id: bodyTrace,
    }, { status: 400, headers: { [header]: headerTrace } })) }), (error) => {
      assert.ok(error instanceof AIProviderError);
      assert.equal(error.diagnostics?.traceId, headerTrace);
      return true;
    });
  }
  for (const trace of [API_KEY, '<script>1234567890123456</script>', 'a'.repeat(15), 'a'.repeat(65), 'a'.repeat(15) + 'g']) {
    await assert.rejects(callHealthAssistant(configured(), input, { fetch: mockResponse(() => jsonResponse({
      error: { code: '2013' }, trace_id: trace,
    }, { status: 400, headers: { trace_id: trace } })) }), (error) => {
      assert.ok(error instanceof AIProviderError);
      assert.equal(error.diagnostics?.traceId, undefined);
      return true;
    });
  }
  await assert.rejects(callHealthAssistant(configured(), input, { fetch: mockResponse(() => jsonResponse({
    error: { code: '2013' }, trace_id: ' abcdef0123456789 ',
  }, { status: 400 })) }), (error) => {
    assert.ok(error instanceof AIProviderError);
    assert.equal(error.diagnostics?.traceId, undefined);
    return true;
  });
  const hexKey = '0123456789abcdef';
  await assert.rejects(callHealthAssistant(configured({ MINIMAX_API_KEY: hexKey }), input, { fetch: mockResponse(() => jsonResponse({
    error: { code: '2013' }, trace_id: 'aa' + hexKey.toUpperCase() + 'bb',
  }, { status: 400, headers: { trace_id: hexKey } })) }), (error) => {
    assert.ok(error instanceof AIProviderError);
    assert.equal(error.diagnostics?.traceId, undefined);
    assert.equal(JSON.stringify(error).toLowerCase().includes(hexKey), false);
    return true;
  });
  await assert.rejects(callHealthAssistant(configured(), input, { fetch: mockResponse(() => jsonResponse({
    error: { code: '2013' }, traceId: bodyTrace,
  }, { status: 400 })) }), (error) => {
    assert.ok(error instanceof AIProviderError);
    assert.equal(error.diagnostics?.traceId, bodyTrace);
    return true;
  });
});

test('untrusted error codes must be bounded positive integers or plain decimal strings', async () => {
  for (const code of [API_KEY, 0, -1, 1.5, 10000000000, {}, [], null, '0', '-1004', '1.5', '1e3', ' 1004 ', '12345678901']) {
    await assert.rejects(callHealthAssistant(configured(), input, { fetch: mockResponse(() => jsonResponse({
      error: { code, message: API_KEY },
    }, { status: 400 })) }), (error) => {
      expectError('AI_PROVIDER_UNAVAILABLE', 502)(error);
      assert.ok(error instanceof AIProviderError);
      assert.deepEqual(error.diagnostics, { upstreamStatus: 400 });
      return true;
    });
  }
});

test('invalid or oversized HTTP error bodies retain the upstream status and remain bounded', async () => {
  const traceId = 'abcdef0123456789';
  for (const body of ['not json ' + API_KEY, new Uint8Array([0xff]), '']) {
    await assert.rejects(callHealthAssistant(configured(), input, { fetch: mockResponse(() => new Response(body, {
      status: 403, headers: { trace_id: traceId },
    })) }), (error) => {
      expectError('AI_AUTH_FAILED', 503)(error);
      assert.ok(error instanceof AIProviderError);
      assert.deepEqual(error.diagnostics, { upstreamStatus: 403, traceId });
      return true;
    });
  }
  let chunks = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) { chunks++; controller.enqueue(new Uint8Array(65536)); },
    cancel() { cancelled = true; },
  });
  await assert.rejects(callHealthAssistant(configured(), input, { fetch: mockResponse(() => new Response(body, { status: 500 })) }), (error) => {
    expectError('AI_PROVIDER_UNAVAILABLE', 502)(error);
    assert.ok(error instanceof AIProviderError);
    assert.deepEqual(error.diagnostics, { upstreamStatus: 500 });
    return true;
  });
  assert.equal(cancelled, true);
  assert.ok(chunks <= 4);
});

test('truncated and tool-call completions are rejected rather than presented as final answers', async () => {
  for (const finish_reason of ['length', 'max_tokens']) {
    await assert.rejects(callHealthAssistant(configured(), input, { fetch: mockResponse(() => jsonResponse({ choices: [{ finish_reason, message: { content: '部分回答' } }] })) }), expectError('AI_RESPONSE_TRUNCATED'));
  }
  for (const raw of [
    { choices: [{ finish_reason: null, message: { content: 'still generating' } }] },
    { choices: [{ finish_reason: 'tool_calls', message: { content: 'will write a record' } }] },
    completion({ tool_calls: [{ id: 'tool-1', function: { name: 'write_health_record' } }] }),
    completion({ function_call: { name: 'write_health_record' } }),
    completion({ role: 'tool' }),
  ]) await assert.rejects(callHealthAssistant(configured(), input, { fetch: mockResponse(() => jsonResponse(raw)) }), expectError('AI_RESPONSE_INVALID'));
});

test('invalid JSON, invalid UTF-8, missing choices and blank content produce safe errors', async () => {
  for (const response of [
    new Response('{not valid json ' + API_KEY), new Response(''), new Response(new Uint8Array([0xff])),
    jsonResponse({}), jsonResponse([]), jsonResponse({ choices: [] }), jsonResponse(completion({ content: ' \n\t ' })),
  ]) await assert.rejects(callHealthAssistant(configured(), input, { fetch: mockResponse(() => response) }), expectError('AI_RESPONSE_INVALID'));
});

test('the answer length is bounded and a reflected API key cannot reach the client', async () => {
  await assert.rejects(callHealthAssistant(configured(), input, { fetch: mockResponse(() => jsonResponse(completion({ content: '字'.repeat(10001) }))) }), expectError('AI_RESPONSE_TOO_LARGE'));
  await assert.rejects(callHealthAssistant(configured(), input, { fetch: mockResponse(() => jsonResponse(completion({ content: 'credential: ' + API_KEY }))) }), expectError('AI_RESPONSE_INVALID'));
  const result = await callHealthAssistant(configured(), input, { fetch: mockResponse(() => jsonResponse(completion({ content: '字'.repeat(10000) }))) });
  assert.equal(result.answer.length, 10000);
});

test('response limits count streamed UTF-8 bytes and cancel an oversized body', async () => {
  let cancelled = false;
  let chunks = 0;
  const chunk = new TextEncoder().encode('字'.repeat(20000));
  const response = new Response(new ReadableStream<Uint8Array>({
    pull(controller) { chunks++; controller.enqueue(chunk); },
    cancel() { cancelled = true; },
  }));
  await assert.rejects(callHealthAssistant(configured(), input, { fetch: mockResponse(() => response) }), expectError('AI_RESPONSE_TOO_LARGE'));
  assert.equal(cancelled, true);
  assert.ok(chunks <= 4);
  await assert.rejects(callHealthAssistant(configured(), input, { fetch: mockResponse(() => new Response('unused', { headers: { 'Content-Length': String(128 * 1024 + 1) } })) }), expectError('AI_RESPONSE_TOO_LARGE'));
});

test('unknown or invalid token usage is omitted rather than reflected', async () => {
  for (const usage of [undefined, null, { prompt_tokens: API_KEY, completion_tokens: -1 }, { prompt_tokens: NaN, completion_tokens: 1.5 }]) {
    const result = await callHealthAssistant(configured(), input, { fetch: mockResponse(() => jsonResponse(completion({}, { usage }))) });
    assert.equal(result.usage, undefined);
  }
  const result = await callHealthAssistant(configured(), input, { fetch: mockResponse(() => jsonResponse(completion({}, { usage: { prompt_tokens: 0, completion_tokens: '10' } }))) });
  assert.deepEqual(result.usage, { inputTokens: 0 });
});

test('network errors and aborted requests are reported without their raw error messages', async () => {
  await assert.rejects(callHealthAssistant(configured(), input, { fetch: async () => { throw new Error(API_KEY); } }), expectError('AI_NETWORK_ERROR'));
  await assert.rejects(callHealthAssistant(configured(), input, { fetch: async () => { const error = new Error(API_KEY); error.name = 'AbortError'; throw error; } }), expectError('AI_TIMEOUT', 504));
});

test('fetch rejection diagnostics distinguish DNS, TLS, connection, policy and local request failures', async () => {
  const cases = [
    { error: new TypeError('fetch failed', { cause: Object.assign(new Error(API_KEY), { code: 'ENOTFOUND' }) }),
      reason: 'DNS_FAILURE', code: 'ENOTFOUND', type: 'TypeError' },
    { error: Object.assign(new Error('getaddrinfo EAI_AGAIN PRIVATE-HEALTH'), { code: 'EAI_AGAIN' }),
      reason: 'DNS_FAILURE', code: 'EAI_AGAIN', type: 'Error' },
    { error: new TypeError('fetch failed', { cause: Object.assign(new Error(API_KEY), { code: 'CERT_HAS_EXPIRED' }) }),
      reason: 'TLS_FAILURE', code: 'CERT_HAS_EXPIRED', type: 'TypeError' },
    { error: new Error('TLS handshake failed for ' + API_KEY), reason: 'TLS_FAILURE', type: 'Error' },
    { error: Object.assign(new Error(API_KEY), { code: 'ECONNRESET' }), reason: 'CONNECTION_LOST', code: 'ECONNRESET', type: 'Error' },
    { error: new Error('Network connection lost. ' + API_KEY), reason: 'CONNECTION_LOST', type: 'Error' },
    { error: Object.assign(new Error(API_KEY), { code: 'ECONNREFUSED' }), reason: 'CONNECTION_REFUSED', code: 'ECONNREFUSED', type: 'Error' },
    { error: new TypeError('Header value is invalid: ' + API_KEY), reason: 'INVALID_HEADER', type: 'TypeError' },
    { error: Object.assign(new TypeError(API_KEY), { code: 'ERR_HTTP_INVALID_HEADER_VALUE' }), reason: 'INVALID_HEADER', code: 'ERR_HTTP_INVALID_HEADER_VALUE', type: 'TypeError' },
    { error: Object.assign(new TypeError('request ' + API_KEY), { code: 'ERR_INVALID_URL' }), reason: 'INVALID_FETCH_OPTIONS', code: 'ERR_INVALID_URL', type: 'TypeError' },
    { error: new TypeError('Invalid RequestInit option PRIVATE-HEALTH'), reason: 'INVALID_FETCH_OPTIONS', type: 'TypeError' },
    { error: new Error('Outbound request blocked by policy ' + API_KEY), reason: 'EGRESS_DENIED', type: 'Error' },
    { error: new Error('Egress denied PRIVATE-HEALTH'), reason: 'EGRESS_DENIED', type: 'Error' },
    { error: new TypeError('unexpected redirect ' + API_KEY), reason: 'REDIRECT_BLOCKED', type: 'TypeError' },
    { error: new TypeError('Failed to fetch ' + API_KEY), reason: 'FETCH_FAILED', type: 'TypeError' },
    { error: Object.assign(new Error(API_KEY), { code: 'ETIMEDOUT' }), reason: 'FETCH_FAILED', code: 'ETIMEDOUT', type: 'Error' },
    { error: new Error(API_KEY), reason: 'UNKNOWN', type: 'Error' },
    { error: { message: API_KEY, code: 'PRIVATE-HEALTH', name: 'PRIVATE-TYPE' }, reason: 'UNKNOWN' },
    { error: API_KEY, reason: 'UNKNOWN' },
    { error: new DOMException('Network connection lost. ' + API_KEY, 'NetworkError'), reason: 'CONNECTION_LOST', type: 'DOMException' },
  ];
  for (const { error: thrown, reason, code, type } of cases) {
    let requests = 0;
    await assert.rejects(callHealthAssistant(configured(), input, { fetch: async () => { requests++; throw thrown; } }), (error) => {
      expectError('AI_NETWORK_ERROR', 502)(error);
      assert.ok(error instanceof AIProviderError);
      assert.deepEqual(error.diagnostics, { networkReason: reason, ...(code ? { networkCode: code } : {}), ...(type ? { networkType: type } : {}) });
      assert.equal(Object.isFrozen(error.diagnostics), true);
      assert.equal(error.diagnostics?.upstreamStatus, undefined);
      assert.equal((JSON.stringify(error) + error.message).includes('PRIVATE-HEALTH'), false);
      return true;
    });
    assert.equal(requests, 1, 'failed fetch is never retried');
  }
});

test('network exception inspection is bounded, does not execute getters and logs only safe enum fields', async (context) => {
  const warn = context.mock.method(console, 'warn', () => {});
  const privateDetail = `${API_KEY} PRIVATE-HEALTH https://private.test/request`;
  const cause = Object.assign(new Error('Network connection lost. ' + privateDetail), { code: 'ECONNRESET' });
  const outer = new TypeError(privateDetail, { cause });
  await assert.rejects(callHealthAssistant(configured(), input, { fetch: async () => { throw outer; } }), expectError('AI_NETWORK_ERROR', 502));
  assert.deepEqual(warn.mock.calls[0].arguments, ['minimax_request_failed', {
    code: 'AI_NETWORK_ERROR', status: 502, networkReason: 'CONNECTION_LOST', networkCode: 'ECONNRESET', networkType: 'TypeError',
  }]);
  const logged = JSON.stringify(warn.mock.calls[0].arguments);
  assert.equal(logged.includes(privateDetail), false);
  assert.equal(logged.includes(API_KEY), false);
  let getters = 0;
  const unusual = Object.create(null);
  for (const key of ['message', 'cause', 'code']) Object.defineProperty(unusual, key, { get() { getters++; throw new Error(privateDetail); } });
  await assert.rejects(callHealthAssistant(configured(), input, { fetch: async () => { throw unusual; } }), (error) => {
    assert.ok(error instanceof AIProviderError);
    assert.deepEqual(error.diagnostics, { networkReason: 'UNKNOWN' });
    return true;
  });
  assert.equal(getters, 0);
  const cycle: { message: string; cause?: unknown } = { message: privateDetail };
  cycle.cause = cycle;
  await assert.rejects(callHealthAssistant(configured(), input, { fetch: async () => { throw cycle; } }), (error) => {
    assert.ok(error instanceof AIProviderError);
    assert.deepEqual(error.diagnostics, { networkReason: 'UNKNOWN' });
    return true;
  });
  const oversizedMessage = new Error('x'.repeat(2048) + ' DNS resolution failed');
  await assert.rejects(callHealthAssistant(configured(), input, { fetch: async () => { throw oversizedMessage; } }), (error) => {
    assert.ok(error instanceof AIProviderError);
    assert.equal(error.diagnostics?.networkReason, 'UNKNOWN');
    return true;
  });
});

test('the total request deadline aborts even a fetch implementation that ignores its signal', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let signal: AbortSignal | null | undefined;
  const result = callHealthAssistant(configured(), input, { fetch: async (_url, init) => {
    signal = init?.signal;
    return await new Promise<Response>(() => {});
  } });
  assert.equal(signal?.aborted, false);
  context.mock.timers.tick(40000);
  await assert.rejects(result, expectError('AI_TIMEOUT', 504));
  assert.equal(signal?.aborted, true);
});

test('invalid questions or non-serializable contexts fail locally without contacting MiniMax', async () => {
  let requests = 0;
  const fetch: typeof globalThis.fetch = async () => { requests++; return jsonResponse(completion()); };
  const cyclic: { self?: unknown } = {}; cyclic.self = cyclic;
  for (const value of [{ ...input, question: '' }, { ...input, question: '字'.repeat(4001) }, { ...input, context: undefined }, { ...input, context: cyclic }, { ...input, context: { text: '字'.repeat(50000) } }]) {
    await assert.rejects(callHealthAssistant(configured(), value, { fetch }), expectError('AI_INPUT_INVALID', 400));
  }
  assert.equal(requests, 0);
});
