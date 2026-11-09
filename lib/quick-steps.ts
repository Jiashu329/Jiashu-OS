/** Self-contained so the same function can be embedded in the private page. */
export function buildQuickStepsPayload(fields: {
  value?: string | null; values?: string | null; dates?: string | null; days?: string | null;
  at: string | null; source: string | null; metric?: string | null; unit?: string | null;
}) {
  const maximumBytes = 512 * 1024;
  const columns = [fields.value, fields.values, fields.dates, fields.days, fields.at, fields.source, fields.metric, fields.unit];
  if (columns.some((value) => typeof value === 'string' && value.length > maximumBytes)
      || new TextEncoder().encode(columns.map((value) => value ?? '').join('\n')).byteLength > maximumBytes) {
    throw new Error('这次同步数据超过 512 KB，请缩短查询日期范围，或通过文件分批导入。');
  }
  const metric = fields.metric ?? 'steps';
  if (metric !== 'steps' && metric !== 'active_energy') throw new Error('这个简易同步地址的数据类型不受支持，请重新复制网站生成的地址。');
  const unit = fields.unit ?? (metric === 'steps' ? 'count' : null);
  if (metric === 'steps' && unit !== 'count') throw new Error('步数的单位需要为 count，请重新复制步数同步地址。');
  if (metric === 'active_energy' && unit !== 'kcal' && unit !== 'kJ') throw new Error('请在网站选择手机读取值的能量单位：千卡（kcal）或千焦（kJ），再重新复制活动能量同步地址。');
  const label = metric === 'steps' ? '步数' : '活动能量';
  const source = fields.source?.trim();
  // oxlint-disable-next-line no-control-regex -- Source identifiers must exclude control characters.
  if (!source || source.length > 120 || /[\u0000-\u001f\u007f]/.test(fields.source!)) throw new Error('没有收到选定的数据来源，请重新复制网页生成的同步地址。');

  function timestamp(raw: string | null | undefined, name: string) {
    // URLSearchParams interprets a literal + as a space. Restore only the
    // unambiguous trailing ISO timezone, never arbitrary date whitespace.
    const value = raw?.trim().replace(/ (\d{2}:\d{2})$/, '+$1');
    const match = value?.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-](\d{2}):(\d{2}))$/);
    if (!value || !match) throw new Error(name + '不完整。请格式化为 ISO 8601 并开启“包括时间”，然后点选对应的蓝色日期变量。');
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const calendar = new Date(Date.UTC(year, month - 1, day));
    const offsetHour = match[7] === 'Z' ? 0 : Number(match[8]);
    const offsetMinute = match[7] === 'Z' ? 0 : Number(match[9]);
    const time = Date.parse(value);
    if (year < 1970 || year > 2100 || calendar.getUTCFullYear() !== year
        || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day
        || Number(match[4]) > 23 || Number(match[5]) > 59 || Number(match[6]) > 59
        || offsetHour > 14 || offsetMinute > 59 || (offsetHour === 14 && offsetMinute !== 0)
        || !Number.isFinite(time) || new Date(time).getUTCFullYear() < 1970 || new Date(time).getUTCFullYear() > 2100) {
      throw new Error(name + '无效，请核对日期、时间和时区。');
    }
    return { value, time };
  }

  const at = timestamp(fields.at, '本次同步时间');
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  function parts(time: number) {
    const entries = formatter.formatToParts(new Date(time));
    return (name: string) => entries.find((item) => item.type === name)!.value;
  }
  function shanghaiDay(time: number) {
    const part = parts(time);
    return part('year') + '-' + part('month') + '-' + part('day');
  }
  function midnight(day: string) {
    const local = Date.parse(day + 'T00:00:00Z');
    const guess = local - 8 * 3600000;
    const part = parts(guess);
    // Honor Shanghai's historical daylight-saving offset as well as UTC+08.
    const offset = Date.UTC(Number(part('year')), Number(part('month')) - 1, Number(part('day')),
      Number(part('hour')), Number(part('minute')), Number(part('second'))) - guess;
    return local - offset;
  }
  function dailyDate(raw: string, index: number) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
      timestamp(raw + 'T12:00:00+08:00', '第 ' + (index + 1) + ' 行日期');
      return raw;
    }
    const date = timestamp(raw, '第 ' + (index + 1) + ' 行日期');
    if (date.time > at.time + 5 * 60000) throw new Error('第 ' + (index + 1) + ' 行日期晚于本次同步时间，请使用这行健康样本的原始开始日期。');
    return shanghaiDay(date.time);
  }
  function lines(raw: string | null | undefined, name: string) {
    if (!raw?.trim()) throw new Error('没有收到' + name + '。请从同一批按天分组的健康样本提取数值和日期；没有记录时不要填入 0。');
    if (/\r(?!\n)/.test(raw)) throw new Error(name + '的分行格式不正确，请在“合并文本”里选择“新行”。');
    const result = raw.split(/\r\n|\n/);
    if (result.length > 1000) throw new Error('单次最多接收 1000 条每日记录，请缩短查询范围或分批导入。');
    return result.map((line, index) => {
      if (!line.trim()) throw new Error(name + '第 ' + (index + 1) + ' 行为空。请保留数值与日期的对应关系，不要单独删除某一列的空行。');
      return line.trim();
    });
  }
  function numeric(raw: string) {
    const grouped = /^\d{1,3}([,，\u00a0\u202f ])\d{3}(?:\1\d{3})*(?:\.\d+)?$/;
    if (!/^\d+(?:\.\d+)?$/.test(raw) && !grouped.test(raw)) {
      throw new Error('收到的' + label + '不是数字。请点选健康样本的“值”，不要包含单位或变量名称；多日同步需同时传入每日数值和对应日期。');
    }
    const value = Number(raw.replace(/[,，\u00a0\u202f ]/g, ''));
    if (metric === 'steps' && (!Number.isInteger(value) || value < 0 || value > 200000)) {
      throw new Error('步数超出可接收范围，请核对健康样本类型是否为“步数”。');
    }
    if (metric === 'active_energy' && (!Number.isFinite(value) || value < 0 || value > (unit === 'kJ' ? 20000 * 4.184 : 20000))) {
      throw new Error('活动能量超出可接收范围，请核对健康样本类型和能量单位。');
    }
    return metric === 'active_energy' && unit === 'kJ' ? Math.round(value / 4.184 * 1000000) / 1000000 : value;
  }

  const batch = fields.values != null || fields.dates != null;
  if (batch && fields.value != null) throw new Error('同步地址同时包含单日和多日数据，请使用新引导生成的多日地址，不要混用 value 与 values、dates。');
  if (fields.days != null) {
    const validDays = metric === 'steps' ? /^(?:[1-9]|[1-8]\d|90)$/ : /^(?:[1-9]|[12]\d|30)$/;
    if (!batch || fields.days.trim() !== fields.days || !validDays.test(fields.days)) {
      throw new Error(label + '同步天数需要为 1 至 ' + (metric === 'steps' ? '90' : '30')
        + ' 的整数，且只用于多日' + label + '地址，请重新复制配置指引生成的地址。');
    }
  }
  const today = shanghaiDay(at.time);
  const firstDay = fields.days == null ? null
    : new Date(Date.parse(today + 'T12:00:00Z') - (Number(fields.days) - 1) * 86400000).toISOString().slice(0, 10);
  const values = batch ? lines(fields.values, '每日' + label) : lines(fields.value, label);
  const dates = batch ? lines(fields.dates, '每日日期') : [shanghaiDay(at.time)];
  if (values.length !== dates.length) throw new Error('每日' + label + '与日期条数不一致。请从同一批按天分组的健康样本提取两列，并保持相同顺序。');
  const measurements = new Map<string, {
    id: string; metric: 'steps' | 'active_energy'; value: number; unit: 'count' | 'kcal';
    aggregation: 'daily'; source: string; startDate: string; endDate: string;
  }>();
  for (let index = 0; index < values.length; index++) {
    const value = numeric(values[index]);
    const day = dailyDate(dates[index], index);
    // Query an extra day in Shortcuts so every retained historical day is
    // complete. Filter the paired row by its date, never by list position.
    if (firstDay && day < firstDay) continue;
    const start = midnight(day);
    if (new Date(start).getUTCFullYear() < 1970) throw new Error('第 ' + (index + 1) + ' 行日期超出支持范围，请核对原健康样本。');
    const nextDay = new Date(Date.parse(day + 'T12:00:00Z') + 86400000).toISOString().slice(0, 10);
    const end = Math.min(midnight(nextDay), at.time);
    if (end <= start) throw new Error('第 ' + (index + 1) + ' 行日期尚未开始或同步时间恰好在午夜，请核对每日日期，稍后重新读取再同步。');
    const previous = measurements.get(day);
    if (previous) {
      if (previous.value !== value) throw new Error('同一天出现不同的' + label + '总量。请按天分组并只选一个来源，不要把原始样本当作每日汇总。');
      continue;
    }
    measurements.set(day, {
      id: 'quick-' + metric + ':' + day, metric, value, unit: metric === 'steps' ? 'count' : 'kcal',
      aggregation: 'daily', source: source!, startDate: new Date(start).toISOString(),
      endDate: end === at.time ? at.value : new Date(end).toISOString(),
    });
  }
  if (firstDay && measurements.size === 0) throw new Error('查询结果中没有所选日期范围内的' + label + '，请核对查询天数、样本日期和手机时区；没有记录时不要补零。');
  const payload = {
    version: 1, source: 'apple-health-shortcuts', timezone: 'Asia/Shanghai', exportedAt: at.value,
    measurements: [...measurements.values()].sort((left, right) => left.startDate.localeCompare(right.startDate)),
  };
  if (new TextEncoder().encode(JSON.stringify(payload)).byteLength > maximumBytes) {
    throw new Error('组装后的同步数据超过 512 KB，请缩短查询日期范围，或通过文件分批导入。');
  }
  return payload;
}
