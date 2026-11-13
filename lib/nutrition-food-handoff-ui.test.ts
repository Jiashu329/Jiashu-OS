import assert from 'node:assert/strict';
import test from 'node:test';
import { parseHTML } from 'linkedom';
import { installNutritionFoodHandoff } from './nutrition-food-handoff-ui.ts';
import { getFood } from './food-catalog.ts';

const food = getFood('mcd-cn:49:28')!;
function fixture() {
  const { document } = parseHTML('<section id="notice" hidden><span id="message"></span><button id="retry"></button><button id="resume"></button></section>');
  let ready = false, blocked: string | null = null, consumed = 0, restored = 0, requests = 0;
  let respond: () => Promise<{ food?: typeof food }> = async () => ({ food });
  const opened: typeof food[] = [];
  const notice = document.getElementById('notice')!, message = document.getElementById('message')!;
  const retry = document.getElementById('retry')! as unknown as HTMLButtonElement, resume = document.getElementById('resume')! as unknown as HTMLButtonElement;
  const controller = installNutritionFoodHandoff({ id: food.id, notice, message, retry, resume,
    ready: () => ready, blocked: () => blocked,
    async request(id) { assert.equal(id, food.id); requests++; return respond(); },
    consume() { consumed++; }, open(selected) { opened.push(selected); }, restore() { restored++; } });
  return { notice, message, retry, resume, controller, opened, setReady(value: boolean) { ready = value; }, setBlocked(value: string | null) { blocked = value; },
    setResponse(value: typeof respond) { respond = value; }, get consumed() { return consumed; }, get requests() { return requests; }, get restored() { return restored; } };
}
const settled = async () => { for (let count = 0; count < 4; count++) await new Promise<void>((resolve) => setImmediate(resolve)); };

test('food handoff waits for ready data, consumes the URL once, and only prepares a confirmation', async () => {
  const app = fixture(); app.controller.offerOnce(); await settled(); assert.equal(app.requests, 0);
  app.setReady(true); app.controller.offerOnce(); app.controller.offerOnce(); await settled();
  assert.equal(app.requests, 1); assert.equal(app.consumed, 1); assert.equal(app.opened[0].id, food.id); assert.equal(app.notice.hidden, true);
  app.retry.click(); app.controller.offerOnce(); await settled(); assert.equal(app.requests, 1);
});

test('a saved or pending draft keeps its content and has an explicit restore action', async () => {
  const app = fixture(); app.setReady(true); app.setBlocked('请先恢复原草稿。'); app.controller.offerOnce(); await settled();
  assert.equal(app.requests, 0); assert.equal(app.opened.length, 0); assert.equal(app.resume.hidden, false); assert.match(app.message.textContent!, /保留/);
  app.resume.click(); assert.equal(app.restored, 1); app.setBlocked(null); app.retry.click(); await settled();
  assert.equal(app.opened.length, 1); assert.equal(app.consumed, 1);
});

test('an edit started while lookup is in flight prevents the response from overwriting it', async () => {
  const app = fixture(); let finish!: (value: { food: typeof food }) => void;
  app.setResponse(() => new Promise((resolve) => { finish = resolve; })); app.setReady(true); app.controller.offerOnce(); await settled();
  app.setBlocked('当前已有食物草稿。'); finish({ food }); await settled();
  assert.equal(app.opened.length, 0); assert.equal(app.resume.hidden, false); assert.match(app.message.textContent!, /不会覆盖/);
});

test('a lookup failure is visible and can be retried without automatically creating anything', async () => {
  const app = fixture(); app.setReady(true); app.setResponse(async () => { throw new Error('登录账号已变化，请刷新。'); });
  app.controller.offerOnce(); await settled(); assert.equal(app.opened.length, 0); assert.match(app.message.textContent!, /账号已变化/); assert.equal(app.retry.disabled, false);
  app.setResponse(async () => ({ food })); app.retry.click(); await settled(); assert.equal(app.requests, 2); assert.equal(app.opened.length, 1);
});

test('an unavailable or mismatched food never reaches the confirmation form', async () => {
  const app = fixture(); app.setReady(true); app.setResponse(async () => ({ food: { ...food, id: 'unavailable' } }));
  app.controller.offerOnce(); await settled(); assert.equal(app.opened.length, 0); assert.match(app.message.textContent!, /当前食物库/);
});
