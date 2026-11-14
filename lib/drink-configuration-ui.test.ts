import assert from 'node:assert/strict';
import test from 'node:test';
import { parseHTML } from 'linkedom';
import luckin from '../data/food-catalog-releases/luckin-cn-2026-11-13-v1.json' with { type: 'json' };
import { createDrinkConfigurationRuntime, drinkConfiguration, type ResolvedDrinkConfiguration } from './drink-configuration.ts';
import { installDrinkConfiguration, renderDrinkConfigurationSection } from './drink-configuration-ui.ts';

const latte = luckin.foods.find((food) => food.id === 'luckin-cn:1')!;
function fixture() {
  const { window, document } = parseHTML('<main>' + renderDrinkConfigurationSection(latte) + '</main>');
  for (const select of document.querySelectorAll('select')) Object.defineProperty(select, 'value', {
    configurable: true,
    get() { return select.querySelector('option[selected]')?.getAttribute('value') ?? select.querySelector('option')?.getAttribute('value') ?? ''; },
    set(value: string) { for (const option of select.querySelectorAll('option')) { if (option.getAttribute('value') === value) option.setAttribute('selected', ''); else option.removeAttribute('selected'); } },
  });
  const changes: ResolvedDrinkConfiguration[] = [];
  const control = installDrinkConfiguration({ container: document.querySelector('main')! as unknown as HTMLElement, food: latte, onChange: (value) => changes.push(value) }, createDrinkConfigurationRuntime());
  return { window, document, changes, control };
}

test('configuration controls show the exact official defaults and emit only explicit user changes', () => {
  const app = fixture();
  assert.equal(app.changes.length, 0);
  for (const [key, value] of Object.entries(drinkConfiguration(latte).defaults)) assert.equal((app.document.querySelector('[data-drink-field="' + key + '"]') as unknown as HTMLSelectElement).value, value);
  assert.match(app.document.querySelector('[data-drink-official]')?.textContent ?? '', /埃塞金烘\/默认浓度/);
  const temperature = app.document.querySelector('[data-drink-field="temperature"]')! as unknown as HTMLSelectElement;
  temperature.value = '热'; temperature.dispatchEvent(new app.window.Event('change'));
  assert.equal(app.changes.length, 1); assert.equal(app.changes[0].nutritionAvailable, false);
  assert.match(app.document.querySelector('[data-drink-message]')?.textContent ?? '', /暂无此配置官方营养/);
  assert.match(app.document.querySelector('[data-drink-selected]')?.textContent ?? '', /大杯\/热\/埃塞金烘/);
  app.control.destroy(); temperature.value = '冰'; temperature.dispatchEvent(new app.window.Event('change'));
  assert.equal(app.changes.length, 1);
});

test('rendered selection and fixed configuration text are escaped and other brands receive no controls', () => {
  assert.equal(renderDrinkConfigurationSection({ id: 'mcd-cn:49:28' }), '');
  const html = renderDrinkConfigurationSection({ ...latte, serving: { ...latte.serving, label: '大杯/冰/不另外加糖/<img src=x onerror=bad()>' } });
  const { document } = parseHTML(html);
  assert.equal(document.querySelectorAll('img,script').length, 0);
  assert.match(document.querySelector('[data-drink-official]')?.textContent ?? '', /<img src=x onerror=bad\(\)>/);
  assert.equal(document.querySelectorAll('select').length, 3);
});
