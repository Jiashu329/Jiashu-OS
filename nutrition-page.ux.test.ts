import assert from 'node:assert/strict';
import test from 'node:test';
import { parseHTML } from 'linkedom';
import { renderNutritionPage } from './nutrition-page.ts';

test('nutrition starts with one recording composer and keeps history and maintenance out of the daily path', () => {
  const { document } = parseHTML(renderNutritionPage('layout-fixture'));
  const tabs = [...document.querySelectorAll('#nutrition-entry-methods [role="tab"]')];
  assert.deepEqual(tabs.map((tab) => tab.getAttribute('data-entry-method')), ['ai', 'quick', 'manual', 'photo']);
  assert.equal(tabs.filter((tab) => tab.getAttribute('aria-selected') === 'true').length, 1);
  assert.equal(document.getElementById('nutrition-entry-ai')?.hasAttribute('hidden'), false);
  assert.equal(document.getElementById('nutrition-entry-quick')?.hasAttribute('hidden'), true);
  assert.equal(document.getElementById('nutrition-entry-manual')?.hasAttribute('hidden'), true);
  assert.equal(document.getElementById('nutrition-entry-photo')?.hasAttribute('hidden'), true);
  for (const id of ['nutrition-options', 'nutrition-history']) {
    const section = document.getElementById(id);
    assert.equal(section?.tagName, 'DETAILS');
    assert.equal(section?.hasAttribute('open'), false);
    assert.ok(section?.querySelector('summary'));
  }
  assert.ok(document.getElementById('nutrition-options')?.contains(document.getElementById('nutrition-include-deleted')));
  assert.ok(document.getElementById('nutrition-history')?.contains(document.getElementById('nutrition-review-chart')));
  assert.equal(document.querySelectorAll('header #nutrition-focus-entry').length, 1);
});

test('manual recording exposes essentials while nutrition, catalog and record context remain available on demand', () => {
  const { document } = parseHTML(renderNutritionPage('layout-fixture'));
  for (const id of ['nutrition-name', 'nutrition-portion']) {
    assert.ok(document.getElementById('nutrition-fields')?.contains(document.getElementById(id)));
    assert.equal(document.getElementById(id)?.closest('details'), null);
  }
  const groups = {
    'nutrition-form-nutrients': ['nutrition-calories', 'nutrition-carbs', 'nutrition-protein', 'nutrition-fat'],
    'nutrition-form-catalog': ['nutrition-food-search', 'nutrition-food-search-button', 'nutrition-food-selection'],
    'nutrition-form-context': ['nutrition-form-day', 'nutrition-meal', 'nutrition-note'],
  };
  for (const [id, fields] of Object.entries(groups)) {
    const group = document.getElementById(id);
    assert.equal(group?.tagName, 'DETAILS');
    assert.equal(group?.hasAttribute('open'), false);
    for (const field of fields) assert.ok(group?.contains(document.getElementById(field)), field + ' must remain reachable');
  }
  assert.ok(document.getElementById('nutrition-form')?.querySelector('[type="submit"]'));
  const ids = [...document.querySelectorAll('[id]')].map((node) => node.id);
  assert.equal(new Set(ids).size, ids.length, 'Control IDs must stay unique for labels and browser scripts');
});
