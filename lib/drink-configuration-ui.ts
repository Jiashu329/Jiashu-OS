import { createDrinkConfigurationRuntime, drinkConfiguration, resolveDrinkConfiguration, type DrinkConfigurationFood, type DrinkSelection, type ResolvedDrinkConfiguration } from './drink-configuration.ts';

export const DRINK_CONFIGURATION_CSS = String.raw`
.drink-configuration{margin:16px 0;padding:14px;border:1px solid var(--line);border-radius:9px;background:var(--subtle)}
.drink-configuration h3{margin:0 0 10px;font-size:13px;font-weight:600}.drink-configuration-fields{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}
.drink-configuration label{display:grid;gap:5px;font-size:12px;color:var(--muted)}.drink-configuration select{min-width:0;min-height:40px;padding:8px;border:1px solid var(--line);border-radius:7px;background:var(--paper);font:inherit;color:var(--ink)}
.drink-configuration p{margin:10px 0 0;font-size:12px;line-height:1.8;color:var(--muted);overflow-wrap:anywhere}.drink-configuration [data-drink-message]{color:var(--primary-hover)}
@media(max-width:420px){.drink-configuration-fields{grid-template-columns:1fr}.drink-configuration select{font-size:16px}}
`;
const escape = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!));

export function renderDrinkConfigurationSection(food: DrinkConfigurationFood, selected?: DrinkSelection): string {
  const model = drinkConfiguration(food);
  if (!model.supported) return '';
  const selection = selected ?? model.defaults, result = resolveDrinkConfiguration(food, selection);
  const labels = { cup: '杯型', temperature: '冰热', sweetness: '糖度' };
  return '<section class="drink-configuration" data-drink-configuration aria-label="饮品配置"><h3>核对饮品配置</h3><div class="drink-configuration-fields">'
    + (['cup', 'temperature', 'sweetness'] as const).map((field) => '<label>' + labels[field] + '<select data-drink-field="' + field + '" aria-label="' + labels[field] + '">'
      + model.options[field].map((option) => '<option value="' + escape(option) + '"' + (selection[field] === option ? ' selected' : '') + '>' + escape(option || '未选择') + '</option>').join('') + '</select></label>').join('')
    + '</div><p data-drink-official>官网配置：' + escape(model.label || '未注明完整固定配置') + '</p><p data-drink-selected>所选配置：' + escape(result.label) + '</p><p data-drink-message role="status" aria-live="polite">' + escape(result.note) + '</p></section>';
}

export interface InstallDrinkConfigurationOptions {
  container: HTMLElement;
  food: DrinkConfigurationFood;
  selection?: DrinkSelection;
  onChange: (result: ResolvedDrinkConfiguration) => void;
}

/** Accept the self-contained runtime explicitly when embedding this installer in raw client HTML. */
export function installDrinkConfiguration(options: InstallDrinkConfigurationOptions, runtime = createDrinkConfigurationRuntime()) {
  const root = options.container.querySelector('[data-drink-configuration]') as HTMLElement | null;
  if (!root) return { refresh() {}, destroy() {} };
  const fields = ['cup', 'temperature', 'sweetness'] as const;
  const controls = fields.map((field) => root.querySelector('[data-drink-field="' + field + '"]') as HTMLSelectElement | null);
  const listeners: Array<() => void> = [];
  const refresh = () => {
    const selection = Object.fromEntries(fields.map((field, index) => [field, controls[index]?.value ?? ''])) as unknown as DrinkSelection;
    const result = runtime.resolve(options.food, selection);
    const selected = root.querySelector('[data-drink-selected]'), message = root.querySelector('[data-drink-message]');
    if (selected) selected.textContent = '所选配置：' + result.label;
    if (message) message.textContent = result.note;
    options.onChange(result);
  };
  for (const control of controls) {
    if (!control) continue;
    const changed = () => refresh();
    control.addEventListener('change', changed);
    listeners.push(() => control.removeEventListener('change', changed));
  }
  if (options.selection) for (let index = 0; index < fields.length; index++) if (controls[index]) controls[index]!.value = options.selection[fields[index]];
  return { refresh, destroy() { for (const remove of listeners) remove(); } };
}
