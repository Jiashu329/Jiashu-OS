#!/usr/bin/env python3
"""One-time Nginx integration inspector; never prints configuration values wholesale."""

import argparse
import glob
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys

CONFIG = Path('/etc/nginx/conf.d/www.treefund.asia.conf')
ALLOWED_INCLUDE_ROOTS = (Path('/etc/nginx'), Path('/opt/pharmcube-customer-relay/app'))
MAX_FILE_BYTES = 256 * 1024
MAX_FILES = 32
MAX_TOTAL_BYTES = 1024 * 1024


class ConfigError(Exception):
    """Errors deliberately exclude arbitrary configuration content."""


def tokens(source):
    """Read Nginx punctuation, quoted arguments and comments without evaluating values."""
    result, index = [], 0
    while index < len(source):
        char = source[index]
        if char.isspace():
            index += 1
            continue
        if char == '#':
            end = source.find('\n', index)
            index = len(source) if end < 0 else end + 1
            continue
        if char in '{};':
            result.append((char, index, index + 1))
            index += 1
            continue
        start, value, quote = index, [], None
        while index < len(source):
            char = source[index]
            if char == '\\':
                if index + 1 >= len(source):
                    raise ConfigError('Unsupported trailing escape.')
                value.append(source[index + 1])
                index += 2
                continue
            if quote:
                if char == quote:
                    quote = None
                else:
                    value.append(char)
                index += 1
                continue
            if char in "\"'":
                quote = char
                index += 1
                continue
            if char == '$' and source[index:index + 2] == '${':
                end = source.find('}', index + 2)
                if end < 0:
                    raise ConfigError('Unclosed variable.')
                value.append(source[index:end + 1])
                index = end + 1
                continue
            if char.isspace() or char in '{};#':
                break
            value.append(char)
            index += 1
        if quote or index == start:
            raise ConfigError('Unsupported quoted argument.')
        result.append((''.join(value), start, index))
        if len(result) > 12000:
            raise ConfigError('Configuration has too many tokens.')
    return result


def parse(source):
    values, index = tokens(source), 0

    def block(depth=0):
        nonlocal index
        if depth > 16:
            raise ConfigError('Configuration nesting is too deep.')
        nodes = []
        while index < len(values):
            if values[index][0] == '}':
                if not depth:
                    raise ConfigError('Unexpected closing block.')
                index += 1
                return nodes
            head = []
            while index < len(values) and values[index][0] not in (';', '{', '}'):
                head.append(values[index])
                index += 1
            if not head or index == len(values) or values[index][0] == '}':
                raise ConfigError('Invalid directive boundary.')
            ending = values[index]
            index += 1
            children = block(depth + 1) if ending[0] == '{' else None
            nodes.append({'name': head[0][0], 'args': [item[0] for item in head[1:]],
                          'start': head[0][1], 'headEnd': ending[2],
                          'end': values[index - 1][2], 'children': children})
        if depth:
            raise ConfigError('Unclosed block.')
        return nodes

    return block()


def safe_value(name, value):
    # Public routes and certificate/config paths are useful for reviewing the
    # intended patch. Header values, key contents and arbitrary directive values
    # are never included in the inspection output.
    if not value or len(value) > 300 or any(ord(char) < 32 for char in value):
        return '<redacted>'
    if name == 'listen' and re.fullmatch(r'[A-Za-z0-9_.:\[\]=-]+', value):
        return value
    if name == 'server_name' and re.fullmatch(r'[A-Za-z0-9.*_-]+', value):
        return value
    if name in ('include', 'root', 'alias', 'ssl_certificate', 'ssl_certificate_key'):
        if value.startswith('/') and re.fullmatch(r'[A-Za-z0-9_./*?+-]+', value):
            return value
    if name in ('location', 'index', 'try_files'):
        if re.fullmatch(r'[A-Za-z0-9_$/{}/.=~^*?+|():\[\]\\-]+', value):
            return value
    if name == 'proxy_pass' and re.fullmatch(r'https?://(?:127\.0\.0\.1|localhost|\[::1\]):[0-9]+/?', value):
        return value
    if name == 'return':
        if re.fullmatch(r'[1-5][0-9]{2}', value):
            return value
        if re.fullmatch(r'https?://(?:\$host|\$server_name|(?:www\.)?treefund\.asia)(?:\$request_uri|/[A-Za-z0-9_./$-]*)?', value):
            return value
    return '<redacted>'


def summary(nodes):
    output = []
    for node in nodes:
        name = node['name'] if re.fullmatch(r'[A-Za-z0-9_]+', node['name']) else '<redacted>'
        item = {'directive': name, 'args': [safe_value(name, value) for value in node['args']]}
        if node['children'] is not None:
            item['children'] = summary(node['children'])
        output.append(item)
    return output


def walk(nodes):
    for node in nodes:
        yield node
        if node['children'] is not None:
            yield from walk(node['children'])


def read_regular(path):
    # Reject symlinks in the full chain; an apply operation will never follow a
    # changed configuration link to an unintended file.
    for parent in (path, *path.parents):
        if parent.is_symlink():
            raise ConfigError('Symlinked configuration paths are unsupported.')
    info = path.stat()
    if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_FILE_BYTES:
        raise ConfigError('Configuration is not a bounded regular file.')
    flags = os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0)
    descriptor = os.open(path, flags)
    with os.fdopen(descriptor, 'rb') as stream:
        data = stream.read(MAX_FILE_BYTES + 1)
    if len(data) > MAX_FILE_BYTES:
        raise ConfigError('Configuration exceeds its size bound.')
    return data, info


def inspect_config():
    files, pending, total = {}, [CONFIG], 0
    while pending:
        path = pending.pop(0)
        key = str(path)
        if key in files:
            continue
        if len(files) >= MAX_FILES:
            raise ConfigError('Too many configuration includes.')
        data, info = read_regular(path)
        total += len(data)
        if total > MAX_TOTAL_BYTES:
            raise ConfigError('Configuration closure exceeds its size bound.')
        nodes = parse(data.decode('utf-8', errors='strict'))
        files[key] = {'path': key, 'sha256': hashlib.sha256(data).hexdigest(),
                      'bytes': len(data), 'mode': oct(stat.S_IMODE(info.st_mode)),
                      'uid': info.st_uid, 'gid': info.st_gid, 'structure': summary(nodes)}
        for node in walk(nodes):
            if node['name'] != 'include':
                continue
            if len(node['args']) != 1:
                raise ConfigError('Unsupported include arguments.')
            pattern = Path(node['args'][0])
            if not pattern.is_absolute() or '..' in pattern.parts or pattern.suffix != '.conf':
                raise ConfigError('Only absolute configuration includes are supported.')
            if not any(pattern.is_relative_to(root) for root in ALLOWED_INCLUDE_ROOTS):
                raise ConfigError('An include lies outside the reviewed configuration roots.')
            matches = sorted(glob.glob(str(pattern)))
            if not matches and not any(char in str(pattern) for char in '*?['):
                raise ConfigError('A required include is missing.')
            pending.extend(Path(match) for match in matches)
    digest_input = {'version': 1, 'files': [{'path': path, 'sha256': files[path]['sha256']} for path in sorted(files)]}
    expected_hash = hashlib.sha256(json.dumps(digest_input, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    return {'version': 1, 'operation': 'inspect', 'scope': 'vhost-and-recursive-includes',
            'expectedHash': expected_hash, 'requiresGlobalConfigReview': True,
            'applyAvailable': False, 'files': [files[path] for path in sorted(files)]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--inspect', action='store_true', required=True)
    parser.parse_args()
    try:
        print(json.dumps(inspect_config(), sort_keys=True, separators=(',', ':')))
    except (ConfigError, OSError, UnicodeError):
        print(json.dumps({'ok': False, 'operation': 'inspect', 'error': 'Configuration inspection failed safely.'}), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
