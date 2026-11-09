/** Self-contained: the private page embeds this function without module imports. */
export function buildQuickSleepPayload(fields: { states: string | null; starts: string | null; ends: string | null; at: string | null; source: string | null }) {
  const maximumBytes = 512 * 1024;
  const columns = [fields.states, fields.starts, fields.ends, fields.at, fields.source];
  if (columns.some((value) => typeof value === 'string' && value.length > maximumBytes)
      || new TextEncoder().encode(columns.map((value) => value ?? '').join('\n')).byteLength > maximumBytes) {
    throw new Error('这次睡眠数据超过 512 KB，请缩短快捷指令查询的日期范围。');
  }

  function lines(raw: string | null, label: string) {
    if (typeof raw !== 'string' || !raw.trim()) {
      throw new Error('没有收到' + label + '。请确认查找到了睡眠记录，并点选对应的蓝色变量；没有记录不代表睡眠为 0 小时。');
    }
    if (/\r(?!\n)/.test(raw)) throw new Error(label + '的分行格式不正确，请在“合并文本”里选择“新行”。');
    const result = raw.split(/\r\n|\n/);
    if (result.length > 300) throw new Error('单次最多接收 300 段睡眠记录，请缩短查询的日期范围。');
    for (let index = 0; index < result.length; index++) {
      if (!result[index].trim()) {
        throw new Error(label + '第 ' + (index + 1) + ' 行为空。请让三列来自同一批健康样本，并保留原来的顺序。');
      }
      result[index] = result[index].trim();
    }
    return result;
  }

  function timestamp(raw: string | null, label: string) {
    if (typeof raw !== 'string') throw new Error('没有收到' + label + '，请使用包含时间的 ISO 8601 日期。');
    // A literal + in a URL becomes a space under URLSearchParams. Restore
    // only an unambiguous trailing ISO timezone, never arbitrary whitespace.
    const value = raw.trim().replace(/ (\d{2}:\d{2})$/, '+$1');
    const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-](\d{2}):(\d{2}))$/);
    if (!match) {
      const instruction = label === '本次同步时间'
        ? '请将“日期”动作的当前日期设为 ISO 8601，并开启“包括时间”。'
        : '请将健康样本的开始、结束日期分别格式化为 ISO 8601，并开启“包括时间”；片段日期应来自原健康样本。';
      throw new Error(label + '格式不完整。' + instruction);
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
    if (year < 1970 || year > 2100 || calendar.getUTCFullYear() !== year
        || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day
        || hour > 23 || minute > 59 || second > 59 || offsetHour > 14
        || offsetMinute > 59 || (offsetHour === 14 && offsetMinute !== 0)
        || !Number.isFinite(Date.parse(value))) {
      throw new Error(label + '无效，请检查日期、时间和时区是否完整。');
    }
    return { value, time: Date.parse(value) };
  }

  const states = lines(fields.states, '睡眠状态');
  const starts = lines(fields.starts, '睡眠开始时间');
  const ends = lines(fields.ends, '睡眠结束时间');
  if (states.length !== starts.length || states.length !== ends.length) {
    throw new Error('睡眠状态、开始时间和结束时间的条数不一致。请从同一批健康样本分别取出三列，不要单独筛选或排序其中一列。');
  }
  const at = timestamp(fields.at, '本次同步时间');
  const rawSource = fields.source;
  if (typeof rawSource !== 'string' || !rawSource.trim() || rawSource.trim().length > 120
      || /[\u0000-\u001f\u007f]/.test(rawSource)) {
    throw new Error('没有收到有效的睡眠来源，请重新复制网站生成的同步地址。');
  }
  const source = rawSource.trim();
  const segments = states.map((state, index) => {
    const start = timestamp(starts[index], '第 ' + (index + 1) + ' 段开始时间');
    const end = timestamp(ends[index], '第 ' + (index + 1) + ' 段结束时间');
    if (end.time <= start.time) throw new Error('第 ' + (index + 1) + ' 段的结束时间必须晚于开始时间，请核对两列蓝色变量是否接反。');
    // Preserve category labels. The server owns Apple state mapping and the
    // union of asleep intervals; a category value is never a duration here.
    return { state, startDate: start.value, endDate: end.value };
  });
  const dateParts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(at.time));
  const part = (name: string) => dateParts.find((item) => item.type === name)!.value;
  const payload = {
    version: 1 as const,
    source: 'apple-health-shortcuts' as const,
    timezone: 'Asia/Shanghai' as const,
    exportedAt: at.value,
    measurements: [],
    sleepReport: { day: part('year') + '-' + part('month') + '-' + part('day'), source, segments },
  };
  if (new TextEncoder().encode(JSON.stringify(payload)).byteLength > maximumBytes) {
    throw new Error('组装后的睡眠数据超过 512 KB，请缩短查询的日期范围。');
  }
  return payload;
}
