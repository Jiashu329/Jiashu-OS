import type { LibraryFood } from './food-library-catalog.ts';
import type { NutritionTemplate } from './nutrition-templates.ts';

interface FoodHandoffOptions {
  id: string | null;
  templateId?: string | null;
  templateRevision?: number | null;
  invalid?: boolean;
  notice: HTMLElement;
  message: HTMLElement;
  retry: HTMLButtonElement;
  resume: HTMLButtonElement;
  ready: () => boolean;
  blocked: () => string | null;
  request: (id: string) => Promise<{ food?: LibraryFood }>;
  requestTemplate?: (id: string) => Promise<{ template?: NutritionTemplate }>;
  consume: () => void;
  open: (food: LibraryFood) => void;
  openTemplate?: (template: NutritionTemplate) => void;
  restore: () => void;
}

/** Library selection prepares an explicit confirmation; it never writes records. */
export function installNutritionFoodHandoff(options: FoodHandoffOptions) {
  let attempted = false, consumed = false, loading = false, completed = false;
  const validFood = (food: LibraryFood | undefined): food is LibraryFood => {
    if (!food || food.id !== options.id || typeof food.name !== 'string' || !food.name || food.name.length > 100) return false;
    if (food.basis === 'catalogOnly' || food.basis === 'managed') {
      const managed = food.basis === 'managed';
      if (!(managed ? /^managed:[0-9a-f-]{36}:\d+$/.test(food.id) : /^luckin-cn:\d+$/.test(food.id))
        || !food.source || typeof food.source.name !== 'string' || typeof food.source.url !== 'string'
        || (!managed && !/^https:\/\/lkcoffee\.com\//.test(food.source.url))
        || (managed && food.source.url !== '' && !/^https:\/\//.test(food.source.url))
        || typeof food.source.version !== 'string' || !food.reference || typeof food.reference !== 'object'
        || !(food.reference.label === null || typeof food.reference.label === 'string' && food.reference.label.length <= 100)) return false;
      const reference = food.reference as unknown as Record<string, unknown>;
      return ['calories', 'protein', 'fat', 'carbs', 'caffeineMg'].every((key) => {
        const value = reference[key];
        return value === undefined || value === null || typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 20000;
      });
    }
    return food.basis === 'perServing' && food.serving?.unit === '份'
      && typeof food.catalogRelease === 'string' && Boolean(food.catalogRelease)
      && Number.isFinite(food.serving.kcal) && food.serving.kcal >= 0
      && (food.serving.energyKj === null ? food.serving.energyBasis === 'officialKcal'
        : Number.isFinite(food.serving.energyKj) && food.serving.energyKj >= 0);
  };
  const show = (message: string, restore = false) => {
    options.notice.hidden = false;
    options.message.textContent = message;
    options.retry.hidden = false;
    options.retry.disabled = loading;
    options.retry.textContent = restore ? '处理后继续选择' : '重试选择';
    options.resume.hidden = !restore;
  };
  async function offer() {
    if ((!options.id && !options.templateId) || loading || completed || !options.ready()) return;
    if (!consumed) { options.consume(); consumed = true; }
    const blocked = options.blocked();
    if (blocked) { show(blocked + ' 已保留从食物库选中的内容，处理后可继续选择。', true); return; }
    loading = true; show('正在读取所选食物信息…'); options.retry.hidden = true;
    try {
      if (options.invalid) throw new Error('所选食物或饮品配置参数不完整，请返回食物库重新选择。');
      const templateMode = Boolean(options.templateId);
      const result = templateMode ? await options.requestTemplate!(options.templateId!) : await options.request(options.id!);
      if (!options.ready()) { show('当前记录尚未读取完成，请稍后重试。'); return; }
      const currentBlock = options.blocked();
      if (currentBlock) { show(currentBlock + ' 所选内容尚未填入，不会覆盖原内容。', true); return; }
      if (templateMode) {
        const template = (result as { template?: NutritionTemplate }).template;
        if (!template || template.id !== options.templateId || template.revision !== options.templateRevision || template.archivedAt
          || !['food', 'recipe', 'meal'].includes(template.kind) || typeof template.name !== 'string' || !Array.isArray(template.components)
          || !options.openTemplate) throw new Error('此个人模板已更新、归档或无法读取，请返回我的食物重新选择。');
        options.openTemplate(template);
      } else {
        const food = (result as { food?: LibraryFood }).food;
        if (!validFood(food)) throw new Error('这项食物已不在当前食物库，请返回食物库重新选择。');
        options.open(food);
      }
      completed = true; options.notice.hidden = true;
    } catch (error) { show((error as Error)?.message || '食物暂时无法读取，请重试。'); }
    finally { loading = false; options.retry.disabled = false; }
  }
  options.retry.addEventListener('click', () => { void offer(); });
  options.resume.addEventListener('click', () => options.restore());
  return { offerOnce() { if (!attempted && options.ready()) { attempted = true; void offer(); } } };
}
