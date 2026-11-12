import { parseNutritionPhotoRequest, buildNutritionPhotoDrafts } from '../../lib/nutrition-photo.ts';

/** Synthetic image recognition uses production request/result validation, never an external model. */
export function syntheticPhotoAnswer() {
  return { items: [{ name: '合成图片午餐', evidence: '图片中有一份主食和一份配菜', confidence: 'high',
    estimate: { calories: 450, carbs: 50, protein: 25, fat: 16.7,
      portion: '约1份（图片估算）', basis: '按图片可见份量作合成参考，不代表实际吃完或实测克重' } }] };
}

export async function handleSyntheticPhoto({ route, state, url, method, body, send, fail }) {
  if (url.pathname !== '/api/health/nutrition/photo') return false;
  if (method !== 'POST') { await fail('图片识别只接受主动提交。', 'PHOTO_METHOD_INVALID', 405); return true; }
  try {
    const input = parseNutritionPhotoRequest(body);
    if (state.photoFailure) {
      const failure = state.photoFailure; state.photoFailure = null;
      await fail(failure.message ?? '合成图片识别暂时不可用，请保留图片后重试。', failure.code ?? 'AI_PROVIDER_UNAVAILABLE', failure.status ?? 503);
      return true;
    }
    if (state.photoGate) await state.photoGate;
    if (state.photoLoseReply) { state.photoLoseReply = false; await route.abort('connectionreset'); return true; }
    const answer = state.photoAnswer ?? (state.photoEmpty ? { items: [] } : syntheticPhotoAnswer());
    const result = buildNutritionPhotoDrafts(JSON.stringify(answer), input);
    state.photoAnswered = (state.photoAnswered ?? 0) + 1;
    await send({ ...result, provider: 'synthetic', model: 'no-provider-call' });
  } catch (error) {
    // AbortController cancellation is an intentional photo-replacement path.
    // Chromium may reject fulfilling a route the page has already cancelled.
    if (route.request?.().failure?.()?.errorText === 'net::ERR_ABORTED') return true;
    await fail(error.message || '合成图片输入无效。', error.code || 'INVALID_NUTRITION_PHOTO_REQUEST', error.status || 400);
  }
  return true;
}
