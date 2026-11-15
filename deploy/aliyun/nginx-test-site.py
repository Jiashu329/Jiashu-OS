#!/usr/bin/env python3
"""One-time Nginx integration inspector; never prints configuration values wholesale."""

import argparse
import fcntl
import glob
import hashlib
import json
import http.client
import os
from pathlib import Path
import re
import stat
import socket
import ssl
import subprocess
import sys
import tempfile
import time

CONFIG = Path('/etc/nginx/conf.d/www.treefund.asia.conf')
ALLOWED_INCLUDE_ROOTS = (Path('/etc/nginx'), Path('/opt/pharmcube-customer-relay/app'))
MAX_FILE_BYTES = 256 * 1024
MAX_FILES = 32
MAX_TOTAL_BYTES = 1024 * 1024
RELAY = Path('/opt/pharmcube-customer-relay/app/nginx-locations.conf')
NGINX = '/usr/sbin/nginx'
BACKUP_ROOT = Path('/opt/jiashu-test/nginx-backups')


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


def configuration_files():
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
                      'uid': info.st_uid, 'gid': info.st_gid, 'structure': summary(nodes),
                      '_source': data.decode('utf-8'), '_nodes': nodes, '_stat': info}
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
    return files


def run_nginx(arguments):
    result = subprocess.run([NGINX, *arguments], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL, timeout=15, check=False)
    if result.returncode or len(result.stdout) > 4 * 1024 * 1024:
        raise ConfigError('Nginx validation or reload failed.')
    return result.stdout


def direct(node, name):
    return [child for child in node['children'] or [] if child['name'] == name]


def one(node, name, args=None):
    found = direct(node, name)
    if len(found) != 1 or (args is not None and found[0]['args'] != args):
        raise ConfigError('Configuration differs from the reviewed template.')
    return found[0]


def validate_global(source, configured=False):
    servers = [node for node in walk(parse(source)) if node['name'] == 'server' and node['children'] is not None]
    if len(servers) != (4 if configured else 3):
        raise ConfigError('Unexpected global virtual host count.')
    target, defaults = [], []
    for server in servers:
        names = [arg for node in direct(server, 'server_name') for arg in node['args']]
        if any(name in ('treefund.asia', 'www.treefund.asia') for name in names):
            target.append(server)
        else:
            if names not in ([], ['_']) or not direct(server, 'listen'):
                raise ConfigError('Unexpected global virtual host.')
            for listen in direct(server, 'listen'):
                if listen['args'][0] not in ('80', '[::]:80') or any(arg not in ('80', '[::]:80', 'default_server') for arg in listen['args']):
                    raise ConfigError('Unexpected default virtual host.')
            defaults.append(server)
    if len(defaults) != 1 or len(target) != (3 if configured else 2):
        raise ConfigError('Unexpected matching virtual host count.')
    expected = [(('80',), ('treefund.asia', 'www.treefund.asia')),
                (('443', 'ssl'), ('treefund.asia',)), (('443', 'ssl'), ('www.treefund.asia',))] if configured else [
                    (('80',), ('treefund.asia', 'www.treefund.asia')),
                    (('443', 'ssl'), ('treefund.asia', 'www.treefund.asia'))]
    actual = [(tuple(one(server, 'listen')['args']), tuple(one(server, 'server_name')['args'])) for server in target]
    if sorted(actual) != sorted(expected):
        raise ConfigError('A duplicate or unexpected matching virtual host exists.')
    return [{'listen': list(listen), 'serverNames': list(names)} for listen, names in actual]


def proxy_location():
    return '''location / {
        proxy_pass http://127.0.0.1:3100;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header oai-authenticated-user-id "";
        proxy_set_header oai-authenticated-user-email "";
        proxy_set_header oai-authenticated-user-full-name "";
        proxy_set_header oai-authenticated-user-full-name-encoding "";
        proxy_cache off;
        client_max_body_size 18m;
        proxy_read_timeout 75s;
        proxy_send_timeout 75s;
    }'''


def replace_spans(source, replacements):
    for start, end, replacement in sorted(replacements, reverse=True):
        source = source[:start] + replacement + source[end:]
    return source


def build_patch(files):
    if set(files) != {str(CONFIG), str(RELAY)}:
        raise ConfigError('The include closure differs from the reviewed two files.')
    primary = files[str(CONFIG)]
    nodes, source = primary['_nodes'], primary['_source']
    if len(nodes) != 2 or any(node['name'] != 'server' or node['children'] is None or node['args'] for node in nodes):
        raise ConfigError('The reviewed pair of server blocks is required.')
    http, https = nodes
    if [node['name'] for node in http['children']] != ['listen', 'server_name', 'return']:
        raise ConfigError('HTTP redirect differs from the reviewed template.')
    one(http, 'listen', ['80']); one(http, 'server_name', ['treefund.asia', 'www.treefund.asia'])
    one(http, 'return', ['301', 'https://$host$request_uri'])
    expected_names = ['listen', 'http2', 'server_name', 'ssl_certificate', 'ssl_certificate_key',
                      'ssl_protocols', 'ssl_ciphers', 'root', 'index', 'include', 'location']
    if [node['name'] for node in https['children']] != expected_names:
        raise ConfigError('HTTPS routing differs from the reviewed template.')
    one(https, 'listen', ['443', 'ssl']); one(https, 'http2', ['on'])
    name = one(https, 'server_name', ['treefund.asia', 'www.treefund.asia'])
    one(https, 'ssl_certificate', ['/etc/nginx/ssl/www.treefund.asia.crt'])
    one(https, 'ssl_certificate_key', ['/etc/nginx/ssl/www.treefund.asia.key'])
    one(https, 'root', ['/var/www/my-homepage']); one(https, 'index', ['index.html', 'index.htm'])
    one(https, 'include', [str(RELAY)])
    location = one(https, 'location', ['/'])
    if len(location['children'] or []) != 1:
        raise ConfigError('Root location differs from the reviewed homepage.')
    one(location, 'try_files', ['$uri', '$uri/', '=404'])
    relay = files[str(RELAY)]['_nodes']
    if [node['name'] for node in relay] != ['location', 'location'] or [node['args'] for node in relay] != [
            ['=', '/pharmcube-crm-relay/v1/sharecrm'], ['=', '/pharmcube-crm-relay/health']]:
        raise ConfigError('Relay paths differ from the reviewed routes.')
    allowed_relay = {'client_max_body_size', 'proxy_http_version', 'proxy_set_header', 'proxy_connect_timeout',
                     'proxy_read_timeout', 'proxy_pass', 'access_log'}
    if any(child['name'] not in allowed_relay or child['children'] is not None for node in relay for child in node['children'] or []):
        raise ConfigError('Relay routing differs from the reviewed template.')
    base = https['start']
    original_block = source[base:https['end']]
    www = replace_spans(original_block, [(name['start'] - base, name['end'] - base, 'server_name www.treefund.asia;'),
                                        (location['start'] - base, location['end'] - base, proxy_location())])
    apex = replace_spans(original_block, [(name['start'] - base, name['end'] - base, 'server_name treefund.asia;')])
    return source[:base] + apex + '\n\n# Jiashu empty-data test site; existing apex and relay routes preserved.\n' + www + source[https['end']:]


def snapshot():
    files = configuration_files()
    global_bytes = run_nginx(['-T'])
    global_source = global_bytes.decode('utf-8', errors='strict')
    global_hash = hashlib.sha256(global_bytes).hexdigest()
    configured = False
    try:
        global_servers = validate_global(global_source)
    except ConfigError:
        global_servers = validate_global(global_source, configured=True)
        configured = True
    digest_input = {'version': 2, 'globalConfigSha256': global_hash,
                    'files': [{'path': path, 'sha256': files[path]['sha256']} for path in sorted(files)]}
    expected_hash = hashlib.sha256(json.dumps(digest_input, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    available = False
    if not configured:
        build_patch(files)
        available = True
    return files, {'version': 2, 'operation': 'inspect', 'scope': 'effective-nginx-and-recursive-vhost-includes',
                   'expectedHash': expected_hash, 'globalConfigSha256': global_hash,
                   'globalServers': global_servers, 'applyAvailable': available, 'configured': configured,
                   'files': [{key: value for key, value in files[path].items() if not key.startswith('_')} for path in sorted(files)]}


def inspect_config():
    return snapshot()[1]


def read_health(connection, commit):
    try:
        connection.request('GET', '/_selfhost/healthz', headers={'Host': 'www.treefund.asia', 'Connection': 'close'})
        response = connection.getresponse()
        body = response.read(16385)
        if response.status != 200 or len(body) > 16384:
            raise ConfigError('Application health check failed.')
        health = json.loads(body)
        if not isinstance(health, dict) or not isinstance(health.get('schema'), dict):
            raise ConfigError('Application health response is malformed.')
        schema = health.get('schema', {})
        if health.get('ok') is not True or health.get('commitSha') != commit or schema.get('schemaReady') is not True or type(schema.get('pending')) is not int or schema['pending'] != 0 or type(schema.get('total')) is not int or schema['total'] < 1 or type(schema.get('applied')) is not int or schema['applied'] != schema['total']:
            raise ConfigError('Application commit or schema is not ready.')
    finally:
        connection.close()


def check_app(commit):
    read_health(http.client.HTTPConnection('127.0.0.1', 3100, timeout=5), commit)
    connection = http.client.HTTPConnection('127.0.0.1', 3100, timeout=5)
    try:
        connection.request('GET', '/signin-with-chatgpt', headers={'Host': 'www.treefund.asia', 'Connection': 'close'})
        response = connection.getresponse()
        page = response.read(65537)
        if response.status != 200 or len(page) > 65536 or b'name="csrf"' not in page or b'name="password"' not in page:
            raise ConfigError('The application login form is not ready.')
    finally:
        connection.close()


class LocalTLSConnection(http.client.HTTPSConnection):
    def connect(self):
        raw = socket.create_connection(('127.0.0.1', 443), timeout=self.timeout)
        try:
            self.sock = self._context.wrap_socket(raw, server_hostname='www.treefund.asia')
        except Exception:
            raw.close()
            raise


def check_public_route(commit):
    last_error = None
    for _ in range(20):
        try:
            read_health(LocalTLSConnection('www.treefund.asia', timeout=3, context=ssl.create_default_context()), commit)
            return
        except (ConfigError, OSError, ValueError, http.client.HTTPException) as error:
            last_error = error
            time.sleep(0.25)
    raise ConfigError('HTTPS routing did not become healthy.') from last_error


def atomic_write(data, info):
    descriptor, temporary = tempfile.mkstemp(prefix='.jiashu-nginx-', suffix='.tmp', dir=CONFIG.parent)
    try:
        os.fchown(descriptor, info.st_uid, info.st_gid)
        os.fchmod(descriptor, stat.S_IMODE(info.st_mode))
        with os.fdopen(descriptor, 'wb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, CONFIG)
        directory = os.open(CONFIG.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def activate_config(patched, original, info, commit):
    try:
        atomic_write(patched, info)
        run_nginx(['-t'])
        run_nginx(['-s', 'reload'])
        check_public_route(commit)
    except Exception as error:
        try:
            atomic_write(original, info)
            run_nginx(['-t'])
            run_nginx(['-s', 'reload'])
        except Exception as rollback_error:
            raise ConfigError('Nginx integration failed and automatic rollback requires administrator attention.') from rollback_error
        raise ConfigError('Nginx integration failed; the previous configuration was restored and reloaded.') from error


def apply_config(expected_hash, commit, port):
    if os.geteuid() != 0 or port != 3100 or not re.fullmatch(r'[0-9a-f]{64}', expected_hash or '') or not re.fullmatch(r'[0-9a-f]{40}', commit or ''):
        raise ConfigError('Apply requires root and an exact reviewed snapshot, commit and port.')
    parent = BACKUP_ROOT.parent
    if not parent.is_dir() or parent.is_symlink() or parent.stat().st_uid != 0 or stat.S_IMODE(parent.stat().st_mode) & 0o077:
        raise ConfigError('The private managed application directory is required.')
    BACKUP_ROOT.mkdir(mode=0o700, exist_ok=True)
    if BACKUP_ROOT.is_symlink() or BACKUP_ROOT.stat().st_uid != 0 or stat.S_IMODE(BACKUP_ROOT.stat().st_mode) & 0o077:
        raise ConfigError('The backup directory must be private and owned by root.')
    # The deployment entrypoint takes this exact mutex too, so the image and
    # schema cannot change between the commit gate and the Nginx health probe.
    lock = os.open(parent / '.deploy.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(lock, 'w') as stream:
        fcntl.flock(stream, fcntl.LOCK_EX)
        files, details = snapshot()
        if details['expectedHash'] != expected_hash or not details['applyAvailable']:
            raise ConfigError('Configuration changed since inspection or was already configured.')
        check_app(commit)
        patched = build_patch(files).encode('utf-8')
        original = files[str(CONFIG)]['_source'].encode('utf-8')
        info = files[str(CONFIG)]['_stat']
        if info.st_uid != 0 or read_regular(CONFIG)[0] != original:
            raise ConfigError('The reviewed configuration changed before writing.')
        backup = BACKUP_ROOT / ('www.treefund.asia.' + files[str(CONFIG)]['sha256'] + '.conf.bak')
        try:
            descriptor = os.open(backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        except FileExistsError:
            if read_regular(backup)[0] != original or stat.S_IMODE(backup.stat().st_mode) != 0o600:
                raise ConfigError('An unexpected backup file exists.')
        else:
            with os.fdopen(descriptor, 'wb') as output:
                output.write(original); output.flush(); os.fsync(output.fileno())
        activate_config(patched, original, info, commit)
        return {'ok': True, 'operation': 'apply', 'commitSha': commit, 'port': port,
                'publicOrigin': 'https://www.treefund.asia', 'apexPreserved': True,
                'relayPreserved': True, 'backup': str(backup)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--inspect', action='store_true')
    mode.add_argument('--apply', action='store_true')
    parser.add_argument('--expected-hash')
    parser.add_argument('--expected-commit')
    parser.add_argument('--port', type=int, default=3100)
    args = parser.parse_args()
    try:
        result = inspect_config() if args.inspect else apply_config(args.expected_hash, args.expected_commit, args.port)
        print(json.dumps(result, sort_keys=True, separators=(',', ':')))
    except (ConfigError, OSError, UnicodeError, ValueError, http.client.HTTPException, subprocess.SubprocessError) as error:
        # ConfigError messages are fixed strings; never include arbitrary upstream output.
        message = str(error) if isinstance(error, ConfigError) else 'Nginx integration failed safely.'
        print(json.dumps({'ok': False, 'operation': 'inspect' if args.inspect else 'apply', 'error': message}), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
