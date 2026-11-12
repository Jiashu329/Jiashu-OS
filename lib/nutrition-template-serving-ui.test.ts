import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { parseHTML } from 'linkedom';
import { NUTRITION_P1_SCRIPT } from './nutrition-p1-ui.ts';
import { NUTRITION_TEMPLATES_CONTENT, NUTRITION_TEMPLATES_DIALOGS, NUTRITION_TEMPLATES_PENDING, NUTRITION_TEMPLATES_SCRIPT } from './nutrition-templates-ui.ts';

const item = { id: 'official-serving', basis: 'perServing', grams: null, kcalPer100g: null, serving: { unit: '份', label: '标准份', originalLabel: null, kcal: 500, energyKj: 2092 }, catalogRelease: 'official-release' };
const record = { name: '官方每份食物', portion: '0.5份', calories: '250.0', carbs: null, protein: '10.0', fat: '0.0', foodItem: item,
  food: { foodId: item.id, catalogRelease: item.catalogRelease, amount: 0.5, unit: '份', grams: null }, provenance: { calories: { source: 'catalog' } } };
function fixture() {
  const { window, document } = parseHTML('<html><body>' + NUTRITION_TEMPLATES_CONTENT + NUTRITION_TEMPLATES_PENDING + NUTRITION_TEMPLATES_DIALOGS + '</body></html>');
  Object.defineProperty(window.HTMLSelectElement.prototype, 'value', { configurable: true, get() { return this.querySelector('option[selected]')?.getAttribute('value') ?? this.querySelector('option')?.getAttribute('value') ?? ''; }, set(value: string) { for (const option of this.querySelectorAll('option')) { if (option.getAttribute('value') === String(value)) option.setAttribute('selected', ''); else option.removeAttribute('selected'); } } });
  for (const dialog of document.querySelectorAll('dialog')) Object.assign(dialog, { showModal() { dialog.setAttribute('open', ''); }, close() { dialog.removeAttribute('open'); } });
  const defaults: unknown[][] = [];
  const context = { window, document, ownerId: 'synthetic-owner', state: { busy: false, date: '2026-11-10', form: null },
    el: (name: string) => document.getElementById('nutrition-' + name)!, defaultMeal: () => 'lunch', today: () => '2026-11-10',
    esc: (value: string | number | null | undefined) => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;'),
    foodAmount: () => ({ grams: null, calories: '250.0', protein: '10.0', carbs: null, fat: '0.0' }), setFormFoodBase: (...args: unknown[]) => defaults.push(args),
  };
  const api = runInNewContext(NUTRITION_P1_SCRIPT + NUTRITION_TEMPLATES_SCRIPT + '\n({templateComponent,templateOpenEditor,templateDefinition,templateUse,setFormFood})', context) as {
    templateComponent(value: unknown): { grams: string | null; food: { amount: number; unit: string }; [key: string]: unknown };
    templateOpenEditor(item: unknown, rows: unknown[]): void;
    templateDefinition(): { components: Array<{ grams: string | null }> };
    templateUse(value: unknown): void;
    setFormFood(food: unknown): void;
  };
  return { api, document, defaults };
}
void test('importing a per-serving record into a template keeps unknown grams empty in the rendered editor and payload', () => {
  const f = fixture(), component = f.api.templateComponent(record);
  assert.equal(component.grams, null);assert.equal(component.food.amount, 0.5);assert.equal(component.food.unit, '份');
  f.api.templateOpenEditor(null, [component]);
  const grams = f.document.querySelector('[data-template-field="grams"]') as unknown as HTMLInputElement;
  assert.equal(grams.value, '');assert.equal(f.api.templateDefinition().components[0].grams, null);
  assert.doesNotMatch(f.document.getElementById('nutrition-template-components')!.textContent!, /NaN|0g|nullg/);
  assert.match(f.document.getElementById('nutrition-template-components')!.textContent!, /重量未知可留空/);
});
void test('a template without declared yield weight disables grams mode, while an explicit user-measured yield enables it', () => {
  const f = fixture(), template = { id: 'template', name: '每份整餐', baseServings: '1', totalWeight: null };
  f.api.templateUse(template);
  const weight = f.document.querySelector('#nutrition-template-scale-mode [value="weight"]') as unknown as HTMLOptionElement;
  assert.equal(weight.disabled, true);assert.match(f.document.getElementById('nutrition-template-use-basis')!.textContent!, /暂不能按克重换算/);
  f.api.templateUse({ ...template, totalWeight: '200' });assert.equal(weight.disabled, false);
});
void test('the provenance wrapper delegates serving-aware defaults to the food editor without forcing 100g', () => {
  const f = fixture();f.api.setFormFood(item);
  assert.equal(f.defaults.length, 1);assert.equal(f.defaults[0][0], item);assert.equal(f.defaults[0][1], undefined);assert.equal(f.defaults[0][2], undefined);
});
