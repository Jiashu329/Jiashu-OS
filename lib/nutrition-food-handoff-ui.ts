import type { LibraryFood } from './food-library-catalog.ts';

interface FoodHandoffOptions {
  id: string | null;
  notice: HTMLElement;
  message: HTMLElement;
  retry: HTMLButtonElement;
  resume: HTMLButtonElement;
  ready: () => boolean;
  blocked: () => string | null;
  request: (id: string) => Promise<{ food?: LibraryFood }>;
  consume: () => void;
  open: (food: LibraryFood) => void;
  restore: () => void;
}

/** The library only prepares a confirmation form; it never saves a record. */
export function installNutritionFoodHandoff(options: FoodHandoffOptions) {
  let attempted = false, consumed = false, loading = false, completed = false;
  const validFood = (food: LibraryFood | undefined): food is LibraryFood => {
    if (!food || food.id !== options.id || typeof food.name !== 'string' || !food.name || food.name.length > 100) return false;
    if (food.basis === 'catalogOnly') {
      if (!/^luckin-cn:\d+$/.test(food.id) || !food.source || typeof food.source.name !== 'string'
        || typeof food.source.url !== 'string' || !/^https:\/\/lkcoffee\.com\//.test(food.source.url)
        || typeof food.source.version !== 'string' || !food.reference || typeof food.reference !== 'object'
        || !(food.reference.label === null || typeof food.reference.label === 'string' && food.reference.label.length <= 100)) return false;
      return ['protein', 'fat', 'carbs', 'caffeineMg'].every((key) => {
        const value = (food.reference as Record<string, unknown>)[key];
        return value === undefined || typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 20000;
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
    if (!options.id || loading || completed || !options.ready()) return;
    if (!consumed) { options.consume(); consumed = true; }
    const blocked = options.blocked();
    if (blocked) { show(blocked + ' 已保留从食物库选中的食物，处理后可继续选择。', true); return; }
    loading = true;
    show('正在读取所选食物的官方信息…');
    options.retry.hidden = true;
    try {
      const result = await options.request(options.id);
      if (!options.ready()) { show('当前记录尚未读取完成，请稍后重试。'); return; }
      const currentBlock = options.blocked();
      if (currentBlock) { show(currentBlock + ' 所选食物尚未填入，不会覆盖原内容。', true); return; }
      const food = result.food;
      if (!validFood(food)) throw new Error('这项食物已不在当前食物库，请返回食物库重新选择。');
      options.open(food);
      completed = true;
      options.notice.hidden = true;
    } catch (error) {
      show((error as Error)?.message || '食物暂时无法读取，请重试。');
    } finally {
      loading = false;
      options.retry.disabled = false;
    }
  }
  options.retry.addEventListener('click', () => { void offer(); });
  options.resume.addEventListener('click', () => options.restore());
  return { offerOnce() { if (!attempted && options.ready()) { attempted = true; void offer(); } } };
}
