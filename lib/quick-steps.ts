/** Self-contained so the same function can be embedded in the private page. */
export function buildQuickStepsPayload(fields: { value: string | null; at: string | null; source: string | null }) {
  const raw = fields.value?.trim();
  if (!raw) throw new Error('没有收到步数。请先运行“查找健康样本”，确认今天确实有记录；不要填入 0 代替。');
  const grouped = /^\d{1,3}(?:[,，\u00a0\u202f ]\d{3})+$/;
  if (!/^\d+(?:\.0+)?$/.test(raw) && !grouped.test(raw)) {
    throw new Error('收到的步数不是数字。请在“文本”中点选蓝色的“健康样本详细信息”变量，不要手动输入变量名称。');
  }
  const value = Number(raw.replace(/[,，\u00a0\u202f ]/g, ''));
  if (!Number.isInteger(value) || value < 0 || value > 200000) throw new Error('步数超出可接收范围，请核对健康样本类型是否为“步数”。');
  // URLSearchParams interprets a literal + as a space. Restore only the
  // unambiguous trailing ISO timezone, without asking users to add an encoder.
  const at = fields.at?.trim().replace(/ (\d{2}:\d{2})$/, '+$1');
  const match = at?.match(/^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/);
  if (!at || !match || !Number.isFinite(Date.parse(at))) {
    throw new Error('没有收到完整日期。请将“格式化日期”的输入设为“当前日期”，格式设为 ISO 8601，再点选它的蓝色输出变量。');
  }
  const calendar = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (calendar.getUTCFullYear() !== Number(match[1]) || calendar.getUTCMonth() !== Number(match[2]) - 1 || calendar.getUTCDate() !== Number(match[3])) {
    throw new Error('日期无效，请重新运行快捷指令获取当前日期。');
  }
  const source = fields.source?.trim();
  if (!source || source.length > 120 || /[\u0000-\u001f\u007f]/.test(source)) throw new Error('没有收到选定的数据来源，请重新复制网页生成的同步地址。');
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(at));
  const part = (name: string) => parts.find((item) => item.type === name)!.value;
  const day = part('year') + '-' + part('month') + '-' + part('day');
  return {
    version: 1,
    source: 'apple-health-shortcuts',
    timezone: 'Asia/Shanghai',
    exportedAt: at,
    measurements: [{ id: 'quick-steps:' + day, metric: 'steps', value, unit: 'count', aggregation: 'daily', source, startDate: day + 'T00:00:00+08:00', endDate: at }],
  };
}
