import type { WeeklyAction, WeeklyActionInput } from '../lib/health-weekly-actions.ts';

export type WeeklyActionDatabase = Pick<D1Database, 'prepare'>;
const columns = 'week_start AS weekStart, text, status, feedback, revision, created_at AS createdAt, updated_at AS updatedAt';
export class WeeklyActionConflictError extends Error {
  readonly code = 'WEEKLY_ACTION_CONFLICT';
  constructor() { super('这周的行动已在另一页面更新，请读取最新内容后再保存。'); this.name = 'WeeklyActionConflictError'; }
}
export async function readWeeklyAction(db: WeeklyActionDatabase, userId: string, weekStart: string): Promise<WeeklyAction | null> {
  return db.prepare(`SELECT ${columns} FROM health_weekly_actions WHERE user_id = ? AND week_start = ?`)
    .bind(userId, weekStart).first<WeeklyAction>();
}
export async function readWeeklyActions(db: WeeklyActionDatabase, userId: string, weeks: readonly string[]): Promise<Array<WeeklyAction | null>> {
  return Promise.all(weeks.map((week) => readWeeklyAction(db, userId, week)));
}
/** One action per execution week. Same-content retries never duplicate or overwrite newer feedback. */
export async function writeWeeklyAction(db: WeeklyActionDatabase, userId: string, input: WeeklyActionInput, now = new Date().toISOString()) {
  const row = input.expectedRevision === 0
    ? await db.prepare(`INSERT INTO health_weekly_actions (user_id, week_start, text, status, feedback, revision, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 1, ?, ?) ON CONFLICT(user_id, week_start) DO NOTHING RETURNING ${columns}`)
      .bind(userId, input.weekStart, input.text, input.status, input.feedback, now, now).first<WeeklyAction>()
    : await db.prepare(`UPDATE health_weekly_actions SET text = ?, status = ?, feedback = ?, revision = revision + 1, updated_at = ?
        WHERE user_id = ? AND week_start = ? AND revision = ? RETURNING ${columns}`)
      .bind(input.text, input.status, input.feedback, now, userId, input.weekStart, input.expectedRevision).first<WeeklyAction>();
  if (row) return { action: row, replayed: false };
  const current = await readWeeklyAction(db, userId, input.weekStart);
  if (current && current.text === input.text && current.status === input.status && current.feedback === input.feedback) return { action: current, replayed: true };
  throw new WeeklyActionConflictError();
}
