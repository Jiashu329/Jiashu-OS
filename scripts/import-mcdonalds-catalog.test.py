"""Pinned-source and semantic regression checks; no network is used."""
import copy
import importlib.util
import json
from pathlib import Path
import sys
import unittest


SCRIPT = Path(__file__).with_name('import-mcdonalds-catalog.py')
sys.dont_write_bytecode = True
SPEC = importlib.util.spec_from_file_location('mcdonalds_import', SCRIPT)
catalog = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(catalog)


class OfficialCatalogTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.raw = (catalog.ROOT / catalog.RAW_FILE).read_bytes()
        cls.source = catalog.parse(cls.raw)
        cls.artifacts = catalog.build(cls.raw)
        cls.release = json.loads(cls.artifacts[catalog.RELEASE_FILE])
        cls.items = {food['source']['recordId']: food for food in cls.release['foods']}

    def test_checked_in_files_reproduce_exactly_from_archived_json(self):
        for path, expected in self.artifacts.items():
            self.assertEqual((catalog.ROOT / path).read_bytes(), expected)

    def test_complete_graph_retains_both_same_name_menu_entries(self):
        self.assertEqual(len(self.items), 137)
        product_ids = {item['source']['recordId'].split(':')[0] for item in self.items.values()}
        self.assertEqual(len(product_ids), 93)
        waters = [item for item in self.items.values() if item['aliases'] == ['纯悦']]
        self.assertEqual(len(waters), 2)
        self.assertEqual({item['category'] for item in waters}, {'饮品', '开心乐园餐'})
        self.assertEqual({item['source']['recordId'] for item in waters}, {'63:81', '129:71'})

    def test_known_official_servings_not_derived_weight(self):
        big_mac = self.items['49:28']
        self.assertEqual(big_mac['serving'], {
            'unit': '份', 'label': '1个', 'originalLabel': '1个',
            'kcal': 513, 'energyKj': 2146, 'protein': 27, 'fat': 26,
            'carbs': 42, 'sodiumMg': 961, 'calciumMg': 171,
        })
        for item in self.items.values():
            self.assertEqual(item['basis'], 'perServing')
            self.assertIsNone(item['grams'])
            self.assertIsNone(item['kcalPer100g'])
            self.assertEqual(item['portions'], [])
        self.assertEqual(self.items['51:72']['serving']['kcal'], 107)
        self.assertEqual(self.items['51:73']['serving']['kcal'], 147)
        self.assertEqual(self.items['51:74']['serving']['kcal'], 224)

    def test_official_zero_is_not_recomputed_from_macros(self):
        zero_cola = self.items['53:83']['serving']
        self.assertEqual((zero_cola['energyKj'], zero_cola['kcal'], zero_cola['carbs']), (0, 0, 1))
        self.assertEqual(self.items['63:81']['serving']['originalLabel'], '默认')
        self.assertEqual(self.items['63:81']['serving']['label'], '1份（官网默认规格）')

    def test_fractional_calcium_is_preserved(self):
        item = next(item for item in self.items.values() if item['source']['recordId'].endswith(':408'))
        self.assertEqual(item['serving']['calciumMg'], 284.7)

    def test_rounding_matches_official_positive_half_up_not_5kcal_steps(self):
        self.assertEqual(catalog.kcal(2146), 513)
        self.assertEqual(catalog.kcal(446), 107)
        self.assertEqual(catalog.kcal('2.092'), 1)
        self.assertEqual(catalog.kcal(8), 2)

    def test_missing_inequality_negative_nonfinite_are_never_zero_filled(self):
        for value in (None, '', '<0.1', '≤0.1', '-1', 'NaN', 'Infinity', 0):
            with self.subTest(value=value), self.assertRaises(ValueError):
                catalog.number(value)
        self.assertEqual(catalog.number('0'), 0)
        self.assertEqual(catalog.number('0.1'), 0.1)

    def test_changed_graph_unknown_value_and_duplicate_json_key_are_rejected(self):
        repeated = copy.deepcopy(self.source)
        repeated['category_list'][0]['Product'][1] = repeated['category_list'][0]['Product'][0]
        with self.assertRaisesRegex(ValueError, 'repeated'):
            catalog.parse(json.dumps(repeated))
        changed = copy.deepcopy(self.source)
        changed['ProductType']['28']['nutrition'][2] = '<0.1'
        with self.assertRaisesRegex(ValueError, 'Unknown source numeric'):
            catalog.parse(json.dumps(changed))
        with self.assertRaisesRegex(ValueError, 'Duplicate JSON key'):
            catalog.parse('{"Product":{},"Product":{}}')

    def test_raw_source_pin_cannot_silently_change(self):
        with self.assertRaisesRegex(ValueError, 'NEW release identity'):
            catalog.build(self.raw + b' ')

    def test_provenance_distinguishes_capture_date_from_upstream_update(self):
        metadata = json.loads(self.artifacts[catalog.SOURCE_FILE])
        self.assertEqual(metadata['snapshotDate'], '2026-11-12')
        self.assertEqual(metadata['upstreamRelease'], '2025-04')
        self.assertEqual(metadata['source']['rawSha256'], catalog.sha256(self.raw))
        self.assertEqual(metadata['release']['sha256'], catalog.sha256(self.artifacts[catalog.RELEASE_FILE]))
        self.assertEqual(metadata['unmappedNutritionIndices'], [0, 6, 7, 8, 9, 10, 11, 12])
        self.assertIn('2025年4月', metadata['disclaimer']['scopeAndUpdatedAt'])


if __name__ == '__main__':
    unittest.main()
