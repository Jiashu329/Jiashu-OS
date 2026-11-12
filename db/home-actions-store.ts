import { shanghaiDay } from '../lib/health.ts';
import { parseCurrency, parseLedger } from '../lib/finance.ts';
import type { HomeActionsInput } from '../lib/home-overview.ts';
import { readFinanceDecisionSummary } from './finance-decision-summary.ts';
import { readEffectiveHealthMeasurements } from './health-records-store.ts';

type HomeDatabase = Pick<D1Database, 'prepare' | 'batch'>;
function shift(day: string, offset: number) {
  return new Date(Date.parse(day + 'T12:00:00Z') + offset * 86400000).toISOString().slice(0, 10);
}

export function homeActionDates(now: Date | string = new Date()) {
  const today = shanghaiDay(new Date(now).toISOString());
  const weekday = new Date(today + 'T12:00:00Z').getUTCDay();
  const weekStart = shift(today, -((weekday + 6) % 7));
  return { today, weekStart, previousWeekStart: shift(weekStart, -7), recentFrom: shift(today, -6) };
}

/** Optional action sources fail independently; a missing source is never treated as completed. */
export async function readHomeActions(db: HomeDatabase, userId: string, now: Date | string = new Date()): Promise<HomeActionsInput> {
  const { today, weekStart, previousWeekStart, recentFrom } = homeActionDates(now);
  const [nutrition, weekly, decisions] = await Promise.allSettled([
    (async () => db.prepare(`SELECT COUNT(CASE WHEN date = ? THEN 1 END) AS entryCountToday,
        COUNT(DISTINCT date) AS recordedDays7 FROM nutrition_entries
        WHERE user_id = ? AND deleted_at IS NULL AND date >= ? AND date <= ?`)
      .bind(today, userId, recentFrom, today).first<{ entryCountToday: number; recordedDays7: number }>())(),
    (async () => {
      const [health, row] = await Promise.all([
        readEffectiveHealthMeasurements(db, userId, previousWeekStart, shift(weekStart, -1)),
        db.prepare(`SELECT EXISTS(SELECT 1 FROM nutrition_entries WHERE user_id = ? AND deleted_at IS NULL AND date >= ? AND date < ?) AS previousHasRecords,
          EXISTS(SELECT 1 FROM health_weekly_actions WHERE user_id = ? AND week_start = ?) AS reviewed`)
          .bind(userId, previousWeekStart, weekStart, userId, weekStart).first<{ previousHasRecords: number; reviewed: number }>(),
      ]);
      return { previousHasRecords: health.length > 0 || !!row?.previousHasRecords, reviewed: !!row?.reviewed };
    })(),
    (async () => {
      const scopes = await db.prepare(`SELECT ledger, currency FROM finance_goal_plans WHERE user_id = ? AND archived_at IS NULL
        UNION SELECT ledger, currency FROM finance_runway_settings WHERE user_id = ? ORDER BY ledger, currency`)
        .bind(userId, userId).all<{ ledger: string; currency: string }>();
      return Promise.all(scopes.results.map((scope) => readFinanceDecisionSummary(db, userId,
        parseLedger(scope.ledger), parseCurrency(scope.currency), today)));
    })(),
  ]);
  return {
    nutrition: nutrition.status === 'fulfilled' && nutrition.value ? {
      entryCountToday: nutrition.value.entryCountToday, recordedDays7: nutrition.value.recordedDays7,
    } : null,
    weekly: weekly.status === 'fulfilled' && weekly.value ? {
      weekStart, previousWeekStart, previousHasRecords: !!weekly.value.previousHasRecords, reviewed: !!weekly.value.reviewed,
    } : null,
    decisions: decisions.status === 'fulfilled' ? decisions.value : null,
  };
}
