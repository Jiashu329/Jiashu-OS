import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { AI_DIAGNOSTICS_HELPERS } from './ai-diagnostics-ui.ts';

const format = (input: unknown): string => runInNewContext(AI_DIAGNOSTICS_HELPERS + '\ndiagnosticText(input)', { input }) as string;

test('diagnostic display distinguishes provider codes and carries a bounded trace ID', () => {
  assert.equal(format({ upstreamCode: 2061, upstreamStatus: 200, traceId: 'a'.repeat(32) }),
    '（MiniMax 错误码：2061；上游 HTTP：200；追踪 ID：' + 'a'.repeat(32) + '）');
});

test('untrusted error strings, credentials and malformed diagnostics are never displayed', () => {
  for (const input of [null, [], 'private-key', { upstreamCode: 'private-key', upstreamStatus: 'private-health-data', traceId: '<img src=x>', message: 'private-key' },
    { upstreamCode: -1, upstreamStatus: 999, traceId: 'a'.repeat(65) }, { upstreamCode: 1.5, upstreamStatus: NaN, traceId: 'abcdef' }]) {
    assert.equal(format(input), '');
  }
});
