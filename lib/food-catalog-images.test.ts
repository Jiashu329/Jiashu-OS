import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import manifest from '../data/food-catalog-images.json' with { type: 'json' };
import raw from '../data/food-catalog-sources/mcd-cn-2025-04.raw.json' with { type: 'json' };
import mcdRelease from '../data/food-catalog-releases/mcd-only-2026-11-13-v1.json' with { type: 'json' };
import luckinManifest from '../data/luckin-catalog-images.json' with { type: 'json' };
import luckinRaw from '../data/food-catalog-sources/luckin-cn-2026-11-13.raw.json' with { type: 'json' };
import luckinRelease from '../data/food-catalog-releases/luckin-cn-2026-11-13-v1.json' with { type: 'json' };
import { foodCatalogImages } from './food-catalog-images.ts';

test('McDonald product images retain exact source identities and unchanged PNG bytes for their 137 specifications', () => {
  assert.equal(manifest.images.length, 93);
  const source = readFileSync(new URL('../' + manifest.sourceRawFile, import.meta.url));
  assert.equal(createHash('sha256').update(source).digest('hex'), manifest.sourceRawSha256);
  const allIds: string[] = [];
  for (const image of manifest.images) {
    const product = raw.Product[image.productId as keyof typeof raw.Product];
    assert.ok(product);
    assert.equal(image.productTitle, product.title);
    assert.equal(image.mediaPath, product.media_url);
    assert.equal(image.sourceUrl, 'https://officiaweb-afd.mcdonalds.com.cn/public/' + product.media_url);
    assert.deepEqual(image.foodIds, product.ProductType.map((variant) => `mcd-cn:${product.id}:${variant}`));
    assert.equal(image.src, `/food-images/mcd-cn/${product.id}.png`);
    const bytes = readFileSync(new URL('../public' + image.src, import.meta.url));
    assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(bytes.length, image.bytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), image.sha256);
    assert.equal(bytes.readUInt32BE(16), image.width);
    assert.equal(bytes.readUInt32BE(20), image.height);
    allIds.push(...image.foodIds);
  }
  assert.equal(new Set(allIds).size, 137);
  assert.deepEqual([...allIds].sort(), [...mcdRelease.foodIds].sort());
});

test('Luckin images correspond to all 28 official products, including products with unpublished calories', () => {
  const products = luckinRaw.categories.flatMap((category) => category.productList);
  const byId = new Map(products.map((product) => [String(product.id), product]));
  const ids = [...luckinRelease.foods, ...luckinRelease.products].map((food) => food.id);
  assert.equal(luckinManifest.images.length, 28);
  assert.equal(byId.size, 28);
  assert.deepEqual(luckinManifest.images.flatMap((image) => image.foodIds).sort(), ids.sort());
  const bytes = readFileSync(new URL('../' + luckinManifest.sourceRawFile, import.meta.url));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), luckinManifest.sourceRawSha256);
  for (const image of luckinManifest.images) {
    const product = byId.get(image.productId);
    assert.ok(product);
    assert.equal(image.productTitle, product.productName);
    assert.equal(image.sourceUrl, product.mainImageUrl);
    assert.deepEqual(image.foodIds, [`luckin-cn:${product.id}`]);
    assert.match(image.src, /^\/food-images\/luckin-cn\/\d+\.(?:png|jpg|jpeg)$/);
    const file = readFileSync(new URL('../public' + image.src, import.meta.url));
    assert.equal(file.length, image.bytes);
    assert.equal(createHash('sha256').update(file).digest('hex'), image.sha256);
    assert.deepEqual(foodCatalogImages(image.foodIds.map((id) => ({ id }))), {
      [image.foodIds[0]]: { src: image.src, alt: product.productName },
    });
  }
});

test('bounded visual metadata does not mutate catalog items or attach images to unknown historical foods', () => {
  const burger = Object.freeze({ id: 'mcd-cn:49:28' });
  const result = foodCatalogImages([burger, { id: 'tfda:1' }, { id: 'unknown' }]);
  assert.deepEqual(result, { 'mcd-cn:49:28': { src: '/food-images/mcd-cn/49.png', alt: '巨无霸' } });
  assert.deepEqual(burger, { id: 'mcd-cn:49:28' });
  assert.ok(Object.isFrozen(result[burger.id]));
  assert.deepEqual(foodCatalogImages([]), {});
});
