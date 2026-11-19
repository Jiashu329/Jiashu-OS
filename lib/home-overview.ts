import type { HealthMetric, HealthSummary } from './health.ts';
import { shanghaiDay } from './health.ts';
import { buildFinanceSummary, formatMoney, type CurrencyCode, type FinanceSummaryAccount, type LedgerKind } from './finance.ts';
import { isCheckedThisMonth } from './finance-balance-check.ts';
import type { BodyComposition } from './body-composition.ts';
import type { NutritionDayStatus, NutritionEntry, NutritionMealStatus, NutritionMeal } from './nutrition.ts';
import { nutritionDayCompleteness } from './nutrition-review.ts';
import { summarizeNutrients, type NutritionNutrients } from './nutrition-nutrients.ts';
import { nutritionGoalProgress, type NutritionGoals } from './nutrition-goals.ts';

export interface HomeHealthInput { summary: HealthSummary; lastSync: string | null; bodyComposition?: BodyComposition }
export interface HomeFinanceInput { accounts: readonly (FinanceSummaryAccount & { asOfDate: string })[] }
export interface HomeNutritionInput { entries: readonly NutritionEntry[]; statuses?: readonly NutritionDayStatus[]; goals?: NutritionGoals | null }
export interface HomeActionsInput {
  nutrition: { entryCountToday: number; recordedDays7: number } | null;
  weekly: { weekStart: string; previousWeekStart: string; previousHasRecords: boolean; reviewed: boolean } | null;
  decisions: readonly {
    ledger: LedgerKind; currency: CurrencyCode;
    goals: readonly { id: string; name: string; status: string; gapMinor: string; deadline: string }[];
    runway: { gapMinor: string; status: string; runwayMonths: string; missingCount: number } | null;
  }[] | null;
}
export interface HomeOverviewSources {
  health: HomeHealthInput | null;
  personal: HomeFinanceInput | null;
  family: HomeFinanceInput | null;
  nutrition?: HomeNutritionInput | null;
  actions?: HomeActionsInput | null;
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
  uncheckedAccountCount: number;
  pendingBalanceCount: number;
}
export interface HomeNutrition {
  status: 'ready' | 'unavailable'; date: string; entryCount: number; complete: boolean;
  meals: Record<NutritionMeal, NutritionMealStatus>;
  nutrients: NutritionNutrients;
  targets: Record<'calories'|'carbs'|'protein'|'fat',string|null>;
  progress: ReturnType<typeof nutritionGoalProgress>;
}
export interface HomePriority {
  id: string;
  tone: 'attention' | 'action' | 'setup' | 'neutral';
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
  nutrition: HomeNutrition;
  actionsStatus: 'ready' | 'partial' | 'unavailable' | 'not-requested';
  weekly: HomeActionsInput['weekly'];
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
  if (!input) return { status: 'unavailable', accountCount: 0, currencies: [], oldestBalanceDate: null, latestBalanceDate: null, staleAccountCount: 0, uncheckedAccountCount: 0, pendingBalanceCount: 0 };
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
    uncheckedAccountCount: accounts.filter((account) => !isCheckedThisMonth(account.asOfDate, today)).length,
    pendingBalanceCount: accounts.filter((account) => !isCheckedThisMonth(account.asOfDate, today)).length,
  };
}

function nutritionOverview(input: HomeNutritionInput | null | undefined, today: string): HomeNutrition {
  const entries=(input?.entries??[]).filter((entry)=>entry.date===today&&entry.deletedAt===null);
  const status=input?.statuses?.find((row)=>row.date===today);
  const nutrients=summarizeNutrients(entries),goals=input?.goals;
  const targets={calories:goals?.calories??null,carbs:goals?.carbs??null,protein:goals?.protein??null,fat:goals?.fat??null};
  return {status:input?'ready':'unavailable',date:today,entryCount:entries.length,...nutritionDayCompleteness(entries,status),nutrients,targets,progress:nutritionGoalProgress(nutrients,targets)};
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
  const nutrition=nutritionOverview(sources.nutrition,today);
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
    else if (book.uncheckedAccountCount) priorities.push({
      id:ledger+'-month-check',tone:'attention',title:'核对'+label+'本月余额',detail:'待核对 '+book.uncheckedAccountCount+' / '+book.accountCount+' 个账户；尚无本月余额记录。',
      href:'/finance/balances?ledger='+ledger,actionLabel:'开始本月核对',
    });
  }
  const weight = health.metrics.find((metric) => metric.metric === 'weight')!;
  if (health.status === 'ready' && weight.freshness !== 'current') priorities.push({
    id: 'weight-record', tone: 'setup', title: '更新体重记录',
    detail: weight.day ? '最近记录：' + weight.day + '。可快速补记或运行体重同步。' : '近90天暂无体重记录，可以先手动记一次。',
    href: '/health/records?metric=weight&compose=1', actionLabel: '记体重',
  });
  if(Object.hasOwn(sources,'nutrition')){
    if(nutrition.status==='unavailable')priorities.push({id:'nutrition-unavailable',tone:'attention',title:'重新读取饮食记录',detail:'今日饮食读取失败，尚不能判断记录状态。',href:'/health/nutrition',actionLabel:'查看饮食'});
    else if(!nutrition.entryCount&&!nutrition.complete)priorities.push({id:'nutrition-record',tone:'setup',title:'记下今天吃过的',detail:'今天还没有食物记录，已明确未进食的餐次会保留。',href:'/health/nutrition?compose=1',actionLabel:'记饮食'});
  }
  const actions = sources.actions;
  if (actions) {
    for (const decision of actions.decisions ?? []) {
      const label = decision.ledger === 'family' ? '家庭账本' : '个人账本';
      const scope = '?ledger=' + decision.ledger + '&currency=' + decision.currency;
      const due = decision.goals.filter((goal) => goal.status !== 'achieved' && BigInt(goal.gapMinor) > BigInt(0)
        && goal.deadline <= daysBefore(today, -30)).sort((a, b) => a.deadline.localeCompare(b.deadline));
      if (due.length) priorities.push({
        id: 'goals-' + decision.ledger + '-' + decision.currency, tone: 'action',
        title: due[0].status === 'overdue' ? '处理已到期的财务目标' : '查看近期到期的财务目标',
        detail: label + ' · ' + due[0].name + '，截止 ' + due[0].deadline + '，缺口 ' + formatMoney(due[0].gapMinor, decision.currency)
          + (due.length > 1 ? '；另有 ' + (due.length - 1) + ' 项。' : '。'),
        href: '/finance/goals' + scope, actionLabel: '查看目标',
      });
      if (decision.runway?.missingCount) priorities.push({
        id: 'runway-links-' + decision.ledger + '-' + decision.currency, tone: 'action', title: '核对应急资金的关联账户',
        detail: label + ' · ' + decision.currency + '，有 ' + decision.runway.missingCount + ' 个关联账户已失效。',
        href: '/finance/runway' + scope, actionLabel: '调整关联',
      });
      else if (decision.runway?.status === 'short') priorities.push({
        id: 'runway-' + decision.ledger + '-' + decision.currency, tone: 'action', title: '查看应急资金缺口',
        detail: label + ' · 当前可覆盖 ' + decision.runway.runwayMonths + ' 个月，距自设目标还差 ' + formatMoney(decision.runway.gapMinor, decision.currency) + '。',
        href: '/finance/runway' + scope, actionLabel: '查看资金安排',
      });
    }
    if (actions.weekly?.previousHasRecords && !actions.weekly.reviewed) priorities.push({
      id: 'weekly-review', tone: 'action', title: '完成上周健康复盘',
      detail: '查看 ' + actions.weekly.previousWeekStart + ' 起这一周的记录，并为本周选一项行动。',
      href: '/health/review?week=' + actions.weekly.previousWeekStart, actionLabel: '复盘并安排本周',
    });
    if (!Object.hasOwn(sources, 'nutrition') && actions.nutrition && actions.nutrition.recordedDays7 > 0 && !actions.nutrition.entryCountToday) priorities.push({
      id: 'nutrition-today', tone: 'action', title: '记录今天的饮食',
      detail: '今天还没有饮食记录，可复用最近食物或复制前一天的一餐。',
      href: '/health/nutrition', actionLabel: '记一餐',
    });
  }
  const actionsStatus = actions === undefined ? 'not-requested' : actions === null ? 'unavailable'
    : [actions.nutrition, actions.weekly, actions.decisions].some((part) => part === null) ? 'partial' : 'ready';
  const toneOrder = { attention: 0, action: 1, setup: 2, neutral: 3 } as const;
  priorities.sort((left, right) => toneOrder[left.tone] - toneOrder[right.tone]);
  return { asOf, today, health, finance, nutrition, actionsStatus, weekly: actions?.weekly ?? null, priorities: priorities.slice(0, 3) };
}
