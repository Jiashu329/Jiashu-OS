/** A structural input keeps configuration choices independent from catalog storage. */
export interface DrinkConfigurationFood {
  id: string;
  basis?: string;
  serving?: { label: string; kcal?: number };
  reference?: { label: string | null };
}
export interface DrinkSelection { cup: string; temperature: string; sweetness: string }
export interface DrinkConfigurationModel {
  supported: boolean;
  defaults: DrinkSelection;
  options: Record<keyof DrinkSelection, string[]>;
  label: string | null;
  fixedTokens: string[];
  completeOfficial: boolean;
}
export interface ResolvedDrinkConfiguration {
  matchesOfficial: boolean;
  nutritionAvailable: boolean;
  selection: DrinkSelection;
  label: string;
  note: string;
}

/** Self-contained so the exact same rules can be serialized into the browser. */
export function createDrinkConfigurationRuntime() {
  const fields = ['cup', 'temperature', 'sweetness'] as const;
  const names = { cup: '杯型', temperature: '冰热', sweetness: '糖度' };
  const common = {
    cup: ['中杯', '大杯', '超大杯'],
    temperature: ['冰', '热', '温', '少冰', '去冰', '全冰去水'],
    sweetness: ['不另外加糖', '无糖', '微甜', '少糖', '半糖', '标准糖', '全糖'],
  };
  const patterns = {
    cup: /^(?:小杯|中杯|大杯|超大杯|\d+(?:\.\d+)?(?:oz|OZ|ml|mL|毫升))$/,
    temperature: /^(?:冰|热|温|去冰|少冰|标准冰|正常冰|全冰去水)$/,
    sweetness: /^(?:不另外加糖|无糖|少糖|半糖|微甜|标准糖|全糖|正常糖|多糖|三分糖|七分糖)$/,
  };
  const empty = (): DrinkSelection => ({ cup: '', temperature: '', sweetness: '' });
  function model(food: DrinkConfigurationFood): DrinkConfigurationModel {
    const supported = Boolean(food && typeof food.id === 'string' && /^luckin-cn:\d+$/.test(food.id));
    const raw = supported ? food.basis === 'perServing' ? food.serving?.label : food.reference?.label : null;
    const label = typeof raw === 'string' && raw.trim() && raw.length <= 200 && !/[\u0000-\u001f\u007f]/.test(raw) ? raw.trim() : null;
    const tokens = label ? label.split(/[\/／]/).map((token) => token.trim()).filter(Boolean) : [];
    const defaults = empty();
    const ambiguous = new Set<string>();
    for (const field of fields) {
      const values = [...new Set(tokens.filter((token) => patterns[field].test(token)))];
      if (values.length === 1) defaults[field] = values[0];
      else if (values.length > 1) ambiguous.add(field);
    }
    const options = Object.fromEntries(fields.map((field) => [field, [...new Set(['', ...(defaults[field] ? [defaults[field]] : []), ...common[field]])]])) as Record<keyof DrinkSelection, string[]>;
    return { supported, defaults, options, label,
      fixedTokens: tokens.filter((token) => !fields.some((field) => patterns[field].test(token))),
      completeOfficial: supported && fields.every((field) => Boolean(defaults[field])) && ambiguous.size === 0 };
  }
  function resolve(food: DrinkConfigurationFood, value: unknown): ResolvedDrinkConfiguration {
    const config = model(food);
    if (!config.supported) throw new Error('此餐品不支持饮品配置选择。');
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
      || Object.keys(value).length !== fields.length || fields.some((field) => !Object.hasOwn(value, field))) {
      throw new Error('请完整选择杯型、冰热和糖度。');
    }
    const raw = value as Record<string, unknown>, selection = empty();
    for (const field of fields) {
      const choice = raw[field];
      if (typeof choice !== 'string' || !config.options[field].includes(choice)) throw new Error('请选择有效的' + names[field] + '。');
      selection[field] = choice;
    }
    const matchesOfficial = config.completeOfficial && fields.every((field) => selection[field] === config.defaults[field]);
    const seen = new Set<string>();
    const tokens = config.label ? config.label.split(/[\/／]/).map((token) => token.trim()).filter(Boolean) : [];
    const result = tokens.map((token) => {
      const field = fields.find((key) => patterns[key].test(token));
      if (!field) return token;
      if (seen.has(field)) return '';
      seen.add(field);
      return selection[field] || names[field] + '未选择';
    }).filter(Boolean);
    for (const field of fields) if (!seen.has(field)) result.push(selection[field] || names[field] + '未选择');
    const nutritionAvailable = matchesOfficial && food.basis === 'perServing'
      && typeof food.serving?.kcal === 'number' && Number.isFinite(food.serving.kcal) && food.serving.kcal >= 0;
    const note = nutritionAvailable
      ? '与官网公布配置一致，可使用此配置的官方营养数据。'
      : !config.label || !config.completeOfficial
        ? '官网未注明完整固定配置，所选配置暂无官方营养；记录时请手工核对，未知值不会补零。'
        : matchesOfficial
          ? '配置与官网文字一致，但官网未公布此产品的热量；记录时请手工核对。'
          : '暂无此配置官方营养。更改杯型、冰热或糖度后，不套用原配置的热量和营养值。';
    return { matchesOfficial, nutritionAvailable, selection, label: result.join('/'), note };
  }
  function readQuery(food: DrinkConfigurationFood, params: URLSearchParams): DrinkSelection | null {
    if (!fields.some((field) => params.has(field))) return null;
    if (fields.some((field) => params.getAll(field).length !== 1)) throw new Error('饮品配置参数需完整且不能重复。');
    return resolve(food, Object.fromEntries(fields.map((field) => [field, params.get(field)]))).selection;
  }
  return { model, resolve, readQuery };
}

const runtime = createDrinkConfigurationRuntime();
export const drinkConfiguration = runtime.model;
export const resolveDrinkConfiguration = runtime.resolve;
export const readDrinkConfigurationQuery = runtime.readQuery;
