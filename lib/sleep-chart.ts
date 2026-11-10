export interface SleepChartRow {
  value: number;
  sleepStages?: {
    core: number;
    deep: number;
    rem: number;
    unspecified: number;
    awake: number;
    inBed: number;
  };
}

export interface SleepChartInput {
  points: Array<[string, SleepChartRow]>;
  days: number;
  start: number;
  end: number;
  width?: number;
  stage?: string;
  selectedDay?: string;
}

/** Kept self-contained because the health page embeds this function in its browser script. */
export function renderSleepChart(input: SleepChartInput): string {
  const escape = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]!);
  const stages = {
    deep: { label: '深度睡眠', color: '#6454a4' },
    core: { label: '核心睡眠', color: '#729bdd' },
    rem: { label: 'REM 睡眠', color: '#54b9be' },
    unspecified: { label: '未分类睡眠', color: '#9ba5b8' },
    awake: { label: '清醒', color: '#d89b59' },
    inBed: { label: '卧床', color: '#bec7cd' },
  };
  type Stage = keyof typeof stages;
  const stage = input.stage && Object.hasOwn(stages, input.stage) ? input.stage as Stage : 'all';
  const visibleStages: Stage[] = stage === 'all' ? ['deep', 'core', 'rem', 'unspecified'] : [stage];
  const duration = (row: SleepChartRow, key: Stage): number | null => {
    if (!row.sleepStages) return key === 'unspecified' ? row.value : null;
    const value = row.sleepStages[key];
    return Number.isFinite(value) && value >= 0 ? value : null;
  };
  const format = (hours: number) => {
    const minutes = Math.round(hours * 60);
    if (!minutes) return hours > 0 ? '不到 1 分钟' : '0 分钟';
    return (Math.floor(minutes / 60) ? Math.floor(minutes / 60) + ' 小时' : '')
      + (minutes % 60 ? ' ' + minutes % 60 + ' 分钟' : '');
  };
  const days = Math.max(1, input.days);
  const baseWidth = Math.max(280, input.width || 680);
  const width = days >= 90 ? Math.max(baseWidth, days * 6 + 68) : baseWidth;
  const height = 280;
  const left = 48, right = 20, top = 28, bottom = 42;
  const plotWidth = width - left - right, plotHeight = height - top - bottom;
  const baseline = height - bottom;
  const slot = plotWidth / days;
  const barWidth = Math.min(28, slot * 0.68);
  const available = input.points.filter(([, row]) => stage === 'all' || duration(row, stage) !== null);
  const values = available.map(([, row]) => stage === 'all' ? row.value : duration(row, stage)!);
  const highest = Math.max(0, ...values);
  const step = highest <= 2 ? 0.5 : highest <= 4 ? 1 : highest <= 8 ? 2 : highest <= 12 ? 3 : highest <= 16 ? 4 : 6;
  const maximum = Math.max(step * 4, Math.ceil(highest / step) * step);
  const y = (value: number) => baseline - value / maximum * plotHeight;
  const title = stage === 'all' ? '睡眠阶段趋势' : stages[stage].label + '趋势';
  const selectedDay = input.selectedDay || available.at(-1)?.[0];
  let svg = '<svg viewBox="0 0 ' + width + ' ' + height + '" role="group" aria-label="'
    + escape(title + '，最近 ' + days + ' 天，' + available.length + ' 天有记录') + '"'
    + (days >= 90 ? ' style="min-width:' + width + 'px"' : '') + '>';
  svg += '<text x="' + (left - 10) + '" y="15" fill="#52616f" font-size="11" text-anchor="end">小时</text>';
  for (let index = 0; index <= 4; index++) {
    const value = maximum * index / 4;
    const yy = y(value);
    svg += '<line x1="' + left + '" y1="' + yy + '" x2="' + (width - right) + '" y2="' + yy
      + '" stroke="#e9edf1"' + (index ? ' stroke-dasharray="3 5"' : '') + '/>'
      + '<text x="' + (left - 10) + '" y="' + (yy + 4) + '" fill="#64727e" text-anchor="end" font-size="11">'
      + Number(value.toFixed(2)) + '</text>';
  }
  for (const [day, row] of available) {
    const dayTime = new Date(day + 'T00:00:00+08:00').getTime();
    if (!Number.isFinite(dayTime) || dayTime < input.start || dayTime > input.end) continue;
    const xx = left + ((dayTime - input.start) / 86400000 + 0.5) * slot;
    const value = stage === 'all' ? row.value : duration(row, stage)!;
    const detail = visibleStages.map((key) => {
      const hours = duration(row, key);
      return hours === null ? '' : stages[key].label + ' ' + format(hours);
    }).filter(Boolean).join('，');
    const label = day + '，' + (stage === 'all' ? '总睡眠 ' : stages[stage].label + ' ') + format(value)
      + (stage === 'all' && detail ? '。' + detail : '') + '。查看当日详情';
    svg += '<g class="sleep-bar' + (selectedDay === day ? ' selected' : '') + '" data-sleep-day="'
      + escape(day) + '" tabindex="0" role="button" aria-pressed="' + String(selectedDay === day)
      + '" aria-label="' + escape(label) + '"><title>' + escape(label) + '</title>'
      + '<rect class="sleep-bar-hit" x="' + (xx - slot / 2 + 0.5) + '" y="' + top + '" width="'
      + Math.max(1, slot - 1) + '" height="' + plotHeight + '" rx="3" fill="transparent"/>';
    let cumulative = 0;
    for (const key of visibleStages) {
      const hours = duration(row, key) ?? 0;
      if (hours <= 0) continue;
      cumulative += hours;
      svg += '<rect x="' + (xx - barWidth / 2).toFixed(2) + '" y="' + y(cumulative).toFixed(2)
        + '" width="' + barWidth.toFixed(2) + '" height="' + (hours / maximum * plotHeight).toFixed(2)
        + '" fill="' + stages[key].color + '" pointer-events="none"/>';
    }
    if (!value) svg += '<line x1="' + (xx - barWidth / 2) + '" x2="' + (xx + barWidth / 2)
      + '" y1="' + baseline + '" y2="' + baseline + '" stroke="' + (stage === 'all' ? '#9ba5b8' : stages[stage].color) + '" stroke-width="2"/>';
    svg += '</g>';
  }
  const tickCount = days === 7 ? 7 : days >= 90 ? Math.min(13, Math.max(4, Math.floor(width / 130))) : 5;
  const shown = new Set<number>();
  for (let index = 0; index < tickCount; index++) {
    const offset = Math.round((days - 1) * index / Math.max(1, tickCount - 1));
    if (shown.has(offset)) continue;
    shown.add(offset);
    const date = new Date(input.start + offset * 86400000 + 8 * 3600000).toISOString().slice(0, 10);
    const xx = left + (offset + 0.5) * slot;
    svg += '<text x="' + xx + '" y="' + (height - 15) + '" fill="#64727e" text-anchor="middle" font-size="11">'
      + escape(date.slice(5).replace('-', '/')) + '</text>';
  }
  svg += '</svg>';
  return '<div class="sleep-chart-scroll" tabindex="' + (days >= 90 ? '0' : '-1') + '" aria-label="睡眠趋势图'
    + (days >= 90 ? '，可左右滚动查看日期' : '') + '">' + svg + '</div>'
    + (!available.length ? '<p class="sleep-chart-note">当前范围没有' + escape(stage === 'all' ? '睡眠' : stages[stage].label)
      + '记录。重新同步含睡眠状态的数据后可查看。</p>' : '')
    + (days >= 90 && available.length ? '<p class="sleep-chart-note">左右滑动查看日期，点选柱形查看各状态时长。</p>' : '');
}

/** Kept self-contained for use through Function.toString() in the health page. */
export function renderSleepDetails(day: string, row: SleepChartRow): string {
  const escape = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]!);
  const format = (hours: number | null) => {
    if (hours === null || !Number.isFinite(hours)) return '未提供';
    const minutes = Math.round(hours * 60);
    if (!minutes) return hours > 0 ? '不到 1 分钟' : '0 分钟';
    return (Math.floor(minutes / 60) ? Math.floor(minutes / 60) + ' 小时' : '')
      + (minutes % 60 ? ' ' + minutes % 60 + ' 分钟' : '');
  };
  const stages = [
    ['core', '核心睡眠', '#729bdd'], ['deep', '深度睡眠', '#6454a4'],
    ['rem', 'REM 睡眠', '#54b9be'], ['unspecified', '未分类睡眠', '#9ba5b8'],
    ['awake', '清醒', '#d89b59'], ['inBed', '卧床', '#bec7cd'],
  ] as const;
  let html = '<div class="sleep-detail-heading"><strong>' + escape(day) + '</strong><span>总睡眠 <b>'
    + escape(format(row.value)) + '</b></span></div><dl class="sleep-stage-details">';
  for (const [key, label, color] of stages) {
    const value = row.sleepStages ? row.sleepStages[key] : key === 'unspecified' ? row.value : null;
    html += '<div><dt><i style="background:' + color + '"></i>' + label + '</dt><dd>' + escape(format(value)) + '</dd></div>';
  }
  html += '</dl><p class="sleep-chart-note">清醒与卧床时长单独展示，不计入总睡眠。卧床可能包含已入睡的时间。</p>';
  if (!row.sleepStages) html += '<p class="sleep-chart-note">这条记录只有总时长，显示为未分类睡眠。重新运行睡眠同步后可查看具体阶段。</p>';
  return html;
}
