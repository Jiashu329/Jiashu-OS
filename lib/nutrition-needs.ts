import { NutritionValidationError } from './nutrition.ts';

export type NutritionNeedsSex = 'male' | 'female';
export type NutritionNeedsActivity = 'sedentary' | 'light' | 'moderate' | 'active' | 'veryActive';
export type NutritionNeedsGoal = 'maintain' | 'lose' | 'gain';
export interface NutritionNeedsInput {
  age: number;
  heightCm: number;
  weightKg: number;
  /** Equation coefficient selected by the user; never inferred from their account. */
  sex: NutritionNeedsSex;
  activity: NutritionNeedsActivity;
  goal: NutritionNeedsGoal;
}
export interface NutritionNeedsEstimate {
  /** Rounded resting energy expenditure (REE), exposed as bmr for the client contract. */
  bmr: number;
  maintenanceCalories: number;
  targets: { calories: string; carbs: string; protein: string; fat: string };
  bmi: number;
  activityMultiplier: number;
  goalAdjustmentPercent: number;
  effectiveAdjustmentPercent: number;
  macroEnergyPercent: { carbs: 50; protein: 20; fat: 30 };
  minimumCalories: number;
  floorApplied: boolean;
  method: 'mifflin-st-jeor-rounded';
  warnings: string[];
  sources: Array<{ title: string; url: string }>;
}

// These activity multipliers and goal adjustments are product estimation choices,
// not coefficients published in the Mifflin paper or measured energy expenditure.
const ACTIVITY_MULTIPLIERS: Record<NutritionNeedsActivity, number> = {
  sedentary: 1.2, light: 1.375, moderate: 1.55, active: 1.725, veryActive: 1.9,
};
const GOAL_ADJUSTMENTS: Record<NutritionNeedsGoal, number> = { maintain: 0, lose: -10, gain: 5 };
const INPUT_FIELDS = ['age', 'heightCm', 'weightKg', 'sex', 'activity', 'goal'];
const SOURCES = [
  { title: 'Mifflin–St Jeor 原研究（含取整后的静息代谢公式）', url: 'https://pubmed.ncbi.nlm.nih.gov/2305711/' },
  { title: 'National Academies：膳食营养素参考摄入量与宏量营养素供能范围', url: 'https://nap.nationalacademies.org/catalog/10490/' },
  { title: 'NIDDK：Body Weight Planner 的适用范围与低摄入限制', url: 'https://www.niddk.nih.gov/bwp' },
];

function invalid(path: string, message: string): never {
  throw new NutritionValidationError([{ path, message }]);
}
function measurement(value: unknown, path: string, label: string, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum
    || !/^\d+(?:\.\d)?$/.test(String(value))) {
    return invalid(path, label + '需为 ' + minimum + '–' + maximum + ' 范围内的数字，最多1位小数。');
  }
  return value;
}

export function parseNutritionNeedsInput(input: unknown): NutritionNeedsInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)) {
    return invalid('$', '请填写完整的每日营养测算资料。');
  }
  const raw = input as Record<string, unknown>;
  if (Object.keys(raw).some((key) => !INPUT_FIELDS.includes(key))) return invalid('$', '每日营养测算含不支持的字段。');
  if (!Number.isSafeInteger(raw.age) || Number(raw.age) < 18 || Number(raw.age) > 80) {
    return invalid('age', '此测算适用于18–80岁一般成人，请填写整数年龄。');
  }
  const heightCm = measurement(raw.heightCm, 'heightCm', '身高（cm）', 120, 230);
  const weightKg = measurement(raw.weightKg, 'weightKg', '体重（kg）', 30, 250);
  if (raw.sex !== 'male' && raw.sex !== 'female') return invalid('sex', '请选择用于公式计算的男性或女性系数。');
  if (typeof raw.activity !== 'string' || !Object.hasOwn(ACTIVITY_MULTIPLIERS, raw.activity)) return invalid('activity', '请选择活动水平。');
  if (typeof raw.goal !== 'string' || !Object.hasOwn(GOAL_ADJUSTMENTS, raw.goal)) return invalid('goal', '请选择维持、减重或增重目标。');
  return { age: Number(raw.age), heightCm, weightKg, sex: raw.sex,
    activity: raw.activity as NutritionNeedsActivity, goal: raw.goal as NutritionNeedsGoal };
}

/**
 * Fixed, inspectable estimates. AI may explain this result; it cannot set its numbers.
 * The original paper explicitly gives the simplified, sex-specific equations used here:
 * REE = 10*kg + 6.25*cm - 5*age + (male ? 5 : -161).
 * Protein/carbohydrate/fat targets are a general 20/50/30 energy split, not a diagnosis
 * or a personalised DRI prescription. See docs/nutrition-needs.md for scope and sources.
 */
export function calculateNutritionNeeds(input: NutritionNeedsInput): NutritionNeedsEstimate {
  const profile = parseNutritionNeedsInput(input);
  const bmi = profile.weightKg / ((profile.heightCm / 100) ** 2);
  if (profile.goal === 'lose' && bmi < 18.5) {
    return invalid('goal', '当前身高体重估算的BMI低于18.5，此工具不提供减重目标；请先咨询专业人员确定适合的营养需求。');
  }
  const rawBmr = 10 * profile.weightKg + 6.25 * profile.heightCm - 5 * profile.age + (profile.sex === 'male' ? 5 : -161);
  const activityMultiplier = ACTIVITY_MULTIPLIERS[profile.activity];
  const rawMaintenance = rawBmr * activityMultiplier;
  // Conservative product guardrails, not individual biological minimum requirements.
  // Do not silently turn a maintain/lose choice into a gain recommendation.
  const minimumCalories = profile.sex === 'male' ? 1500 : 1200;
  if (rawMaintenance < minimumCalories) {
    return invalid('weightKg', '这组资料的维持热量估算低于本工具的适用下限（' + minimumCalories + ' kcal/天），请由专业人员评估；本工具不生成此组合的饮食目标。');
  }
  const goalAdjustmentPercent = GOAL_ADJUSTMENTS[profile.goal];
  const requestedCalories = rawMaintenance * (1 + goalAdjustmentPercent / 100);
  const lowerBound = Math.max(Math.ceil(rawBmr), minimumCalories);
  const floorApplied = requestedCalories < lowerBound;
  const targetCalories = Math.max(Math.round(requestedCalories), lowerBound);
  const warnings = ['活动系数是粗略估算，实际消耗会随日常活动、身体状况和记录误差变化。'];
  if (floorApplied) warnings.push('原目标低于本工具的摄入护栏，已缩小热量调整幅度；护栏不代表你个人的医学最低需求。');
  if (bmi < 18.5) warnings.push('当前身高体重估算的BMI低于18.5，建议先由专业人员评估营养需求。');
  if (profile.age === 18 || profile.age > 78) warnings.push('原公式研究样本为19–78岁；你的年龄位于该样本之外，结果仅供粗略参考。');
  return {
    bmr: Math.round(rawBmr), maintenanceCalories: Math.round(rawMaintenance),
    targets: {
      calories: targetCalories.toFixed(1),
      // Round exact rational tenths; avoid binary 0.05 ties rounding down in toFixed.
      carbs: (Math.round(targetCalories * 5 / 4) / 10).toFixed(1),
      protein: (Math.round(targetCalories / 2) / 10).toFixed(1),
      fat: (Math.round(targetCalories / 3) / 10).toFixed(1),
    },
    bmi: Math.round(bmi * 10) / 10, activityMultiplier, goalAdjustmentPercent,
    effectiveAdjustmentPercent: Math.round((targetCalories / rawMaintenance - 1) * 1000) / 10,
    macroEnergyPercent: { carbs: 50, protein: 20, fat: 30 }, minimumCalories, floorApplied,
    method: 'mifflin-st-jeor-rounded', warnings, sources: SOURCES.map((source) => ({ ...source })),
  };
}
