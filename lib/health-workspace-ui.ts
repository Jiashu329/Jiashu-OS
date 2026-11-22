import { APPLE_WORKOUT_NAMES } from './apple-workout-names.ts';

const groupInfo = {
  activity: { label: '活动与训练', metrics: ['steps', 'active_energy', 'workouts'] },
  sleep: { label: '睡眠', metrics: ['sleep'] },
  heart: { label: '心率', metrics: ['heart_rate', 'resting_heart_rate'] },
  oxygen: { label: '血氧', metrics: ['oxygen_saturation'] },
  body: { label: '体重与体成分', metrics: ['weight', 'lean_body_mass', 'body_fat'] },
} as const;

export const HEALTH_WORKSPACE_METRICS = {
  steps: { label: '步数', short: '步数', title: '步数变化', unit: '步', subtitle: '每日步数汇总', decimals: 0, kind: 'bar', legacy: true },
  active_energy: { label: '活动能量', short: '活动能量', title: '活动能量变化', unit: '千卡', subtitle: '全天活动能量汇总', decimals: 1, kind: 'bar', legacy: true },
  workouts: { label: '训练记录', short: '训练', title: '训练趋势', unit: '次', subtitle: '按训练开始日期统计已同步训练', decimals: 0, kind: 'bar', legacy: false },
  sleep: { label: '睡眠时长', short: '睡眠', title: '睡眠趋势', unit: '小时', subtitle: '按醒来日统计，点选柱形查看分期', decimals: 1, legacy: true },
  heart_rate: { label: '日均心率', short: '心率', title: '心率趋势', unit: '次/分', subtitle: '日均及当天最低、最高心率', decimals: 1, kind: 'range', legacy: false },
  resting_heart_rate: { label: '静息心率', short: '静息心率', title: '静息心率趋势', unit: '次/分', subtitle: '每日静息心率', decimals: 1, legacy: false },
  oxygen_saturation: { label: '血氧', short: '血氧', title: '血氧趋势', unit: '%', subtitle: '按日汇总血氧，日详情显示最近读数', decimals: 1, legacy: false, ticks: [95, 96, 97, 98, 99, 100] },
  weight: { label: '体重', short: '体重', title: '体重变化', unit: 'kg', subtitle: '每日最近一次体重测量', decimals: 1, legacy: true },
  lean_body_mass: { label: '去脂体重', short: '去脂体重', title: '去脂体重变化', unit: 'kg', subtitle: '每日最近一次去脂体重测量', decimals: 1, legacy: true },
  body_fat: { label: '估算体脂率', short: '估算体脂率', title: '估算体脂率变化', unit: '%', subtitle: '取当日最近一次同源测量配对', decimals: 1, legacy: false },
} as const;

const icons = {
  activity: '<path d="M4 16h4l4-8 3 6h5"/>',
  sleep: '<path d="M20.9 13.3A9 9 0 0 1 10.7 3a9 9 0 1 0 10.2 10.3Z"/>',
  heart: '<path d="M20.8 8.6c0 4.3-8.8 10.2-8.8 10.2S3.2 12.9 3.2 8.6a4.6 4.6 0 0 1 8.8-1.8 4.6 4.6 0 0 1 8.8 1.8Z"/><path d="M5 12h4l2-3 2 5 1-2h5"/>',
  oxygen: '<path d="M12 3c2.4 3.8 6.5 7 6.5 11a6.5 6.5 0 1 1-13 0c0-4 4.1-7.2 6.5-11Z"/><path d="M9 15a3 3 0 0 0 3 3"/>',
  body: '<rect x="4" y="4" width="16" height="16" rx="4"/><path d="M8 10a4.5 4.5 0 0 1 8 0M12 10l2-2"/>',
} as const;
type Group = keyof typeof groupInfo;

function icon(group: Group): string {
  return '<span class="health-workspace-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' + icons[group] + '</svg></span>';
}

export function renderHealthWorkspaceGroups(): string {
  return '<div id="health-groups" class="health-groups" role="group" aria-label="健康指标分组">'
    + Object.entries(groupInfo).map(([key, group]) =>
      `<button type="button" class="health-group" data-health-group="${key}" data-health-tone="${key}" aria-label="${group.label}" aria-describedby="health-group-value-${key} health-group-unit-${key} health-group-caption-${key}" aria-pressed="${key === 'activity'}"${group.metrics.length === 1 ? ` data-metric="${group.metrics[0]}"` : ''}>
        <span class="health-group-title">${icon(key as Group)}${group.label}</span>
        <span class="health-group-value"><strong id="health-group-value-${key}">—</strong><span id="health-group-unit-${key}"></span></span>
        <small id="health-group-caption-${key}">读取中</small>
      </button>`).join('') + '</div>';
}

export function renderHealthWorkspaceMetricTabs(): string {
  return '<div id="health-metric-tabs">'
    + Object.entries(groupInfo).filter(([, group]) => group.metrics.length > 1).map(([key, group]) =>
      `<div class="health-metric-tabs" role="group" aria-label="${group.label}指标" data-health-tabs-for="${key}"${key === 'activity' ? '' : ' hidden'}>`
      + group.metrics.map(metric => `<button type="button" data-metric="${metric}" aria-pressed="${metric === 'steps'}">${HEALTH_WORKSPACE_METRICS[metric].label}</button>`).join('')
      + '</div>').join('') + '</div>';
}

export function renderHealthWorkspaceInspector(): string {
  return `<section id="health-day-detail" class="panel health-day-detail" aria-labelledby="health-day-heading">
    <header class="panel-heading"><div><h2 class="panel-title" id="health-day-heading">日详情</h2><p id="health-selected-day" class="panel-subtitle" aria-live="polite"></p></div>
      <div class="health-day-controls"><button id="health-prev-day" type="button" aria-label="前一天">‹</button><button id="health-next-day" type="button" aria-label="后一天">›</button></div></header>
    <button id="health-day-toggle" class="btn small health-day-toggle" type="button" aria-controls="health-day-rows health-day-workouts" aria-expanded="false">查看当天明细</button>
    <dl id="health-day-rows" class="health-day-rows">${Object.entries(groupInfo).map(([key, group]) =>
      `<div class="health-day-row" data-day-group="${key}" data-health-tone="${key}">
        <dt>${icon(key as Group)}${group.label}</dt><dd id="health-day-value-${key}">—</dd><dd id="health-day-caption-${key}" class="health-day-caption"></dd>
      </div>`).join('')}</dl>
    <section id="health-day-workouts" class="health-day-workouts" aria-labelledby="health-day-workouts-title" hidden>
      <h3 id="health-day-workouts-title">当天训练</h3><div id="health-day-workouts-content"></div>
    </section></section>`;
}

export const HEALTH_WORKSPACE_CSS = String.raw`
#overview-page [data-health-tone="activity"]{--jh-accent:#346998;--health-tint:#e9f3fc}
#overview-page [data-health-tone="sleep"]{--jh-accent:#6851a0;--health-tint:#f0ebfb}
#overview-page [data-health-tone="heart"]{--jh-accent:#a54167;--health-tint:#f9edf2}
#overview-page [data-health-tone="oxygen"]{--jh-accent:#237087;--health-tint:#e7f4f7}
#overview-page [data-health-tone="body"]{--jh-accent:#456d61;--health-tint:#e8f3ec}
#overview-page .health-main-heading{margin-bottom:18px}
.health-main-heading .health-range-toolbar{flex:1 1 100%;min-width:0;display:flex;align-items:center;flex-wrap:wrap;gap:10px 14px}
.health-range-toolbar .range-switch{max-width:100%;flex-wrap:wrap}
.health-range-toolbar .health-range-selected{margin:0}
.health-range-toolbar .health-custom-range{margin:0}
.health-range-toolbar .health-custom-range>summary{padding:6px 9px;border:1px solid var(--line);border-radius:7px;background:var(--paper);color:var(--primary-hover);font-weight:550;min-height:33px}
#health-range-error:not([hidden]){margin:4px 0 0}
.health-groups{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:10px;margin-bottom:16px}
.health-group{min-width:0;text-align:left;padding:13px 12px;background:var(--paper);border:1px solid var(--line);border-radius:var(--panel-radius);color:var(--ink);box-shadow:var(--shadow)}
.health-group:hover{background:var(--subtle);border-color:var(--jh-accent)}
.health-group[aria-pressed="true"]{border-color:var(--jh-accent);box-shadow:inset 0 0 0 1px var(--jh-accent);background:var(--health-tint)}
.health-group-title{display:flex;align-items:center;gap:7px;font-size:12px;font-weight:600;overflow-wrap:anywhere}
.health-workspace-icon{display:grid;place-items:center;flex:none;width:25px;height:25px;border-radius:7px;background:var(--health-tint);color:var(--jh-accent)}
.health-workspace-icon svg{width:15px;height:15px}
.health-group-value{display:flex;align-items:baseline;flex-wrap:wrap;gap:4px;margin-top:9px;color:var(--muted);font-size:11px;font-variant-numeric:tabular-nums}
.health-group-value strong{font-size:23px;font-weight:650;color:var(--ink);letter-spacing:-.035em;line-height:1.2}
.health-group small{display:block;margin-top:5px;color:var(--muted);font-size:11px;font-weight:400;overflow-wrap:anywhere}
.health-workspace-columns{display:grid;grid-template-columns:minmax(0,1.9fr) minmax(250px,1fr);gap:14px;align-items:start;min-width:0}
.health-workspace-trend{--jh-plot-grid:var(--line);--jh-muted:var(--muted);--jh-card:var(--paper);--jh-selected:var(--health-tint)}
.health-workspace-trend .chart-wrap{min-height:238px}
.health-workspace-trend .health-workspace-chart-svg{width:100%;height:auto;min-height:0}
.health-workspace-trend .chart-heading .health-chart-actions{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:4px}
.health-workspace-trend .chart-legend i{background:var(--jh-accent)}
.health-metric-tabs{display:inline-flex;max-width:calc(100% - 36px);flex-wrap:wrap;margin:12px 18px 2px;padding:2px;gap:3px;border:1px solid var(--line);border-radius:8px;background:var(--subtle)}
.health-metric-tabs button{min-height:34px;background:transparent;padding:4px 9px;border-radius:6px;color:var(--muted);font-size:12px}
.health-metric-tabs button[aria-pressed="true"]{color:var(--jh-accent);background:var(--health-tint);font-weight:600;box-shadow:inset 0 0 0 1px var(--jh-accent)}
.health-metric-tabs button:hover{background:var(--hover)}
.health-chart-readout{display:flex;flex-wrap:wrap;align-items:baseline;gap:5px;margin:11px 18px 0;color:var(--muted);font-size:12px}
.health-chart-readout strong{font-size:27px;font-weight:650;color:var(--ink);letter-spacing:-.03em}
.health-chart-readout .health-coverage{margin-left:5px;font-size:11px;color:var(--muted)}
.health-day-controls{display:flex;gap:5px}
.health-day-controls button{display:grid;place-items:center;width:36px;height:36px;border:1px solid var(--line);background:var(--paper);border-radius:8px;color:var(--primary-hover);font-size:22px;line-height:1}
.health-day-controls button:not(:disabled):hover{background:var(--hover)}
.health-day-controls button:disabled{cursor:default}
.health-day-rows{margin:13px 0 0}
.health-day-row{position:relative;display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:3px 8px;padding:9px 14px;border-top:1px solid var(--line);font-size:12px}
.health-day-row dt{display:flex;align-items:center;gap:6px;font-weight:550;min-width:0}
.health-day-row dd{margin:0;text-align:right;font-variant-numeric:tabular-nums;font-weight:600}
.health-day-row .health-day-caption{grid-column:1/-1;margin-left:31px;text-align:left;font-size:11px;font-weight:400;color:var(--muted)}
.health-day-toggle{display:none}
.health-day-workouts h3,.health-sleep-title{margin:0;font-size:13px;font-weight:600;color:var(--ink)}
.health-day-workouts h3{padding:11px 14px;border-top:1px solid var(--line)}
.health-day-workouts .health-workouts-list{margin:0}
.health-day-workouts .health-workout-row summary{padding-inline:14px;gap:6px 8px}
.health-day-workouts .health-workout-row summary strong{font-size:12px}
.health-day-workouts .health-workout-row p{padding-inline:14px}
.health-sleep-title{margin-bottom:8px}
.health-workouts{padding-bottom:6px}
.health-workouts-list{margin:13px 0 0;padding:0;list-style:none}
.health-workout-row,.health-more-workouts{border-top:1px solid var(--line);min-width:0}
.health-workout-row summary{display:grid;grid-template-columns:minmax(0,1fr) auto auto;align-items:center;gap:8px 14px;padding:11px 17px;list-style:none;cursor:pointer}
.health-workout-row summary::-webkit-details-marker,.health-more-workouts summary::-webkit-details-marker{display:none}
.health-workout-row summary::after,.health-more-workouts>summary::before{content:"";width:7px;height:7px;border-right:1.5px solid var(--muted);border-bottom:1.5px solid var(--muted);transform:rotate(45deg);margin:0 4px 3px;display:inline-block}
.health-workout-row[open] summary::after,.health-more-workouts[open]>summary::before{transform:rotate(225deg);margin-bottom:-4px}
.health-workout-row summary:hover,.health-more-workouts>summary:hover{background:var(--subtle)}
.health-workout-row[data-selected="true"] summary{background:var(--subtle)}
.health-workout-row summary span{min-width:0;overflow-wrap:anywhere}
.health-workout-row summary strong{font-size:13px;font-weight:600}
.health-workout-row summary time{display:block;font-size:11px;color:var(--muted);margin-top:2px}
.health-workout-row p,.health-workouts-empty{padding:0 17px 11px;margin:4px 0 0;color:var(--muted);font-size:12px;line-height:1.65}
.health-workouts-empty{margin-top:12px}
.health-more-workouts>summary{display:flex;align-items:center;padding:11px 17px;gap:7px;color:var(--primary-hover);cursor:pointer;font-size:12px}
.health-more-workouts>.health-workouts-list{margin-top:0}
#apple-health-status{margin-bottom:12px}
@media(max-width:1090px){.health-workspace-columns{grid-template-columns:minmax(0,1.5fr) minmax(236px,1fr)}.health-groups{gap:8px}.health-group{padding:10px 9px}.health-group-title{gap:5px}.health-group-value strong{font-size:20px}}
@media(max-width:760px){.health-workspace-columns{grid-template-columns:minmax(0,1fr)}.health-groups{grid-template-columns:repeat(3,minmax(0,1fr))}.health-day-toggle{display:inline-flex;margin:10px 14px 13px}.health-day-detail:not(.health-day-expanded) :is(.health-day-rows,.health-day-workouts){display:none}.health-day-detail.health-day-expanded .health-day-rows{margin-top:0}}
@media(max-width:420px){
  .health-groups{grid-template-columns:repeat(2,minmax(0,1fr))}
  .health-group[data-health-group="body"]{display:grid;grid-column:1/-1;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:3px 12px}
  .health-group[data-health-group="body"] .health-group-value{grid-column:2;grid-row:1/3;justify-content:flex-end;margin-top:0}
  .health-group[data-health-group="body"] small{grid-column:1;margin-top:0}
  .health-workspace-trend .chart-heading .health-chart-actions{justify-content:flex-start}
  .health-range-toolbar .range-switch{width:auto}
  .health-workspace-trend .chart-wrap{padding-inline:9px}
}
`;

// Shares the existing health page's range, account-aware requests, and navigation.
export const HEALTH_WORKSPACE_SCRIPT = String.raw`
const healthGroups = ${JSON.stringify(groupInfo)};
const metrics = ${JSON.stringify(HEALTH_WORKSPACE_METRICS)};
const workoutNames = ${JSON.stringify(APPLE_WORKOUT_NAMES)};
const healthMetricGroups = Object.fromEntries(Object.entries(healthGroups).flatMap(([name, group]) => group.metrics.map(metric => [metric, name])));
const healthLegacySeries = ['steps', 'active_energy', 'sleep', 'weight', 'lean_body_mass', 'body_fat'];
const healthClock = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const healthCalendar = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' });
const healthNumber = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 });
const healthDistance = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 });
const healthDayMs = 86400000;
let appleRequest = null;
let appleSnapshot = { path: null, data: null, error: null };
let workspaceDayExpanded = false;
let workspacePlot = null;
let workoutMarkup = '';
let dayWorkoutMarkup = '';
let sleepStage = 'all';

function healthTime(input, formatter) {
  if (typeof input !== 'string') return '';
  const value = new Date(input);
  return Number.isFinite(value.getTime()) ? formatter.format(value) : '';
}

function healthShortDay(day) {
  return Number(day.slice(5, 7)) + '月' + Number(day.slice(8, 10)) + '日';
}

function shiftHealthDay(day, count) {
  return new Date(Date.parse(day + 'T12:00:00Z') + count * healthDayMs).toISOString().slice(0, 10);
}

function healthSpan(day) {
  return healthCalendar.format(new Date(day + 'T12:00:00+08:00'));
}

function selectedHealthDay(range = selectedHealthRange()) {
  return state.day && state.day >= range.from && state.day <= range.to ? state.day : range.to;
}

function chooseHealthDay(day, focusChart = false, mode = 'push') {
  const range = selectedHealthRange();
  if (!isCalendarDay(day) || day < range.from || day > range.to || day === selectedHealthDay(range)) return;
  state.day = day;
  workspaceDayExpanded = true;
  renderHealthWorkspace();
  writeHealthNavigation(healthPath(), mode);
  if (focusChart) $('chart-wrap').querySelector('[data-chart-date="' + day + '"], [data-sleep-day="' + day + '"]')?.focus?.({ preventScroll: true });
}

function appleWorkspacePath(range = selectedHealthRange()) {
  return '/api/health/apple-activity?' + new URLSearchParams({ from: range.from, to: range.to });
}

function loadAppleWorkspace(force = false) {
  if ($('overview-page').hidden) return;
  const range = selectedHealthRange();
  const path = appleWorkspacePath(range);
  if (appleRequest?.path === path || (!force && appleSnapshot.path === path && (appleSnapshot.data || appleSnapshot.error))) return;
  appleRequest?.controller.abort();
  const controller = new AbortController();
  const pending = { path, controller };
  appleRequest = pending;
  appleSnapshot = { path, data: appleSnapshot.path === path ? appleSnapshot.data : null, error: null };
  updateAppleStatus();
  void (async () => {
    try {
      const data = await request(path, { signal: controller.signal, redirect: 'error' });
      if (appleRequest !== pending) return;
      if (data?.from !== range.from || data?.to !== range.to || !Array.isArray(data.vitals) || !Array.isArray(data.workouts)) {
        throw new Error('收到的数据格式暂时无法读取。');
      }
      appleSnapshot = { path, data, error: null };
    } catch (error) {
      if (appleRequest !== pending || controller.signal.aborted) return;
      appleSnapshot = { ...appleSnapshot, error: readableError(error) };
    } finally {
      if (appleRequest === pending) {
        appleRequest = null;
        renderHealthWorkspace();
      }
    }
  })();
}

function updateAppleStatus() {
  const matches = appleSnapshot.path === appleWorkspacePath();
  const error = matches ? appleSnapshot.error : null;
  $('apple-health-status').hidden = !error;
  $('apple-health-status-text').textContent = error
    ? error + (appleSnapshot.data ? ' 仍显示此日期范围最近一次成功读取的记录。' : '') : '';
  if (state.legacyStatus === 'ready' && !state.measurements.length) {
    $('data-banner').hidden = matches && Boolean(appleSnapshot.data?.vitals.length || appleSnapshot.data?.workouts.length);
  }
}

function buildWorkspaceDays(range) {
  const result = new Map();
  for (let offset = 0; offset < range.days; offset++) {
    const day = shiftHealthDay(range.from, offset);
    result.set(day, { day, workouts: [], vitals: null, legacy: {} });
  }
  for (const metric of healthLegacySeries) {
    for (const row of metricRows(metric)) {
      const date = result.get(dayOf(row));
      if (date) date.legacy[metric] = row;
    }
  }
  if (appleSnapshot.path === appleWorkspacePath(range) && appleSnapshot.data) {
    for (const row of appleSnapshot.data.vitals) {
      const date = result.get(row?.day);
      if (date) date.vitals = row;
    }
    for (const workout of appleSnapshot.data.workouts) {
      const start = new Date(workout?.startDate);
      if (!Number.isFinite(start.getTime())) continue;
      result.get(isoDay(start))?.workouts.push(workout);
    }
    for (const row of result.values()) row.workouts.sort((a, b) => Date.parse(b.startDate) - Date.parse(a.startDate));
  }
  return result;
}

function noVitalRecord() {
  if (appleSnapshot.path !== appleWorkspacePath() || (appleRequest && !appleSnapshot.data)) return '读取中';
  return appleSnapshot.error && !appleSnapshot.data ? '暂时无法读取' : '暂无记录';
}

function noLegacyRecord() {
  return state.legacyStatus === 'loading' && !state.measurements.length ? '读取中'
    : state.legacyStatus === 'error' && !state.measurements.length ? '暂时无法读取' : '暂无记录';
}

function sleepDuration(hours) {
  if (!Number.isFinite(hours)) return '暂无记录';
  return workoutDuration(hours * 3600);
}

function workoutDuration(seconds) {
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor(total / 60) % 60;
  const remainder = total % 60;
  return [hours ? hours + ' 小时' : '', minutes ? minutes + ' 分钟' : '', remainder ? remainder + ' 秒' : ''].filter(Boolean).join(' ') || '0 秒';
}

function healthValue(value, metric) {
  if (!Number.isFinite(value)) return '暂无记录';
  const unit = metrics[metric].unit;
  return formatValue(value, metric) + (unit === '%' ? '' : ' ') + unit;
}

function showHealthSummary(group, primary, unit, caption) {
  $('health-group-value-'+group).textContent = primary;
  $('health-group-unit-'+group).textContent = unit;
  $('health-group-caption-'+group).textContent = caption;
}

function renderHealthSummary(days) {
  const rows = Array.from(days.values());
  const steps = rows.findLast(row => Number.isFinite(row.legacy.steps?.value));
  const sleep = rows.findLast(row => Number.isFinite(row.legacy.sleep?.value));
  const heart = rows.findLast(row => Number.isFinite(row.vitals?.heartRate?.average));
  const rest = rows.findLast(row => Number.isFinite(row.vitals?.restingHeartRate?.value));
  const oxygen = rows.findLast(row => Number.isFinite(row.vitals?.oxygenSaturation?.latest));
  const body = rows.findLast(row => Number.isFinite(row.legacy.weight?.value));
  const workoutCount = rows.reduce((sum, row) => sum + row.workouts.length, 0);
  showHealthSummary('activity', steps ? formatValue(steps.legacy.steps.value, 'steps') : '—', steps ? '步' : '',
    workoutCount ? '本时段 ' + workoutCount + ' 次训练' : steps ? healthShortDay(steps.day) + ' · ' + (noVitalRecord() === '暂无记录' ? '暂无已同步训练' : '训练' + noVitalRecord()) : noLegacyRecord());
  showHealthSummary('sleep', sleep ? sleepDuration(sleep.legacy.sleep.value) : '—', '', sleep ? healthShortDay(sleep.day) + '醒来' : noLegacyRecord());
  showHealthSummary('heart', rest ? formatValue(rest.vitals.restingHeartRate.value, 'resting_heart_rate') : heart ? formatValue(heart.vitals.heartRate.average, 'heart_rate') : '—', rest || heart ? '次/分' : '',
    rest ? '静息 · ' + healthShortDay(rest.day) : heart ? '日均 · ' + healthShortDay(heart.day) : noVitalRecord());
  const oxygenSample = oxygen?.vitals.oxygenSaturation;
  showHealthSummary('oxygen', oxygenSample ? formatValue(oxygenSample.latest, 'oxygen_saturation') : '—', oxygenSample ? '%' : '',
    oxygenSample ? '最近 · ' + healthShortDay(oxygen.day) + ' ' + healthTime(oxygenSample.measuredAt, healthClock) : noVitalRecord());
  showHealthSummary('body', body ? formatValue(body.legacy.weight.value, 'weight') : '—', body ? 'kg' : '',
    body ? (Number.isFinite(body.legacy.body_fat?.value) ? '估算体脂 ' + healthValue(body.legacy.body_fat.value, 'body_fat') : healthShortDay(body.day) + '测量') : noLegacyRecord());
}

function renderDayInspector(day, range) {
  $('health-selected-day').textContent = healthSpan(day.day);
  $('health-prev-day').disabled = day.day === range.from;
  $('health-next-day').disabled = day.day === range.to;
  $('health-day-detail').classList.toggle('health-day-expanded', workspaceDayExpanded);
  $('health-day-toggle').setAttribute('aria-expanded', String(workspaceDayExpanded));
  $('health-day-toggle').textContent = workspaceDayExpanded ? '收起当天明细' : '查看当天明细';
  const { steps, active_energy, sleep, weight, lean_body_mass, body_fat } = day.legacy;
  const heart = day.vitals?.heartRate;
  const rest = day.vitals?.restingHeartRate;
  const oxygen = day.vitals?.oxygenSaturation;
  const active = [
    steps && healthValue(steps.value, 'steps'),
    active_energy && healthValue(active_energy.value, 'active_energy'),
  ].filter(Boolean).join(' · ');
  const sleepTimes = sleep?.sleepTiming
    ? [healthTime(sleep.sleepTiming.onset, healthClock), healthTime(sleep.sleepTiming.wake, healthClock)].filter(Boolean).join(' → ') : '';
  const heartRange = heart && Number.isFinite(heart.min) && Number.isFinite(heart.max)
    ? healthNumber.format(heart.min) + '–' + healthNumber.format(heart.max) + ' 次/分' : '';
  const restCaption = rest ? '静息 ' + healthValue(rest.value, 'resting_heart_rate') + ' · ' + healthTime(rest.measuredAt, healthClock) : '暂无静息心率';
  const oxygenCaption = oxygen ? [healthTime(oxygen.measuredAt, healthClock) + ' 采样', '日均 ' + healthValue(oxygen.average, 'oxygen_saturation'), oxygen.count + ' 次'].join(' · ') : '';
  const build = [
    ['sleep', sleep ? sleepDuration(sleep.value) : noLegacyRecord(), sleepTimes || '按醒来日归属'],
    ['activity', active || noLegacyRecord(), day.workouts.length ? day.workouts.length + ' 次已同步训练' : noVitalRecord() === '暂无记录' ? '暂无已同步训练' : '训练' + noVitalRecord()],
    ['heart', heart ? '日均 ' + healthValue(heart.average, 'heart_rate') : rest ? '静息 ' + healthValue(rest.value, 'resting_heart_rate') : noVitalRecord(), heart ? [heartRange, restCaption].filter(Boolean).join(' · ') : rest ? healthTime(rest.measuredAt, healthClock) : ''],
    ['oxygen', oxygen ? '最近 ' + healthValue(oxygen.latest, 'oxygen_saturation') : noVitalRecord(), oxygenCaption],
    ['body', weight ? healthValue(weight.value, 'weight') : noLegacyRecord(),
      [lean_body_mass && '去脂 ' + healthValue(lean_body_mass.value, 'lean_body_mass'), body_fat && '估算体脂 ' + healthValue(body_fat.value, 'body_fat')].filter(Boolean).join(' · ')],
  ];
  for (const [group, value, caption] of build) {
    $('health-day-value-'+group).textContent = value;
    $('health-day-caption-'+group).textContent = caption;
    $('health-day-caption-'+group).hidden = !caption;
  }
  const workoutSection = $('health-day-workouts');
  workoutSection.hidden = !day.workouts.length;
  if (!workoutSection.hidden) {
    const markup = formatWorkoutList(day.workouts.map(workout => ({ day: day.day, workout })), false);
    if (markup !== dayWorkoutMarkup) {
      dayWorkoutMarkup = markup;
      $('health-day-workouts-content').innerHTML = markup;
    }
  }
}

function formatWorkoutList(workouts, showDay = true) {
  return '<ul class="health-workouts-list">' + workouts.map(({ day, workout }) => {
    const duration = workoutDuration(workout.durationSeconds);
    const details = ['实际时长 ' + duration];
    if (Number.isFinite(workout.distanceMeters)) details.push('距离 ' + (workout.distanceMeters >= 1000
      ? healthDistance.format(workout.distanceMeters / 1000) + ' 公里' : healthNumber.format(workout.distanceMeters) + ' 米'));
    if (Number.isFinite(workout.energyKcal)) details.push('活动能量 ' + healthNumber.format(workout.energyKcal) + ' 千卡');
    return '<li><details class="health-workout-row" data-workout-day="' + esc(day) + '"><summary><span><strong>'
      + esc(workoutNames[workout.activityType] || '其他训练') + '</strong><time datetime="' + esc(workout.startDate) + '">'
      + esc((showDay ? day + ' · ' : '') + healthTime(workout.startDate, healthClock)) + '</time></span><strong>' + esc(duration)
      + '</strong></summary><p>' + esc(details.join(' · ')) + '</p></details></li>';
  }).join('') + '</ul>';
}

function renderWorkspaceWorkouts(days, selected, group) {
  const element = $('health-workouts');
  element.hidden = group !== 'activity';
  if (element.hidden) return;
  const workouts = Array.from(days.values()).reverse().flatMap(row => row.workouts.map(workout => ({ day: row.day, workout })));
  $('health-workout-count').textContent = workouts.length ? workouts.length + ' 次训练' : '';
  const markup = workouts.length ? formatWorkoutList(workouts.slice(0, 4))
    + (workouts.length > 4 ? '<details class="health-more-workouts"><summary>其余 ' + (workouts.length - 4) + ' 条训练</summary>' + formatWorkoutList(workouts.slice(4)) + '</details>' : '')
    : '<p class="health-workouts-empty">' + (noVitalRecord() === '暂无记录' ? '这段日期暂无已同步训练。' : '训练记录' + noVitalRecord() + '。') + '</p>';
  if (markup !== workoutMarkup) {
    workoutMarkup = markup;
    $('health-workouts-content').innerHTML = markup;
  }
  $('health-workouts-content').querySelectorAll('[data-workout-day]').forEach(row => row.dataset.selected = String(row.dataset.workoutDay === selected.day));
}

function seriesReading(row, metric) {
  if (metric === 'heart_rate') return { value: row.vitals?.heartRate?.average ?? null, min: row.vitals?.heartRate?.min, max: row.vitals?.heartRate?.max };
  if (metric === 'resting_heart_rate') return { value: row.vitals?.restingHeartRate?.value ?? null };
  if (metric === 'oxygen_saturation') return { value: row.vitals?.oxygenSaturation?.average ?? null };
  if (metric === 'workouts') return { value: row.workouts.length || null };
  return { value: row.legacy[metric]?.value ?? null };
}

function drawCurrentWorkspacePlot() {
  if (!workspacePlot || $('overview-page').hidden) return;
  const { metric, range, points, selected, series, missingMessage } = workspacePlot;
  const chart = $('chart-wrap');
  if (metric === 'sleep' && points.length) {
    const distance = chart.querySelector('.sleep-chart-scroll')?.scrollLeft;
    chart.innerHTML = sleepChartHTML({
      points, days: range.days, start: Date.parse(range.from + 'T00:00:00+08:00'), end: Date.parse(range.to + 'T00:00:00+08:00'),
      stage: sleepStage, selectedDay: selected, width: Math.max(280, chart.clientWidth - 36),
    });
    const scroll = chart.querySelector('.sleep-chart-scroll');
    if (!scroll) return;
    const target = chart.querySelector('[data-sleep-day="' + selected + '"]');
    if (range.days >= 90 && target && typeof target.getBoundingClientRect === 'function') {
      if (Number.isFinite(distance)) scroll.scrollLeft = distance;
      const rect = target.getBoundingClientRect();
      const viewport = scroll.getBoundingClientRect();
      if (rect.left < viewport.left || rect.right > viewport.right) scroll.scrollLeft += rect.left - viewport.left - viewport.width / 2;
    } else if (Number.isFinite(distance)) scroll.scrollLeft = distance;
    return;
  }
  const definition = metrics[metric];
  drawHealthWorkspaceChart(chart, series, { ...definition, name: definition.label, missingMessage }, selected,
    (day, mode) => chooseHealthDay(day, false, mode));
}

function renderWorkspaceRecent(metric, range, series) {
  const computed = metric === 'body_fat';
  const isSleep = metric === 'sleep';
  const vitals = !metrics[metric].legacy && !computed;
  $('health-recent-panel').hidden = metric === 'workouts';
  $('records-title').textContent = computed ? '最近计算记录' : '最近记录';
  $('records-subtitle').textContent = '当前 ' + range.days + ' 天范围内的' + (computed ? '配对计算值。' : '记录。');
  $('record-value-label').textContent = metrics[metric].short;
  $('record-source-label').textContent = computed ? '配对来源' : '来源';
  const rows = vitals ? series.filter(row => Number.isFinite(row.value)).map(row => ({ ...row, source: '苹果健康' })) : metricRows(metric);
  $('record-count').textContent = rows.length + (computed ? ' 天计算记录' : ' 条记录');
  $('record-rows').innerHTML = rows.length ? rows.slice(-8).reverse().map((row) => {
    const stages = isSleep ? '<small class="sleep-record-stages">' + (row.sleepStages
      ? ['deep','core','rem','unspecified'].filter(key => row.sleepStages[key] > 0)
        .map(key => ({deep:'深度',core:'核心',rem:'REM',unspecified:'未分类'})[key]+' '+formatValue(row.sleepStages[key], 'sleep')+' 小时').join(' · ')
      : '未分类睡眠 · 重新同步可获取阶段') + '</small>' : '';
    const sourceDetail = computed ? ' title="' + esc('体重 ' + formatValue(row.weight,'weight') + ' kg · 去脂体重 ' + formatValue(row.leanBodyMass,'lean_body_mass') + ' kg') + '"' : '';
    return '<tr><td title="' + esc(row.startDate || '') + '">' + esc(dayOf(row)) + '</td><td>' + esc(healthValue(row.value, metric))
      + stages + '</td><td' + sourceDetail + '>' + esc((row.source || '苹果健康') + (computed ? ' · 计算估算' : '')) + '</td></tr>';
  }).join('') : '<tr><td colspan="3" class="table-empty">' + esc(computed ? '当前范围暂无可计算配对。'
    : vitals ? noVitalRecord() + '。' : noLegacyRecord() + '。可在记录管理中补录。') + '</td></tr>';
}

function renderWorkspaceTrend(days, range, selected, group) {
  const metric = state.metric;
  const definition = metrics[metric];
  const isSleep = metric === 'sleep';
  const computed = metric === 'body_fat';
  const legacyActions = definition.legacy;
  const series = Array.from(days.values(), row => ({ day: row.day, ...seriesReading(row, metric) }));
  const points = isSleep ? Array.from(days.values()).filter(row => row.legacy.sleep).map(row => [row.day, row.legacy.sleep]) : [];
  const reading = seriesReading(selected, metric);
  $('health-trend-panel').dataset.healthTone = group;
  $('ask-health-chart').hidden = !legacyActions;
  $('ask-health-chart').disabled = !legacyActions;
  $('health-export-chart').hidden = !legacyActions;
  $('chart-title').textContent = definition.title;
  $('chart-subtitle').textContent = definition.subtitle;
  $('chart-legend').textContent = definition.label;
  $('health-range-legend').hidden = metric !== 'heart_rate';
  $('chart-legend').parentElement.hidden = isSleep;
  $('chart-foot-note').textContent = computed ? '未配对的日期不计算' : isSleep
    ? sleepStage === 'awake' ? '清醒时长单独统计' : sleepStage === 'inBed' ? '卧床时长单独统计' : '睡眠分期合计为总睡眠'
    : metric === 'workouts' ? '只统计已同步的训练' : '缺失日期留空';
  $('health-plot-value').textContent = Number.isFinite(reading.value) ? (isSleep ? sleepDuration(reading.value) : formatValue(reading.value, metric)) : '—';
  $('health-plot-unit').textContent = Number.isFinite(reading.value) && !isSleep ? definition.unit : '';
  const coveredDays = series.filter(row => Number.isFinite(row.value)).length;
  const loading = healthLegacySeries.includes(metric) ? noLegacyRecord() : noVitalRecord();
  $('health-plot-coverage').textContent = coveredDays || loading === '暂无记录' ? '有记录 ' + coveredDays + '/' + range.days + ' 天' : loading;
  $('health-selected-reading').textContent = metric === 'heart_rate' && Number.isFinite(reading.min) && Number.isFinite(reading.max)
    ? healthNumber.format(reading.min) + '–' + healthNumber.format(reading.max) + ' 次/分'
    : metric === 'oxygen_saturation' && selected.vitals?.oxygenSaturation ? selected.vitals.oxygenSaturation.count + ' 次采样'
    : Number.isFinite(reading.value) ? '' : '当天' + loading;
  $('sleep-stage-switch').hidden = !isSleep;
  $('sleep-analysis').hidden = !isSleep;
  document.querySelectorAll('[data-sleep-stage]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.sleepStage === sleepStage)));
  $('sleep-detail').hidden = !isSleep;
  $('sleep-detail').innerHTML = isSleep
    ? '<h3 class="health-sleep-title">睡眠分期</h3>' + (selected.legacy.sleep ? sleepDetailsHTML(selected.day, selected.legacy.sleep) : '<p>这一天暂无已同步睡眠分期。</p>') : '';
  $('sleep-analysis').innerHTML = isSleep ? sleepAnalysisRuntime.renderSleepAnalysis(sleepAnalysisRuntime.buildSleepAnalysis(
    points.map(([day, row]) => ({ ...row, day })), range)) : '';
  $('composition-note').hidden = !computed;
  if (computed) {
    const invalid = state.bodyComposition?.invalidPairCount || 0;
    const unmatched = (state.bodyComposition?.unmatchedWeightCount || 0) + (state.bodyComposition?.unmatchedLeanCount || 0);
    $('composition-pairing-status').textContent = (coveredDays ? '当前范围内 ' + coveredDays + ' 天有可计算记录。' : '当前范围暂无可计算配对。')
      + (unmatched ? ' 部分记录尚未找到同来源、同一测量时间的另一项数据。' : '')
      + (invalid ? ' 有数值矛盾或重复歧义的记录，未计算体脂率。' : '');
  }
  const missingMessage = loading === '暂无记录' ? undefined
    : loading === '读取中' ? '正在读取记录…' : '此指标暂时无法读取';
  workspacePlot = { metric, range, points, selected: selected.day, series, missingMessage };
  drawCurrentWorkspacePlot();
  renderWorkspaceRecent(metric, range, series);
}

function renderHealthWorkspace() {
  const range = selectedHealthRange();
  const group = healthMetricGroups[state.metric];
  const days = buildWorkspaceDays(range);
  const selected = days.get(selectedHealthDay(range));
  updateAppleStatus();
  renderHealthSummary(days);
  renderDayInspector(selected, range);
  renderWorkspaceTrend(days, range, selected, group);
  renderWorkspaceWorkouts(days, selected, group);
}

function wireHealthWorkspace() {
  const groupButtons = document.querySelectorAll('[data-health-group]');
  groupButtons.forEach(button => button.addEventListener('click', () => {
    const group = button.dataset.healthGroup;
    if (healthMetricGroups[state.metric] !== group) selectMetric(healthGroups[group].metrics[0]);
  }));
  $('health-prev-day').addEventListener('click', () => chooseHealthDay(shiftHealthDay(selectedHealthDay(), -1)));
  $('health-next-day').addEventListener('click', () => chooseHealthDay(shiftHealthDay(selectedHealthDay(), 1)));
  $('health-day-toggle').addEventListener('click', () => {
    workspaceDayExpanded = !workspaceDayExpanded;
    renderDayInspector(buildWorkspaceDays(selectedHealthRange()).get(selectedHealthDay()), selectedHealthRange());
  });
  $('apple-health-retry').addEventListener('click', () => {
    loadAppleWorkspace(true);
    renderHealthWorkspace();
  });
  $('chart-wrap').addEventListener('click', event => {
    const day = event.target.closest?.('[data-sleep-day]')?.dataset.sleepDay;
    if (day) chooseHealthDay(day, true);
  });
  $('chart-wrap').addEventListener('keydown', event => {
    const day = event.target.closest?.('[data-sleep-day]')?.dataset.sleepDay;
    if (!day || !['Enter', ' '].includes(event.key)) return;
    event.preventDefault();
    chooseHealthDay(day, true);
  });
  document.querySelectorAll('[data-sleep-stage]').forEach(button => button.addEventListener('click', () => {
    sleepStage = button.dataset.sleepStage;
    renderHealthWorkspace();
  }));
  if (typeof ResizeObserver === 'function') {
    let width = 0;
    new ResizeObserver(entries => {
      const next = Math.round(entries[0].contentRect.width);
      if (!next || width === next) return;
      width = next;
      drawCurrentWorkspacePlot();
    }).observe($('chart-wrap'));
  }
}
`;
