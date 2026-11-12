import { parseNutritionTemplate, parseNutritionTemplateEdit, parseNutritionTemplatePreview, parseNutritionTemplateRevision, previewNutritionTemplate } from '../../lib/nutrition-templates.ts';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const clone = (value) => structuredClone(value);

/** Uses production parsing and scaling without accessing a database or a model. */
export async function handleSyntheticNutritionTemplates({ route, state, url, method, body, key, send, fail }) {
  const match = /^\/api\/health\/nutrition\/templates(?:\/([0-9a-f-]+)(?:\/(preview))?)?$/.exec(url.pathname);
  if (!match) return false;
  state.templates ??= [];
  state.templateReplays ??= new Map();
  const id = match[1], item = id ? state.templates.find((row) => row.id === id) : null;
  try {
    if (method === 'GET') {
      if (id && !item) await fail('合成模板不存在。', 'NUTRITION_TEMPLATE_NOT_FOUND', 404);
      else await send(id ? { template: item } : { templates: state.templates.filter((row) => url.searchParams.get('includeArchived') === '1' || !row.archivedAt) });
      return true;
    }
    if (match[2] === 'preview' && method === 'POST') {
      if (!item) await fail('合成模板不存在。', 'NUTRITION_TEMPLATE_NOT_FOUND', 404);
      else {
        const input = parseNutritionTemplatePreview(body);
        if (input.expectedRevision !== item.revision) await fail('模板版本已变化，请重新选择。', 'NUTRITION_TEMPLATE_CONFLICT');
        else await send({ preview: previewNutritionTemplate(item, input) });
      }
      return true;
    }
    if (!uuid.test(key ?? '')) { await fail('模板操作需要固定标识。', 'NUTRITION_TEMPLATE_IDEMPOTENCY', 400); return true; }
    const serialized = JSON.stringify({ method, id, body }), receipt = state.templateReplays.get(key);
    if (receipt) {
      if (receipt.serialized !== serialized) await fail('原模板请求内容不可更换。', 'NUTRITION_TEMPLATE_IDEMPOTENCY');
      else await send({ template: receipt.template, replayed: true });
      return true;
    }
    let saved;
    const now = new Date().toISOString();
    if (!id && method === 'POST') {
      saved = { ...parseNutritionTemplate(body), id: key, revision: 1, createdAt: now, updatedAt: now, archivedAt: null };
      state.templates.push(saved);
    } else if (id && ['PUT', 'DELETE'].includes(method)) {
      if (!item) { await fail('合成模板不存在。', 'NUTRITION_TEMPLATE_NOT_FOUND', 404); return true; }
      const parsed = method === 'PUT' ? parseNutritionTemplateEdit(body) : { expectedRevision: parseNutritionTemplateRevision(body) };
      if (state.rejectNextTemplateEdit) { state.rejectNextTemplateEdit = false; item.revision++; }
      if (item.archivedAt || parsed.expectedRevision !== item.revision) { await fail('其他页面已更新模板，请读取最新版本。', 'NUTRITION_TEMPLATE_CONFLICT'); return true; }
      if (method === 'PUT') Object.assign(item, parsed.definition);
      else item.archivedAt = now;
      Object.assign(item, { revision: item.revision + 1, updatedAt: now });
      saved = item;
    } else { await fail('合成模板操作不支持。', 'UNEXPECTED_SYNTHETIC_API', 405); return true; }
    const snapshot = clone(saved);
    state.templateReplays.set(key, { serialized, template: snapshot });
    if (state.loseNextTemplateReply) { state.loseNextTemplateReply = false; await route.abort('connectionreset'); }
    else await send({ template: snapshot, replayed: false });
  } catch (error) {
    await fail(error.message || '合成模板验证失败。', 'NUTRITION_TEMPLATE_INVALID', 400);
  }
  return true;
}

export function syntheticNutritionTemplate(kind = 'meal') {
  const definition = parseNutritionTemplate({ kind, name: kind === 'recipe' ? '合成酸奶燕麦杯' : '合成早餐模板', note: '分装后取用', baseServings: '2', totalWeight: '300', components: [
    { name: '合成燕麦', portion: '100g', grams: '100', calories: '100', carbs: '20', protein: '2', fat: '0', provenance: Object.fromEntries(['calories','carbs','protein','fat'].map((key) => [key, { source: 'label', basis: '合成包装标签' }])) },
    { name: '合成酸奶', portion: '200g', grams: '200', calories: '50', carbs: null, protein: '4', fat: '1', provenance: { calories: { source: 'manual' }, carbs: { source: 'unknown' }, protein: { source: 'manual' }, fat: { source: 'manual' } } },
  ] });
  return { ...definition, id: '88888888-8888-4888-8888-888888888888', revision: 1, createdAt: '2026-11-11T00:00:00.000Z', updatedAt: '2026-11-11T00:00:00.000Z', archivedAt: null };
}
