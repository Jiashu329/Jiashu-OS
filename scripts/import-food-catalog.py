#!/usr/bin/env python3
"""Build the offline food catalog from a pinned, attributable TFDA mirror.

Only this build-time importer needs OpenCC:
  python -m venv /tmp/food-catalog-venv
  /tmp/food-catalog-venv/bin/pip install opencc-python-reimplemented==0.1.7
  /tmp/food-catalog-venv/bin/python scripts/import-food-catalog.py [--input nutrition.csv]
  # After reviewing a new upstream pin, use a NEW immutable release identity:
  /tmp/food-catalog-venv/bin/python scripts/import-food-catalog.py --release-id tfda-YYYY-MM-DD

The generated JSON is committed; running the website needs no Python/OpenCC,
external food service, API key, or user data upload.
"""
import argparse
import csv
import hashlib
import io
import json
import math
from pathlib import Path
import re
import urllib.request

from opencc import OpenCC

COMMIT = 'da3bd63ee385638c7c490bc7999507ad70572b70'
MIRROR = 'https://github.com/liao961120/Taiwan-FDA-nutrition'
RAW_URL = f'https://raw.githubusercontent.com/liao961120/Taiwan-FDA-nutrition/{COMMIT}/made/nutrition.csv'
RAW_SHA256 = '4670ababc656e1136a8f10faff7e0a59c7700ff988e95ec471870132ea7c6d64'
OFFICIAL_URL = 'https://data.gov.tw/dataset/8543'
VERSION = '2024-03-29 镜像快照；原始发布版本未注明'
LEGACY_RELEASE = 'tfda-2024-03-29'
ROOT = Path(__file__).resolve().parents[1]
convert = OpenCC('t2s').convert

# Lexical aliases only: no nutrition value or portion weight is invented here.
ALIASES = {
    '白飯': ['米饭', '熟米饭', '白米饭'],
    '全脂鮮乳': ['全脂牛奶'],
    '低脂鮮乳': ['低脂牛奶'],
    '脫脂鮮乳': ['脱脂牛奶'],
    '燕麥片': ['麦片'],
    '青花菜': ['西兰花', '绿花椰菜'],
    '花椰菜': ['菜花'],
    '馬鈴薯': ['土豆'],
    '番茄': ['西红柿'],
    '胡蘿蔔': ['红萝卜'],
    '小黃瓜': ['黄瓜'],
    '黃豆': ['大豆'],
    '甘薯': ['红薯', '地瓜'],
    '高麗菜': ['卷心菜', '包菜', '圆白菜'],
    '芭樂': ['番石榴'],
    '奇異果': ['猕猴桃'],
    '雞水煮蛋': ['水煮蛋', '水煮鸡蛋'],
}


def number(raw):
    if raw is None or str(raw).strip() in ('', 'NA'):
        return None
    try:
        value = float(raw)
    except ValueError:
        raise ValueError(f'Invalid numeric source field: {raw!r}')
    if not math.isfinite(value) or value < 0:
        raise ValueError('A source nutrition value is negative or non-finite')
    return int(value) if value.is_integer() else value


def state_for(name, description):
    # Use explicit preparation words only. Do not infer cooked state from a
    # generic food category; retain the complete source description separately.
    text = convert(description)
    states = []
    if re.search(r'^(生|生鲜)(?:[,，]|$)|生鲜', text):
        states.append('生鲜')
    if re.search(r'^(熟|熟食)(?:[,，]|$)|煮熟|蒸熟|烤熟|炒熟', text):
        states.append('熟制')
    if '冷冻' in text or '冷冻' in convert(name):
        states.append('冷冻')
    if re.search(r'干燥|晒干|烘干|脱水', text):
        states.append('干制')
    if re.search(r'罐装|罐头', text):
        states.append('罐装')
    return '；'.join(states) or '未注明'


def build(data):
    reader = csv.DictReader(io.StringIO(data.decode('utf-8-sig')))
    required = {'ID', 'ITEM', 'CONTENT_DESC', 'COMMON_NAMES', 'ENGLISH_NAME',
                'FOOD_TYPE', 'PER_PORTION_WEIGHT', '熱量', '粗蛋白', '粗脂肪', '總碳水化合物'}
    if not required.issubset(reader.fieldnames or []):
        raise ValueError('Pinned source columns changed')
    foods, ids = [], set()
    for row in reader:
        record_id, original = row['ID'].strip(), row['ITEM'].strip()
        if not re.fullmatch(r'[A-Z][0-9]{5,7}', record_id) or record_id in ids or not original:
            raise ValueError('Missing or duplicate source identity')
        ids.add(record_id)
        energy = number(row['熱量'])
        if energy is None:
            continue
        if energy > 1000:
            raise ValueError('Source energy exceeds the supported per-100g range')
        name = convert(original)
        aliases = [original]
        for field in ['COMMON_NAMES', 'ENGLISH_NAME']:
            raw = row[field].strip()
            if raw and raw != 'NA':
                for alias in re.split(r'[;；、]', raw):
                    alias = alias.strip()
                    if alias:
                        aliases.extend([alias, convert(alias)])
        # Include synonyms for named varieties too, without collapsing the
        # varieties into one FoodItem; ambiguous matches remain separate.
        for key, values in ALIASES.items():
            if key == original or original.startswith(key + '(') or original == key + '平均值':
                aliases.extend(values)
        # Broad names deliberately map to several variants. They improve
        # retrieval without deciding fat level, egg variety, or chicken skin.
        if '鮮乳' in original:
            aliases.append('牛奶')
            for prefix, alias in [('全脂', '全脂牛奶'), ('低脂', '低脂牛奶'), ('脫脂', '脱脂牛奶')]:
                if original.startswith(prefix):
                    aliases.append(alias)
        if original.startswith('雞蛋(') or original in ['土雞蛋', '烏骨雞蛋']:
            aliases.append('鸡蛋')
        if '對切胸(肉雞)' in original:
            aliases.append('鸡胸肉')
        aliases = list(dict.fromkeys(alias for alias in aliases if alias != name))
        description = '' if row['CONTENT_DESC'] == 'NA' else convert(row['CONTENT_DESC'])
        food = {
            'id': 'tfda:' + record_id,
            'name': name,
            'aliases': aliases,
            'category': convert(row['FOOD_TYPE']),
            'state': state_for(original, row['CONTENT_DESC']),
            'description': description,
            'kcalPer100g': energy,
            'source': {'name': '台湾食品药物管理署食品营养成分资料集',
                       'url': OFFICIAL_URL, 'recordId': record_id, 'version': VERSION},
            'portions': [],
        }
        for source_key, destination in [('粗蛋白', 'proteinPer100g'), ('粗脂肪', 'fatPer100g'),
                                        ('總碳水化合物', 'carbsPer100g')]:
            value = number(row[source_key])
            if value is not None:
                food[destination] = value
        portion = number(row['PER_PORTION_WEIGHT'])
        if portion:
            # The mirror preserves a source unit weight but no unit noun.
            # Never relabel it as an egg, bowl, millilitre, or a personal serving.
            food['portions'].append({'unit': '参考单位', 'grams': portion,
                                     'label': f'来源参考单位（{portion:g}g可食部）',
                                     'estimated': True})
        foods.append(food)
    if len(foods) < 2000:
        raise ValueError('Source unexpectedly lost food records')
    return foods


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', type=Path, help='The pinned made/nutrition.csv file; otherwise download from GitHub')
    parser.add_argument('--release-id', default=LEGACY_RELEASE,
                        help='Immutable release identity. Existing different content is never overwritten; register each new release in food-catalog-releases.json and the runtime registry.')
    args = parser.parse_args()
    if not re.fullmatch(r'[a-z][a-z0-9]*(?:-[a-z0-9]+)+', args.release_id) or len(args.release_id) > 100:
        raise ValueError('Use a bounded lowercase release identity, for example tfda-2024-03-29')
    data = args.input.read_bytes() if args.input else urllib.request.urlopen(RAW_URL, timeout=60).read()
    if hashlib.sha256(data).hexdigest() != RAW_SHA256:
        raise ValueError('Pinned source SHA-256 mismatch; review provenance before updating the importer')
    foods = build(data)
    target = ROOT / 'data'
    target.mkdir(exist_ok=True)
    metadata = {
        'name': '台湾食品药物管理署食品营养成分资料集',
        'url': OFFICIAL_URL,
        'version': VERSION,
        'count': len(foods),
        'license': '政府资料开放授权条款第1版',
        'licenseUrl': 'https://data.gov.tw/license',
        'attribution': '原始资料：台湾卫生福利部食品药物管理署，依政府资料开放授权条款第1版提供。本目录进行了字段整理、简繁转换与别名补充；与提供机关无隶属或合作关系。',
        'description': '每100g可食部的参考营养值。来源为2024-03-29固定GitHub镜像快照，镜像未注明原始发布版本，不代表2026年最新资料。不同生熟状态、品种与烹调方式不可直接混用；未知营养字段留空。来源单位重未注明单位名称，因此仅标为参考单位，不自动当作一个、一碗或一毫升。',
        'energyField': '热量（kcal/100g），保留源“熱量”字段；没有混用“修正熱量”。',
        'snapshotDate': '2024-03-29',
        'upstreamRelease': None,
        'mirror': {'url': MIRROR, 'commit': COMMIT, 'file': 'made/nutrition.csv',
                   'rawUrl': RAW_URL, 'sha256': RAW_SHA256},
        'transformation': {'script': 'scripts/import-food-catalog.py',
                           'simplifiedChinese': 'OpenCC t2s / opencc-python-reimplemented 0.1.7'},
    }
    if args.release_id == LEGACY_RELEASE:
        catalog_path, source_path = target / 'food-catalog.json', target / 'food-catalog-source.json'
    else:
        target = target / 'food-catalog-releases'
        target.mkdir(exist_ok=True)
        catalog_path, source_path = target / (args.release_id + '.json'), target / (args.release_id + '.source.json')
        metadata['catalogRelease'] = args.release_id
    outputs = {catalog_path: json.dumps(foods, ensure_ascii=False, separators=(',', ':')) + '\n',
               source_path: json.dumps(metadata, ensure_ascii=False, indent=2) + '\n'}
    # Validate both destinations before writing either one. Old records, pending
    # operations and backups depend on these released values remaining unchanged.
    for path, content in outputs.items():
        if path.exists() and path.read_bytes() != content.encode('utf-8'):
            raise ValueError(f'Immutable release already exists: {path.name}; choose a new --release-id')
    for path, content in outputs.items():
        if not path.exists():
            path.write_text(content)
    print(f'Generated {len(foods)} foods from the verified pinned TFDA mirror')


if __name__ == '__main__':
    main()
