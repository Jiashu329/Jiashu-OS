import { buildHomeOverview } from '../../lib/home-overview.ts';
import { buildHealthSummary, measurementKey, shanghaiDay } from '../../lib/health.ts';
import { buildHomeAppleActivity, homeAppleActivityRange } from '../../lib/apple-activity-supplements.ts';
import { parseDateRangeQuery } from '../../lib/date-range.ts';
import { parseHealthRecordCreate } from '../../lib/health-records.ts';
import { buildFinanceSummary, ACCOUNT_TYPES, CURRENCIES } from '../../lib/finance.ts';
import { buildNutritionReview, parseNutritionQuery, parseNutritionCreate, presentNutritionEntry } from '../../lib/nutrition.ts';
import { buildNutritionInsight, parseNutritionInsightQuery } from '../../lib/nutrition-review.ts';
import { parseNutritionGoals } from '../../lib/nutrition-goals.ts';
import { BROWSER_FIXTURE_OWNER } from '../../scripts/browser-fixture.mjs';
import { handleSyntheticP2 } from './p2-api.mjs';
import { handleSyntheticNutritionTemplates } from './nutrition-templates-api.mjs';
import { handleSyntheticPhoto } from './photo-api.mjs';

export const ACCOUNT_ID = '11111111-1111-4111-8111-111111111111';
export const DAY = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
const meals = () => ({ breakfast: 'unrecorded', lunch: 'unrecorded', dinner: 'unrecorded', snack: 'unrecorded' });
const stamp = () => new Date().toISOString();
function makeEntry(input, id = crypto.randomUUID(), revision = 1) {
  const allowed = ['date','meal','name','portion','calories','carbs','protein','fat','note','food','provenance'];
  return { ...parseNutritionCreate(Object.fromEntries(Object.entries(input).filter(([key]) => allowed.includes(key)))), id, revision, createdAt: stamp(), updatedAt: stamp(), deletedAt: null };
}

export function syntheticState() {
  return {
    owner: BROWSER_FIXTURE_OWNER, requests: [], externalRequests: [], entries: [], histories: new Map(),
    sessionFailure: null, nutritionReadFailure: null, goalsReadGate: null, failNextGoalsRead: false,
    healthRecords: [], healthRecordReplays: new Map(), hangNextHealthWrite: false,
    dayStatus: { date: DAY, complete: false, revision: 0, meals: meals() },
    goals: { calories: null, carbs: null, protein: null, fat: null, revision: 0, createdAt: null, updatedAt: null },
    accounts: [{ id: ACCOUNT_ID, name: '合成验收账户', type: 'bank', ledger: 'personal', currency: 'CNY',
      note: '', amount: '100.00', balanceMinor: '10000', asOfDate: DAY, archived: false, archivedAt: null,
      metadataRevision: 1, balanceRevision: 1, liquidityKind: 'liquid', usableBps: 10000, createdAt: stamp(), updatedAt: stamp() }],
    rejectNextAccountEdit: false, rejectNextGoalEdit: false, rejectNextNutritionSave: false, loseNextBatchReply: false, nutritionReplays: new Map(),
  };
}

export function syntheticAppleActivityDaily(activity) {
  const workouts = new Map();
  for (const record of activity.workouts) {
    const day = shanghaiDay(record.startDate);
    const summary = workouts.get(day) ?? { day, count: 0, durationSeconds: 0 };
    summary.count++;
    summary.durationSeconds += record.durationSeconds;
    workouts.set(day, summary);
  }
  return { vitals: activity.vitals, workouts: [...workouts.values()] };
}

export async function interceptSyntheticAPI(context, state) {
  await context.route('**/*', async (route) => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== 'http://127.0.0.1:4175') { state.externalRequests.push(url.origin); await route.abort('blockedbyclient'); return; }
    if (!url.pathname.startsWith('/api/')) { await route.continue(); return; }
    const method = request.method(), body = request.postDataJSON() ?? null;
    state.requests.push({ path: url.pathname, search: url.search, method, body, key: request.headers()['idempotency-key'] ?? null });
    const send = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: { 'Cache-Control': 'no-store' }, body: JSON.stringify(value) });
    const fail = (message, code, status = 409) => send({ error: message, code }, status);
    if (url.pathname === '/api/session') return state.sessionFailure ? send(state.sessionFailure.body, state.sessionFailure.status) : send({ userId: state.owner });
    if (await handleSyntheticPhoto({ route, state, url, method, body, send, fail })) return;
    if (await handleSyntheticNutritionTemplates({ route, state, url, method, body, key: request.headers()['idempotency-key'] ?? null, send, fail })) return;
    if (await handleSyntheticP2({ route, state, url, method, body, key: request.headers()['idempotency-key'] ?? null, send, fail })) return;
    if (url.pathname === '/api/health/apple-activity' && method === 'GET') {
      if (state.appleActivityReadFailure) return fail('暂时无法读取苹果健康记录。', 'SYNTHETIC_UNAVAILABLE', 503);
      const { from, to } = parseDateRangeQuery(url.searchParams, state.now ?? Date.now(), 30);
      const includes = (day) => day >= from && day <= to;
      const vitals = (state.appleActivity?.vitals ?? []).filter(row => includes(row.day));
      const workouts = (state.appleActivity?.workouts ?? []).filter(row => includes(shanghaiDay(row.startDate)));
      return send({ from, to, vitals, workouts });
    }
    if (url.pathname === '/api/overview') {
      const now = new Date(state.now ?? Date.now());
      const overview = buildHomeOverview({ health: { summary: buildHealthSummary([]), lastSync: null },
        personal: { accounts: state.accounts }, family: { accounts: [] },
        nutrition: { entries: state.entries, statuses: [state.dayStatus], goals: state.goals } }, now);
      if (!state.appleActivity) return send(overview);
      const appleActivity = buildHomeAppleActivity(syntheticAppleActivityDaily(state.appleActivity), homeAppleActivityRange(overview.today));
      return send({ ...overview, appleActivity });
    }
    if (url.pathname === '/api/health/records' && method === 'GET') return send({ records: state.healthRecords, hasMore: false, nextCursor: null, today: DAY });
    if (url.pathname === '/api/health/records' && method === 'POST') {
      const key = request.headers()['idempotency-key'], payload = JSON.stringify(body), replay = state.healthRecordReplays.get(key);
      if (replay) return replay.payload === payload ? send({ record: replay.record, replayed: true }, 201) : fail('原请求内容已变化。', 'HEALTH_RECORD_CONFLICT');
      let command;
      try { command = parseHealthRecordCreate(body, key); }
      catch (error) { return send({ error: error.message, code: 'HEALTH_RECORD_INVALID', issues: error.issues }, 400); }
      const recordKey = measurementKey(command.measurement);
      if (state.healthRecords.some(record => record.recordKey === recordKey)) return fail('该日期已有此指标记录。', 'HEALTH_RECORD_CONFLICT');
      const record = { recordKey, metric: command.measurement.metric, day: body.date, base: null, effective: command.measurement, override: command.measurement, deleted: false, revision: 1, updatedAt: stamp(), manual: true };
      state.healthRecords.push(record); state.healthRecordReplays.set(key, { payload, record });
      // The server has committed, but this request receives no headers before the client deadline.
      if (state.hangNextHealthWrite) { state.hangNextHealthWrite = false; return; }
      return send({ record, replayed: false }, 201);
    }
    if (url.pathname === '/api/health/nutrition' && method === 'GET') {
      if (state.nutritionReadFailure) return send(state.nutritionReadFailure.body, state.nutritionReadFailure.status);
      const selection = parseNutritionQuery(url.searchParams);
      return send({ ...buildNutritionReview(state.entries, selection), recentFoods: state.entries.map(presentNutritionEntry), dayStatus: { ...state.dayStatus, date: selection.date } });
    }
    if (url.pathname === '/api/health/nutrition/goals') {
      if (method === 'PUT') {
        if (state.rejectNextGoalEdit) { state.rejectNextGoalEdit = false; state.goals.revision++; return fail('其他页面已更新目标，请先核对最新内容。', 'NUTRITION_GOALS_CONFLICT'); }
        const command = parseNutritionGoals(body);
        if (command.expectedRevision !== state.goals.revision) return fail('目标版本已变化。', 'NUTRITION_GOALS_CONFLICT');
        state.goals = { ...state.goals, ...command.targets, revision: state.goals.revision + 1, updatedAt: stamp(), createdAt: state.goals.createdAt ?? stamp() };
      }
      const goals = structuredClone(state.goals);
      if (method === 'GET' && state.goalsReadGate) { const gate = state.goalsReadGate; state.goalsReadGate = null; await gate; }
      if (method === 'GET' && state.failNextGoalsRead) { state.failNextGoalsRead = false; return fail('目标暂时不可读取，请重试。', 'SYNTHETIC_UNAVAILABLE', 503); }
      return send({ goals, weightPlan: null });
    }
    if (url.pathname === '/api/health/nutrition/review') return send(buildNutritionInsight(state.entries, [state.dayStatus], parseNutritionInsightQuery(url.searchParams)));
    if (url.pathname.endsWith('/nutrition/favorites')) return send({ favorites: [] });
    if (url.pathname.endsWith('/nutrition/reuse')) return send({ favorites: [], recent: state.entries.map(presentNutritionEntry) });
    if (url.pathname.endsWith('/nutrition/foods')) return send({ foods: [] });
    if (url.pathname.endsWith('/nutrition/status')) return send({ dayStatus: state.dayStatus });
    if (url.pathname.endsWith('/nutrition/parse')) {
      return send({ drafts: [{ date: DAY, meal: body.meal ?? 'lunch', name: '合成验收午餐', portion: '1份（按普通份量估算）', amount: 1, unit: '份',
        calories: '450.0', carbs: '50.0', protein: '25.0', fat: '16.7', calorieSource: 'ai',
        macroSources: { carbs: 'ai', protein: 'ai', fat: 'ai' }, food: null, candidates: [], warnings: ['合成 AI 估算，核对后保存。'],
        provenance: Object.fromEntries(['calories', 'carbs', 'protein', 'fat'].map((key) => [key, { source: 'ai', basis: '合成参考份量', portion: '1份' }])),
        note: 'AI 估算：1份；合成参考份量。' }], warnings: [], provider: 'synthetic', model: 'no-provider-call' });
    }
    if ((url.pathname === '/api/health/nutrition' || url.pathname.endsWith('/nutrition/batch')) && method === 'POST') {
      if (state.rejectNextNutritionSave) { state.rejectNextNutritionSave = false; return fail('合成网络服务暂时不可用，请继续确认原操作。', 'SYNTHETIC_UNAVAILABLE', 503); }
      const operationKey = request.headers()['idempotency-key'];
      if (state.nutritionReplays.has(operationKey)) return send({ ...state.nutritionReplays.get(operationKey), replayed: true }, 201);
      const inputs = body.entries ?? [body];
      const entries = inputs.map((input) => makeEntry(input));
      state.entries.push(...entries);
      for (const entry of entries) state.histories.set(entry.id, [{ revision: 1, action: 'create', createdAt: entry.createdAt, before: null, after: presentNutritionEntry(entry) }]);
      const result = body.entries ? { entries: entries.map(presentNutritionEntry), replayed: false } : { entry: presentNutritionEntry(entries[0]), replayed: false };
      state.nutritionReplays.set(operationKey, result);
      if (body.entries && state.loseNextBatchReply) { state.loseNextBatchReply = false; return route.abort('connectionreset'); }
      return send(result, 201);
    }
    const item = /^\/api\/health\/nutrition\/([0-9a-f-]+)(?:\/(history|restore))?$/.exec(url.pathname);
    if (item) {
      const entry = state.entries.find((value) => value.id === item[1]);
      if (!entry) return fail('合成记录不存在。', 'NUTRITION_NOT_FOUND', 404);
      if (item[2] === 'history') return send({ entryId: entry.id, history: state.histories.get(entry.id) ?? [] });
      if (method === 'GET') return send({ entry: presentNutritionEntry(entry) });
      const before = presentNutritionEntry(entry);
      const restored = item[2] === 'restore' ? state.histories.get(entry.id).find((event) => event.revision === body.revision)?.after : null;
      if (item[2] === 'restore' && !restored) return fail('合成历史版本不存在。', 'NUTRITION_HISTORY_NOT_FOUND', 404);
      if (restored) {
        // Restore the recorded values, not a fresh create request/catalog lookup.
        // History is an API view; storage keeps normalized tenths and snapshots.
        const { calories, carbs, protein, fat, deleted, ...snapshot } = structuredClone(restored);
        delete entry.food;
        delete entry.provenance;
        Object.assign(entry, snapshot, { id: entry.id, createdAt: before.createdAt,
          revision: before.revision + 1, updatedAt: stamp(),
          carbsTenth: snapshot.carbsTenth ?? null, proteinTenth: snapshot.proteinTenth ?? null, fatTenth: snapshot.fatTenth ?? null });
      } else Object.assign(entry, makeEntry({ ...before, ...body }, entry.id, entry.revision + 1));
      state.histories.get(entry.id).push({ revision: entry.revision, action: restored ? 'restore' : 'edit', createdAt: stamp(), before, after: presentNutritionEntry(entry) });
      return send({ entry: presentNutritionEntry(entry) });
    }
    if (url.pathname === '/api/finance') {
      const ledger = url.searchParams.get('ledger') ?? 'personal';
      return send({ accounts: state.accounts.filter((account) => account.ledger === ledger), summary: buildFinanceSummary(state.accounts, ledger), meta: { today: DAY, accountTypes: ACCOUNT_TYPES, currencies: CURRENCIES } });
    }
    const finance = /^\/api\/finance\/accounts\/([0-9a-f-]+)$/.exec(url.pathname);
    if (finance) {
      const account = state.accounts.find((value) => value.id === finance[1]);
      if (!account) return fail('合成账户不存在。', 'FINANCE_NOT_FOUND', 404);
      if (method === 'PATCH') {
        if (state.rejectNextAccountEdit) { state.rejectNextAccountEdit = false; account.metadataRevision++; return fail('其他页面已更新账户，请读取最新内容。', 'FINANCE_METADATA_CONFLICT'); }
        Object.assign(account, body, { metadataRevision: account.metadataRevision + 1 });
        delete account.expectedRevision;
      }
      return send({ account, balances: [{ id: 'initial:' + account.id, amountMinor: account.balanceMinor, asOfDate: account.asOfDate, note: '', createdAt: account.createdAt }] });
    }
    if (url.pathname === '/api/finance/goals') return send({ ledger: 'personal', currency: 'CNY', today: DAY, goals: [], accounts: state.accounts });
    if (url.pathname === '/api/health/goals') return send({ targets: { steps: 6000, sleep: 8, active_energy: 400 }, revision: 0, history: [] });
    if (url.pathname.startsWith('/api/health/assistant')) return send({ configuration: { ready: false, message: '合成验收不连接模型' }, hasData: false, context: { health: [], nutrition: { days: [] } }, sources: [] });
    return fail('Browser fixture has no handler for ' + method + ' ' + url.pathname, 'UNEXPECTED_SYNTHETIC_API', 501);
  });
}
