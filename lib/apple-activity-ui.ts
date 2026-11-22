import { CLIENT_REQUEST_SCRIPT } from './client-request.ts';
import { DATE_RANGE_CLIENT_SCRIPT } from './date-range.ts';

export const APPLE_ACTIVITY_SCRIPT = String.raw`(() => {
${CLIENT_REQUEST_SCRIPT}
${DATE_RANGE_CLIENT_SCRIPT}
const element = (name) => document.getElementById('activity-' + name);
const presets = [...document.querySelectorAll('[data-activity-days]')];
const number = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 });
const kilometers = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 });
const dateTime = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
// HealthKit HKWorkoutActivityType raw values. Preserve unknown types as workouts.
const workoutNames = {
  1:'美式橄榄球', 2:'射箭', 3:'澳式足球', 4:'羽毛球', 5:'棒球', 6:'篮球', 7:'保龄球',
  8:'拳击', 9:'攀岩', 10:'板球', 11:'交叉训练', 12:'冰壶', 13:'骑行', 14:'舞蹈',
  15:'舞蹈训练', 16:'椭圆机', 17:'马术运动', 18:'击剑', 19:'钓鱼', 20:'功能性力量训练',
  21:'高尔夫', 22:'体操', 23:'手球', 24:'徒步', 25:'曲棍球', 26:'狩猎', 27:'长曲棍球',
  28:'武术', 29:'身心训练', 30:'混合有氧', 31:'桨类运动', 32:'游戏运动', 33:'准备与恢复',
  34:'短柄墙球', 35:'划船', 36:'英式橄榄球', 37:'跑步', 38:'帆船', 39:'滑冰及轮滑',
  40:'雪上运动', 41:'足球', 42:'垒球', 43:'壁球', 44:'爬楼机', 45:'冲浪', 46:'游泳',
  47:'乒乓球', 48:'网球', 49:'田径', 50:'传统力量训练', 51:'排球', 52:'步行', 53:'水中健身',
  54:'水球', 55:'水上运动', 56:'摔跤', 57:'瑜伽', 58:'芭蕾把杆', 59:'核心训练', 60:'越野滑雪',
  61:'高山滑雪', 62:'柔韧性训练', 63:'高强度间歇训练', 64:'跳绳', 65:'踢拳', 66:'普拉提',
  67:'单板滑雪', 68:'爬楼梯', 69:'踏板训练', 70:'轮椅步行配速', 71:'轮椅跑步配速', 72:'太极',
  73:'混合有氧', 74:'手摇自行车', 75:'飞盘', 76:'健身游戏', 77:'有氧舞蹈', 78:'社交舞蹈',
  79:'匹克球', 80:'放松整理', 82:'游泳、骑行及跑步', 83:'训练转换', 84:'潜水', 3000:'其他训练',
};
const vitalCards = [
  { name:'heart-rate', unit:'次/分', trend:row => row.heartRate?.average,
    latest:row => row.heartRate?.average, detail:row => row.day + ' · ' + valueRange(row.heartRate, '次/分') },
  { name:'resting-heart-rate', unit:'次/分', trend:row => row.restingHeartRate?.value,
    latest:row => row.restingHeartRate?.value, detail:row => '最近记录 · ' + dateTime.format(new Date(row.restingHeartRate.measuredAt)) },
  { name:'oxygen', unit:'%', trend:row => row.oxygenSaturation?.average,
    latest:row => row.oxygenSaturation?.latest, detail:row => '最近读数 · ' + dateTime.format(new Date(row.oxygenSaturation.measuredAt)) },
];
let selection = { days: 30 };
let activeRequest;

function selectionFromLocation() {
  const query = new URLSearchParams(location.search);
  if (['from', 'to', 'days'].some((key) => query.getAll(key).length > 1)) throw new Error('时间范围不能重复提交。');
  const value = Object.fromEntries(['from', 'to', 'days'].filter((key) => query.has(key)).map((key) => [key, query.get(key)]));
  resolveDateRange(value, Date.now(), 30);
  return value;
}

function updateRangeError(message) {
  element('range-error').textContent = message;
  element('range-error').hidden = !message;
  if (message) element('custom-range').open = true;
}

function selectionChanged(next) {
  const query = new URLSearchParams(next).toString();
  if (location.search !== '?' + query) history.pushState(null, '', location.pathname + '?' + query);
  selection = next;
  load();
}

function readLocation() {
  try {
    selection = selectionFromLocation();
    load();
  } catch (error) {
    selection = { days: 30 };
    load();
    updateRangeError(error.message);
  }
}

async function load() {
  const range = resolveDateRange(selection, Date.now(), 30);
  for (const key of ['from', 'to']) {
    element(key).value = range[key];
    element(key).max = range.today;
  }
  element('range').textContent = range.from + ' 至 ' + range.to + '（北京时间）';
  element('custom-range').open = Boolean(selection.from);
  updateRangeError('');
  const selectedDays = String(selection.days ?? (selection.from ? '' : 30));
  presets.forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.activityDays === selectedDays)));

  activeRequest?.abort();
  const controller = new AbortController();
  activeRequest = controller;
  setStatus('正在读取苹果健康记录…');
  element('results').hidden = true;
  element('results').setAttribute('aria-busy', 'true');
  try {
    const data = await requestJSON('/api/health/apple-activity?' + new URLSearchParams({ from: range.from, to: range.to }), {
      signal: controller.signal, redirect: 'error',
    });
    if (controller !== activeRequest) return;
    if (!Array.isArray(data?.vitals) || !Array.isArray(data?.workouts) || data.from !== range.from || data.to !== range.to) {
      throw new Error('服务器返回的日期或记录格式暂时无法读取。');
    }
    renderResults(data, range);
    element('results').hidden = false;
    setStatus('');
  } catch (error) {
    if (controller !== activeRequest || controller.signal.aborted) return;
    setStatus(error?.message || '暂时无法读取苹果健康记录。', true);
  } finally {
    if (controller === activeRequest) element('results').setAttribute('aria-busy', 'false');
  }
}

function setStatus(message, failed = false) {
  element('status-text').textContent = message;
  element('status').hidden = !message;
  element('status').dataset.error = String(failed);
  element('retry').hidden = !failed;
}

function valueRange(sample, unit) {
  return number.format(sample.min) + '–' + number.format(sample.max) + (unit === '%' ? '%' : ' ' + unit);
}

function renderPlot(metric, rows, range) {
  const group = element(metric.name + '-plot-group');
  const plot = element(metric.name + '-plot');
  const values = new Map(rows.map(row => [row.day, metric.trend(row)]).filter(([, value]) => Number.isFinite(value)));
  plot.replaceChildren();
  group.hidden = values.size < 2;
  if (group.hidden) return;
  const low = Math.min(...values.values());
  const high = Math.max(...values.values());
  const start = Date.parse(range.from + 'T12:00:00Z');
  plot.style.setProperty('--plot-gap', Math.min(2, 48 / range.days) + 'px');
  const marks = document.createDocumentFragment();
  for (let index = 0; index < range.days; index++) {
    const day = new Date(start + index * 86400000).toISOString().slice(0, 10);
    const value = values.get(day);
    const mark = document.createElement('span');
    if (value !== undefined) {
      const ratio = high === low ? .5 : (value - low) / (high - low);
      mark.style.setProperty('--relative-height', (12 + 88 * ratio) + '%');
      mark.title = day + ' · ' + number.format(value) + metric.unit;
    }
    marks.append(mark);
  }
  plot.append(marks);
  element(metric.name + '-plot-label').textContent = (metric.name === 'oxygen' ? '日均 ' : '') + valueRange({ min: low, max: high }, metric.unit) + ' · ' + values.size + ' 天有记录';
}

function renderVitalCard(metric, rows, range) {
  const latest = rows.find(row => Number.isFinite(metric.latest(row)));
  const value = element(metric.name + '-value');
  value.textContent = latest ? number.format(metric.latest(latest)) : '暂无记录';
  value.toggleAttribute('data-empty', !latest);
  element(metric.name + '-unit').hidden = !latest;
  element(metric.name + '-latest').textContent = latest ? metric.detail(latest) : '';
  renderPlot(metric, rows, range);
}

function vitalCell(row, value, detail) {
  const cell = row.insertCell();
  cell.textContent = value ?? '—';
  if (detail) {
    const secondary = document.createElement('small');
    secondary.textContent = detail;
    cell.append(secondary);
  }
}

function renderVitalRows(rows) {
  const table = element('vitals-table');
  const body = element('vital-rows');
  body.replaceChildren();
  table.hidden = !rows.length;
  element('vitals-empty').hidden = Boolean(rows.length);
  for (const record of rows) {
    const row = body.insertRow();
    const date = document.createElement('th');
    date.scope = 'row';
    date.textContent = record.day;
    row.append(date);
    const { heartRate, restingHeartRate, oxygenSaturation } = record;
    vitalCell(row, heartRate && number.format(heartRate.average), heartRate && valueRange(heartRate, '次/分'));
    vitalCell(row, restingHeartRate && number.format(restingHeartRate.value));
    vitalCell(row, oxygenSaturation && number.format(oxygenSaturation.average) + '%', oxygenSaturation &&
      valueRange(oxygenSaturation, '%') + ' · ' + oxygenSaturation.count + ' 次采样');
  }
}

function duration(seconds) {
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor(total / 60) % 60;
  return [hours && hours + ' 小时', minutes && minutes + ' 分', (total % 60) && (total % 60) + ' 秒'].filter(Boolean).join(' ') || '0 秒';
}

function renderWorkouts(workouts) {
  const list = element('workout-list');
  const count = element('workout-count');
  list.replaceChildren();
  list.hidden = count.hidden = !workouts.length;
  element('workouts-empty').hidden = Boolean(workouts.length);
  count.textContent = workouts.length + ' 次训练';
  for (const workout of [...workouts].sort((a, b) => Date.parse(b.startDate) - Date.parse(a.startDate))) {
    const item = document.createElement('li');
    item.className = 'activity-workout';
    const heading = document.createElement('div');
    const name = document.createElement('strong');
    name.textContent = workoutNames[workout.activityType] || '其他训练';
    const time = document.createElement('time');
    time.dateTime = workout.startDate;
    time.textContent = dateTime.format(new Date(workout.startDate));
    heading.append(name, time);
    const details = document.createElement('dl');
    const stats = [['时长', duration(workout.durationSeconds)]];
    if (Number.isFinite(workout.distanceMeters)) {
      stats.push(['距离', workout.distanceMeters < 1000
        ? number.format(workout.distanceMeters) + ' 米'
        : kilometers.format(workout.distanceMeters / 1000) + ' 公里']);
    }
    if (Number.isFinite(workout.energyKcal)) stats.push(['活动能量', number.format(workout.energyKcal) + ' 千卡']);
    for (const [title, value] of stats) {
      const entry = document.createElement('div');
      const term = document.createElement('dt');
      term.textContent = title;
      const definition = document.createElement('dd');
      definition.textContent = value;
      entry.append(term, definition);
      details.append(entry);
    }
    item.append(heading, details);
    list.append(item);
  }
}

function renderResults(data, range) {
  const rows = [...data.vitals].sort((a, b) => b.day.localeCompare(a.day));
  for (const metric of vitalCards) renderVitalCard(metric, rows, range);
  renderVitalRows(rows);
  renderWorkouts(data.workouts);
  element('help').hidden = Boolean(rows.length && data.workouts.length);
}

presets.forEach(button => button.addEventListener('click', () => selectionChanged({ days: button.dataset.activityDays })));
element('range-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const next = { from: element('from').value, to: element('to').value };
  try {
    resolveDateRange(next);
    selectionChanged(next);
  } catch (error) {
    updateRangeError(error.message);
  }
});
element('retry').addEventListener('click', load);
window.addEventListener('popstate', readLocation);
readLocation();
})();`;
