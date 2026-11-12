import { FinanceValidationError, LEDGERS } from '../../../lib/finance';
import { apiUser, isSameOrigin, json } from '../_shared';
import { FinanceIdempotencyConflictError, FinanceMetadataConflictError } from '../../../db/finance-store';
import { FinanceBalanceChangeConflictError, FinanceLastBalanceError } from '../../../db/finance-balance-changes-store';

export { apiUser, json };

export function financeUnauthenticated() {
  return json({ error: '请先登录网站，再查看或更新账本。', code: 'SIGN_IN_REQUIRED' }, 401);
}

export function financeNotFound() {
  return json({ error: '找不到这个账户。', code: 'FINANCE_ACCOUNT_NOT_FOUND' }, 404);
}

export function financeError(error: unknown) {
  if (error instanceof FinanceMetadataConflictError) return json({ error: error.message, code: error.code }, 409);
  if (error instanceof FinanceBalanceChangeConflictError || error instanceof FinanceLastBalanceError) return json({ error: error.message, code: error instanceof FinanceLastBalanceError ? 'FINANCE_LAST_BALANCE' : 'FINANCE_BALANCE_CHANGED' }, 409);
  if (error instanceof FinanceIdempotencyConflictError) return json({ error: '这次提交标识已用于其他内容，已有记录没有被修改。请重新打开表单后再保存。', code: 'FINANCE_IDEMPOTENCY_CONFLICT' }, 409);
  if (error instanceof FinanceValidationError) return json({ error: '请检查账户、金额和记录日期。', code: error.code, issues: error.issues }, 400);
  if (error instanceof SyntaxError) return json({ error: '填写内容格式不正确，请重试。', code: 'INVALID_FINANCE_INPUT' }, 400);
  if (error instanceof RangeError) return json({ error: '单次填写内容不能超过 16 KB。', code: 'FINANCE_REQUEST_TOO_LARGE' }, 413);
  const diagnosticId = crypto.randomUUID().replaceAll('-', '');
  const reason = error instanceof Error && error.message === 'READ_DEADLINE_EXCEEDED' ? 'read_timeout' : 'storage_failure';
  console.error(JSON.stringify({ event: 'storage_unavailable', module: 'finance', reason, diagnosticId }));
  return json({ error: '账本暂时不可用，请稍后重试。', code: 'FINANCE_UNAVAILABLE', diagnosticId }, 503, { 'X-Diagnostic-ID': diagnosticId });
}

export function ledgerFromRequest(request: Request): keyof typeof LEDGERS | null {
  const ledger = new URL(request.url).searchParams.get('ledger') ?? 'personal';
  return Object.hasOwn(LEDGERS, ledger) ? ledger as keyof typeof LEDGERS : null;
}

export function validAccountId(id: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
}

export function financeIdempotencyKey(request: Request): string | null {
  const key = request.headers.get('idempotency-key')?.trim();
  return key && validAccountId(key) ? key.toLowerCase() : null;
}

export function invalidFinanceIdempotencyKey() {
  return json({ error: '这次提交缺少有效标识，请重新打开表单后保存。', code: 'FINANCE_IDEMPOTENCY_KEY_REQUIRED' }, 400);
}

export function guardFinanceWrite(request: Request) {
  if (!isSameOrigin(request)) return json({ error: '请在已登录的网站中更新账本。', code: 'INVALID_ORIGIN' }, 403);
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) return json({ error: '请通过网站表单提交账本内容。' }, 415);
  return null;
}

export async function financeBody(request: Request): Promise<unknown> {
  const maximumBytes = 16 * 1024;
  const length = Number(request.headers.get('content-length'));
  if (Number.isFinite(length) && length > maximumBytes) throw new RangeError('Finance request too large');
  if (!request.body) throw new SyntaxError('Missing body');
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0; let text = '';
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      bytes += result.value.byteLength;
      if (bytes > maximumBytes) { await reader.cancel(); throw new RangeError('Finance request too large'); }
      text += decoder.decode(result.value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally { reader.releaseLock(); }
}
