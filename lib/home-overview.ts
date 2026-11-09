import type { HealthMetric, HealthSummary } from './health.ts';
import { shanghaiDay } from './health.ts';
import { buildFinanceSummary, type FinanceSummaryAccount, type LedgerKind } from './finance.ts';
import type { BodyComposition } from './body-composition.ts';

export interface HomeHealthInput { summary: HealthSummary; lastSync: string | null; bodyComposition?: BodyComposition }
export interface HomeFinanceInput { accounts: readonly (FinanceSummaryAccount & { asOfDate: string })[] }
export interface HomeOverviewSources {
  health: HomeHealthInput | null;
  personal: HomeFinanceInput | null;
  family: HomeFinanceInput | null;
}
export type HomeMetric = HealthMetric | 'body_fat';
export interface HomeHealthMetric {
  metric: HomeMetric;
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

const metricDefinitions: { metric: HomeMetric; label: string; unit: string }[] = [
  { metric: 'steps', label: '步数', unit: '步' },
  { metric: 'sleep', label: '睡眠', unit: '小时' },
  { metric: 'active_energy', label: '活动能量', unit: '千卡' },
  { metric: 'weight', label: '体重', unit: 'kg' },
  { metric: 'lean_body_mass', label: '去脂体重', unit: 'kg' },
  { metric: 'body_fat', label: '估算体脂率', unit: '%' },
];

function daysBefore(day: string, days: number): string {
  return new Date(Date.parse(day + 'T00:00:00Z') - days * 86400000).toISOString().slice(0, 10);
}

function healthOverview(input: HomeHealthInput | null, today: string): HomeOverview['health'] {
  const metrics = metricDefinitions.map(({ metric, label, unit }): HomeHealthMetric => {
    const candidatePoints = metric === 'body_fat' ? input?.bodyComposition?.points ?? [] : input?.summary.metrics[metric]?.points ?? [];
    const allPoints = candidatePoints
      .filter((point) => point.day >= daysBefore(today, 89) && point.day <= today)
      .sort((left, right) => left.day.localeCompare(right.day));
    const latest = allPoints.at(-1);
    const points = allPoints.filter((point) => point.day >= daysBefore(today, 6))
      .map(({ day, value }) => ({ day, value }));
    return {
      metric, label, unit, value: latest?.value ?? null, day: latest?.day ?? null,
      freshness: !latest ? 'missing' : latest.day >= daysBefore(today, ['weight', 'lean_body_mass', 'body_fat'].includes(metric) ? 7 : 1) ? 'current' : 'stale',
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
    detail: '健康记录读取失败，请重试。', href: '/health', actionLabel: '查看健康',
  });
  const unavailableLedgers = (['personal', 'family'] as const).filter((ledger) => finance[ledger].status === 'unavailable');
  if (unavailableLedgers.length) priorities.push({
    id: 'finance-unavailable', tone: 'attention', title: '重新读取财务账本',
    detail: unavailableLedgers.map((ledger) => ledger === 'personal' ? '个人账本' : '家庭账本').join('、') + '读取失败，请重试。',
    href: '/finance?ledger=' + unavailableLedgers[0], actionLabel: '查看账本',
  });
  const dailyMetrics = health.metrics.filter((metric) => ['steps', 'sleep', 'active_energy'].includes(metric.metric));
  const stale = dailyMetrics.filter((metric) => metric.freshness === 'stale');
  if (health.status === 'ready' && stale.length) priorities.push({
    id: 'health-stale', tone: 'attention', title: '更新最近的健康记录',
    detail: stale.map((metric) => metric.label).join('、') + '的最新记录早于昨天。运行对应快捷指令更新。',
    href: '/sync', actionLabel: '查看数据同步',
  });
  if (health.status === 'ready' && dailyMetrics.every((metric) => metric.freshness === 'missing')) priorities.push({
    id: 'health-setup', tone: 'setup', title: '接入第一项日常健康数据',
    detail: '近90天暂无步数、睡眠或活动能量记录。',
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
      detail: '暂无账户，添加账户和当前余额。',
      href: '/finance?ledger=' + ledger, actionLabel: '添加首个账户',
    });
  }
  const weight = health.metrics.find((metric) => metric.metric === 'weight')!;
  if (health.status === 'ready' && weight.freshness !== 'current') priorities.push({
    id: 'weight-record', tone: 'setup', title: '更新体重记录',
    detail: weight.day ? '最近记录：' + weight.day + '。运行体重同步快捷指令更新。' : '近90天暂无体重记录，可同步苹果健康中的测量数据。',
    href: '/connect-weight', actionLabel: '接入体重与去脂体重',
  });
  const toneOrder = { attention: 0, setup: 1, neutral: 2 } as const;
  priorities.sort((left, right) => toneOrder[left.tone] - toneOrder[right.tone]);
  return { asOf, today, health, finance, priorities: priorities.slice(0, 3) };
}
