import type { NutritionEntry } from './nutrition.ts';

export const NUTRIENT_KEYS = ['calories', 'carbs', 'protein', 'fat'] as const;
export type NutrientKey = (typeof NUTRIENT_KEYS)[number];
export interface NutritionNutrientTotal { total: string | null; knownCount: number; unknownCount: number }
export type NutritionNutrients = Record<NutrientKey, NutritionNutrientTotal>;
export const NUTRIENT_LABELS = { calories: '热量', carbs: '碳水化合物', protein: '蛋白质', fat: '脂肪' } as const;

export function nutrientDecimal(tenth: number | bigint): string {
  const digits = String(tenth).padStart(2, '0');
  return digits.slice(0, -1) + '.' + digits.slice(-1);
}

/** Sum only observed values. A missing nutrient never becomes a real zero. */
export function summarizeNutrients(entries: readonly NutritionEntry[]): NutritionNutrients {
  const active = entries.filter((entry) => entry.deletedAt === null);
  return Object.fromEntries(NUTRIENT_KEYS.map((key) => {
    const field = `${key}Tenth` as 'caloriesTenth' | 'carbsTenth' | 'proteinTenth' | 'fatTenth';
    let total = BigInt(0), knownCount = 0;
    for (const entry of active) {
      const value = entry[field];
      if (value === undefined || value === null) continue;
      if (!Number.isSafeInteger(value) || value < 0 || value > 200000) throw new Error('Invalid stored nutrition nutrient');
      total += BigInt(value); knownCount++;
    }
    return [key, { total: knownCount ? nutrientDecimal(total) : null, knownCount, unknownCount: active.length - knownCount }];
  })) as NutritionNutrients;
}
