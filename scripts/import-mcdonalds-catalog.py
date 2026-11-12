#!/usr/bin/env python3
"""Reproduce the pinned McDonald's China *per serving* catalog, offline.

  python scripts/import-mcdonalds-catalog.py --check
  python scripts/import-mcdonalds-catalog.py  # create missing immutable artifacts
  python scripts/import-mcdonalds-catalog.py --fetch --check

The exact public inline JSON is committed beside its provenance. --fetch uses
ordinary unauthenticated HTTPS and saves a fresh response under ignored outputs/;
changed upstream data is rejected, never silently published under this version.
No Python dependency, upstream service, account or API key is needed at runtime.
"""
import argparse
from collections import Counter
from datetime import datetime, timezone
from decimal import Decimal, ROUND_HALF_UP
import hashlib
import json
from pathlib import Path
import re
import urllib.request


ROOT = Path(__file__).resolve().parents[1]
URL = 'https://www.mcdonalds.com.cn/nutrition_calculator'
VERSION = '2025-04（官网标注）'
SNAPSHOT_DATE = '2026-11-12'
FETCHED_AT = '2026-11-12T09:05:33.603171+00:00'
RAW_SHA256 = 'a7aff9e2de3ac6e2713f6720fb4e620d25f39c07910252a750ed8b63075f09aa'
HTML_SHA256 = '4f744c29fb6b5627c3c30225b6b00ea7e73c35ab960e0225a0426c3b74bdab7c'
RAW_FILE = Path('data/food-catalog-sources/mcd-cn-2025-04.raw.json')
RELEASE_FILE = Path('data/food-catalog-releases/mcd-cn-2025-04-v1.json')
SOURCE_FILE = Path('data/food-catalog-sources/mcd-cn-2025-04.json')
RELEASE_ID = 'catalog-2026-11-12-mcd-cn-v1'
SOURCE_NAME = '麦当劳中国官网营养计算器'
EXPECTED_COUNTS = (8, 93, 137)
NUMERIC = re.compile(r'(?:0|[1-9][0-9]*)(?:\.[0-9]+)?\Z')
DISCLAIMER = (
    '本营养计算器提供了麦当劳常规菜单中主要餐品的六种营养成分数据，供消费者参考。'
    '营养成分数据以单份餐品计量。六种营养成分包括能量、蛋白质、脂肪、碳水化合物、钠和钙。'
    '上述营养成分数据更新时间为2025年4月。'
)
VARIABILITY_NOTICE = (
    '您所购买的餐品，有可能因原料批次、产地和供应季节，生产加工工艺和餐厅烹制过程，'
    '实际供应份量的不同有所差异。此外，麦当劳会不定期更新产品配方，亦可能影响上述营养成分数据。'
)


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def encode(value):
    return (json.dumps(value, ensure_ascii=False, indent=2) + '\n').encode('utf-8')


def require(condition, message):
    if not condition:
        raise ValueError(message)


def number(raw):
    # Never coerce missing values, inequalities such as <0.1, or NaN to zero.
    require(isinstance(raw, str) and NUMERIC.fullmatch(raw),
            f'Unknown source numeric representation: {raw!r}')
    value = Decimal(raw)
    require(value.is_finite() and value >= 0, 'Invalid source nutrition value')
    return int(value) if value == value.to_integral_value() else float(value)


def kcal(kj):
    # All pinned kJ are nonnegative integers. ROUND_HALF_UP matches the page's
    # Math.round(parseFloat(kj) / 4.184), including a positive .5 boundary.
    return int((Decimal(str(kj)) / Decimal('4.184')).quantize(Decimal('1'), rounding=ROUND_HALF_UP))


def extract(html):
    marker = 'var raw_data = '
    require(html.count(marker) == 1, 'Expected one public raw_data declaration')
    tail = html.split(marker, 1)[1]
    _, length = json.JSONDecoder().raw_decode(tail)
    return tail[:length].encode('utf-8')


def no_duplicate_keys(pairs):
    value = {}
    for key, item in pairs:
        require(key not in value, f'Duplicate JSON key: {key}')
        value[key] = item
    return value


def parse(raw):
    source = json.loads(raw, object_pairs_hook=no_duplicate_keys)
    require(set(source) == {'category_list', 'Product', 'ProductType'}, 'Source root changed')
    categories, products, variants = source['category_list'], source['Product'], source['ProductType']
    require(isinstance(categories, list) and isinstance(products, dict) and isinstance(variants, dict),
            'Source collections changed')
    require((len(categories), len(products), len(variants)) == EXPECTED_COUNTS, 'Pinned source counts changed')
    product_edges, variant_edges, category_ids = [], [], set()
    for category in categories:
        require(set(category) == {'ProductCategory', 'Product'}, 'Category shape changed')
        details = category['ProductCategory']
        require(isinstance(details, dict) and set(details) == {'id', 'title', 'media_url3', 'content', 'cms'},
                'Category details changed')
        require(isinstance(details['id'], str) and details['id'].isdigit() and details['id'] not in category_ids,
                'Invalid or duplicate category identity')
        category_ids.add(details['id'])
        require(isinstance(details['title'], str) and details['title'].strip(), 'Missing category title')
        require(isinstance(category['Product'], list) and category['Product'], 'Empty category references')
        product_edges.extend(category['Product'])
    for identity, product in products.items():
        require(set(product) == {'id', 'title', 'media_url', 'nutrition_desc', 'ProductType', 'count', 'checked', 'selected'},
                'Product shape changed')
        require(identity.isdigit() and product['id'] == identity, 'Product identity mismatch')
        require(isinstance(product['title'], str) and product['title'].strip(), 'Missing product title')
        require(isinstance(product['ProductType'], list) and product['ProductType'], 'Product has no specification')
        require(product['count'] == 1, 'Source base serving count changed')
        variant_edges.extend(product['ProductType'])
    require(len(product_edges) == len(set(product_edges)) and set(product_edges) == set(products),
            'Missing, repeated or unreferenced products')
    require(len(variant_edges) == len(set(variant_edges)) and set(variant_edges) == set(variants),
            'Missing, repeated or unreferenced specifications')
    for identity, variant in variants.items():
        require(set(variant) == {'id', 'title', 'nutrition_desc', 'nutrition'}, 'Specification shape changed')
        require(identity.isdigit() and variant['id'] == identity, 'Specification identity mismatch')
        require(isinstance(variant['title'], str) and variant['title'].strip(), 'Missing specification title')
        require(isinstance(variant['nutrition'], list) and len(variant['nutrition']) == 14,
                'Nutrition array length changed')
        for raw_value in variant['nutrition']:
            number(raw_value)
    return source


def build(raw):
    require(sha256(raw) == RAW_SHA256, 'Raw source hash differs; review upstream and create a NEW release identity')
    source = parse(raw)
    foods = []
    for category in source['category_list']:
        for product_id in category['Product']:
            product = source['Product'][product_id]
            for variant_id in product['ProductType']:
                variant = source['ProductType'][variant_id]
                original = variant['title']
                label = '1份（官网默认规格）' if original == '默认' else original
                values = [number(v) for v in variant['nutrition']]
                title = f'麦当劳{product["title"]}［{label}］'
                require(len(title) <= 100, 'Item name exceeds supported length')
                foods.append({
                    'id': f'mcd-cn:{product_id}:{variant_id}',
                    'name': title,
                    'aliases': [product['title']],
                    'category': category['ProductCategory']['title'],
                    'state': '中国大陆官方标准份',
                    'description': '官网单份规格；营养值更新于2025年4月，实际供应可能有差异。',
                    'basis': 'perServing', 'grams': None, 'kcalPer100g': None, 'portions': [],
                    'serving': {
                        'unit': '份', 'label': label, 'originalLabel': original,
                        'kcal': kcal(values[1]), 'energyKj': values[1],
                        'protein': values[2], 'fat': values[3], 'carbs': values[4],
                        'sodiumMg': values[5], 'calciumMg': values[13],
                    },
                    'source': {'name': SOURCE_NAME, 'url': URL,
                               'recordId': f'{product_id}:{variant_id}', 'version': VERSION},
                })
    release = {
        'id': RELEASE_ID, 'parent': 'tfda-2024-03-29-cn2',
        'label': '麦当劳中国官方标准份（官网2025年4月数据）',
        'publishedAt': SNAPSHOT_DATE,
        'description': '2026年11月12日保存的官网快照；官网营养数据更新于2025年4月。'
                       '137个官方商品规格按份记录，不推算重量或每100克营养值。',
        'foods': foods,
    }
    release_bytes = encode(release)
    names = Counter(p['title'] for p in source['Product'].values())
    metadata = {
        'name': SOURCE_NAME, 'url': URL, 'version': VERSION, 'count': len(foods),
        'description': '中国大陆官网常规菜单主要餐品的标准单份数据，不代表所有在售或季节商品。',
        'snapshotDate': SNAPSHOT_DATE, 'upstreamRelease': '2025-04',
        'attribution': '麦当劳中国官网营养计算器；具体营养信息和免责声明请以官网为准。',
        'rightsNotice': '官网公开页面；未提供开放数据许可，不套用其他食物来源的许可。',
        'source': {
            'requestedUrl': URL, 'finalUrl': URL, 'httpStatus': 200,
            'fetchedAtUtc': FETCHED_AT, 'htmlSha256': HTML_SHA256, 'htmlBytes': 128814,
            'extraction': 'HTML内 var raw_data 的原始JSON；不执行网页脚本。',
            'rawFile': RAW_FILE.as_posix(), 'rawSha256': RAW_SHA256, 'rawBytes': len(raw),
        },
        'release': {'id': RELEASE_ID, 'file': RELEASE_FILE.as_posix(), 'sha256': sha256(release_bytes)},
        'counts': {
            'categories': 8, 'products': 93, 'specifications': 137, 'uniqueProductNames': len(names),
            'duplicateProductNames': {name: count for name, count in names.items() if count > 1},
            'categoryProducts': {c['ProductCategory']['title']: len(c['Product']) for c in source['category_list']},
            'specificationLabels': dict(Counter(v['title'] for v in source['ProductType'].values())),
            'nullNutritionCells': 0, 'inequalityNutritionCells': 0,
        },
        'servingBasis': '官网明确以单份餐品计量；每个ProductType为对应商品的一个原始规格，使用份数倍数。',
        'nutritionIndexMapping': {
            '1': {'field': 'serving.energyKj', 'unit': 'kJ'},
            '2': {'field': 'serving.protein', 'unit': 'g'},
            '3': {'field': 'serving.fat', 'unit': 'g'},
            '4': {'field': 'serving.carbs', 'unit': 'g'},
            '5': {'field': 'serving.sodiumMg', 'unit': 'mg'},
            '13': {'field': 'serving.calciumMg', 'unit': 'mg'},
        },
        'unmappedNutritionIndices': [0, 6, 7, 8, 9, 10, 11, 12],
        'unmappedReason': '当前官网可见表头未确认这些槽位的名称或单位；第0项不作为克数或毫升。',
        'energyConversion': {
            'sourceCodeExcerpt': 'function formatKcal(kj) { var kcal = parseFloat(kj) / 4.184; return Math.round(kcal); }',
            'formula': 'kcal = Math.round(energyKj / 4.184)',
            'explanation': '复现官网每份整数大卡；保留官方千焦原值，不由宏量营养素重算。'
                           '源码return后5/10大卡分档代码不可达，不使用。',
        },
        'transformation': [
            '仅映射当前官网可见的六项营养素；所有原始14槽数据保存在rawFile。',
            '保留商品ID和规格ID组成recordId；不按同名商品或相同营养值去重。',
            '原规格标题原样保存为originalLabel；默认的显示解释为1份（官网默认规格）。',
            'grams、kcalPer100g为null，portions为空；不推算重量、杯容量或每100克值。',
            '官网营养比较说明并非规格定义，不据此生成份量或别名。',
            '缺值、非数、负数和小于号表示均拒绝；不以0补齐。此快照无此类单元格。',
        ],
        'disclaimer': {'scopeAndUpdatedAt': DISCLAIMER, 'variabilityExcerpt': VARIABILITY_NOTICE},
    }
    return {RELEASE_FILE: release_bytes, SOURCE_FILE: encode(metadata)}


def fetch():
    request = urllib.request.Request(URL, headers={'User-Agent': 'Mozilla/5.0', 'Accept': 'text/html,application/xhtml+xml'})
    with urllib.request.urlopen(request, timeout=30) as response:
        require(response.geturl() == URL, 'Unexpected redirect; inspect the public source manually')
        html = response.read()
        status = response.status
    raw = extract(html.decode('utf-8'))
    output = ROOT / 'outputs/mcdonalds-source'
    output.mkdir(parents=True, exist_ok=True)
    (output / 'latest-nutrition-calculator.html').write_bytes(html)
    (output / 'latest-raw-data.source.json').write_bytes(raw)
    (output / 'latest-fetch.json').write_bytes(encode({
        'requestedUrl': URL, 'finalUrl': URL, 'httpStatus': status,
        'fetchedAtUtc': datetime.now(timezone.utc).isoformat(),
        'htmlSha256': sha256(html), 'rawSha256': sha256(raw),
    }))
    require(sha256(raw) == RAW_SHA256, 'Live source changed; response saved for review. Do not overwrite this immutable release.')
    return raw


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true', help='verify committed artifacts, without writing them')
    parser.add_argument('--fetch', action='store_true', help='also verify the public page against the raw source pin')
    parser.add_argument('--input', type=Path, help='exact raw_data JSON, which must match the pinned hash')
    args = parser.parse_args()
    raw = fetch() if args.fetch else (args.input or ROOT / RAW_FILE).read_bytes()
    artifacts = build(raw)
    for relative, expected in artifacts.items():
        path = ROOT / relative
        if path.exists():
            require(path.read_bytes() == expected, f'Immutable artifact differs: {relative}; use a new release identity')
        else:
            require(not args.check, f'Missing generated artifact: {relative}')
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(expected)
    print(f'Verified {len(artifacts)} artifacts: 8 categories / 93 products / 137 per-serving specifications; source SHA-256 {RAW_SHA256}')


if __name__ == '__main__':
    main()
