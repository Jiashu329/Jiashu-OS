#!/usr/bin/env python3
"""Receive a signed blob URL over stdin; never print it or store credentials."""
import hashlib
import json
import os
from pathlib import Path
import re
import socket
import ssl
import stat
import sys
import tempfile
import time
from urllib.parse import urlsplit
from urllib.error import HTTPError, URLError
from urllib.request import build_opener, HTTPRedirectHandler, HTTPSHandler, ProxyHandler, Request
import zipfile

MAX_ZIP_BYTES = 1024 * 1024 * 1024
MAX_IMAGE_BYTES = 1024 * 1024 * 1024
PROBE_BYTES = 256 * 1024
CHUNK_BYTES = 1024 * 1024


class TransferError(Exception):
    pass


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise TransferError('Artifact storage redirects are not allowed')


def validate_payload(payload):
    if not isinstance(payload, dict) or set(payload) != {'url', 'artifactDigest'}:
        raise TransferError('Invalid artifact request')
    value = payload['url']
    if not isinstance(value, str) or len(value) > 12000 or any(ord(c) < 32 for c in value):
        raise TransferError('Invalid artifact URL')
    url = urlsplit(value)
    if url.scheme != 'https' or url.username or url.password or url.fragment or url.port not in (None, 443) or not re.fullmatch(r'[a-z0-9-]+\.blob\.core\.windows\.net', url.hostname or ''):
        raise TransferError('Artifact host is not approved HTTPS storage')
    if not isinstance(payload['artifactDigest'], str) or not re.fullmatch(r'[a-f0-9]{64}', payload['artifactDigest']):
        raise TransferError('Invalid artifact checksum')
    return payload


def default_opener():
    # Use system trust roots, no environment proxy or redirect to another host.
    return build_opener(ProxyHandler({}), NoRedirect(), HTTPSHandler(context=ssl.create_default_context()))


def expected_image_checksum(directory):
    path = directory / 'manifest.json'
    if path.is_symlink() or not path.is_file() or path.stat().st_size > 65536:
        raise TransferError('Release manifest is unavailable')
    value = json.loads(path.read_text(encoding='utf-8'))
    checksum = value.get('archiveSha256') if isinstance(value, dict) else None
    if not isinstance(checksum, str) or not re.fullmatch(r'[a-f0-9]{64}', checksum):
        raise TransferError('Release image checksum is invalid')
    return checksum


def extract_image(archive, directory, checksum):
    destination = directory / 'image.tar.gz'
    if destination.exists() or destination.is_symlink():
        raise TransferError('Release image destination already exists')
    with zipfile.ZipFile(archive, 'r') as zipped:
        entries = zipped.infolist()
        if len(entries) != 1:
            raise TransferError('Artifact must contain exactly one image archive')
        entry = entries[0]
        file_type = stat.S_IFMT(entry.external_attr >> 16)
        if entry.filename != 'image.tar.gz' or entry.is_dir() or file_type not in (0, stat.S_IFREG) or entry.flag_bits & 1 or entry.file_size <= 0 or entry.file_size > MAX_IMAGE_BYTES or entry.compress_size > MAX_ZIP_BYTES:
            raise TransferError('Artifact image entry is invalid')
        descriptor, temporary = tempfile.mkstemp(prefix='.image-', dir=directory)
        try:
            digest = hashlib.sha256()
            total = 0
            with os.fdopen(descriptor, 'wb') as output, zipped.open(entry, 'r') as source:
                while True:
                    chunk = source.read(CHUNK_BYTES)
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > MAX_IMAGE_BYTES or total > entry.file_size:
                        raise TransferError('Artifact image exceeds its declared limit')
                    digest.update(chunk)
                    output.write(chunk)
                output.flush()
                os.fsync(output.fileno())
            if total != entry.file_size or digest.hexdigest() != checksum:
                raise TransferError('Release image checksum mismatch')
            os.link(temporary, destination)  # atomic, never overwrite another release image
            return total
        finally:
            os.unlink(temporary)


def fetch_artifact(payload, directory, probe=False, opener=None, on_phase=lambda phase: None):
    payload = validate_payload(payload)
    directory = Path(directory)
    if directory.is_symlink() or not directory.is_dir():
        raise TransferError('Private transfer directory is unavailable')
    checksum = None if probe else expected_image_checksum(directory)
    opener = opener or default_opener()
    headers = {'Accept-Encoding': 'identity'}
    if probe:
        headers['Range'] = f'bytes=0-{PROBE_BYTES - 1}'
    request = Request(payload['url'], headers=headers, method='GET')
    started = time.monotonic()
    temporary = None
    try:
        on_phase('network')
        with opener.open(request, timeout=45) as response:
            if response.status not in ((200, 206) if probe else (200,)):
                raise TransferError('Artifact storage returned an unexpected status')
            if probe:
                if response.status == 206 and not re.fullmatch(rf'bytes 0-{PROBE_BYTES - 1}/[0-9]+', response.headers.get('Content-Range', '')):
                    raise TransferError('Artifact probe range is invalid')
                received = 0
                while received < PROBE_BYTES:
                    chunk = response.read(min(64 * 1024, PROBE_BYTES - received))
                    if not chunk:
                        break
                    received += len(chunk)
                if received != PROBE_BYTES:
                    raise TransferError('Artifact probe was truncated')
            else:
                length = response.headers.get('Content-Length')
                if length is not None and (not length.isdigit() or not 0 < int(length) <= MAX_ZIP_BYTES):
                    raise TransferError('Artifact length exceeds the transfer limit')
                descriptor, temporary = tempfile.mkstemp(prefix='.artifact-', suffix='.zip', dir=directory)
                digest = hashlib.sha256()
                downloaded = 0
                with os.fdopen(descriptor, 'wb') as output:
                    while True:
                        chunk = response.read(CHUNK_BYTES)
                        if not chunk:
                            break
                        downloaded += len(chunk)
                        if downloaded > MAX_ZIP_BYTES:
                            raise TransferError('Artifact exceeds the transfer limit')
                        digest.update(chunk)
                        output.write(chunk)
                if length is not None and downloaded != int(length):
                    raise TransferError('Artifact download was truncated')
                on_phase('verify_zip')
                if digest.hexdigest() != payload['artifactDigest']:
                    raise TransferError('Artifact checksum mismatch')
                on_phase('verify_image')
                received = extract_image(temporary, directory, checksum)
        seconds = max(time.monotonic() - started, 0.000001)
        return {'mode': 'probe' if probe else 'download', 'bytes': received, 'seconds': round(seconds, 6), 'bytesPerSecond': round(received / seconds, 2)}
    finally:
        if temporary is not None:
            os.unlink(temporary)


def main():
    phase = 'input'

    def on_phase(value):
        nonlocal phase
        phase = value

    try:
        if sys.argv[1:] not in ([], ['--probe']):
            raise TransferError('Invalid artifact helper arguments')
        raw = sys.stdin.buffer.read(16385)
        if len(raw) > 16384:
            raise TransferError('Artifact request is too large')
        payload = json.loads(raw)
        result = fetch_artifact(payload, Path(__file__).resolve().parent, probe=bool(sys.argv[1:]), on_phase=on_phase)
        print(json.dumps(result, separators=(',', ':')))
        return 0
    except Exception as error:
        diagnostic = {'phase': phase}
        if isinstance(error, HTTPError):
            diagnostic.update(code='http', status=error.code)
        elif isinstance(error, (TimeoutError, socket.timeout)) or isinstance(error, URLError) and isinstance(error.reason, (TimeoutError, socket.timeout)):
            diagnostic['code'] = 'timeout'
        elif isinstance(error, ssl.SSLError) or isinstance(error, URLError) and isinstance(error.reason, ssl.SSLError):
            diagnostic['code'] = 'tls'
        elif isinstance(error, URLError):
            diagnostic['code'] = 'network'
        elif isinstance(error, TransferError):
            diagnostic['code'] = 'validation'
        elif isinstance(error, zipfile.BadZipFile):
            diagnostic['code'] = 'invalid_zip'
        elif isinstance(error, OSError):
            diagnostic['code'] = 'io'
        else:
            diagnostic['code'] = 'internal'
        print(json.dumps(diagnostic, separators=(',', ':')), file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
