import { NUTRIENT_KEYS, NUTRIENT_LABELS, nutrientDecimal, type NutrientKey, type NutritionNutrients } from './nutrition-nutrients.ts';
import { NutritionValidationError } from './nutrition.ts';

export type NutritionGoalTargets = Record<NutrientKey, string | null>;
export interface NutritionGoals extends NutritionGoalTargets { revision: number; createdAt: string | null; updatedAt: string | null }
export interface NutritionGoalsCommand { targets: NutritionGoalTargets; expectedRevision: number }
export const EMPTY_NUTRITION_GOALS: NutritionGoals = { calories: null, carbs: null, protein: null, fat: null, revision: 0, createdAt: null, updatedAt: null };

function invalid(path: string, message: string): never { throw new NutritionValidationError([{ path, message }]); }
export function parseNutritionGoals(input: unknown): NutritionGoalsCommand {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return invalid('$', '请提交完整的饮食目标。');
  const raw = input as Record<string, unknown>;
  if (Object.keys(raw).some((key) => ![...NUTRIENT_KEYS, 'expectedRevision'].includes(key))) return invalid('$', '饮食目标含不支持的字段。');
  if (!Number.isSafeInteger(raw.expectedRevision) || Number(raw.expectedRevision) < 0) return invalid('expectedRevision', '请先读取最新饮食目标。');
  const targets = Object.fromEntries(NUTRIENT_KEYS.map((key) => {
    const value = raw[key];
    if (value === null || (typeof value === 'string' && !value.trim())) return [key, null];
    if (typeof value !== 'string' || value.length > 128 || !/^\d+(?:\.\d)?$/.test(value.trim()) || /[\u0000-\u001f\u007f]/.test(value)) return invalid(key, NUTRIENT_LABELS[key] + '目标需为非负数，最多1位小数；不设置时留空。');
    const [whole, fraction = '0'] = value.trim().split('.');
    const tenth = BigInt(whole + fraction);
    if (tenth > BigInt(200000)) return invalid(key, NUTRIENT_LABELS[key] + '目标不能超过20000。');
    return [key, nutrientDecimal(tenth)];
  })) as NutritionGoalTargets;
  return { targets, expectedRevision: Number(raw.expectedRevision) };
}

export function nutritionGoalProgress(nutrients: NutritionNutrients, goals: NutritionGoalTargets) {
  return Object.fromEntries(NUTRIENT_KEYS.map((key) => {
    const current = nutrients[key], target = goals[key];
    const currentTenth = current.total === null ? null : BigInt(current.total.replace('.', ''));
    const targetTenth = target === null ? null : BigInt(target.replace('.', ''));
    const remaining = currentTenth === null || targetTenth === null ? null : targetTenth - currentTenth;
    return [key, { ...current, target, remaining: remaining === null ? null : nutrientDecimal(remaining < BigInt(0) ? BigInt(0) : remaining),
      percent: currentTenth === null || targetTenth === null || targetTenth === BigInt(0) ? null : Number(currentTenth * BigInt(1000) / targetTenth) / 10,
      partial: current.unknownCount > 0 }];
  }));
}
