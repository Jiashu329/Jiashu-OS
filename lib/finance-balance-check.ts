/** Self-contained helpers: the balance-check page embeds each function independently. */
export function normalizeCheckAmount(raw: unknown, decimals: number): string {
  if (decimals !== 0 && decimals !== 2) throw new Error('账户币种的小数位设置不正确，请刷新页面后重试。');
  if (typeof raw !== 'string' || !raw.trim()) throw new Error('请输入余额，负债也填写非负金额。');
  if (raw.length > 128) throw new Error('金额格式不正确，请使用普通数字。');
  for (let index = 0; index < raw.length; index++) {
    const code = raw.charCodeAt(index);
    if (code < 32 || code === 127) throw new Error('金额格式不正确，请使用普通数字。');
  }
  const value = raw.trim();
  const pieces = value.split('.');
  if (pieces.length > 2) throw new Error('金额格式不正确，请使用普通十进制数字。');
  const whole = pieces[0];
  const fraction = pieces[1];
  const grouped = /^\d{1,3}([,，\u00a0\u202f ])\d{3}(?:\1\d{3})*$/;
  if (!/^\d+$/.test(whole) && !grouped.test(whole)) throw new Error('金额需为非负数字；千位分组应完整且使用同一种分隔符。');
  if (fraction !== undefined && (decimals === 0 || !/^\d+$/.test(fraction) || fraction.length > decimals)) {
    throw new Error(decimals === 0 ? '日元余额不填写小数。' : '余额最多保留 2 位小数。');
  }
  const minor = BigInt(whole.replace(/[,，\u00a0\u202f ]/g, '') + (fraction ?? '').padEnd(decimals, '0'));
  if (minor > BigInt('999999999999999999')) throw new Error('单个账户余额过大，最多支持 18 位最小货币单位。');
  const digits = minor.toString().padStart(decimals + 1, '0');
  return decimals === 0 ? digits : digits.slice(0, -decimals) + '.' + digits.slice(-decimals);
}

export function validateCheckDate(raw: unknown, today: string): string {
  function validDay(value: unknown): value is string {
    if (typeof value !== 'string' || value.length !== 10 || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const year = Number(value.slice(0, 4));
    const month = Number(value.slice(5, 7));
    const day = Number(value.slice(8, 10));
    const date = new Date(Date.UTC(year, month - 1, day));
    return year >= 1970 && year <= 2100 && date.getUTCFullYear() === year
      && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  }
  if (!validDay(today)) throw new Error('当前日期无效，请刷新页面后重试。');
  if (!validDay(raw)) throw new Error('余额日期需为有效的 YYYY-MM-DD，年份在 1970 至 2100 之间。');
  if (raw > today) throw new Error('余额记录日期不能晚于今天。');
  return raw;
}

export function isCheckedThisMonth(asOfDate: string, today: string): boolean {
  function validDay(value: unknown): value is string {
    if (typeof value !== 'string' || value.length !== 10 || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const year = Number(value.slice(0, 4));
    const month = Number(value.slice(5, 7));
    const day = Number(value.slice(8, 10));
    const date = new Date(Date.UTC(year, month - 1, day));
    return year >= 1970 && year <= 2100 && date.getUTCFullYear() === year
      && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  }
  return validDay(asOfDate) && validDay(today) && asOfDate <= today && asOfDate.slice(0, 7) === today.slice(0, 7);
}

export function normalizeCheckNote(raw: unknown): string {
  if (raw === undefined) return '';
  if (typeof raw !== 'string') throw new Error('备注请使用文字。');
  for (let index = 0; index < raw.length; index++) {
    const code = raw.charCodeAt(index);
    if ((code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127) throw new Error('备注中包含不支持的控制字符。');
  }
  const note = raw.trim();
  if (note.length > 500) throw new Error('备注最多 500 个字符。');
  return note;
}
