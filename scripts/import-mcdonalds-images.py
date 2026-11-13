#!/usr/bin/env python3
"""Archive the published product images without changing nutrition releases.

Run --download to fetch the exact Product.media_url objects; --check is offline.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import struct
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
RAW_PATH = ROOT / 'data/food-catalog-sources/mcd-cn-2025-04.raw.json'
MANIFEST_PATH = ROOT / 'data/food-catalog-images.json'
SOURCE_PAGE = 'https://www.mcdonalds.com.cn/nutrition_calculator'
IMAGE_BASE = 'https://officiaweb-afd.mcdonalds.com.cn/public/'
MAX_IMAGE_BYTES = 8 * 1024 * 1024


def digest(data):
    return hashlib.sha256(data).hexdigest()


def png_size(data):
    if len(data) < 33 or data[:8] != b'\x89PNG\r\n\x1a\n' or data[12:16] != b'IHDR':
        raise ValueError('Expected an original PNG image')
    width, height = struct.unpack('>II', data[16:24])
    if not (1 <= width <= 12000 and 1 <= height <= 12000):
        raise ValueError('Unsupported PNG dimensions')
    return width, height


def products():
    source = json.loads(RAW_PATH.read_text())
    result = []
    for product_id, product in source['Product'].items():
        media = product['media_url']
        if product['id'] != product_id or not re.fullmatch(r'upload/attachment/[0-9/]+\.png', media):
            raise ValueError('Unexpected official image path or identity')
        result.append((product_id, product, media))
    return result


def fetch(product_id, product, media):
    request = urllib.request.Request(IMAGE_BASE + media, headers={
        'Referer': SOURCE_PAGE,
        'User-Agent': 'Mozilla/5.0',
    })
    for attempt in range(3):
        try:
            with urllib.request.urlopen(request, timeout=25) as response:
                if response.url != request.full_url:
                    raise ValueError('Unexpected image redirect')
                data = response.read(MAX_IMAGE_BYTES + 1)
            if len(data) > MAX_IMAGE_BYTES:
                raise ValueError('Image exceeds supported size')
            width, height = png_size(data)
            local = f'/food-images/mcd-cn/{product_id}.png'
            destination = ROOT / 'public' / local.lstrip('/')
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(data)
            return {
                'productId': product_id, 'productTitle': product['title'],
                'foodIds': [f'mcd-cn:{product_id}:{variant}' for variant in product['ProductType']],
                'src': local, 'sourceUrl': request.full_url, 'mediaPath': media,
                'sha256': digest(data), 'bytes': len(data), 'width': width, 'height': height,
            }
        except Exception:
            if attempt == 2:
                raise
            time.sleep(attempt + 1)


def check(manifest):
    expected = products()
    if manifest['sourcePage'] != SOURCE_PAGE or manifest['sourceRawSha256'] != digest(RAW_PATH.read_bytes()):
        raise ValueError('Image source provenance changed')
    images = manifest['images']
    if len(images) != len(expected) or len({item['productId'] for item in images}) != len(images):
        raise ValueError('Image products missing or duplicated')
    by_product = {image['productId']: image for image in images}
    food_ids = []
    for product_id, product, media in expected:
        image = by_product[product_id]
        ids = [f'mcd-cn:{product_id}:{variant}' for variant in product['ProductType']]
        if image['productTitle'] != product['title'] or image['foodIds'] != ids:
            raise ValueError('Image product/variant mapping differs from official source')
        if image['src'] != f'/food-images/mcd-cn/{product_id}.png' or image['sourceUrl'] != IMAGE_BASE + media or image['mediaPath'] != media:
            raise ValueError('Image location differs from official source')
        data = (ROOT / 'public' / image['src'].lstrip('/')).read_bytes()
        if digest(data) != image['sha256'] or len(data) != image['bytes'] or png_size(data) != (image['width'], image['height']):
            raise ValueError('Archived image bytes or dimensions differ')
        food_ids.extend(ids)
    active = json.loads((ROOT / 'data/food-catalog-releases/mcd-only-2026-11-13-v1.json').read_text())
    if len(food_ids) != len(set(food_ids)) or set(food_ids) != set(active['foodIds']):
        raise ValueError('Images do not cover the current catalog exactly')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--download', action='store_true')
    mode.add_argument('--check', action='store_true')
    args = parser.parse_args()
    if args.download:
        expected = products()
        downloaded = {}
        failures = []
        with ThreadPoolExecutor(max_workers=4) as executor:
            futures = {executor.submit(fetch, *item): item[0] for item in expected}
            for future in as_completed(futures):
                product_id = futures[future]
                try:
                    downloaded[product_id] = future.result()
                except Exception as error:
                    failures.append(f'{product_id}: {error}')
        if failures:
            raise ValueError('Official images could not be archived: ' + '; '.join(failures))
        manifest = {
            'sourcePage': SOURCE_PAGE,
            'sourceRawFile': str(RAW_PATH.relative_to(ROOT)),
            'sourceRawSha256': digest(RAW_PATH.read_bytes()),
            'fetchedAtUtc': datetime.now(timezone.utc).isoformat(),
            'description': '麦当劳中国官网餐品原图；以官网 Product 和 ProductType 关系对应规格。不同规格可能共用同一张产品示意图，图片不代表实际份量。',
            'rightsNotice': '图片来源于麦当劳中国官网，仅用于对应餐品展示；未提供开放数据许可。',
            'images': [downloaded[product_id] for product_id, _, _ in expected],
        }
        check(manifest)
        MANIFEST_PATH.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
    manifest = json.loads(MANIFEST_PATH.read_text())
    check(manifest)
    print(json.dumps({'products': len(manifest['images']), 'specifications': sum(len(image['foodIds']) for image in manifest['images']), 'bytes': sum(image['bytes'] for image in manifest['images'])}))


if __name__ == '__main__':
    main()
