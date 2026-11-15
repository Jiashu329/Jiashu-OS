#!/usr/bin/env python3
"""Inspect explicitly retired homepage/CRM services without displaying their contents."""

import argparse
import fcntl
import hashlib
import http.client
import importlib.util
import ipaddress
import json
import os
from pathlib import Path
import re
import shutil
import socket
import ssl
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
from urllib.parse import urlsplit

OLD_CRM = Path('/opt/pharmcube-customer-relay')
OLD_HOMEPAGE = Path('/var/www/my-homepage')
UNIT_ROOT = Path('/etc/systemd/system')
VHOST = Path('/etc/nginx/conf.d/www.treefund.asia.conf')
RELAY_INCLUDE = OLD_CRM / 'app/nginx-locations.conf'
APP_ROOT = Path('/opt/jiashu-test')
MAIN_NGINX = Path('/etc/nginx/nginx.conf')
RETIRED_UNIT = 'pharmcube-sharecrm-relay.service'
RETIRED_UNIT_PATH = UNIT_ROOT / RETIRED_UNIT
REVIEWED_UNIT_SHA = 'b20ececd6ce41291724bd06c60b1678541ed4eea88d85743ca08a5e090b18c15'
REVIEWED_ROOTS = {str(OLD_HOMEPAGE): (64771, 1046975), str(OLD_CRM): (64771, 262052)}
UNIT_NAME = re.compile(r'[A-Za-z0-9_.@:-]+\.(?:service|socket|timer|path)\Z')
SAFE_TOP_NAMES = {'app', 'src', 'dist', 'public', 'static', 'assets', 'node_modules', '.git', '.env', '.env.example',
                  'package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'Dockerfile', 'compose.yml',
                  'docker-compose.yml', 'index.html', 'index.htm', 'README.md', 'nginx-locations.conf',
                  'server.js', 'server.mjs', 'server.py', 'requirements.txt', 'logs', 'data', 'backups'}


class InspectError(Exception):
    pass


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def safe_text(value, limit=400):
    return ''.join(char if ord(char) >= 32 and ord(char) != 127 else '\ufffd' for char in value)[:limit]


def metadata(info):
    kind = 'symlink' if stat.S_ISLNK(info.st_mode) else 'directory' if stat.S_ISDIR(info.st_mode) else 'file' if stat.S_ISREG(info.st_mode) else 'other'
    return {'kind': kind, 'mode': oct(stat.S_IMODE(info.st_mode)), 'uid': info.st_uid, 'gid': info.st_gid,
            'bytes': info.st_size, 'mtimeNs': info.st_mtime_ns, 'ctimeNs': info.st_ctime_ns,
            'inode': info.st_ino, 'device': info.st_dev}


def bounded_read(path, limit=256 * 1024):
    descriptor = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
    with os.fdopen(descriptor, 'rb') as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size > limit:
            raise InspectError('An inspected file exceeds its regular-file bound.')
        content = stream.read(limit + 1)
    if len(content) > limit:
        raise InspectError('An inspected file exceeds its size bound.')
    return content, info


def upstream_origin(value):
    # Only the origin survives; credentials, paths, queries and fragments never do.
    value = value.strip().strip('\"\'')
    if '$' in value or any(ord(char) < 32 for char in value):
        return '<redacted>'
    try:
        parsed = urlsplit(value)
        host, port = parsed.hostname, parsed.port
        if parsed.scheme not in ('http', 'https') or not host:
            return '<redacted>'
        if ':' in host:
            ipaddress.IPv6Address(host)
            host = '[' + host + ']'
        elif not re.fullmatch(r'[A-Za-z0-9.-]+', host):
            return '<redacted>'
        return parsed.scheme + '://' + host + (':' + str(port) if port is not None else '')
    except ValueError:
        return '<redacted>'


def inspect_nginx():
    result = subprocess.run(['/usr/sbin/nginx', '-T'], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL, check=False, timeout=15)
    if result.returncode or len(result.stdout) > 4 * 1024 * 1024:
        raise InspectError('The active Nginx configuration could not be inspected.')
    files, origins = [], []
    for path in (VHOST, RELAY_INCLUDE):
        if not path.exists():
            files.append({'path': str(path), 'exists': False})
            continue
        content, info = bounded_read(path)
        files.append({'path': str(path), 'exists': True, 'sha256': hashlib.sha256(content).hexdigest(), **metadata(info)})
        if path == RELAY_INCLUDE:
            text = content.decode('utf-8', errors='replace')
            origins = sorted({upstream_origin(value) for value in re.findall(r'^\s*proxy_pass\s+([^;\r\n]{1,1000});', text, re.MULTILINE)})
    return {'globalConfigSha256': hashlib.sha256(result.stdout).hexdigest(), 'files': files,
            'relayUpstreamOrigins': origins}


def unit_for_path(path):
    if path.parent == UNIT_ROOT and UNIT_NAME.fullmatch(path.name):
        return path.name
    if path.parent.parent == UNIT_ROOT and path.parent.name.endswith('.d'):
        name = path.parent.name[:-2]
        if path.suffix == '.conf' and UNIT_NAME.fullmatch(name):
            return name
    return None


def unit_state(unit):
    result = subprocess.run(['systemctl', 'show', '--no-pager',
                             '--property=ActiveState,SubState,UnitFileState', '--', unit],
                            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                            check=False, timeout=5)
    if result.returncode or len(result.stdout) > 8192:
        return {'inspectionAvailable': False}
    allowed = {'ActiveState', 'SubState', 'UnitFileState'}
    values = {}
    for line in result.stdout.decode('utf-8', errors='replace').splitlines():
        key, separator, value = line.partition('=')
        if separator and key in allowed:
            values[key] = value if re.fullmatch(r'[a-z-]{0,40}', value) else '<redacted>'
    return {'inspectionAvailable': True, **values}


def inspect_units():
    records, referenced, total, complete = [], {}, 0, True
    if UNIT_ROOT.is_symlink() or not UNIT_ROOT.is_dir():
        raise InspectError('The custom systemd unit directory is unavailable or symlinked.')
    # Do not follow wants/requires links into OS unit directories. Only installed
    # custom files and their immediate drop-ins can establish ownership candidates.
    paths = sorted(UNIT_ROOT.iterdir())
    for directory in list(paths):
        if directory.name.endswith('.d') and not directory.is_symlink() and directory.is_dir():
            paths.extend(sorted(directory.iterdir()))
    for path in paths:
        unit = unit_for_path(path)
        if not unit:
            continue
        if len(records) >= 512:
            complete = False
            break
        info = path.lstat()
        record = {'path': str(path), 'unit': unit, **metadata(info)}
        content = None
        if stat.S_ISLNK(info.st_mode):
            target = os.readlink(path)
            record['linkTargetSha256'] = hashlib.sha256(os.fsencode(target)).hexdigest()
            # A unit link into the old application is only a candidate. Never
            # follow links to read arbitrary system files or environment files.
            record['referencesOldRoot'] = str(OLD_CRM) in target
            if record['referencesOldRoot']:
                referenced.setdefault(unit, set()).add('unit-symlink')
        elif stat.S_ISREG(info.st_mode):
            content, _ = bounded_read(path)
            total += len(content)
            if total > 4 * 1024 * 1024:
                complete = False
                break
            record['sha256'] = hashlib.sha256(content).hexdigest()
            record['referencesOldRoot'] = os.fsencode(str(OLD_CRM)) in content
            if record['referencesOldRoot']:
                kinds = referenced.setdefault(unit, set())
                kinds.add('file-path-reference')
                # Only directive names are retained. Comment/description matches
                # remain visibly unproven ownership candidates for the next review.
                for line in content.decode('utf-8', errors='replace').splitlines():
                    if str(OLD_CRM) not in line:
                        continue
                    key, equals, _value = line.strip().partition('=')
                    if equals and re.fullmatch(r'[A-Za-z][A-Za-z0-9]{0,60}', key):
                        kinds.add(key)
        else:
            record['unsupportedType'] = True
            complete = False
        records.append(record)
    candidates = []
    for unit in sorted(referenced):
        candidates.append({'unit': unit, 'candidateOnly': True, 'referenceKinds': sorted(referenced[unit]),
                           'files': [record for record in records if record['unit'] == unit], 'state': unit_state(unit)})
    return {'root': str(UNIT_ROOT), 'complete': complete, 'scannedFiles': len(records),
            'filesSha256': digest(records), 'installedCustomUnitFiles': records, 'candidates': candidates}


def inspect_processes():
    candidates, scanned, complete = [], 0, True
    old_bytes = os.fsencode(str(OLD_CRM))
    for path in sorted(Path('/proc').iterdir(), key=lambda item: item.name):
        if not path.name.isdecimal():
            continue
        scanned += 1
        if scanned > 8192:
            complete = False
            break
        try:
            cwd = os.readlink(path / 'cwd')
            with (path / 'cmdline').open('rb') as stream:
                command = stream.read(65536)
            if str(OLD_CRM) not in cwd and old_bytes not in command:
                continue
            with (path / 'comm').open('rb') as stream:
                name = stream.read(256).decode('utf-8', errors='replace').strip()
            candidates.append({'pid': int(path.name), 'name': safe_text(name, 80), 'cwd': safe_text(cwd)})
        except (FileNotFoundError, ProcessLookupError, PermissionError):
            continue
    return {'complete': complete, 'scannedPids': min(scanned, 8192), 'candidates': candidates}


def inspect_old_root(root):
    if not root.exists() and not root.is_symlink():
        return {'path': str(root), 'exists': False, 'complete': True}
    info = root.lstat()
    if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode):
        return {'path': str(root), 'exists': True, 'complete': False, 'root': metadata(info)}
    entries, top, counts, total_bytes = [], [], {'files': 0, 'directories': 0, 'symlinks': 0, 'other': 0}, 0
    pending, complete, errors, other_top, deadline = [root], True, 0, 0, time.monotonic() + 8
    while pending:
        directory = pending.pop()
        try:
            children = sorted(os.scandir(directory), key=lambda item: item.name)
        except OSError:
            errors += 1; complete = False
            continue
        for child in children:
            if len(entries) >= 100000 or time.monotonic() > deadline:
                complete = False
                pending.clear()
                break
            try:
                current = child.stat(follow_symlinks=False)
                record = {'relativePath': str(Path(child.path).relative_to(root)), **metadata(current)}
                if stat.S_ISLNK(current.st_mode):
                    counts['symlinks'] += 1
                    record['linkTargetSha256'] = hashlib.sha256(os.fsencode(os.readlink(child.path))).hexdigest()
                elif stat.S_ISDIR(current.st_mode):
                    counts['directories'] += 1
                    if current.st_dev == info.st_dev:
                        pending.append(Path(child.path))
                    else:
                        record['differentFilesystem'] = True
                        complete = False
                elif stat.S_ISREG(current.st_mode):
                    counts['files'] += 1
                    total_bytes += current.st_size
                else:
                    counts['other'] += 1
                entries.append(record)
                if directory == root:
                    if child.name in SAFE_TOP_NAMES:
                        top.append({'name': child.name, **metadata(current)})
                    else:
                        other_top += 1
            except OSError:
                errors += 1; complete = False
    entries.sort(key=lambda item: item['relativePath'])
    return {'path': str(root), 'exists': True, 'complete': complete, 'root': metadata(info),
            'entries': len(entries), 'counts': counts, 'fileBytes': total_bytes, 'errors': errors,
            'metadataSha256': digest(entries), 'topFiles': sorted(top, key=lambda item: item['name']),
            'otherTopLevelEntries': other_top, 'contentRead': False, 'followsSymlinks': False}


def inspect_retired():
    nginx, units, processes = inspect_nginx(), inspect_units(), inspect_processes()
    roots = [inspect_old_root(root) for root in (OLD_HOMEPAGE, OLD_CRM)]
    fingerprint = {'version': 1, 'nginx': nginx, 'unitFilesSha256': units['filesSha256'],
                   'unitCandidates': units['candidates'], 'processCandidates': processes['candidates'], 'oldRoots': roots}
    result = {'version': 1, 'operation': 'inspect-retired', 'readOnly': True, 'applyAvailable': False,
            'expectedHash': digest(fingerprint), 'complete': units['complete'] and processes['complete'] and all(root['complete'] for root in roots),
            'nginx': nginx, 'units': units, 'processes': processes, 'oldRoots': roots,
            'ownershipNote': 'Path references identify candidates; exact unit ownership must be reviewed before retirement.'}
    # The final v2 operation is delivered with the reviewed Nginx helper in the
    # same private directory. Legacy stdin inspection remains read-only v1.
    if Path(__file__).with_name('nginx-test-site.py').is_file():
        try:
            plan, _private = retirement_plan()
            result.update(version=2, expectedHash=digest(plan), retirementPlan=plan, applyAvailable=True)
        except (InspectError, OSError, UnicodeError, ValueError, web_helper().ConfigError):
            result.update(version=2, applyAvailable=False, planStatus='New www deployment or retirement preconditions are not ready.')
    return result


def web_helper():
    if not hasattr(web_helper, 'module'):
        path = Path(__file__).with_name('nginx-test-site.py')
        if not path.is_file():
            raise InspectError('The reviewed Nginx helper must accompany this script.')
        specification = importlib.util.spec_from_file_location('retirement_nginx', path)
        module = importlib.util.module_from_spec(specification)
        specification.loader.exec_module(module)
        web_helper.module = module
    return web_helper.module


def semantic(nodes):
    return [(node['name'], node['args'], semantic(node['children']) if node['children'] is not None else None) for node in nodes]


def retirement_nginx_patch(main_source, vhost_source):
    web = web_helper()
    servers = web.parse(vhost_source)
    if len(servers) != 3 or any(node['name'] != 'server' or node['args'] for node in servers):
        raise InspectError('The verified split apex/www deployment is required.')
    http, apex, www = servers
    web.one(http, 'listen', ['80']); web.one(http, 'server_name', ['treefund.asia', 'www.treefund.asia'])
    redirect = web.one(http, 'return', ['301', 'https://$host$request_uri'])
    if [node['name'] for node in http['children']] != ['listen', 'server_name', 'return']:
        raise InspectError('Unexpected HTTP routing.')
    expected = ['listen', 'http2', 'server_name', 'ssl_certificate', 'ssl_certificate_key', 'ssl_protocols',
                'ssl_ciphers', 'root', 'index', 'include', 'location']
    replacements = [(redirect['start'], redirect['end'], 'return 301 https://www.treefund.asia$request_uri;')]
    for server, hostname in ((apex, 'treefund.asia'), (www, 'www.treefund.asia')):
        if [node['name'] for node in server['children']] != expected:
            raise InspectError('Unexpected HTTPS routing.')
        web.one(server, 'listen', ['443', 'ssl']); web.one(server, 'http2', ['on'])
        web.one(server, 'server_name', [hostname])
        web.one(server, 'ssl_certificate', ['/etc/nginx/ssl/www.treefund.asia.crt'])
        web.one(server, 'ssl_certificate_key', ['/etc/nginx/ssl/www.treefund.asia.key'])
        for directive, arguments in (('root', [str(OLD_HOMEPAGE)]), ('index', ['index.html', 'index.htm']), ('include', [str(RELAY_INCLUDE)])):
            node = web.one(server, directive, arguments)
            replacements.append((node['start'], node['end'], ''))
        location = web.one(server, 'location', ['/'])
        if hostname == 'treefund.asia':
            if semantic(location['children']) != semantic(web.parse('try_files $uri $uri/ =404;')):
                raise InspectError('Unexpected apex homepage routing.')
            replacements.append((location['start'], location['end'], 'return 301 https://www.treefund.asia$request_uri;'))
        elif semantic([location]) != semantic(web.parse(web.proxy_location())):
            raise InspectError('The www application proxy differs from the verified template.')
    patched_vhost = web.replace_spans(vhost_source, replacements)
    defaults = [node for node in web.walk(web.parse(main_source)) if node['name'] == 'server' and node['children'] is not None]
    if len(defaults) != 1:
        raise InspectError('The main Nginx configuration has unexpected default servers.')
    default = defaults[0]
    names = [arg for node in web.direct(default, 'server_name') for arg in node['args']]
    if names not in ([], ['_']) or not web.direct(default, 'listen') or web.direct(default, 'return'):
        raise InspectError('Unexpected default HTTP server.')
    for node in web.direct(default, 'listen'):
        if not node['args'] or node['args'][0] not in ('80', '[::]:80') or any(arg not in ('80', '[::]:80', 'default_server') for arg in node['args']):
            raise InspectError('Unexpected default listener.')
    old_root = web.one(default, 'root', [str(OLD_HOMEPAGE)])
    patched_main = web.replace_spans(main_source, [(old_root['start'], old_root['end'], 'return 301 https://www.treefund.asia$request_uri;')])
    for source in (patched_main, patched_vhost):
        if any(str(root) in argument for root in (OLD_HOMEPAGE, OLD_CRM) for node in web.walk(web.parse(source)) for argument in node['args']):
            raise InspectError('A surviving Nginx directive still references an old application.')
    return patched_main, patched_vhost


def precise_enable_links():
    records = []
    for path in sorted(UNIT_ROOT.glob('*.' + 'wants/' + RETIRED_UNIT)) + sorted(UNIT_ROOT.glob('*.requires/' + RETIRED_UNIT)):
        if path.parent.is_symlink() or not path.is_symlink() or path.resolve() != RETIRED_UNIT_PATH:
            raise InspectError('An unexpected enable link exists for the retired unit.')
        records.append({'path': str(path), 'target': os.readlink(path)})
    if not records:
        raise InspectError('The reviewed enabled unit has no precise enable link.')
    return records


def no_mounts_in_old_roots():
    with Path('/proc/self/mountinfo').open() as stream:
        for line in stream:
            fields = line.split()
            if len(fields) < 5:
                raise InspectError('Mount metadata is malformed.')
            mount = re.sub(r'\\([0-7]{3})', lambda match: chr(int(match[1], 8)), fields[4])
            if any(mount == str(root) or mount.startswith(str(root) + '/') for root in (OLD_HOMEPAGE, OLD_CRM)):
                raise InspectError('A mount exists inside a retired tree.')


def retirement_plan():
    web = web_helper()
    files, nginx = web.snapshot()
    if not nginx['configured']:
        raise InspectError('The new www site must be configured and verified first.')
    unit_content, unit_info = bounded_read(RETIRED_UNIT_PATH)
    if hashlib.sha256(unit_content).hexdigest() != REVIEWED_UNIT_SHA or unit_info.st_uid != 0 or stat.S_IMODE(unit_info.st_mode) != 0o644:
        raise InspectError('The retired unit differs from its reviewed identity.')
    dropin = UNIT_ROOT / (RETIRED_UNIT + '.d')
    if dropin.exists() or dropin.is_symlink():
        raise InspectError('Unexpected drop-ins exist for the retired unit.')
    units = inspect_units()
    if not units['complete'] or [candidate['unit'] for candidate in units['candidates']] != [RETIRED_UNIT]:
        raise InspectError('The retired unit candidate set changed.')
    main_content, main_info = bounded_read(MAIN_NGINX)
    main_patch, vhost_patch = retirement_nginx_patch(main_content.decode('utf-8'), files[str(VHOST)]['_source'])
    roots = []
    for root in (OLD_HOMEPAGE, OLD_CRM):
        for ancestor in (root, *root.parents):
            if ancestor.is_symlink():
                raise InspectError('A retired root has a symlinked ancestor.')
        info = root.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or (info.st_dev, info.st_ino) != REVIEWED_ROOTS[str(root)]:
            raise InspectError('A retired root differs from its reviewed filesystem identity.')
        roots.append({'path': str(root), 'device': info.st_dev, 'inode': info.st_ino, 'uid': info.st_uid})
    no_mounts_in_old_roots()
    links = precise_enable_links()
    plan = {'version': 2, 'unit': RETIRED_UNIT, 'unitSha256': REVIEWED_UNIT_SHA, 'enableLinks': links, 'oldRoots': roots,
            'globalConfigSha256': nginx['globalConfigSha256'],
            'configFiles': [{'path': str(MAIN_NGINX), 'sha256': hashlib.sha256(main_content).hexdigest()},
                            *[{'path': path, 'sha256': files[path]['sha256']} for path in sorted(files)]]}
    private = {'originals': {MAIN_NGINX: (main_content, main_info), VHOST: (files[str(VHOST)]['_source'].encode(), files[str(VHOST)]['_stat'])},
               'patches': {MAIN_NGINX: main_patch.encode(), VHOST: vhost_patch.encode()}, 'links': links}
    return plan, private


def systemctl(arguments):
    result = subprocess.run(['systemctl', *arguments], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL, timeout=30, check=False)
    if result.returncode or len(result.stdout) > 16384:
        raise InspectError('A precise retired-unit operation failed.')
    return result.stdout.decode('utf-8', errors='replace')


def old_port_closed():
    for family, address in ((socket.AF_INET, ('127.0.0.1', 8788)), (socket.AF_INET6, ('::1', 8788))):
        with socket.socket(family, socket.SOCK_STREAM) as connection:
            connection.settimeout(0.5)
            try:
                if connection.connect_ex(address) == 0:
                    return False
            except OSError:
                continue
    return True


def assert_stopped():
    state = unit_state(RETIRED_UNIT)
    if state.get('ActiveState') != 'inactive' or not old_port_closed():
        raise InspectError('The retired service or its old port is still active.')
    processes = inspect_processes()
    if not processes['complete'] or processes['candidates']:
        raise InspectError('An unidentified process still references the retired application.')


def archive_allowed(name, extra):
    path = Path(name)
    if path.is_absolute() or '..' in path.parts or str(path) != name:
        return False
    absolute = '/' + name
    return absolute in extra or any(absolute == str(root) or absolute.startswith(str(root) + '/') for root in (OLD_HOMEPAGE, OLD_CRM))


def validate_archive(archive, extra):
    names, links, manifest, regular_files = set(), [], [], set()
    with tarfile.open(archive, 'r:') as stream:
        for member in stream:
            if member.name in names or not archive_allowed(member.name, extra) or not (member.isdir() or member.isfile() or member.issym() or member.islnk()):
                raise InspectError('The retirement archive has an unexpected member.')
            names.add(member.name)
            if member.issym() or member.islnk():
                links.append(member)
            checksum = None
            if member.isfile():
                regular_files.add(member.name)
                hasher = hashlib.sha256()
                with stream.extractfile(member) as content:
                    for chunk in iter(lambda: content.read(1024 * 1024), b''):
                        hasher.update(chunk)
                checksum = hasher.hexdigest()
            manifest.append({'name': member.name, 'sha256': checksum, 'bytes': member.size})
    symlinks = {member.name for member in links if member.issym()}
    for name in names:
        if any(parent.as_posix() in symlinks for parent in Path(name).parents):
            raise InspectError('An archive member descends through a symlink.')
    for member in links:
        if member.islnk() and (member.linkname not in regular_files or not archive_allowed(member.linkname, extra)):
            raise InspectError('A hardlink target escapes the retirement archive.')
    return digest(manifest), len(names)


def create_archive(directory, paths):
    archive = directory / 'retired-services.tar'
    descriptor = os.open(archive, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, 'wb') as output:
        with tarfile.open(fileobj=output, mode='w', dereference=False, format=tarfile.PAX_FORMAT) as stream:
            for path in paths:
                stream.add(path, arcname=str(path).lstrip('/'), recursive=True)
        output.flush(); os.fsync(output.fileno())
    extra = {str(path) for path in paths if path not in (OLD_HOMEPAGE, OLD_CRM)}
    manifest, members = validate_archive(archive, extra)
    hasher = hashlib.sha256()
    with archive.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            hasher.update(chunk)
    receipt = {'archiveSha256': hasher.hexdigest(), 'manifestSha256': manifest, 'members': members, 'extraPaths': sorted(extra)}
    return archive, receipt


def restore_archive(archive, extra, expected_sha=None):
    if expected_sha is not None:
        checksum = hashlib.sha256()
        with archive.open('rb') as content:
            for chunk in iter(lambda: content.read(1024 * 1024), b''):
                checksum.update(chunk)
        if checksum.hexdigest() != expected_sha:
            raise InspectError('The private backup checksum changed before recovery.')
    validate_archive(archive, extra)
    with tarfile.open(archive, 'r:') as stream:
        members = stream.getmembers()
        # Parents are validated at every write. Symlinks are restored last, and
        # no archive path can ever descend through an archive symlink.
        for member in sorted(members, key=lambda item: (item.issym() or item.islnk(), len(Path(item.name).parts))):
            target = Path('/') / member.name
            for parent in target.parents:
                if parent.is_symlink():
                    raise InspectError('A restore parent became a symlink.')
            if target.is_symlink() and not member.issym():
                target.unlink()
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
            elif member.isfile():
                target.parent.mkdir(parents=True, exist_ok=True)
                descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
                with os.fdopen(descriptor, 'wb') as output, stream.extractfile(member) as content:
                    shutil.copyfileobj(content, output)
            else:
                if target.is_symlink() or target.exists():
                    target.unlink()
                if member.issym():
                    os.symlink(member.linkname, target)
                else:
                    os.link(Path('/') / member.linkname, target, follow_symlinks=False)
            os.chown(target, member.uid, member.gid, follow_symlinks=False)
            if not member.issym():
                os.chmod(target, member.mode)
                os.utime(target, (member.mtime, member.mtime))


def atomic_config(path, content, info):
    descriptor, temporary = tempfile.mkstemp(prefix='.retired-nginx-', suffix='.tmp', dir=path.parent)
    try:
        with os.fdopen(descriptor, 'wb') as stream:
            os.fchown(stream.fileno(), info.st_uid, info.st_gid)
            os.fchmod(stream.fileno(), stat.S_IMODE(info.st_mode))
            stream.write(content); stream.flush(); os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def private_json(path, content):
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, 'w') as stream:
        json.dump(content, stream, sort_keys=True)
        stream.flush(); os.fsync(stream.fileno())


def check_redirects():
    class ApexTLS(http.client.HTTPSConnection):
        def connect(self):
            raw = socket.create_connection(('127.0.0.1', 443), timeout=self.timeout)
            try:
                self.sock = self._context.wrap_socket(raw, server_hostname='treefund.asia')
            except Exception:
                raw.close()
                raise

    for attempt in range(20):
        try:
            for connection, hostname in ((http.client.HTTPConnection('127.0.0.1', 80, timeout=3), '127.0.0.1'),
                                          (ApexTLS('treefund.asia', timeout=3, context=ssl.create_default_context()), 'treefund.asia')):
                try:
                    connection.request('GET', '/', headers={'Host': hostname, 'Connection': 'close'})
                    response = connection.getresponse()
                    if response.status != 301 or response.getheader('Location') != 'https://www.treefund.asia/':
                        raise InspectError('Canonical redirect routing is not active.')
                finally:
                    connection.close()
            return
        except (OSError, http.client.HTTPException, InspectError):
            if attempt == 19:
                raise InspectError('Canonical redirect routing is not active.') from None
            time.sleep(0.25)


def apply_retirement(expected_hash, commit, port):
    web = web_helper()
    if os.geteuid() != 0 or port != 3100 or not re.fullmatch('[0-9a-f]{64}', expected_hash or '') or not re.fullmatch('[0-9a-f]{40}', commit or ''):
        raise InspectError('Retirement requires root, an exact v2 plan, commit and port.')
    for ancestor in (APP_ROOT, *APP_ROOT.parents):
        if ancestor.is_symlink():
            raise InspectError('The managed application directory has a symlinked ancestor.')
    if APP_ROOT.stat().st_uid != 0 or stat.S_IMODE(APP_ROOT.stat().st_mode) & 0o077 or bounded_read(APP_ROOT / '.jiashu-selfhost', 100)[0] != b'jiashu-selfhost-v1\n':
        raise InspectError('The private marked application directory is required.')
    lock = os.open(APP_ROOT / '.deploy.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(lock, 'w') as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        plan, private = retirement_plan()
        if digest(plan) != expected_hash:
            raise InspectError('The stable retirement plan changed since inspection.')
        web.check_app(commit); web.check_public_route(commit)
        effective = systemctl(['show', '--no-pager', '--property=FragmentPath,DropInPaths', '--', RETIRED_UNIT])
        effective_values = dict(line.split('=', 1) for line in effective.splitlines() if '=' in line)
        if effective_values.get('FragmentPath') != str(RETIRED_UNIT_PATH) or effective_values.get('DropInPaths'):
            raise InspectError('The effective service unit differs from the reviewed custom file.')
        original_state = unit_state(RETIRED_UNIT)
        if not original_state.get('inspectionAvailable') or original_state.get('ActiveState') not in ('active', 'inactive'):
            raise InspectError('The original service state cannot be safely restored.')
        inventories = [inspect_old_root(root) for root in (OLD_HOMEPAGE, OLD_CRM)]
        if any(not value['complete'] or value['counts']['other'] for value in inventories):
            raise InspectError('The old trees have unsupported files or incomplete metadata.')
        backup_root = APP_ROOT / 'retired-backups'
        backup_root.mkdir(mode=0o700, exist_ok=True)
        if backup_root.is_symlink() or backup_root.stat().st_uid != 0 or stat.S_IMODE(backup_root.stat().st_mode) & 0o077:
            raise InspectError('The retired backup directory is not private.')
        needed = sum(value['fileBytes'] for value in inventories) + 64 * 1024 * 1024
        if shutil.disk_usage(backup_root).free < needed * 1.2:
            raise InspectError('There is insufficient space for a complete verified backup.')
        directory = Path(tempfile.mkdtemp(prefix='retired-', dir=backup_root))
        os.chmod(directory, 0o700)
        journal = directory / 'transaction.json'
        private_json(journal, {'phase': 'preflight', 'planHash': expected_hash, 'commitSha': commit})
        stopped, deleted, archive, receipt = False, False, None, None
        try:
            stopped = True
            systemctl(['stop', RETIRED_UNIT])
            assert_stopped()
            inventories = [inspect_old_root(root) for root in (OLD_HOMEPAGE, OLD_CRM)]
            paths = [OLD_HOMEPAGE, OLD_CRM, RETIRED_UNIT_PATH, MAIN_NGINX, VHOST, *[Path(link['path']) for link in private['links']]]
            archive, receipt = create_archive(directory, paths)
            after = [inspect_old_root(root) for root in (OLD_HOMEPAGE, OLD_CRM)]
            if any(not value['complete'] for value in inventories + after) or [value['metadataSha256'] for value in inventories] != [value['metadataSha256'] for value in after]:
                raise InspectError('An old tree changed while its backup was being created.')
            private_json(directory / 'backup-receipt.json', receipt)
            private_json(journal, {'phase': 'backed-up', 'planHash': expected_hash, 'commitSha': commit})
            for path, content in private['patches'].items():
                atomic_config(path, content, private['originals'][path][1])
            web.run_nginx(['-t']); web.run_nginx(['-s', 'reload']); web.check_public_route(commit); check_redirects()
            active = web.parse(web.run_nginx(['-T']).decode('utf-8'))
            if any(str(root) in argument for root in (OLD_HOMEPAGE, OLD_CRM) for node in web.walk(active) for argument in node['args']):
                raise InspectError('The active Nginx configuration still references a retired tree.')
            assert_stopped(); no_mounts_in_old_roots()
            for root in (OLD_HOMEPAGE, OLD_CRM):
                info = root.lstat()
                if (info.st_dev, info.st_ino) != REVIEWED_ROOTS[str(root)] or root.is_symlink():
                    raise InspectError('A retired root changed before deletion.')
            private_json(journal, {'phase': 'deleting', 'planHash': expected_hash, 'commitSha': commit})
            deleted = True
            for link in private['links']:
                Path(link['path']).unlink()
            RETIRED_UNIT_PATH.unlink()
            systemctl(['daemon-reload'])
            if not shutil.rmtree.avoids_symlink_attacks:
                raise InspectError('This Python runtime cannot safely remove retired trees.')
            for root in (OLD_HOMEPAGE, OLD_CRM):
                shutil.rmtree(root)
            web.check_app(commit); web.check_public_route(commit); check_redirects()
            if not old_port_closed() or RETIRED_UNIT_PATH.exists() or any(root.exists() for root in (OLD_HOMEPAGE, OLD_CRM)):
                raise InspectError('Retirement postconditions are incomplete.')
            private_json(journal, {'phase': 'complete', 'planHash': expected_hash, 'commitSha': commit})
            return {'ok': True, 'operation': 'retire-old', 'commitSha': commit, 'removedUnit': RETIRED_UNIT,
                    'removedRoots': [str(OLD_HOMEPAGE), str(OLD_CRM)], 'backupDirectory': str(directory),
                    'archiveSha256': receipt['archiveSha256'], 'oldPortClosed': True, 'newAppHealthy': True}
        except Exception as error:
            try:
                if deleted:
                    restore_archive(archive, set(receipt['extraPaths']), receipt['archiveSha256'])
                for path, (content, info) in private['originals'].items():
                    atomic_config(path, content, info)
                web.run_nginx(['-t']); web.run_nginx(['-s', 'reload'])
                systemctl(['daemon-reload'])
                if stopped and original_state['ActiveState'] == 'active':
                    systemctl(['start', RETIRED_UNIT])
                private_json(journal, {'phase': 'rolled-back', 'planHash': expected_hash, 'commitSha': commit})
            except Exception as rollback_error:
                raise InspectError('Retirement failed; the private backup remains and administrator recovery is required.') from rollback_error
            raise InspectError('Retirement failed; the previous configuration and service were restored.') from error


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
        result = inspect_retired() if args.inspect else apply_retirement(args.expected_hash, args.expected_commit, args.port)
        print(json.dumps(result, sort_keys=True, separators=(',', ':')))
    except Exception as error:
        message = str(error) if isinstance(error, InspectError) else 'Retired service operation failed safely.'
        print(json.dumps({'ok': False, 'operation': 'inspect-retired' if args.inspect else 'retire-old', 'error': message}), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
