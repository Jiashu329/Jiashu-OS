/** Self-contained: the private page embeds this function without module imports. */
export function buildQuickWeightPayload(fields: {
  values: string | null; dates: string | null; at: string | null;
  source: string | null; unit: string | null;
  leanValues?: string | null; leanDates?: string | null; leanUnit?: string | null;
}) {
  const maximumBytes = 512 * 1024;
  const columns = [fields.values, fields.dates, fields.at, fields.source, fields.unit, fields.leanValues, fields.leanDates, fields.leanUnit];
  if (columns.some((value) => typeof value === 'string' && value.length > maximumBytes)
      || new TextEncoder().encode(columns.map((value) => value ?? '').join('\n')).byteLength > maximumBytes) {
    throw new Error('这次体重与去脂体重数据超过 512 KB，请缩短查询日期范围，或通过文件分批导入。');
  }
  function hasText(raw: string | null | undefined) {
    return typeof raw === 'string' && raw.trim().length > 0;
  }
  if (![fields.values, fields.dates, fields.leanValues, fields.leanDates].some(hasText)) {
    throw new Error('没有收到体重或去脂体重记录。请确认苹果健康中有对应记录，并点选对应的蓝色变量；没有记录时不要填入 0。');
  }
  const rawSource = fields.source;
  if (typeof rawSource !== 'string' || !rawSource.trim() || rawSource.trim().length > 120
      || /[\u0000-\u001f\u007f]/.test(rawSource)) {
    throw new Error('没有收到有效的体重与去脂体重来源，请选择一个实际数据来源，再复制网站生成的同步地址。');
  }
  const source = rawSource.trim();

  function lines(raw: string | null | undefined, label: string, kind: string) {
    if (typeof raw !== 'string' || !raw.trim()) {
      throw new Error('没有收到' + label + '。请确认苹果健康已有' + kind + '记录，并点选对应的蓝色变量；没有记录时不要填入 0。');
    }
    if (/\r(?!\n)/.test(raw)) throw new Error(label + '的分行格式不正确，请在“合并文本”里选择“新行”。');
    const result = raw.split(/\r\n|\n/);
    if (result.length > 300) throw new Error('单次每类最多接收 300 条记录，请缩短' + kind + '查询日期范围，或通过文件分批导入。');
    for (let index = 0; index < result.length; index++) {
      if (!result[index].trim()) {
        throw new Error(label + '第 ' + (index + 1) + ' 行为空。请让' + kind + '数值和它的测量日期来自同一批健康样本，并保留相同顺序。');
      }
      result[index] = result[index].trim();
    }
    return result;
  }

  function timestamp(raw: string | null, label: string) {
    if (typeof raw !== 'string') {
      if (label === '本次同步时间') throw new Error('同步地址中没有收到 at= 本次同步时间。若已添加日期变量，请检查地址是否被空格或换行截断，以及最后的 &at= 是否正确拼接；可按同步引导先清理最终地址中的空白，再打开 URL。');
      throw new Error('没有收到' + label + '，请使用包含时间的 ISO 8601 日期。');
    }
    if (label === '本次同步时间' && !raw.trim()) throw new Error('同步地址已有 at=，但本次同步时间是空的。请把“本次同步时间编码”的蓝色变量放在 &at= 后面，再运行快捷指令。');
    // URLSearchParams converts a literal + to a space. Restore only the
    // unambiguous trailing timezone, never arbitrary whitespace in the date.
    const value = raw.trim().replace(/ (\d{2}:\d{2})$/, '+$1');
    const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-](\d{2}):(\d{2}))$/);
    if (!match) {
      throw new Error(label + '格式不完整。' + (label === '本次同步时间'
        ? '请先添加“日期”动作选择“当前日期”，再格式化为 ISO 8601，并开启“包括时间”。'
        : '请使用原健康样本的“开始日期”，格式化为 ISO 8601，并开启“包括时间”；不要用当前日期代替测量日期。'));
    }
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const hour = Number(match[4]);
    const minute = Number(match[5]);
    const second = Number(match[6]);
    const offsetHour = match[8] === 'Z' ? 0 : Number(match[9]);
    const offsetMinute = match[8] === 'Z' ? 0 : Number(match[10]);
    const calendar = new Date(Date.UTC(year, month - 1, day));
    const time = Date.parse(value);
    if (year < 1970 || year > 2100 || calendar.getUTCFullYear() !== year
        || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day
        || hour > 23 || minute > 59 || second > 59 || offsetHour > 14
        || offsetMinute > 59 || (offsetHour === 14 && offsetMinute !== 0)
        || !Number.isFinite(time)) {
      throw new Error(label + '无效，请检查日期、时间和时区是否完整。');
    }
    const normalized = new Date(time);
    if (normalized.getUTCFullYear() < 1970 || normalized.getUTCFullYear() > 2100) {
      throw new Error(label + '超出支持的日期范围，请核对原健康样本。');
    }
    return { value, time, canonical: normalized.toISOString() };
  }

  const at = timestamp(fields.at, '本次同步时间');
  const grouped = /^\d{1,3}([,，\u00a0\u202f ])\d{3}(?:\1\d{3})*(?:\.\d+)?$/;
  const measurements = new Map<string, {
    id: string; metric: 'weight' | 'lean_body_mass'; value: number; unit: 'kg';
    aggregation: 'sample'; source: string; startDate: string;
  }>();
  function addMetric(metric: 'weight' | 'lean_body_mass', kind: string, rawValues: string | null | undefined, rawDates: string | null | undefined, unit: string | null | undefined) {
    // Each category owns its own pair of columns; an absent category must not
    // erase the other one or be matched to the other category by row number.
    if (!hasText(rawValues) && !hasText(rawDates)) return;
    if (unit !== 'kg' && unit !== 'lb' && unit !== 'jin') {
      throw new Error('请在网站选择手机读取值的' + kind + '单位：千克（kg）、磅（lb）或斤，再重新复制同步地址。');
    }
    const values = lines(rawValues, kind + '值', kind);
    const dates = lines(rawDates, kind + '测量日期', kind);
    if (values.length !== dates.length) {
      throw new Error(kind + '值和它的测量日期条数不一致。请从同一批' + kind + '健康样本提取两列，不要单独筛选或排序其中一列。');
    }
    const factor = unit === 'lb' ? 0.45359237 : unit === 'jin' ? 0.5 : 1;
    const minimum = metric === 'weight' ? 10 : 1;
    for (let index = 0; index < values.length; index++) {
      const raw = values[index];
      if (!/^\d+(?:\.\d+)?$/.test(raw) && !grouped.test(raw)) {
        throw new Error('第 ' + (index + 1) + ' 条' + kind + '不是有效数字。请提取健康样本的数值，不要包含单位、变量名称或使用小数逗号。');
      }
      const kilograms = Number(raw.replace(/[,，\u00a0\u202f ]/g, '')) * factor;
      if (!Number.isFinite(kilograms) || kilograms < minimum || kilograms > 600) {
        throw new Error('第 ' + (index + 1) + ' 条' + kind + '换算后需在 ' + minimum + ' 至 600 kg 之间，请核对数值和所选单位；不要用 0 代替缺失记录。');
      }
      const value = Math.round(kilograms * 1000000) / 1000000;
      const measuredAt = timestamp(dates[index], '第 ' + (index + 1) + ' 条' + kind + '测量日期');
      if (measuredAt.time > at.time + 5 * 60000) {
        throw new Error('第 ' + (index + 1) + ' 条' + kind + '测量日期晚于本次同步时间，请核对原健康样本日期与“当前日期”变量是否接反。');
      }
      // Retain existing weight IDs. Re-exporting either category preserves its
      // identity, while the two categories remain independent at the same time.
      const id = (metric === 'weight' ? 'quick-weight:' : 'quick-lean-body-mass:') + measuredAt.canonical;
      const previous = measurements.get(id);
      if (previous) {
        if (previous.value !== value) throw new Error('同一个测量时刻出现不同' + kind + '，请在苹果健康核对重复记录，保留一个选定来源后重试。');
        continue;
      }
      measurements.set(id, { id, metric, value, unit: 'kg', aggregation: 'sample', source, startDate: measuredAt.canonical });
    }
  }
  addMetric('weight', '体重', fields.values, fields.dates, fields.unit);
  addMetric('lean_body_mass', '去脂体重', fields.leanValues, fields.leanDates, fields.leanUnit);
  const payload = {
    version: 1 as const,
    source: 'apple-health-shortcuts' as const,
    timezone: 'Asia/Shanghai' as const,
    exportedAt: at.value,
    measurements: [...measurements.values()].sort((left, right) => left.startDate.localeCompare(right.startDate) || left.metric.localeCompare(right.metric)),
  };
  if (new TextEncoder().encode(JSON.stringify(payload)).byteLength > maximumBytes) {
    throw new Error('组装后的体重与去脂体重数据超过 512 KB，请缩短查询日期范围，或通过文件分批导入。');
  }
  return payload;
}
