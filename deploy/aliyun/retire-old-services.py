#!/usr/bin/env python3
"""Inspect explicitly retired homepage/CRM services without displaying their contents."""

import argparse
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import time
from urllib.parse import urlsplit

OLD_CRM = Path('/opt/pharmcube-customer-relay')
OLD_HOMEPAGE = Path('/var/www/my-homepage')
UNIT_ROOT = Path('/etc/systemd/system')
VHOST = Path('/etc/nginx/conf.d/www.treefund.asia.conf')
RELAY_INCLUDE = OLD_CRM / 'app/nginx-locations.conf'
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
    return {'version': 1, 'operation': 'inspect-retired', 'readOnly': True, 'applyAvailable': False,
            'expectedHash': digest(fingerprint), 'complete': units['complete'] and processes['complete'] and all(root['complete'] for root in roots),
            'nginx': nginx, 'units': units, 'processes': processes, 'oldRoots': roots,
            'ownershipNote': 'Path references identify candidates; exact unit ownership must be reviewed before retirement.'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--inspect', action='store_true', required=True)
    parser.parse_args()
    try:
        print(json.dumps(inspect_retired(), sort_keys=True, separators=(',', ':')))
    except (InspectError, OSError, ValueError, subprocess.SubprocessError):
        print(json.dumps({'ok': False, 'operation': 'inspect-retired', 'error': 'Retired service inspection failed safely.'}), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
