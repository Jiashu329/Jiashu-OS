import type { FoodItem } from './food-catalog.ts';

interface FoodHandoffOptions {
  id: string | null;
  notice: HTMLElement;
  message: HTMLElement;
  retry: HTMLButtonElement;
  resume: HTMLButtonElement;
  ready: () => boolean;
  blocked: () => string | null;
  request: (id: string) => Promise<{ food?: FoodItem }>;
  consume: () => void;
  open: (food: FoodItem) => void;
  restore: () => void;
}

/** The library only prepares a confirmation form; it never saves a record. */
export function installNutritionFoodHandoff(options: FoodHandoffOptions) {
  let attempted = false, consumed = false, loading = false, completed = false;
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
    show('正在读取所选食物的官方份量…');
    options.retry.hidden = true;
    try {
      const result = await options.request(options.id);
      if (!options.ready()) { show('当前记录尚未读取完成，请稍后重试。'); return; }
      const currentBlock = options.blocked();
      if (currentBlock) { show(currentBlock + ' 所选食物尚未填入，不会覆盖原内容。', true); return; }
      const food = result.food;
      if (!food || food.id !== options.id || food.basis !== 'perServing' || food.serving?.unit !== '份'
        || typeof food.catalogRelease !== 'string' || !food.catalogRelease || !Number.isFinite(food.serving.kcal)
        || food.serving.kcal < 0 || typeof food.name !== 'string') throw new Error('这项食物已不在当前食物库，请返回食物库重新选择。');
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
