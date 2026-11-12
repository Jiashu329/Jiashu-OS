import { normalizeTimestamp, shanghaiDay } from './health.ts';

export const WEEKLY_ACTION_STATUSES = ['planned', 'completed', 'not_completed'] as const;
export type WeeklyActionStatus = typeof WEEKLY_ACTION_STATUSES[number];
export interface WeeklyAction {
  weekStart: string;
  text: string;
  status: WeeklyActionStatus;
  feedback: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}
export interface WeeklyActionInput extends Pick<WeeklyAction, 'weekStart' | 'text' | 'status' | 'feedback'> { expectedRevision: number }
export class WeeklyActionValidationError extends Error {
  readonly code = 'INVALID_WEEKLY_ACTION';
  constructor(message: string) { super(message); this.name = 'WeeklyActionValidationError'; }
}
export function shiftWeekDay(day: string, count: number): string {
  return new Date(Date.parse(day + 'T12:00:00Z') + count * 86400000).toISOString().slice(0, 10);
}
function monday(day: string): string {
  return shiftWeekDay(day, -((new Date(day + 'T12:00:00Z').getUTCDay() + 6) % 7));
}
export function weeklyActionWeek(input: unknown, now: Date | number = Date.now()): string {
  const today = shanghaiDay(new Date(now).toISOString());
  if (input === undefined || input === null) return monday(today);
  if (typeof input !== 'string' || input < '1969-12-29' || input > '2100-12-31'
    || !/^\d{4}-\d{2}-\d{2}$/.test(input)
    || !Number.isFinite(Date.parse(input + 'T12:00:00Z'))
    || new Date(input + 'T12:00:00Z').toISOString().slice(0, 10) !== input
    || (input >= '1970-01-01' && !normalizeTimestamp(input + 'T12:00:00+08:00'))) throw new WeeklyActionValidationError('请选择有效的行动周日期。');
  const week = monday(input);
  if (week > shiftWeekDay(monday(today), 7)) throw new WeeklyActionValidationError('最多可规划下一周的一项行动。');
  return week;
}
export function parseWeeklyActionInput(input: unknown, now: Date | number = Date.now()): WeeklyActionInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new WeeklyActionValidationError('请提交完整的每周行动。');
  const raw = input as Record<string, unknown>;
  if (Object.keys(raw).some((key) => !['weekStart', 'text', 'status', 'feedback', 'expectedRevision'].includes(key))) throw new WeeklyActionValidationError('行动包含不支持的字段。');
  const weekStart = weeklyActionWeek(raw.weekStart, now);
  if (raw.weekStart !== weekStart) throw new WeeklyActionValidationError('行动周请使用该周的周一日期。');
  const controls = (text: string, multiline: boolean) => {
    for (const character of text) {
      const code = character.charCodeAt(0);
      if (code === 127 || (code < 32 && !(multiline && [9, 10, 13].includes(code)))) return true;
    }
    return false;
  };
  if (typeof raw.text !== 'string' || !raw.text.trim() || raw.text.trim().length > 200 || controls(raw.text, false)) throw new WeeklyActionValidationError('请填写 1–200 个字符的一项具体行动。');
  if (typeof raw.feedback !== 'string' || raw.feedback.trim().length > 500 || controls(raw.feedback, true)) throw new WeeklyActionValidationError('行动反馈最多 500 个字符。');
  if (!WEEKLY_ACTION_STATUSES.includes(raw.status as WeeklyActionStatus)) throw new WeeklyActionValidationError('请选择计划中、已完成或未完成。');
  if (!Number.isSafeInteger(raw.expectedRevision) || (raw.expectedRevision as number) < 0) throw new WeeklyActionValidationError('请先读取行动的最新版本。');
  if (weekStart > weeklyActionWeek(undefined, now) && (raw.status !== 'planned' || raw.feedback.trim())) throw new WeeklyActionValidationError('下一周尚未开始，先保存计划，执行后再反馈。');
  return { weekStart, text: raw.text.trim(), status: raw.status as WeeklyActionStatus, feedback: raw.feedback.trim(), expectedRevision: raw.expectedRevision as number };
}
