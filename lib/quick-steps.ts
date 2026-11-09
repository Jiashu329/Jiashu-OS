/** Self-contained so the same function can be embedded in the private page. */
export function buildQuickStepsPayload(fields: { value: string | null; at: string | null; source: string | null; metric?: string | null; unit?: string | null }) {
  const metric = fields.metric ?? 'steps';
  if (metric !== 'steps' && metric !== 'active_energy') throw new Error('这个简易同步地址的数据类型不受支持，请重新复制网站生成的地址。');
  const unit = fields.unit ?? (metric === 'steps' ? 'count' : null);
  if (metric === 'steps' && unit !== 'count') throw new Error('步数的单位需要为 count，请重新复制步数同步地址。');
  if (metric === 'active_energy' && unit !== 'kcal' && unit !== 'kJ') throw new Error('请在网站选择手机读取值的能量单位：千卡（kcal）或千焦（kJ），再重新复制活动能量同步地址。');
  const label = metric === 'steps' ? '步数' : '活动能量';
  const raw = fields.value?.trim();
  if (!raw) throw new Error('没有收到' + label + '。请先运行“查找健康样本”，确认今天确实有记录；不要填入 0 代替。');
  const grouped = /^\d{1,3}([,，\u00a0\u202f ])\d{3}(?:\1\d{3})*(?:\.\d+)?$/;
  if (!/^\d+(?:\.\d+)?$/.test(raw) && !grouped.test(raw)) {
    throw new Error('收到的' + label + '不是数字。请在“文本”中点选蓝色的“健康样本详细信息”变量，不要手动输入变量名称。');
  }
  const numericValue = Number(raw.replace(/[,，\u00a0\u202f ]/g, ''));
  if (metric === 'steps' && (!Number.isInteger(numericValue) || numericValue < 0 || numericValue > 200000)) {
    throw new Error('步数超出可接收范围，请核对健康样本类型是否为“步数”。');
  }
  if (metric === 'active_energy' && (!Number.isFinite(numericValue) || numericValue < 0 || numericValue > (unit === 'kJ' ? 20000 * 4.184 : 20000))) {
    throw new Error('活动能量超出可接收范围，请核对健康样本类型和能量单位。');
  }
  const value = metric === 'active_energy' && unit === 'kJ' ? Math.round(numericValue / 4.184 * 1000000) / 1000000 : numericValue;
  // URLSearchParams interprets a literal + as a space. Restore only the
  // unambiguous trailing ISO timezone, without asking users to add an encoder.
  const at = fields.at?.trim().replace(/ (\d{2}:\d{2})$/, '+$1');
  const match = at?.match(/^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/);
  if (!at || !match || !Number.isFinite(Date.parse(at))) {
    throw new Error('没有收到完整日期。请先添加“日期”动作并选择“当前日期”，再接“格式化日期”，格式设为 ISO 8601 并开启“包括时间”，最后点选它的蓝色输出变量。');
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
    measurements: [{ id: 'quick-' + metric + ':' + day, metric, value, unit: metric === 'steps' ? 'count' : 'kcal', aggregation: 'daily', source, startDate: day + 'T00:00:00+08:00', endDate: at }],
  };
}
