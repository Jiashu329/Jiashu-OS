import { buildHealthSummary } from '../../lib/health.ts';
import { buildBodyComposition } from '../../lib/body-composition.ts';
import { parseDateRangeQuery } from '../../lib/date-range.ts';
import { buildFinanceRunwayView } from '../../lib/finance-runway.ts';
import { buildFinanceReview, parseFinanceReviewQuery } from '../../lib/finance-review.ts';
import { buildWeightPlanReview } from '../../lib/weight-plan.ts';
import { buildWeightCycleSummary, parseWeightCycleCommand } from '../../lib/weight-cycles.ts';
import { BACKUP_TABLE_NAMES, parseDataBackup } from '../../lib/data-backup.ts';
import { splitBackupVolumes, parseBackupInput } from '../../lib/backup-volumes.ts';
import { CURRENCIES } from '../../lib/finance.ts';
import { buildGoalProgress, emptyGoalSettings } from '../../lib/health-goals.ts';

export const shiftDay = (day, offset) => new Date(Date.parse(day + 'T12:00:00Z') + offset * 86400000).toISOString().slice(0,10);
const dayNow = () => new Date(Date.now() + 8*3600000).toISOString().slice(0,10);
const stamp = () => new Date().toISOString();

export function makeP2HealthMeasurements(day = dayNow()) {
  const weights = Array.from({ length: 7 }, (_, index) => ({ id: 'synthetic-weight-' + index, metric: 'weight', unit: 'kg', value: 74.9, aggregation: 'sample', source: '合成体重来源', startDate: shiftDay(day, -index) + 'T00:00:00+08:00' }));
  const timedDay = shiftDay(day, -1), legacyDay = shiftDay(day, -2);
  return [...weights, { id: 'synthetic-sleep-timed', metric: 'sleep', unit: 'hours', value: 8, aggregation: 'daily', source: '合成手表', startDate: timedDay + 'T00:00:00+08:00', endDate: timedDay + 'T08:00:00+08:00',
    sleepTiming: { onset: shiftDay(timedDay,-1) + 'T23:00:00+08:00', wake: timedDay + 'T07:00:00+08:00', clipped: false, method: 'longest-sleep-group-v1' }, sleepStages: { core: 4, deep: 2, rem: 2, unspecified: 0, awake: 0, inBed: 0 } },
    { id: 'synthetic-sleep-legacy', metric: 'sleep', unit: 'hours', value: 7.5, aggregation: 'daily', source: '旧版合成总时长', startDate: legacyDay + 'T00:00:00+08:00', endDate: legacyDay + 'T08:00:00+08:00' }];
}

export function p2State(state) {
  if (state.p2) return state.p2;
  const day = dayNow(), createdAt = shiftDay(day, -30) + 'T00:00:00Z';
  state.p2 = { day, measurements: makeP2HealthMeasurements(day), cycles: [], cycle: { id: 'legacy', archivedAt: null }, weightReplays: new Map(),
    weightSettings: { baselineWeight: 80, targetWeight: 75, startDate: shiftDay(day, -30), deadline: shiftDay(day, 60), enabled: true, revision: 1, createdAt, updatedAt: createdAt },
    backup: parseDataBackup({ kind: 'jiashu-os-backup', version: 2, exportedAt: stamp(), tables: Object.fromEntries(BACKUP_TABLE_NAMES.map((table) => [table, []])) }),
    backupConflict: false,
  };
  return state.p2;
}

function weightView(p2) { return { ...buildWeightPlanReview(p2.weightSettings, p2.measurements), cycle: p2.cycle, cycles: p2.cycles, cycleCount: p2.cycles.length }; }

export async function handleSyntheticP2({ route, state, url, method, body, key, send, fail }) {
  if (!['/api/health','/api/health/export','/api/health/goals/progress','/api/health/weight-plan','/api/health/weight-plan/cycles','/api/finance/runway','/api/finance/review','/api/data/backup'].includes(url.pathname)) return false;
  const p2 = p2State(state);
  if (url.pathname === '/api/health') {
    const range = parseDateRangeQuery(url.searchParams);
    const measurements = p2.measurements.filter((row) => row.startDate.slice(0,10) >= range.from && row.startDate.slice(0,10) <= range.to);
    await send({ measurements, summary: buildHealthSummary(measurements), bodyComposition: buildBodyComposition(measurements), lastSync: null, range });
  } else if (url.pathname === '/api/health/export') {
    const range = parseDateRangeQuery(url.searchParams);
    await route.fulfill({ status: 200, contentType: 'application/json; charset=utf-8', headers: { 'Content-Disposition': 'attachment; filename="jiashu-health-' + range.from + '_' + range.to + '.json"', 'Cache-Control': 'no-store' }, body: JSON.stringify({ version: 1, source: 'apple-health-shortcuts', timezone: 'Asia/Shanghai', exportedAt: stamp(), measurements: p2.measurements.filter((row) => row.startDate.slice(0,10) >= range.from && row.startDate.slice(0,10) <= range.to) }) });
  } else if (url.pathname === '/api/health/goals/progress') {
    await send(buildGoalProgress(emptyGoalSettings(), buildHealthSummary(p2.measurements)));
  } else if (url.pathname === '/api/health/weight-plan') {
    await send(weightView(p2));
  } else if (url.pathname === '/api/health/weight-plan/cycles') {
    if (p2.weightReplays.has(key)) { await send({ ...p2.weightReplays.get(key), replayed: true }); return true; }
    const command = parseWeightCycleCommand(body);
    if (command.expectedRevision !== p2.weightSettings.revision) { await fail('请核对最新周期。', 'WEIGHT_PLAN_CONFLICT'); return true; }
    if (command.action === 'archive') {
      const archivedAt = stamp();
      p2.cycles.push({ id: p2.cycle.id, settings: { ...p2.weightSettings }, summary: buildWeightCycleSummary(p2.weightSettings, p2.measurements, Date.parse(archivedAt)), startedAt: p2.weightSettings.createdAt, archivedAt });
      p2.cycle = { ...p2.cycle, archivedAt };
      p2.weightSettings = { ...p2.weightSettings, enabled: false, revision: p2.weightSettings.revision + 1, updatedAt: archivedAt };
    } else {
      p2.cycle = { id: crypto.randomUUID(), archivedAt: null };
      p2.weightSettings = { ...command.plan, revision: p2.weightSettings.revision + 1, createdAt: stamp(), updatedAt: stamp() };
    }
    const result = weightView(p2); p2.weightReplays.set(key, result);
    await send(result);
  } else if (url.pathname === '/api/finance/runway') {
    const ledger = url.searchParams.get('ledger') ?? 'personal', currency = url.searchParams.get('currency') ?? 'CNY';
    const accounts = state.accounts.filter((account) => account.ledger === ledger && account.currency === currency);
    const settings = { userId: state.owner, ledger, currency, monthlyExpenseMinor: '10000', targetMonths: 6, accountIds: accounts.map((account) => account.id), revision: 1, createdAt: stamp(), updatedAt: stamp() };
    await send({ ledger, currency, today: p2.day, revision: 1, accounts, ...buildFinanceRunwayView(settings, accounts, p2.day), meta: { currencies: CURRENCIES } });
  } else if (url.pathname === '/api/finance/review') {
    const selection = parseFinanceReviewQuery(url.searchParams);
    const accounts = state.accounts.map((account) => ({ ...account, accountId: account.id }));
    const balances = accounts.flatMap((account) => [{ accountId: account.id, amountMinor: account.balanceMinor, asOfDate: selection.previousCutoffDay, sequence: 1 }, { accountId: account.id, amountMinor: account.balanceMinor, asOfDate: selection.cutoffDay, sequence: 2 }]);
    const history = accounts.map((account) => ({ accountId: account.id, revision: 1, effectiveFrom: selection.today, type: account.type, archived: 0, origin: 'baseline', recordedAt: stamp() }));
    await send(buildFinanceReview(accounts, balances, selection, p2.reviewClassifications ?? history));
  } else if (url.pathname === '/api/data/backup') {
    if (method === 'GET') await send(url.searchParams.get('format') === 'volumes' ? await splitBackupVolumes(p2.backup) : p2.backup);
    else if (body.action === 'preview') {
      try {
        const parsed = await parseBackupInput(body.backup);
        const incoming = Object.values(parsed.backup.tables).reduce((sum, rows) => sum + rows.length, 0);
        const conflicts = p2.backupConflict ? 1 : 0;
        await send({ canRestore: !conflicts, previewHash: 'synthetic-preview-hash', generatedGoalHistoryRows: 0,
          total: { incoming, added: incoming - conflicts, skipped: 0, conflicts },
          tables: [{ table: 'health_goal_settings', label: '健康目标', incoming, added: incoming - conflicts, skipped: 0, conflicts,
            conflictExamples: conflicts ? [{ record: '当前健康目标', reason: '现有记录与备份不同', differences: [{ field: 'steps_target', current: '6000', incoming: '10000' }] }] : [] }] });
      } catch (error) { await fail(error.message, 'INVALID_DATA_BACKUP', 400); }
    } else await fail('Synthetic acceptance never writes a restored production database.', 'SYNTHETIC_RESTORE_DISABLED', 403);
  }
  return true;
}
