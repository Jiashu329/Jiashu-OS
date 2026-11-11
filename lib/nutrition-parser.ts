import { searchFoods, calculateFoodSelection } from './food-catalog.ts';
import type { FoodItem } from './food-catalog.ts';
import { validAssistantText } from './health-assistant-chat.ts';
import { shanghaiDay } from './health.ts';

export type NutritionDraftMeal = 'breakfast' | 'lunch' | 'dinner' | 'snack';
export interface NutritionParserRequest {
  text: string;
  date: string;
  today: string;
  meal: NutritionDraftMeal | null;
}
export interface NutritionDraft {
  date: string;
  meal: NutritionDraftMeal | null;
  name: string;
  amount: number | null;
  unit: string | null;
  portion: string;
  calories: string | null;
  note: string;
  food: { id: string; amount: number; unit: string } | null;
  candidates: FoodItem[];
  warnings: string[];
}
export class NutritionParserError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(message = '饮食识别结果暂时无法核对，请换一种描述后重试。', status = 502) {
    super(message);
    this.name = 'NutritionParserError';
    this.status = status;
    this.code = status === 400 ? 'INVALID_NUTRITION_PARSE_REQUEST' : 'NUTRITION_PARSE_RESPONSE_INVALID';
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function validDay(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value < '1970-01-01' || value > '2100-12-31') return false;
  const time = Date.parse(value + 'T12:00:00Z');
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}
function validMeal(value: unknown): value is NutritionDraftMeal {
  return typeof value === 'string' && ['breakfast', 'lunch', 'dinner', 'snack'].includes(value);
}
export function parseNutritionParserRequest(raw: unknown, now: number | Date = Date.now()): NutritionParserRequest {
  if (!object(raw) || Object.keys(raw).some((key) => !['text', 'date', 'meal'].includes(key))) {
    throw new NutritionParserError('请提交饮食描述、记录日期和可选餐次。', 400);
  }
  if (!validAssistantText(raw.text, 2000)) throw new NutritionParserError('请用 1–2000 个字符描述吃了什么。', 400);
  const today = shanghaiDay(new Date(now).toISOString());
  if (!validDay(raw.date) || raw.date > today) throw new NutritionParserError('请选择有效且不晚于今天的记录日期。', 400);
  if (raw.meal !== undefined && raw.meal !== null && !validMeal(raw.meal)) {
    throw new NutritionParserError('请选择早餐、午餐、晚餐或加餐。', 400);
  }
  return { text: raw.text.trim(), date: raw.date, today, meal: validMeal(raw.meal) ? raw.meal : null };
}

function dateFromText(raw: unknown, request: NutritionParserRequest): string {
  if (raw === null) return request.date;
  if (typeof raw !== 'string' || raw.length > 20 || !raw.trim() || !request.text.includes(raw)) throw new NutritionParserError();
  const shifts: Record<string, number> = { 今天: 0, 今日: 0, 今早: 0, 今晨: 0, 今晚: 0,
    昨天: -1, 昨日: -1, 昨晚: -1, 昨夜: -1, 昨早: -1, 前天: -2, 明天: 1, 后天: 2 };
  let date = raw;
  if (Object.hasOwn(shifts, raw)) date = new Date(Date.parse(request.today + 'T12:00:00Z') + shifts[raw] * 86400000).toISOString().slice(0, 10);
  else {
    const partial = /^(\d{1,2})月(\d{1,2})日$/.exec(raw) ?? /^(\d{2})-(\d{2})$/.exec(raw);
    if (partial) date = request.today.slice(0, 4) + '-' + partial[1].padStart(2, '0') + '-' + partial[2].padStart(2, '0');
  }
  if (!validDay(date)) throw new NutritionParserError('识别出的日期无效，请在描述中使用明确的年月日。');
  if (date > request.today) throw new NutritionParserError('饮食记录日期不能晚于今天，请检查描述中的日期。', 400);
  return date;
}
const normalized = (value: string) => value.normalize('NFKC').toLocaleLowerCase('zh-CN').replace(/[\s·・，,、()（）]/g, '');
function compatiblePreparation(source: string, food: FoodItem): boolean {
  const description = [food.name, food.state, ...food.aliases].join(' ');
  // A model must not discard an explicitly stated cooking method and silently
  // match the remaining generic ingredient to its raw counterpart.
  const method = /煎|炸|炒|烤|蒸|炖|焖|燉|燜/.exec(source)?.[0];
  if (method && !description.includes(method)) return false;
  if (/(?:生米|生肉|生鸡|生魚|生鱼|生蛋|生鲜)/.test(source) && /熟制|熟食|水煮|清蒸/.test(description)) return false;
  if (/生鲜/.test(food.state) && /肉|蛋|米|面|魚|鱼|虾|蝦/.test(source) && !/生|鲜|新鮮/.test(source)) return false;
  if (/熟|水煮|煮熟/.test(source) && /生鲜/.test(food.state) && !/熟/.test(food.state)) return false;
  return true;
}
function boundedText(raw: unknown, maximum: number): raw is string {
  return typeof raw === 'string' && raw.trim().length > 0 && raw.length <= maximum
    && !/[\u0000-\u001f\u007f-\u009f]/.test(raw);
}

/** Untrusted model output is validated before food IDs or calories are assigned. */
export function buildNutritionDrafts(answer: string, request: NutritionParserRequest): { drafts: NutritionDraft[]; warnings: string[] } {
  if (typeof answer !== 'string' || answer.length > 10000) throw new NutritionParserError();
  let raw: unknown;
  try { raw = JSON.parse(answer); } catch { throw new NutritionParserError(); }
  if (!object(raw) || Object.keys(raw).length !== 1 || !Array.isArray(raw.items) || raw.items.length > 20) throw new NutritionParserError();
  if (!Object.hasOwn(raw, 'items')) throw new NutritionParserError();
  const drafts = raw.items.map((value): NutritionDraft => {
    if (!object(value) || Object.keys(value).length !== 6
      || Object.keys(value).some((key) => !['name', 'amount', 'unit', 'meal', 'dateText', 'sourceText'].includes(key))
      || !boundedText(value.name, 100) || !validAssistantText(value.sourceText, 500)
      || !request.text.includes(value.sourceText)
      || !(value.amount === null || (typeof value.amount === 'number' && Number.isFinite(value.amount) && value.amount > 0 && value.amount <= 100000))
      || !(value.unit === null || boundedText(value.unit, 20))
      || !(value.meal === null || validMeal(value.meal))) throw new NutritionParserError();
    const name = value.name.trim(), amount = value.amount as number | null, unit = typeof value.unit === 'string' ? value.unit.trim() : null;
    const date = dateFromText(value.dateText, request), meal = validMeal(value.meal) ? value.meal : request.meal;
    const candidates = searchFoods(name, 6);
    const exact = candidates.filter((food) => [food.name, ...food.aliases].some((alias) => normalized(alias) === normalized(name))
      && compatiblePreparation(value.sourceText as string, food));
    const warnings: string[] = [];
    let food: NutritionDraft['food'] = null, calories: string | null = null, portion = amount === null ? '份量待补充' : String(amount) + (unit ?? '（单位待补充）');
    if (!meal) warnings.push('请选择这项食物的餐次。');
    if (!candidates.length) warnings.push('食物库暂未找到匹配项，可搜索其他名称或手工填写，热量保持未知。');
    else if (exact.length !== 1) warnings.push('食物或生熟、烹饪方式尚需核对，请从候选中选择。');
    if (amount === null || unit === null) warnings.push('份量或单位不明确，请补充实际重量或数量。');
    else if (exact.length === 1) {
      try {
        const selection = { id: exact[0].id, amount, unit };
        const calculated = calculateFoodSelection(selection);
        if (!Number.isSafeInteger(calculated.caloriesTenth) || calculated.caloriesTenth < 0 || calculated.caloriesTenth > 200000) throw new Error('Invalid calorie amount');
        food = selection;
        calories = (calculated.caloriesTenth / 10).toFixed(1);
        portion = String(amount) + unit + (unit === 'g' || unit === '克' || unit === '公克' ? '' : '（' + calculated.grams + 'g）');
        if (calculated.estimated) warnings.push('份量换算使用食物库参考重量，请核对实际份量。');
      } catch {
        warnings.push('这个单位没有可核对的重量换算，请改填克重；热量暂未计算。');
      }
    }
    return { date, meal, name: food ? exact[0].name : name, amount, unit, portion, calories, note: '', food, candidates, warnings };
  });
  return { drafts, warnings: drafts.length ? ['以下是识别草稿，检查食物、生熟状态与份量后可批量保存。'] : ['未识别到明确吃过的食物，请描述实际吃了什么及份量。'] };
}
