import type { HealthMetric, HealthSummary } from './health.ts';
import { shanghaiDay } from './health.ts';
import { buildFinanceSummary, type FinanceSummaryAccount, type LedgerKind } from './finance.ts';

export interface HomeHealthInput { summary: HealthSummary; lastSync: string | null }
export interface HomeFinanceInput { accounts: readonly (FinanceSummaryAccount & { asOfDate: string })[] }
export interface HomeOverviewSources {
  health: HomeHealthInput | null;
  personal: HomeFinanceInput | null;
  family: HomeFinanceInput | null;
}
export interface HomeHealthMetric {
  metric: HealthMetric;
  label: string;
  value: number | null;
  unit: string;
  day: string | null;
  freshness: 'current' | 'stale' | 'missing';
  points: { day: string; value: number }[];
  average7: number | null;
  observedDays7: number;
}
export interface HomeFinance {
  status: 'ready' | 'unavailable';
  accountCount: number;
  currencies: {
    currency: string; netFormatted: string; assetsFormatted: string;
    liabilitiesFormatted: string; netMinor: string;
  }[];
  oldestBalanceDate: string | null;
  latestBalanceDate: string | null;
  staleAccountCount: number;
}
export interface HomePriority {
  id: string;
  tone: 'attention' | 'setup' | 'neutral';
  title: string;
  detail: string;
  href: string;
  actionLabel: string;
}
export interface HomeOverview {
  asOf: string;
  today: string;
  health: {
    status: 'ready' | 'unavailable';
    lastSync: string | null;
    metrics: HomeHealthMetric[];
    recordedMetricCount: number;
  };
  finance: Record<LedgerKind, HomeFinance>;
  priorities: HomePriority[];
}

const metricDefinitions: { metric: HealthMetric; label: string; unit: string }[] = [
  { metric: 'steps', label: '步数', unit: '步' },
  { metric: 'sleep', label: '睡眠', unit: '小时' },
  { metric: 'active_energy', label: '活动能量', unit: '千卡' },
  { metric: 'weight', label: '体重', unit: 'kg' },
];

function daysBefore(day: string, days: number): string {
  return new Date(Date.parse(day + 'T00:00:00Z') - days * 86400000).toISOString().slice(0, 10);
}

function healthOverview(input: HomeHealthInput | null, today: string): HomeOverview['health'] {
  const metrics = metricDefinitions.map(({ metric, label, unit }): HomeHealthMetric => {
    const allPoints = (input?.summary.metrics[metric].points ?? [])
      .filter((point) => point.day >= daysBefore(today, 89) && point.day <= today)
      .sort((left, right) => left.day.localeCompare(right.day));
    const latest = allPoints.at(-1);
    const points = allPoints.filter((point) => point.day >= daysBefore(today, 6))
      .map(({ day, value }) => ({ day, value }));
    return {
      metric, label, unit, value: latest?.value ?? null, day: latest?.day ?? null,
      freshness: !latest ? 'missing' : latest.day >= daysBefore(today, metric === 'weight' ? 7 : 1) ? 'current' : 'stale',
      points,
      average7: points.length ? points.reduce((sum, point) => sum + point.value, 0) / points.length : null,
      observedDays7: points.length,
    };
  });
  return {
    status: input ? 'ready' : 'unavailable', lastSync: input?.lastSync ?? null,
    metrics, recordedMetricCount: metrics.filter((metric) => metric.value !== null).length,
  };
}

function financeOverview(input: HomeFinanceInput | null, ledger: LedgerKind, today: string): HomeFinance {
  if (!input) return { status: 'unavailable', accountCount: 0, currencies: [], oldestBalanceDate: null, latestBalanceDate: null, staleAccountCount: 0 };
  const accounts = input.accounts.filter((account) => account.ledger === ledger && account.archived !== true);
  const summary = buildFinanceSummary(accounts, ledger);
  const dates = accounts.map((account) => account.asOfDate).sort();
  return {
    status: 'ready', accountCount: summary.accountCount,
    currencies: summary.currencies.map(({ currency, netFormatted, assetsFormatted, liabilitiesFormatted, netMinor }) => ({
      currency, netFormatted, assetsFormatted, liabilitiesFormatted, netMinor,
    })),
    oldestBalanceDate: dates[0] ?? null, latestBalanceDate: dates.at(-1) ?? null,
    staleAccountCount: accounts.filter((account) => account.asOfDate < daysBefore(today, 30)).length,
  };
}

/** A read-only snapshot. Freshness follows record dates, never the last sync receipt. */
export function buildHomeOverview(sources: HomeOverviewSources, now: Date | string = new Date()): HomeOverview {
  const asOf = new Date(now).toISOString();
  const today = shanghaiDay(asOf);
  const health = healthOverview(sources.health, today);
  const finance = {
    personal: financeOverview(sources.personal, 'personal', today),
    family: financeOverview(sources.family, 'family', today),
  };
  const priorities: HomePriority[] = [];
  if (health.status === 'unavailable') priorities.push({
    id: 'health-unavailable', tone: 'attention', title: '重新读取健康数据',
    detail: '健康记录暂时无法读取，恢复后再判断近期状态。', href: '/health', actionLabel: '查看健康模块',
  });
  const unavailableLedgers = (['personal', 'family'] as const).filter((ledger) => finance[ledger].status === 'unavailable');
  if (unavailableLedgers.length) priorities.push({
    id: 'finance-unavailable', tone: 'attention', title: '重新读取财务账本',
    detail: unavailableLedgers.map((ledger) => ledger === 'personal' ? '个人账本' : '家庭账本').join('、') + '暂时无法读取，已保存的记录不会因此变成零。',
    href: '/finance?ledger=' + unavailableLedgers[0], actionLabel: '查看账本',
  });
  const dailyMetrics = health.metrics.filter((metric) => metric.metric !== 'weight');
  const stale = dailyMetrics.filter((metric) => metric.freshness === 'stale');
  if (health.status === 'ready' && stale.length) priorities.push({
    id: 'health-stale', tone: 'attention', title: '更新最近的健康记录',
    detail: stale.map((metric) => metric.label).join('、') + '的最新记录早于昨天。运行已配置的快捷指令，再查看近期变化。',
    href: '/sync', actionLabel: '查看数据同步',
  });
  if (health.status === 'ready' && dailyMetrics.every((metric) => metric.freshness === 'missing')) priorities.push({
    id: 'health-setup', tone: 'setup', title: '接入第一项日常健康数据',
    detail: '近90天还没有步数、睡眠或活动能量记录，可以从已有的步数开始。',
    href: '/sync', actionLabel: '接入健康数据',
  });
  for (const ledger of ['personal', 'family'] as const) {
    const book = finance[ledger];
    const label = ledger === 'personal' ? '个人账本' : '家庭账本';
    if (book.status !== 'ready') continue;
    if (book.staleAccountCount) priorities.push({
      id: ledger + '-stale', tone: 'attention', title: '更新' + label + '的余额',
      detail: book.staleAccountCount + '个账户的余额日期已超过30天；最早为' + book.oldestBalanceDate + '。',
      href: '/finance?ledger=' + ledger, actionLabel: '更新余额',
    });
    else if (!book.accountCount) priorities.push({
      id: ledger + '-setup', tone: 'setup', title: '建立' + label,
      detail: '添加一个账户和当前余额，让' + (ledger === 'personal' ? '个人' : '家庭') + '资产与负债有独立的视图。',
      href: '/finance?ledger=' + ledger, actionLabel: '添加首个账户',
    });
  }
  const weight = health.metrics.find((metric) => metric.metric === 'weight')!;
  if (health.status === 'ready' && weight.freshness !== 'current') priorities.push({
    id: 'weight-record', tone: 'setup', title: '留下一次近期体重记录',
    detail: weight.day ? '最近一次体重记录为' + weight.day + '；运行体重快捷指令更新记录后，再观察趋势。' : '近90天暂无体重记录。可从苹果健康同步已有测量记录，保留每次称重的原始日期。',
    href: '/connect-weight', actionLabel: '接入体重同步',
  });
  if (!priorities.length) priorities.push({
    id: 'review-trends', tone: 'neutral', title: '回顾最近一周的记录',
    detail: '查看已保存的近期记录，结合趋势和自己的感受安排下一步。',
    href: '/health', actionLabel: '查看健康趋势',
  });
  const toneOrder = { attention: 0, setup: 1, neutral: 2 } as const;
  priorities.sort((left, right) => toneOrder[left.tone] - toneOrder[right.tone]);
  return { asOf, today, health, finance, priorities: priorities.slice(0, 3) };
}
