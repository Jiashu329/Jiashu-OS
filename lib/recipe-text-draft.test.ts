import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { parseRecipeTextDraft } from './recipe-text-draft.ts';

void test('copies labeled ingredients and Xiaohongshu steps from the original text', () => {
  const source = [
    '\ufeff家常蘑菇饭', '准备材料：米饭一碗、香菇\u200b两朵、青葱少许', '具体步骤：',
    '　1️⃣ 切好香菇。', '２．热锅加油。', '3⃣加入米饭。#家常菜[话题]#',
    '评论：', '4️⃣ 最后再加糖。',
  ].join('\r\n');
  assert.deepEqual(parseRecipeTextDraft(source), {
    ingredients: '米饭一碗\n香菇两朵\n青葱少许',
    steps: '切好香菇。\n热锅加油。\n加入米饭。',
    note: source.replace(/\r\n/g, '\n').replace(/[\ufeff\u200b]/g, ''),
  });
});

void test('pairs Xiachufang step labels with the following text and excludes tips', () => {
  const source = [
    '菌菇汤的做法', '', '用料', '香菇 100 克', '水 400 毫升', '', '菌菇汤的做法步骤',
    '', '步骤 1', '', '香菇洗净切片。', '', '步骤 2：加水煮开。', '',
    '步骤 3', '菌菇汤的小贴士', '上桌前撒葱花。', '步骤 4', '评论文字。',
  ].join('\n');
  assert.deepEqual(parseRecipeTextDraft(source), {
    ingredients: '香菇 100 克\n水 400 毫升',
    steps: '香菇洗净切片。\n加水煮开。',
    note: source,
  });
});

void test('recovers consecutively numbered sections from a flattened public description', () => {
  const source = '想家的味道 准备材料：豆腐、蘑菇 具体步骤： 1️⃣切豆腐 2️⃣煮蘑菇 3️⃣一起炖熟 \t 下次也想做 #家常菜';
  assert.deepEqual(parseRecipeTextDraft(source), {
    ingredients: '豆腐\n蘑菇',
    steps: '切豆腐\n煮蘑菇\n一起炖熟',
    note: source,
  });
  assert.equal(parseRecipeTextDraft(source.replace('2️⃣', '4️⃣')).steps, '');
});

void test('keeps unlabeled text as a note and normalizes control characters and line breaks', () => {
  assert.deepEqual(parseRecipeTextDraft(' \u202e 香菇和米饭\u2028 1️⃣ 热锅。\u0085 2️⃣ 调\u0001味。 '), {
    ingredients: '',
    steps: '',
    note: '香菇和米饭\n 1️⃣ 热锅。\n 2️⃣ 调味。',
  });
});

void test('keeps every editable field within its limit on grapheme boundaries', () => {
  const grapheme = '👩🏽‍🍳';
  const line = grapheme.repeat(1_200);
  const draft = parseRecipeTextDraft(`${line}\n食材：${line}\n步骤：\n1️⃣ ${line.slice(0, 6_300)}`);
  assert.equal(draft.note, grapheme.repeat(Math.floor(1_000 / grapheme.length)));
  assert.equal(draft.ingredients, grapheme.repeat(Math.floor(3_000 / grapheme.length)));
  assert.equal(draft.steps, grapheme.repeat(Math.floor(6_000 / grapheme.length)));
});

void test('the same parser runs without module dependencies in the browser script', () => {
  const text = '食材：面条\n做法：煮面后拌入葱油';
  const browserDraft = runInNewContext(`(${parseRecipeTextDraft.toString()})(text)`, { text }) as ReturnType<typeof parseRecipeTextDraft>;
  assert.deepEqual({ ...browserDraft }, parseRecipeTextDraft(text));
});
