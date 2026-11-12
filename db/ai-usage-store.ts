import { shanghaiDay } from '../lib/health.ts';

export type AIUsageDatabase = Pick<D1Database, 'prepare'>;

export interface AIQuotaResult {
  allowed: boolean;
  retryAfter: number;
  remainingToday: number;
}

interface UsageRow {
  day: string;
  dayCount: number;
  minute: number;
  minuteCount: number;
}

const DAILY_LIMIT = 20;
const MINUTE_LIMIT = 3;

/** Read application request counters without reserving a provider call. */
export async function readAIQuota(db: AIUsageDatabase, userId: string, now: number): Promise<AIQuotaResult> {
  const day = shanghaiDay(new Date(now).toISOString()), minute = Math.floor(now / 60000);
  const current = await db.prepare('SELECT day, day_count AS dayCount, minute, minute_count AS minuteCount FROM ai_usage_limits WHERE user_id = ?').bind(userId).first<UsageRow>();
  const dayCount = current?.day === day ? current.dayCount : current && current.day > day ? DAILY_LIMIT : 0;
  const minuteCount = current?.minute === minute ? current.minuteCount : current && current.minute > minute ? MINUTE_LIMIT : 0;
  const allowed = dayCount < DAILY_LIMIT && minuteCount < MINUTE_LIMIT;
  const reset = dayCount >= DAILY_LIMIT ? Date.parse(day + 'T00:00:00+08:00') + 86400000 : (minute + 1) * 60000;
  return { allowed, remainingToday: Math.max(0, DAILY_LIMIT - dayCount), retryAfter: allowed ? 0 : Math.max(1, Math.ceil((reset-now)/1000)) };
}

/** Reserve one request atomically across workers. Only counters are persisted. */
export async function consumeAIQuota(db: AIUsageDatabase, userId: string, now: number): Promise<AIQuotaResult> {
  const day = shanghaiDay(new Date(now).toISOString());
  const minute = Math.floor(now / 60000);
  // Window keys may only advance: a delayed request from another worker must
  // not reset counters that have already rolled into a newer minute or day.
  const consumed = await db.prepare(`
    INSERT INTO ai_usage_limits (user_id, day, day_count, minute, minute_count)
    VALUES (?, ?, 1, ?, 1)
    ON CONFLICT(user_id) DO UPDATE SET
      day = excluded.day,
      day_count = CASE WHEN ai_usage_limits.day = excluded.day THEN ai_usage_limits.day_count + 1 ELSE 1 END,
      minute = excluded.minute,
      minute_count = CASE WHEN ai_usage_limits.minute = excluded.minute THEN ai_usage_limits.minute_count + 1 ELSE 1 END
    WHERE (ai_usage_limits.day < excluded.day OR (ai_usage_limits.day = excluded.day AND ai_usage_limits.day_count < ?))
      AND (ai_usage_limits.minute < excluded.minute OR (ai_usage_limits.minute = excluded.minute AND ai_usage_limits.minute_count < ?))
    RETURNING day_count AS dayCount
  `).bind(userId, day, minute, DAILY_LIMIT, MINUTE_LIMIT).first<{ dayCount: number }>();

  if (consumed) return { allowed: true, retryAfter: 0, remainingToday: Math.max(0, DAILY_LIMIT - consumed.dayCount) };

  const current = await db.prepare(`
    SELECT day, day_count AS dayCount, minute, minute_count AS minuteCount
    FROM ai_usage_limits WHERE user_id = ?
  `).bind(userId).first<UsageRow>();
  const dayCount = current?.day === day ? current.dayCount : current && current.day > day ? DAILY_LIMIT : 0;
  // Shanghai currently uses UTC+08:00 without daylight saving. The daily
  // window ends at the next local midnight, even when UTC is still yesterday.
  const nextMidnight = Date.parse(`${day}T00:00:00+08:00`) + 86400000;
  const nextMinute = (minute + 1) * 60000;
  const resetAt = dayCount >= DAILY_LIMIT ? nextMidnight : nextMinute;
  return {
    allowed: false,
    retryAfter: Math.max(1, Math.ceil((resetAt - now) / 1000)),
    remainingToday: current ? Math.max(0, DAILY_LIMIT - dayCount) : 0,
  };
}
