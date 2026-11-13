#!/usr/bin/env python3
"""Reproduce the pinned Luckin catalog and verify official product images.

--write emits metadata from the pinned public source; --download also archives
its original images. --check is offline and verifies all generated content.
The snapshot intentionally contains one documented reference per product,
not a fabricated cross product of cup sizes, temperatures and sugar choices.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from pathlib import Path
import re
import struct
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
SOURCE_PAGE = 'https://lkcoffee.com/products'
SNAPSHOT_DATE = '2026-11-13'
SOURCE_NAME = '瑞幸咖啡中国官网产品信息'
SOURCE_VERSION = '2026-11-13官网快照（未注明营养更新日期）'
RELEASE_ID = 'luckin-cn-2026-11-13-v1'
RAW_FILE = Path('data/food-catalog-sources/luckin-cn-2026-11-13.raw.json')
RAW_SHA256 = 'e689b5455564f346f24522c693a9ffee99c4b4625dc3d000169132a47e9cb38f'
SOURCE_FILE = Path('data/food-catalog-sources/luckin-cn-2026-11-13.json')
RELEASE_FILE = Path('data/food-catalog-releases/luckin-cn-2026-11-13-v1.json')
IMAGE_FILE = Path('data/luckin-catalog-images.json')
CATEGORY_SLUGS = ['lattes', 'non-coffee', 'americanos', 'iced-teas', 'light-milk-teas', 'fruit-vegetable-teas', 'special-drinks', 'cold-brew-drinks']
NUMBER = r'(?:0|[1-9][0-9]*)(?:\.[0-9]+)?'
CALORIE = re.compile(r'热量\s*[:：]?\s*(?:约\s*)?(' + NUMBER + r')\s*kcal', re.I)


def require(condition, message):
    if not condition:
        raise ValueError(message)


def encode(value):
    return (json.dumps(value, ensure_ascii=False, indent=2) + '\n').encode()


def digest(value):
    return hashlib.sha256(value).hexdigest()


def number(value):
    result = float(value)
    return int(result) if result.is_integer() else result


def read_raw():
    data = (ROOT / RAW_FILE).read_bytes()
    require(digest(data) == RAW_SHA256, 'Pinned official source changed; publish a new release instead')
    raw = json.loads(data)
    require(raw['sourcePage'] == SOURCE_PAGE, 'Source origin changed')
    require([c['slug'] for c in raw['categories']] == CATEGORY_SLUGS, 'Source categories changed')
    products = [p for c in raw['categories'] for p in c['productList']]
    ids = [str(p['id']) for p in products]
    require(len(ids) == 28 and len(set(ids)) == 28 and set(ids) == set(raw['details']), 'Source products missing or duplicated')
    for category in raw['categories']:
        for p in category['productList']:
            require(set(p) == {'attrTags', 'categorySlug', 'id', 'mainImageUrl', 'productName', 'remarkDesc', 'slug', 'specSummary'}, 'Official product fields changed')
            require(isinstance(p['id'], int) and p['id'] > 0, 'Invalid official product identity')
            require(p['categorySlug'] == category['slug'] and re.fullmatch('[a-z0-9-]+', p['slug']), 'Invalid product category or slug')
            expected_url = SOURCE_PAGE + '/' + p['categorySlug'] + '/' + p['slug']
            require(raw['details'][str(p['id'])]['url'] == expected_url, 'Detail page does not match product')
    return raw


def nutrition_section(text):
    found = re.search(r'【营养成分与咖啡因】\s*(.*?)(?=【|\Z)', text, re.S)
    return found.group(1).strip() if found else ''


def first_group(pattern, text, flags=0):
    match = re.search(pattern, text, flags)
    return match.group(1).strip() if match else None


def reference(p, text):
    section = nutrition_section(text)
    label = first_group(r'以下营养成分及咖啡因数据适用于[：:]([^\n]+)', section)
    if not label:
        label = first_group(r'热量[^\n]+[（(]([^（）()]+)[）)]', p['remarkDesc'])
    if not label:
        label = first_group(r'热量[^\n]+[（(]([^（）()]+)[）)]', text)
    if not label:
        label = first_group(r'推荐点单[：:]([^\n]+)', p['remarkDesc'])
    if not label:
        label = first_group(r'【推荐点单】([^\n]+)', text)
    result = {'label': label}
    # Read explicit per-cup nutrition only. Marketing phrases such as 0脂 and
    # unrelated per-100mL values are never used to manufacture macro values.
    for key, chinese, unit in [('protein', '蛋白质', 'g'), ('fat', '脂肪', 'g'), ('carbs', '碳水化合物', 'g'), ('caffeineMg', '咖啡因', 'mg')]:
        value = first_group(r'(?:^|\n)' + chinese + r'\s*[:：]?\s*(?:约\s*)?(' + NUMBER + r')\s*' + unit + r'/杯', section)
        if value is not None:
            result[key] = number(value)
        elif key == 'caffeineMg':
            value = first_group(r'咖啡因\s*[:：]?\s*(?:约\s*)?(' + NUMBER + r')\s*mg', '\n'.join(p['specSummary']))
            if value is not None:
                result[key] = number(value)
    return result


def calories(p, text):
    candidates = CALORIE.findall('\n'.join(p['specSummary']))
    candidates += CALORIE.findall(p['remarkDesc'])
    candidates += re.findall(r'(?:^|\n)热量\s*[:：]?\s*(?:约\s*)?(' + NUMBER + r')\s*kcal/杯', nutrition_section(text), re.I)
    values = {number(value) for value in candidates}
    require(len(values) <= 1, f'Conflicting calorie declarations for {p["id"]}')
    return next(iter(values)) if values else None


def build(raw):
    foods, products = [], []
    for category in raw['categories']:
        for p in category['productList']:
            detail = raw['details'][str(p['id'])]
            text = detail['text']
            ref = reference(p, text)
            kcal = calories(p, text)
            label = ref['label'] or '官网未注明固定参考规格'
            name = '瑞幸' + p['productName'] + (f'［{label}］' if kcal is not None else '')
            require(len(name) <= 100, 'Product name exceeds supported length')
            source = {'name': SOURCE_NAME, 'url': detail['url'], 'recordId': str(p['id']), 'version': SOURCE_VERSION}
            notes = [p['remarkDesc']]
            section = nutrition_section(text)
            if section:
                notes.append(section)
            notes.append('仅适用于官网列明的参考配置；其他杯型、温度、咖啡豆、浓度或糖度不能沿用该数值。官网未注明营养数据更新日期。')
            item = {'id': 'luckin-cn:' + str(p['id']), 'name': name,
                    'aliases': ['瑞幸' + p['productName'], 'luckin ' + p['productName']],
                    'searchAliases': [p['productName']], 'category': category['categoryName'],
                    'state': '官网产品信息' if kcal is None else '中国大陆官网参考规格',
                    'description': '\n'.join(notes), 'source': source}
            if kcal is None:
                item.update({'basis': 'catalogOnly', 'reference': ref})
                products.append(item)
            else:
                serving = {'unit': '份', 'label': label, 'originalLabel': None,
                           'kcal': kcal, 'energyKj': None, 'energyBasis': 'officialKcal'}
                serving.update({key: value for key, value in ref.items() if key in ['protein', 'fat', 'carbs']})
                item.update({'basis': 'perServing', 'grams': None, 'kcalPer100g': None, 'portions': [], 'serving': serving})
                foods.append(item)
    require(len(foods) == 21 and len(products) == 7, 'Pinned official nutrition coverage changed')
    release = {'id': RELEASE_ID, 'publishedAt': SNAPSHOT_DATE,
               'description': '官网28款产品；21款按官网列明参考配置保留kcal，7款未公布热量仅供查阅。未展开没有独立营养依据的可选SKU。',
               'foods': foods, 'products': products}
    source = {'name': SOURCE_NAME, 'url': SOURCE_PAGE, 'version': SOURCE_VERSION,
              'count': 28, 'nutritionCount': 21, 'catalogOnlyCount': 7,
              'description': '官网产品信息快照：28款餐品，21款公布特定配置的单杯热量，7款未公布热量。杯型、冰热、咖啡豆、浓度和糖度须与官网列明配置一致；未为其他配置推算热量。',
              'snapshotDate': SNAPSHOT_DATE, 'upstreamRelease': None,
              'attribution': '瑞幸咖啡中国官网产品信息与对应产品详情；营养数据、产品图片及免责声明以官网为准。',
              'rightsNotice': '官网公开页面，未提供开放数据许可；不套用其他数据来源的许可。',
              'servingBasis': '每份表示官网列明参考配置的一杯；杯体容量提示不作为实际饮品克重，不转换为每100克数据。',
              'source': {'rawFile': str(RAW_FILE), 'rawSha256': RAW_SHA256, 'fetchedAtUtc': raw['fetchedAtUtc'],
                         'listingApi': 'https://lkcoffee.com/portalcapi/resource/portal/product/list',
                         'queryExample': {'pageNum': 1, 'pageSize': 12, 'categorySlug': 'lattes'}},
              'release': {'id': RELEASE_ID, 'file': str(RELEASE_FILE), 'sha256': digest(encode(release))},
              'transformation': {'script': 'scripts/import-luckin-catalog.py',
                                 'calories': '仅提取官方热量声明，kJ未知，不按4.184反算；宏量营养仅使用明确单杯营养字段。',
                                 'excluded': '未为可选杯型、糖度和温度生成未经公布的营养规格；未从0糖0脂营销描述推导营养值。'}}
    return release, source


def image_size(data):
    if data[:8] == b'\x89PNG\r\n\x1a\n' and data[12:16] == b'IHDR':
        return struct.unpack('>II', data[16:24])
    require(data[:2] == b'\xff\xd8', 'Official image is not PNG/JPEG')
    pos = 2
    while pos < len(data):
        require(data[pos] == 255, 'Invalid JPEG marker')
        while data[pos] == 255:
            pos += 1
        marker = data[pos]; pos += 1
        if marker in [0xD8, 0xD9] or 0xD0 <= marker <= 0xD7:
            continue
        size = struct.unpack('>H', data[pos:pos + 2])[0]
        if marker in [0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF]:
            height, width = struct.unpack('>HH', data[pos + 3:pos + 7])
            return width, height
        pos += size
    raise ValueError('Missing JPEG size')


def download_images(raw):
    def fetch(p):
        url = urllib.parse.urlsplit(p['mainImageUrl'])
        require(url.scheme == 'https' and url.hostname == 'img.luckincoffeecdn.com' and not url.query, 'Unexpected official image host')
        ext = url.path.rsplit('.', 1)[-1]
        require(ext in ['png', 'jpeg', 'jpg'], 'Unsupported official image extension')
        with urllib.request.urlopen(p['mainImageUrl'], timeout=30) as response:
            require(response.url == p['mainImageUrl'], 'Unexpected image redirect')
            data = response.read(8 * 1024 * 1024 + 1)
        require(len(data) <= 8 * 1024 * 1024, 'Official image too large')
        width, height = image_size(data)
        require(1 <= width <= 12000 and 1 <= height <= 12000, 'Unexpected image size')
        src = f'/food-images/luckin-cn/{p["id"]}.{ext}'
        local = ROOT / 'public' / src.lstrip('/')
        local.parent.mkdir(parents=True, exist_ok=True)
        local.write_bytes(data)
        return {'productId': str(p['id']), 'productTitle': p['productName'], 'foodIds': ['luckin-cn:' + str(p['id'])],
                'src': src, 'sourceUrl': p['mainImageUrl'], 'sha256': digest(data),
                'bytes': len(data), 'width': width, 'height': height}
    products = [p for c in raw['categories'] for p in c['productList']]
    with ThreadPoolExecutor(max_workers=4) as pool:
        images = list(pool.map(fetch, products))
    return {'sourcePage': SOURCE_PAGE, 'sourceRawFile': str(RAW_FILE), 'sourceRawSha256': RAW_SHA256,
            'fetchedAtUtc': raw['fetchedAtUtc'], 'description': '瑞幸中国官网对应产品原图，不代表实际杯型、容量或配方。',
            'rightsNotice': '官网未提供开放数据许可。', 'images': images}


def check_images(raw):
    manifest = json.loads((ROOT / IMAGE_FILE).read_text())
    expected = {str(p['id']): p for c in raw['categories'] for p in c['productList']}
    require(manifest['sourceRawSha256'] == RAW_SHA256 and manifest['sourcePage'] == SOURCE_PAGE, 'Image source changed')
    require(len(manifest['images']) == 28 and len({p['productId'] for p in manifest['images']}) == 28, 'Image products missing or duplicated')
    for image in manifest['images']:
        p = expected[image['productId']]
        ext = p['mainImageUrl'].rsplit('.', 1)[-1]
        require(image['src'] == f'/food-images/luckin-cn/{p["id"]}.{ext}' and image['sourceUrl'] == p['mainImageUrl'], 'Image identity changed')
        require(image['productTitle'] == p['productName'] and image['foodIds'] == ['luckin-cn:' + str(p['id'])], 'Image product mismatch')
        data = (ROOT / 'public' / image['src'].lstrip('/')).read_bytes()
        require(digest(data) == image['sha256'] and len(data) == image['bytes'], 'Image bytes changed')
        require(image_size(data) == (image['width'], image['height']), 'Image dimensions changed')
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--write', action='store_true')
    mode.add_argument('--download', action='store_true')
    mode.add_argument('--check', action='store_true')
    args = parser.parse_args()
    raw = read_raw()
    release, source = build(raw)
    if args.write or args.download:
        for path, value in [(RELEASE_FILE, release), (SOURCE_FILE, source)]:
            encoded = encode(value)
            require(not (ROOT / path).exists() or (ROOT / path).read_bytes() == encoded, 'Refusing to rewrite immutable generated source')
            (ROOT / path).write_bytes(encoded)
    for path, value in [(RELEASE_FILE, release), (SOURCE_FILE, source)]:
        require((ROOT / path).read_bytes() == encode(value), 'Generated catalog differs from pinned source: ' + str(path))
    if args.download:
        images = download_images(raw)
        encoded = encode(images)
        require(not (ROOT / IMAGE_FILE).exists() or (ROOT / IMAGE_FILE).read_bytes() == encoded, 'Refusing to rewrite immutable image manifest')
        (ROOT / IMAGE_FILE).write_bytes(encoded)
    images = check_images(raw) if args.check or args.download else None
    print(json.dumps({'foods': len(release['foods']), 'catalogOnly': len(release['products']), 'images': len(images['images']) if images else None}))


if __name__ == '__main__':
    main()
