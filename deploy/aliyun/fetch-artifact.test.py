import hashlib
import importlib.util
import io
import json
from pathlib import Path
import stat
import tempfile
import unittest
import zipfile

spec = importlib.util.spec_from_file_location('fetch_artifact', Path(__file__).with_name('fetch-artifact.py'))
transfer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(transfer)
URL = 'https://productionresultssa0.blob.core.windows.net/actions-results/image.zip?sig=not-logged'


def zipped(entries):
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, 'w', zipfile.ZIP_STORED) as archive:
        for name, content in entries:
            archive.writestr(name, content)
    return stream.getvalue()


class Response(io.BytesIO):
    def __init__(self, data, status=200, headers=None):
        super().__init__(data)
        self.status = status
        self.headers = headers or {'Content-Length': str(len(data))}


class Opener:
    def __init__(self, body, status=200, headers=None):
        self.body = body
        self.status = status
        self.headers = headers
        self.requests = []

    def open(self, request, timeout):
        self.requests.append((request, timeout))
        return Response(self.body, self.status, self.headers)


class TransferTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.directory = Path(self.temporary.name)
        self.image = b'controlled gzip image fixture'
        (self.directory / 'manifest.json').write_text(json.dumps({'archiveSha256': hashlib.sha256(self.image).hexdigest()}))

    def tearDown(self):
        self.temporary.cleanup()

    def payload(self, body):
        return {'url': URL, 'artifactDigest': hashlib.sha256(body).hexdigest()}

    def assert_no_image(self):
        self.assertEqual(sorted(p.name for p in self.directory.iterdir()), ['manifest.json'])

    def test_valid_image_requires_both_checksums_and_installs_private_file(self):
        body = zipped([('image.tar.gz', self.image)])
        opener = Opener(body)
        result = transfer.fetch_artifact(self.payload(body), self.directory, opener=opener)
        self.assertEqual(result['bytes'], len(self.image))
        self.assertEqual(result['mode'], 'download')
        self.assertEqual((self.directory / 'image.tar.gz').read_bytes(), self.image)
        self.assertEqual((self.directory / 'image.tar.gz').stat().st_mode & 0o777, 0o600)
        self.assertNotIn('Authorization', opener.requests[0][0].headers)
        with self.assertRaises(transfer.TransferError):
            transfer.fetch_artifact(self.payload(body), self.directory, opener=Opener(body))
        self.assertEqual((self.directory / 'image.tar.gz').read_bytes(), self.image)

    def test_zip_checksum_mismatch_leaves_no_image_or_partial_files(self):
        body = zipped([('image.tar.gz', self.image)])
        request = self.payload(body)
        request['artifactDigest'] = '0' * 64
        with self.assertRaisesRegex(transfer.TransferError, 'Artifact checksum mismatch'):
            transfer.fetch_artifact(request, self.directory, opener=Opener(body))
        self.assert_no_image()

    def test_inner_archive_checksum_mismatch_leaves_no_partial_files(self):
        body = zipped([('image.tar.gz', b'wrong image')])
        with self.assertRaisesRegex(transfer.TransferError, 'image checksum mismatch'):
            transfer.fetch_artifact(self.payload(body), self.directory, opener=Opener(body))
        self.assert_no_image()

    def test_only_one_regular_exact_named_entry_is_accepted(self):
        symlink = zipfile.ZipInfo('image.tar.gz')
        symlink.create_system = 3
        symlink.external_attr = (stat.S_IFLNK | 0o777) << 16
        for entries in [[('../image.tar.gz', self.image)], [('/image.tar.gz', self.image)], [('nested/image.tar.gz', self.image)], [('image.tar.gz', self.image), ('extra.sh', b'shell')], [(symlink, b'/etc/shadow')]]:
            with self.subTest(entries=str(entries)[:40]):
                body = zipped(entries)
                with self.assertRaises(transfer.TransferError):
                    transfer.fetch_artifact(self.payload(body), self.directory, opener=Opener(body))
                self.assert_no_image()

    def test_probe_reads_only_requested_range_and_cannot_install_an_image(self):
        body = b'x' * (1024 * 1024)
        opener = Opener(body, 206, {'Content-Range': f'bytes 0-{transfer.PROBE_BYTES - 1}/{len(body)}'})
        result = transfer.fetch_artifact(self.payload(body), self.directory, probe=True, opener=opener)
        self.assertEqual(result['bytes'], transfer.PROBE_BYTES)
        self.assertEqual(result['mode'], 'probe')
        self.assertEqual(opener.requests[0][0].headers['Range'], 'bytes=0-262143')
        self.assert_no_image()
        with self.assertRaises(transfer.TransferError):
            transfer.fetch_artifact(self.payload(body), self.directory, probe=True, opener=Opener(b'short'))

    def test_host_redirect_and_transfer_size_limits_fail_closed(self):
        body = zipped([('image.tar.gz', self.image)])
        for url in ['http://productionresultssa0.blob.core.windows.net/a', 'https://evil.test/a', 'https://productionresultssa0.blob.core.windows.net.evil.test/a', 'https://u:p@productionresultssa0.blob.core.windows.net/a', URL + '\nheader']:
            request = self.payload(body)
            request['url'] = url
            with self.assertRaises(transfer.TransferError):
                transfer.fetch_artifact(request, self.directory, opener=Opener(body))
        with self.assertRaises(transfer.TransferError):
            transfer.NoRedirect().redirect_request(None, None, 302, '', {}, 'https://evil.test')
        with self.assertRaises(transfer.TransferError):
            transfer.fetch_artifact(self.payload(body), self.directory, opener=Opener(body, 302))
        with self.assertRaises(transfer.TransferError):
            transfer.fetch_artifact(self.payload(body), self.directory, opener=Opener(body, 200, {'Content-Length': str(transfer.MAX_ZIP_BYTES + 1)}))
        self.assert_no_image()


if __name__ == '__main__':
    unittest.main()
