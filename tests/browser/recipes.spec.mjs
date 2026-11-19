import { expect, test as base } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createRecipe, listRecipes, readRecipe, readRecipeBySource, RecipeConflictError } from '../../db/nutrition-recipes-store.ts';
import { validNutritionId } from '../../lib/nutrition.ts';
import { parseRecipeCreation, parseRecipeLink, parseRecipeList, parseRecipePreview, RecipeValidationError } from '../../lib/nutrition-recipes.ts';
import { SQLiteD1Database } from '../../selfhost/database.ts';
import { interceptSyntheticAPI, syntheticState } from './synthetic-api.mjs';

const path = '/health/nutrition/recipes';
const api = '/api' + path;
const xiaohongshu = 'https://xhslink.cn/o/RecipeTest123';
const xiachufang = 'https://www.xiachufang.com/recipe/107111111/';
const xiaohongshuPreview = {
  title: '合成香菇粥', author: '合成作者', ingredients: ['香菇 100 克', '大米 60 克'], steps: ['香菇切片。', '加水煮熟。'],
};
const migration = readFileSync(new URL('../../drizzle/0037_nutrition_recipes.sql', import.meta.url), 'utf8');

const test = base.extend({
  recipes: async ({ context, baseURL }, use) => {
    const state = syntheticState();
    const db = new SQLiteD1Database(':memory:');
    try {
      db.transaction(() => db.executeMigrationSQL(migration));
      await interceptSyntheticAPI(context, state);
      const origin = new URL(baseURL).origin;
      await context.route(url => url.origin === origin && (url.pathname === api || url.pathname.startsWith(api + '/')), async route => {
        const request = route.request();
        const url = new URL(request.url());
        const method = request.method();
        const body = request.postDataJSON() ?? null;
        const key = request.headers()['idempotency-key'] ?? null;
        const suffix = url.pathname.slice(api.length);
        const send = (value, status = 200) => route.fulfill({ status, json: value, headers: { 'Cache-Control': 'no-store' } });
        state.requests.push({ path: url.pathname, search: url.search, method, body, key });

        try {
          if (method === 'POST' && suffix === '/preview') {
            const link = parseRecipePreview(body);
            return send({ preview: link.source === 'xiaohongshu' ? xiaohongshuPreview : null });
          }
          if (method === 'POST' && !suffix) {
            if (!validNutritionId(key)) return send({ error: '这次提交缺少有效标识。', code: 'NUTRITION_REQUEST_ID_REQUIRED' }, 400);
            return send(await createRecipe(db, state.owner, parseRecipeCreation(body), key));
          }
          if (method === 'GET') {
            const sourceUrl = url.searchParams.get('sourceUrl');
            if (!suffix && sourceUrl === null) return send(await listRecipes(db, state.owner, parseRecipeList(url.searchParams)));
            const recipe = suffix
              ? await readRecipe(db, state.owner, suffix.slice(1))
              : await readRecipeBySource(db, state.owner, parseRecipeLink(sourceUrl).key);
            return recipe ? send({ recipe }) : send({ error: '找不到这份菜谱。', code: 'RECIPE_NOT_FOUND' }, 404);
          }
          return send({ error: '未定义的合成验收请求。', code: 'UNEXPECTED_SYNTHETIC_API' }, 501);
        } catch (error) {
          if (error instanceof RecipeValidationError) return send({ error: error.message, code: error.code }, error.status);
          if (error instanceof RecipeConflictError) return send({ error: error.message, code: error.code }, 409);
          throw error;
        }
      });
      await use(state);
      expect(state.externalRequests, 'Recipe acceptance never calls the external sources').toEqual([]);
    } finally {
      db.close();
    }
  },
});

const writes = (state) => state.requests.filter(request => request.path === api && request.method === 'POST');

async function openEditor(page, link) {
  await page.getByRole('button', { name: '保存菜谱链接', exact: true }).click();
  const editor = page.getByRole('dialog');
  await editor.getByLabel('菜谱链接或分享文字', { exact: true }).fill(link);
  return editor;
}

test('opens My Recipes from Diet, previews a Xiaohongshu share and keeps the saved detail across reload', async ({ page, recipes }) => {
  await page.goto('/health/nutrition');
  await page.getByRole('main').getByRole('link', { name: '我的菜谱', exact: true }).click();
  await expect(page).toHaveURL(path);
  await expect(page.getByRole('heading', { name: '我的菜谱', exact: true })).toBeVisible();

  const editor = await openEditor(page, `${xiaohongshu}?tracking=synthetic，复制到小红书`);
  await editor.getByRole('button', { name: '读取原文', exact: true }).click();
  await expect(editor.getByLabel('菜名', { exact: true })).toHaveValue(xiaohongshuPreview.title);
  await expect(editor.getByLabel('食材与用量', { exact: true })).toHaveValue(xiaohongshuPreview.ingredients.join('\n'));
  await expect(editor.getByLabel('做法', { exact: true })).toHaveValue(xiaohongshuPreview.steps.join('\n'));
  expect(writes(recipes)).toEqual([]);
  expect(recipes.requests).toContainEqual(expect.objectContaining({ path: api + '/preview', method: 'POST', body: { sourceUrl: xiaohongshu } }));

  await editor.getByRole('button', { name: '保存', exact: true }).click();
  const detail = page.getByRole('dialog');
  await expect(detail.getByRole('heading', { name: xiaohongshuPreview.title, exact: true })).toBeVisible();
  await expect(detail.getByRole('link', { name: /原文/ })).toHaveAttribute('href', xiaohongshu);
  expect(writes(recipes)).toHaveLength(1);
  expect(writes(recipes)[0].body).toMatchObject({ sourceUrl: xiaohongshu, sourceAuthor: xiaohongshuPreview.author });

  await detail.getByRole('button', { name: '关闭', exact: true }).click();
  await page.reload();
  await page.getByRole('button', { name: /合成香菇粥/ }).click();
  await expect(detail.getByRole('heading', { name: xiaohongshuPreview.title, exact: true })).toBeVisible();
  await expect(detail).toContainText('香菇 100 克');
  await expect(detail).toContainText('加水煮熟。');
});

test('a Xiachufang preview miss leaves the original link and pasted recipe text available', async ({ page, recipes }) => {
  await page.goto(path);
  const editor = await openEditor(page, xiachufang);
  await expect(editor.getByRole('link', { name: /原文/ })).toHaveAttribute('href', xiachufang);
  await editor.getByRole('button', { name: '读取原文', exact: true }).click();
  await expect(editor).toContainText(/无法.*读取|没有读到/);
  await editor.getByText('粘贴原文文字', { exact: true }).click();
  await editor.getByLabel('菜谱原文', { exact: true }).fill('用料\n西红柿 2 个\n鸡蛋 3 个\n\n番茄炒蛋的做法步骤\n步骤 1\n西红柿切块。\n步骤 2：加鸡蛋炒熟。');
  await editor.getByRole('button', { name: '带入菜谱', exact: true }).click();
  await expect(editor.getByLabel('食材与用量', { exact: true })).toHaveValue('西红柿 2 个\n鸡蛋 3 个');
  await expect(editor.getByLabel('做法', { exact: true })).toHaveValue('西红柿切块。\n加鸡蛋炒熟。');
  await editor.getByLabel('菜名', { exact: true }).fill('合成番茄炒蛋');
  await editor.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('heading', { name: '合成番茄炒蛋', exact: true })).toBeVisible();
  expect(writes(recipes)).toHaveLength(1);
  expect(writes(recipes)[0].body).toMatchObject({ sourceUrl: xiachufang, ingredients: '西红柿 2 个\n鸡蛋 3 个' });
});
