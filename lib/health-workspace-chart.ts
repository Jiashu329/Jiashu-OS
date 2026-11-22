/** Browser source for the Health workspace SVG. Keep this independent of server rendering. */
export const HEALTH_WORKSPACE_CHART_SCRIPT = String.raw`
function drawHealthWorkspaceChart(container, rows, metric, selected, onSelect) {
  const styles = container.ownerDocument.defaultView?.getComputedStyle?.(container);
  const padding = (parseFloat(styles?.paddingLeft) || 0) + (parseFloat(styles?.paddingRight) || 0);
  const width = Math.max(240, Math.floor((container.clientWidth || container.getBoundingClientRect?.().width || 300) - padding));
  const height = 214;
  const top = 15;
  const bottom = 180;
  const right = width - 10;
  const color = metric.color || 'var(--jh-accent, #315d9b)';
  const kind = metric.kind || 'line';
  const missingMessage = metric.missingMessage || '暂无记录';
  const number = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: metric.decimals ?? 1 });
  const tickNumber = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 });
  const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);
  const hasRange = (row) => isNumber(row.value) && isNumber(row.min) && isNumber(row.max) && row.min <= row.max;
  const values = rows.flatMap((row) => kind === 'range' && hasRange(row) ? [row.min, row.value, row.max]
    : isNumber(row.value) ? [row.value] : []);

  const suppliedTicks = Array.isArray(metric.ticks) ? [...new Set(metric.ticks.filter(isNumber))].sort((a, b) => a - b) : [];
  const lowest = values.length ? Math.min(...values) : 0;
  const highest = values.length ? Math.max(...values) : 1;
  const span = Math.max(highest - lowest, highest * 0.06, 0.1);
  function roundStep(rawStep) {
    const scale = 10 ** Math.floor(Math.log10(rawStep));
    return ([1, 2, 2.5, 5, 10].find((factor) => factor * scale >= rawStep) || 10) * scale;
  }
  const lowerBound = (step) => kind === 'bar' ? 0 : Math.max(0, Math.floor((lowest - 0.08 * span) / step) * step);
  let step = roundStep((kind === 'bar' ? Math.max(highest, 1) : span * 1.25) / 3);
  let lower = lowerBound(step);
  if (lower + 3 * step < highest) {
    step = roundStep(step * 1.001);
    lower = lowerBound(step);
  }
  const useSuppliedTicks = suppliedTicks.length > 1 &&
    (!values.length || (lowest >= suppliedTicks[0] && highest <= suppliedTicks.at(-1)));
  const ticks = useSuppliedTicks ? suppliedTicks : Array.from({ length: 4 }, (_, i) => lower + i * step);
  const minimum = ticks[0];
  const maximum = ticks.at(-1);
  const tickText = (value) => Math.abs(value) >= 1000 ? tickNumber.format(value / 1000) + 'k' : tickNumber.format(value);
  const left = Math.max(28, ...ticks.map((value) => 13 + 6.5 * tickText(value).length));
  const stride = (right - left) / Math.max(1, rows.length);
  const x = (index) => left + (index + 0.5) * stride;
  const y = (value) => bottom - (bottom - top) * (value - minimum) / Math.max(maximum - minimum, 0.001);
  const shortDate = (day) => Number(day.slice(5, 7)) + '/' + Number(day.slice(8, 10));

  const svgNamespace = 'http://www.w3.org/2000/svg';
  function element(tag, attributes, parent, content) {
    const child = document.createElementNS(svgNamespace, tag);
    for (const [name, value] of Object.entries(attributes)) child.setAttribute(name, String(value));
    if (content !== undefined) child.textContent = content;
    if (parent) parent.append(child);
    return child;
  }

  function contiguous(predicate) {
    const groups = [];
    let current = [];
    rows.forEach((row, index) => {
      if (predicate(row)) current.push({ row, index });
      else if (current.length) { groups.push(current); current = []; }
    });
    if (current.length) groups.push(current);
    return groups;
  }

  function points(group, field) {
    return group.map(({ row, index }) => x(index).toFixed(2) + ',' + y(row[field]).toFixed(2)).join(' ');
  }

  const selectedIndex = rows.findIndex((row) => row.day === selected);
  const active = rows[selectedIndex];
  const preferredFocus = document.activeElement && container.contains(document.activeElement);
  function describe(row) {
    const value = isNumber(row.value) ? number.format(row.value) + (metric.unit ? ' ' + metric.unit : '') : missingMessage;
    const interval = kind === 'range' && hasRange(row) ? '，范围 ' + number.format(row.min) + ' 至 ' + number.format(row.max) : '';
    return row.day + '，' + value + interval;
  }
  const svg = element('svg', {
    class: 'health-workspace-chart-svg', role: 'group', tabindex: rows.length ? 0 : -1,
    'aria-label': metric.name + '趋势' + (active ? '，所选 ' + describe(active) : '') + '。按左右方向键选择日期。',
    viewBox: '0 0 ' + width + ' ' + height, width: '100%', height,
    style: 'display:block;touch-action:pan-y',
  });
  const plot = element('g', { 'aria-hidden': 'true' }, svg);
  if (active) {
    element('rect', {
      x: left + selectedIndex * stride, y: top, width: stride, height: bottom - top,
      fill: 'var(--jh-selected, #e0ebfc)', opacity: 0.48,
    }, plot);
  }
  const labels = { fill: 'var(--jh-muted, #566579)', 'font-size': 11, 'font-family': 'inherit' };
  ticks.forEach((tick) => {
    element('line', { x1: left, x2: right, y1: y(tick), y2: y(tick), stroke: 'var(--jh-plot-grid, #dce3ec)' }, plot);
    element('text', { ...labels, x: left - 7, y: y(tick), 'dominant-baseline': 'middle', 'text-anchor': 'end' }, plot, tickText(tick));
  });
  const labelCount = Math.min(rows.length, width < 380 ? 4 : width < 590 ? 6 : 7);
  for (let labelIndex = 0; labelIndex < labelCount; labelIndex++) {
    const index = labelCount === 1 ? 0 : Math.round(labelIndex * (rows.length - 1) / (labelCount - 1));
    const anchor = labelCount === 1 ? 'middle' : labelIndex === 0 ? 'start' : labelIndex === labelCount - 1 ? 'end' : 'middle';
    element('text', { ...labels, x: x(index), y: 203, 'text-anchor': anchor }, plot, shortDate(rows[index].day));
  }

  if (active) {
    element('line', {
      x1: x(selectedIndex), x2: x(selectedIndex), y1: top, y2: bottom,
      stroke: color, opacity: 0.5, 'stroke-dasharray': '3 4',
    }, plot);
  }
  if (!values.length) {
    element('text', { ...labels, x: (left + right) / 2, y: (top + bottom) / 2, 'text-anchor': 'middle' },
      plot, metric.missingMessage || '所选日期范围暂无记录');
  }
  if (kind === 'range') {
    for (const group of contiguous(hasRange)) {
      if (group.length > 1) {
        element('polygon', { points: points(group, 'max') + ' ' + points([...group].reverse(), 'min'), fill: color, opacity: 0.16 }, plot);
      }
      for (const { row, index } of group) {
        element('line', {
          x1: x(index), x2: x(index), y1: y(row.max), y2: y(row.min),
          stroke: color, 'stroke-width': index === selectedIndex ? 2.5 : 1.15,
          'stroke-linecap': 'round', opacity: 0.48,
        }, plot);
      }
    }
  }
  if (kind === 'bar') {
    const barWidth = Math.max(0.5, Math.min(28, stride * 0.66));
    rows.forEach((row, index) => {
      if (!isNumber(row.value)) return;
      const barHeight = Math.max(1.3, bottom - y(row.value));
      element('rect', {
        x: x(index) - barWidth / 2, y: bottom - barHeight, width: barWidth, height: barHeight,
        rx: Math.min(4, barWidth / 2), fill: color, opacity: index === selectedIndex ? 1 : 0.65,
      }, plot);
    });
  } else {
    for (const group of contiguous((row) => isNumber(row.value))) {
      if (group.length > 1) {
        element('polyline', {
          points: points(group, 'value'), fill: 'none', stroke: color, 'stroke-width': 2,
          'stroke-linecap': 'round', 'stroke-linejoin': 'round',
        }, plot);
      }
      if (group.length === 1 || rows.length <= 31) {
        for (const { row, index } of group) {
          element('circle', { cx: x(index), cy: y(row.value), r: rows.length > 14 ? 1.9 : 2.6, fill: color }, plot);
        }
      }
    }
    if (active && isNumber(active.value)) {
      element('circle', {
        cx: x(selectedIndex), cy: y(active.value), r: 5,
        fill: color, stroke: 'var(--jh-card, #fff)', 'stroke-width': 2,
      }, plot);
    }
  }

  if (rows.length) {
    const hit = element('rect', {
      x: left, y: 0, width: right - left, height, fill: 'transparent',
      style: 'cursor:pointer', 'aria-hidden': 'true',
    }, svg);
    function chooseIndex(index, historyMode) {
      const day = rows[index]?.day;
      if (day && day !== selected) onSelect(day, historyMode);
    }
    function chooseAt(event, historyMode) {
      const rect = svg.getBoundingClientRect();
      if (!rect.width) return;
      const chartX = (event.clientX - rect.left) * width / rect.width;
      chooseIndex(Math.max(0, Math.min(rows.length - 1, Math.floor((chartX - left) / stride))), historyMode);
    }
    hit.addEventListener('click', (event) => chooseAt(event, 'push'));
    hit.addEventListener('pointermove', (event) => {
      if (event.pointerType === 'mouse' && (event.buttons & 1)) chooseAt(event, 'replace');
    });
    svg.addEventListener('keydown', (event) => {
      const from = Math.max(0, selectedIndex);
      const next = {
        ArrowLeft: Math.max(0, from - 1), ArrowRight: Math.min(rows.length - 1, from + 1),
        Home: 0, End: rows.length - 1,
      }[event.key];
      if (next === undefined) return;
      event.preventDefault();
      chooseIndex(next, event.repeat ? 'replace' : 'push');
    });
  }
  container.replaceChildren(svg);
  if (preferredFocus) svg.focus({ preventScroll: true });
}
`;
