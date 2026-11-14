import { previewNutritionTemplate, type NutritionTemplate } from './nutrition-templates.ts';
import { shanghaiDay } from './health.ts';
import type { FoodSource } from './food-catalog.ts';

export interface PersonalLibraryFood {
  basis: 'template'; id: string; templateId: string; revision: number;
  kind: 'food' | 'recipe' | 'meal'; name: string; aliases: string[]; category: string;
  state: string; description?: string; source: FoodSource;
  brand: { id: 'mine'; name: string };
  reference: { label: string; calories: number | null; protein?: number; fat?: number; carbs?: number };
}
const categories = { food: '自建食物', recipe: '食谱', meal: '整餐' } as const;

/** Personal summaries use the same scaling and unknown-value rules as template use. */
export function personalLibraryFood(template: NutritionTemplate, now = new Date().toISOString()): PersonalLibraryFood {
  const reference: PersonalLibraryFood['reference'] = { label: '1份', calories: null };
  let note = template.note;
  try {
    const preview = previewNutritionTemplate(template, { mode: 'servings', amount: '1', date: shanghaiDay(now), meal: 'snack', expectedRevision: template.revision });
    for (const key of ['calories', 'protein', 'fat', 'carbs'] as const) {
      const nutrient = preview.nutrients[key];
      if (!nutrient.unknownCount && nutrient.total !== null) reference[key] = Number(nutrient.total);
    }
  } catch {
    note = [note, '此模板的每份预览暂不可用，请在使用时核对份数。'].filter(Boolean).join('\n');
  }
  return { basis: 'template', id: `template:${template.id}:${template.revision}`, templateId: template.id, revision: template.revision,
    kind: template.kind, name: template.name, aliases: [], category: categories[template.kind], state: '仅自己可见',
    description: note, brand: { id: 'mine', name: '我的食物' }, reference,
    source: { name: '我的食物', url: '', recordId: template.id, version: '版本' + template.revision } };
}
