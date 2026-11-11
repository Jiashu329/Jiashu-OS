import assert from 'node:assert/strict';
import test from 'node:test';
import { parseHTML } from 'linkedom';
import { renderPageHeadingCopy } from './page-heading.ts';

test('page headings expose one title and keep section and purpose distinct', () => {
  const { document } = parseHTML(renderPageHeadingCopy({ section: '健康 / 记录管理', title: '健康记录', description: '查看与更正记录，保留每次修改的依据。' }));
  assert.equal(document.querySelectorAll('h1').length, 1);
  assert.equal(document.querySelector('.page-eyebrow')?.textContent, '健康 / 记录管理');
  assert.equal(document.querySelector('.page-description')?.textContent, '查看与更正记录，保留每次修改的依据。');
});

test('heading copy is text and cannot inject active elements or attributes', () => {
  const input = '<img src=x onerror="alert(1)"> & \'quoted\'';
  const { document } = parseHTML(renderPageHeadingCopy({ section: input, title: input, description: input }));
  assert.equal(document.querySelectorAll('img,script').length, 0);
  for (const selector of ['.page-eyebrow', 'h1', '.page-description']) {
    assert.equal(document.querySelector(selector)?.textContent, input);
  }
});
