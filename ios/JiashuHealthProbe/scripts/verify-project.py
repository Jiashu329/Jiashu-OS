#!/usr/bin/env python3
"""Validate the portable Xcode project structure without pretending to compile iOS code."""

from __future__ import annotations

import json
import plistlib
import re
import struct
import sys
import xml.etree.ElementTree as ET
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SOURCE_NAMES = {path.name for path in (ROOT / 'Sources').glob('*.swift')}
OBJECT_ID = re.compile(r'^[A-F0-9]{24}$')
TOKEN = re.compile(r'\s+|//[^\n]*|/\*.*?\*/|"(?:\\.|[^"\\])*"|[{}()=;,]|[^\s{}()=;,]+', re.S)


def parse_openstep(source: str):
    tokens = []
    position = 0
    while position < len(source):
        match = TOKEN.match(source, position)
        if not match:
            raise ValueError(f'Cannot parse project at byte {position}')
        token = match.group()
        position = match.end()
        if not token.isspace() and not token.startswith(('//', '/*')):
            tokens.append(token)
    index = 0

    def take(expected=None):
        nonlocal index
        if index >= len(tokens):
            raise ValueError(f'Unexpected end; expected {expected!r}')
        token = tokens[index]
        index += 1
        if expected is not None and token != expected:
            raise ValueError(f'Expected {expected!r}, got {token!r}')
        return token

    def scalar(token):
        return json.loads(token) if token.startswith('"') else token

    def value():
        token = take()
        if token == '{':
            result = {}
            while tokens[index] != '}':
                key = scalar(take())
                if key in result:
                    raise ValueError(f'Duplicate project key: {key}')
                take('=')
                result[key] = value()
                take(';')
            take('}')
            return result
        if token == '(':
            result = []
            while tokens[index] != ')':
                result.append(value())
                if tokens[index] != ')':
                    take(',')
            take(')')
            return result
        if token in '}=;,':
            raise ValueError(f'Unexpected token: {token}')
        return scalar(token)

    parsed = value()
    if index != len(tokens):
        raise ValueError('Extra data after project root')
    return parsed


def check(condition, message):
    if not condition:
        raise AssertionError(message)


def main():
    project_path = ROOT / 'JiashuHealthProbe.xcodeproj/project.pbxproj'
    project = parse_openstep(project_path.read_text())
    objects = project['objects']
    check(all(OBJECT_ID.fullmatch(key) for key in objects), 'Invalid project object ID')
    check(objects[project['rootObject']]['isa'] == 'PBXProject', 'Invalid root object')

    def verify_references(node):
        if isinstance(node, dict):
            for key, item in node.items():
                if OBJECT_ID.fullmatch(key):
                    check(key in objects, f'Unresolved project object key: {key}')
                verify_references(item)
        elif isinstance(node, list):
            for item in node:
                verify_references(item)
        elif isinstance(node, str) and OBJECT_ID.fullmatch(node):
            check(node in objects, f'Unresolved project object: {node}')

    verify_references(objects)
    root = objects[project['rootObject']]
    found_source_files = set()

    def verify_files(object_id, directory, ancestors=()):
        check(object_id not in ancestors, 'Cycle in the Xcode project group tree')
        item = objects[object_id]
        tree = item.get('sourceTree')
        if tree in ('SDKROOT', 'BUILT_PRODUCTS_DIR'):
            return
        path = directory / item.get('path', '')
        if item['isa'] == 'PBXGroup':
            for child in item['children']:
                verify_files(child, path, ancestors + (object_id,))
        elif item['isa'] == 'PBXFileReference':
            check(path.exists(), f'Missing project file: {path.relative_to(ROOT)}')
            if path.suffix == '.swift' and path.parent.name == 'Sources':
                found_source_files.add(path.name)

    verify_files(root['mainGroup'], ROOT)
    check(found_source_files == SOURCE_NAMES, 'App source file references do not match the intended files')
    targets = {objects[key]['name']: objects[key] for key in root['targets']}
    check(set(targets) == {'JiashuHealthProbe', 'JiashuHealthProbeTests'}, 'Missing app or unit-test target')
    app = targets['JiashuHealthProbe']
    phases = [objects[key] for key in app['buildPhases']]
    sources_phase = next(item for item in phases if item['isa'] == 'PBXSourcesBuildPhase')
    compiled = {objects[objects[key]['fileRef']]['path'] for key in sources_phase['files']}
    check(compiled == SOURCE_NAMES, 'A Swift file is missing from the app Sources build phase')
    configurations = objects[app['buildConfigurationList']]['buildConfigurations']
    for key in configurations:
        settings = objects[key]['buildSettings']
        check(settings['CODE_SIGN_STYLE'] == 'Automatic', 'Automatic signing is not enabled')
        check(settings['CODE_SIGN_ENTITLEMENTS'] == 'Config/JiashuHealthProbe.entitlements', 'HealthKit entitlement is not used')
        check(settings['INFOPLIST_FILE'] == 'Config/Info.plist', 'App privacy plist is not used')
        check(settings['TARGETED_DEVICE_FAMILY'] == '1', 'App should target iPhone')

    with (ROOT / 'Config/Info.plist').open('rb') as handle:
        info = plistlib.load(handle)
    check(bool(info.get('NSHealthShareUsageDescription')), 'Missing health-read purpose string')
    check(bool(info.get('NSHealthUpdateUsageDescription')), 'Missing HealthKit authorization purpose key')
    check('healthkit' in info.get('UIRequiredDeviceCapabilities', []), 'Missing HealthKit device capability')
    with (ROOT / 'Config/JiashuHealthProbe.entitlements').open('rb') as handle:
        entitlements = plistlib.load(handle)
    check(entitlements == {'com.apple.developer.healthkit': True, 'com.apple.developer.healthkit.background-delivery': True}, 'Unexpected HealthKit entitlements')
    test_phases = [objects[key] for key in targets['JiashuHealthProbeTests']['buildPhases']]
    test_sources = next(item for item in test_phases if item['isa'] == 'PBXSourcesBuildPhase')
    compiled_tests = {objects[objects[key]['fileRef']]['path'] for key in test_sources['files']}
    check(compiled_tests == {path.name for path in (ROOT / 'Tests').glob('*.swift')}, 'A test file is missing from the test target')

    scheme_path = ROOT / 'JiashuHealthProbe.xcodeproj/xcshareddata/xcschemes/JiashuHealthProbe.xcscheme'
    scheme = ET.parse(scheme_path).getroot()
    for reference in scheme.iter('BuildableReference'):
        target = objects[reference.attrib['BlueprintIdentifier']]
        check(target['isa'] == 'PBXNativeTarget', 'Scheme references a non-target')
        check(target['name'] == reference.attrib['BlueprintName'], 'Scheme target name mismatch')
    check(scheme.find('TestAction/Testables/TestableReference') is not None, 'Shared scheme has no unit tests')

    asset_directory = ROOT / 'Resources/Assets.xcassets/AppIcon.appiconset'
    assets = json.loads((asset_directory / 'Contents.json').read_text())
    icons = [item for item in assets['images'] if item.get('filename')]
    check(bool(icons), 'App icon catalog has no image')
    for icon in icons:
        data = (asset_directory / icon['filename']).read_bytes()
        check(data[:8] == b'\x89PNG\r\n\x1a\n', 'App icon is not a PNG')
        width, height, depth, color = struct.unpack('>IIBB', data[16:26])
        check((width, height, depth) == (1024, 1024, 8), 'App icon must be 1024×1024 with 8-bit channels')
        check(color == 2, 'App icon must be opaque RGB')

    print(f'PASS: {len(objects)} project objects; all file references resolve; app/test targets and scheme are consistent.')
    print('PASS: HealthKit read/background entitlements, iPhone target and opaque 1024×1024 icon.')
    print('LIMIT: This is a structural check, not an Xcode build or a HealthKit device test.')


if __name__ == '__main__':
    try:
        main()
    except (AssertionError, KeyError, ValueError, IndexError, OSError) as error:
        print(f'FAIL: {error}', file=sys.stderr)
        raise SystemExit(1)
