import importlib.util
import json
from pathlib import Path
import unittest
import sys

sys.dont_write_bytecode = True

SCRIPT = Path(__file__).with_name('import-luckin-catalog.py')
spec = importlib.util.spec_from_file_location('luckin_import', SCRIPT)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class LuckinImportTests(unittest.TestCase):
    def test_complete_products_have_exact_official_coverage(self):
        raw = module.read_raw()
        release, source = module.build(raw)
        self.assertEqual((len(release['foods']), len(release['products'])), (21, 7))
        self.assertEqual(source['count'], 28)
        self.assertEqual({p['id'] for p in release['products']}, {'luckin-cn:' + str(i) for i in [7, 44, 52, 43, 49, 51, 50]})
        self.assertEqual({p['id'] for p in release['foods']} | {p['id'] for p in release['products']}, {'luckin-cn:' + str(p['id']) for c in raw['categories'] for p in c['productList']})

    def test_calories_keep_their_published_basis_without_fabricated_kj_or_macros(self):
        release, _ = module.build(module.read_raw())
        by_id = {p['id']: p for p in release['foods']}
        self.assertEqual(by_id['luckin-cn:1']['serving']['kcal'], 179)
        self.assertEqual(by_id['luckin-cn:4']['serving']['kcal'], 76)
        self.assertEqual(by_id['luckin-cn:61']['serving']['label'], '超大杯/冰/微甜')
        for product in release['foods']:
            self.assertIsNone(product['serving']['energyKj'])
            self.assertEqual(product['serving']['energyBasis'], 'officialKcal')
            self.assertIsNone(product['grams'])
            self.assertIsNone(product['kcalPer100g'])
            self.assertNotIn('fat', product['serving'])
            self.assertNotIn('carbs', product['serving'])

    def test_missing_calories_are_distinct_from_zero_and_protein_remains_traceable(self):
        release, _ = module.build(module.read_raw())
        by_id = {p['id']: p for p in release['products']}
        for product in by_id.values():
            self.assertNotIn('serving', product)
            self.assertNotIn('kcal', product)
            self.assertNotIn('kcalPer100g', product)
        self.assertEqual(by_id['luckin-cn:44']['reference']['protein'], 6.5)
        self.assertEqual(by_id['luckin-cn:43']['reference']['protein'], 4.4)
        self.assertIsNone(by_id['luckin-cn:49']['reference']['label'])

    def test_contradictory_official_calorie_declarations_fail(self):
        p = {'id': 1, 'specSummary': ['热量179kcal'], 'remarkDesc': '热量180kcal'}
        with self.assertRaisesRegex(ValueError, 'Conflicting calorie'):
            module.calories(p, '')

    def test_macros_only_use_explicit_per_cup_labels_not_marketing_or_per_100ml(self):
        product = {'id': 1000, 'specSummary': [], 'remarkDesc': '0脂0糖，含蛋白质1g/100mL'}
        ref = module.reference(product, '【营养成分与咖啡因】\n以下营养成分及咖啡因数据适用于：冰/大杯\n蛋白质6.5g/杯（约1.45g/100mL）\n【介绍】0脂0糖')
        self.assertEqual(ref, {'label': '冰/大杯', 'protein': 6.5})
        self.assertIsNone(module.calories(product, ''))

    def test_archived_images_match_each_exact_product_and_original_bytes(self):
        raw = module.read_raw()
        images = module.check_images(raw)['images']
        self.assertEqual(len(images), 28)
        self.assertEqual(sum(len(image['foodIds']) for image in images), 28)
        self.assertTrue(all(image['src'].startswith('/food-images/luckin-cn/') for image in images))


if __name__ == '__main__':
    unittest.main()
