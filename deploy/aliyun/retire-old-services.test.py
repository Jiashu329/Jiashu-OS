"""Pure retirement inspection tests; no real systemd, process or Nginx access."""

import importlib.util
import json
from pathlib import Path
import tempfile
import os
import shutil
import tarfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('retire_old_services', Path(__file__).with_name('retire-old-services.py'))
HELPER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(HELPER)


class RetirementInspectionTests(unittest.TestCase):
    def test_upstream_retains_only_origin_and_rejects_variables(self):
        self.assertEqual(HELPER.upstream_origin('http://user:synthetic-password@127.0.0.1:3210/private?token=synthetic#fragment'), 'http://127.0.0.1:3210')
        self.assertEqual(HELPER.upstream_origin('https://[::1]:443/path'), 'https://[::1]:443')
        for value in ('http://$backend/path', 'not-a-url', 'https://host:bad', 'http://host\nsecret'):
            self.assertEqual(HELPER.upstream_origin(value), '<redacted>')

    def test_unit_candidates_come_only_from_file_path_references_and_do_not_expose_values(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'crm-test.service').write_text('[Service]\nWorkingDirectory=/opt/pharmcube-customer-relay/app\nExecStart=/usr/bin/node /opt/pharmcube-customer-relay/app/server.js\nEnvironment=TOKEN=synthetic-private-token\n')
            (root / 'unrelated.service').write_text('[Service]\nExecStart=/usr/bin/true\n')
            (root / 'comment-only.service').write_text('# /opt/pharmcube-customer-relay reference only\n[Service]\nExecStart=/usr/bin/true\n')
            with patch.object(HELPER, 'UNIT_ROOT', root), patch.object(HELPER, 'unit_state', return_value={'ActiveState': 'active'}):
                result = HELPER.inspect_units()
            self.assertEqual([item['unit'] for item in result['candidates']], ['comment-only.service', 'crm-test.service'])
            self.assertTrue(all(item['candidateOnly'] for item in result['candidates']))
            self.assertEqual(result['candidates'][0]['referenceKinds'], ['file-path-reference'])
            self.assertIn('ExecStart', result['candidates'][1]['referenceKinds'])
            rendered = json.dumps(result)
            self.assertNotIn('synthetic-private-token', rendered)
            self.assertNotIn('/usr/bin/node', rendered)

    def test_directory_inventory_never_follows_links_or_outputs_unknown_names(self):
        with tempfile.TemporaryDirectory() as directory, tempfile.TemporaryDirectory() as outside:
            root = Path(directory)
            (root / 'index.html').write_text('synthetic private homepage content')
            (Path(outside) / 'outside-private-content.txt').write_text('outside')
            (root / 'synthetic-private-filename').symlink_to(outside, target_is_directory=True)
            first = HELPER.inspect_old_root(root)
            self.assertTrue(first['complete'])
            self.assertEqual(first['counts'], {'files': 1, 'directories': 0, 'symlinks': 1, 'other': 0})
            self.assertFalse(first['contentRead'])
            self.assertEqual(first['otherTopLevelEntries'], 1)
            self.assertNotIn('synthetic private homepage content', json.dumps(first))
            self.assertNotIn('synthetic-private-filename', json.dumps(first))
            (root / 'index.html').write_text('changed size')
            self.assertNotEqual(first['metadataSha256'], HELPER.inspect_old_root(root)['metadataSha256'])

    def test_nginx_snapshot_hashes_full_output_without_exposing_configuration_values(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            vhost, include = root / 'site.conf', root / 'relay.conf'
            vhost.write_text('server { server_name www.treefund.asia; }')
            include.write_text('location /old {\n proxy_pass http://user:synthetic-secret@127.0.0.1:3220/private?token=secret;\n}\n')
            with patch.object(HELPER, 'VHOST', vhost), patch.object(HELPER, 'RELAY_INCLUDE', include), \
                    patch.object(HELPER.subprocess, 'run', return_value=SimpleNamespace(returncode=0, stdout=b'synthetic-private-nginx-value')):
                result = HELPER.inspect_nginx()
            self.assertEqual(result['relayUpstreamOrigins'], ['http://127.0.0.1:3220'])
            self.assertNotIn('synthetic-secret', json.dumps(result))
            self.assertNotIn('synthetic-private-nginx-value', json.dumps(result))

    def test_retirement_routing_preserves_www_proxy_and_tls_and_redirects_default_and_apex(self):
        web = HELPER.web_helper()
        spec = importlib.util.spec_from_file_location('nginx_fixtures', Path(__file__).with_name('nginx-test-site.test.py'))
        fixtures = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(fixtures)
        configured = web.build_patch(fixtures.files())
        main = 'http { server { listen 80 default_server; listen [::]:80 default_server; server_name _; root /var/www/my-homepage; include /etc/nginx/default.d/*.conf; error_page 404 /404.html; location = /404.html {} } }'
        patched_main, patched_vhost = HELPER.retirement_nginx_patch(main, configured)
        self.assertNotIn('/var/www/my-homepage', patched_main + patched_vhost)
        self.assertNotIn('/opt/pharmcube-customer-relay', patched_main + patched_vhost)
        self.assertEqual(patched_vhost.count('ssl_certificate_key /etc/nginx/ssl/www.treefund.asia.key;'), 2)
        self.assertEqual(patched_vhost.count('proxy_pass http://127.0.0.1:3100;'), 1)
        self.assertEqual(patched_vhost.count('return 301 https://www.treefund.asia$request_uri;'), 2)
        self.assertEqual(patched_main.count('return 301 https://www.treefund.asia$request_uri;'), 1)
        with self.assertRaises((HELPER.InspectError, web.ConfigError)):
            HELPER.retirement_nginx_patch(main, configured.replace('proxy_pass http://127.0.0.1:3100;', 'proxy_pass http://127.0.0.1:9999;'))

    def test_archive_restores_full_trees_unit_and_enablelink_without_following_external_symlinks(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            homepage, crm, backups, outside = (base / name for name in ('homepage', 'crm', 'backups', 'outside'))
            for path in (homepage, crm, backups, outside):
                path.mkdir()
            (homepage / 'index.html').write_text('synthetic homepage')
            (crm / 'private.env').write_text('synthetic-token=private')
            os.chmod(crm / 'private.env', 0o600)
            (outside / 'external.txt').write_text('never follow external content')
            (crm / 'external').symlink_to(outside, target_is_directory=True)
            os.link(crm / 'private.env', crm / 'hardlink.env')
            unit = base / 'test.service'
            unit.write_text('synthetic unit')
            link = base / 'enabled.service'
            link.symlink_to(unit)
            with patch.object(HELPER, 'OLD_HOMEPAGE', homepage), patch.object(HELPER, 'OLD_CRM', crm):
                archive, receipt = HELPER.create_archive(backups, [homepage, crm, unit, link])
                self.assertEqual(archive.stat().st_mode & 0o777, 0o600)
                with tarfile.open(archive) as stream:
                    self.assertFalse(any('external.txt' in member.name for member in stream))
                shutil.rmtree(homepage); shutil.rmtree(crm); unit.unlink(); link.unlink()
                HELPER.restore_archive(archive, set(receipt['extraPaths']))
            self.assertEqual((homepage / 'index.html').read_text(), 'synthetic homepage')
            self.assertEqual((crm / 'private.env').read_text(), 'synthetic-token=private')
            self.assertEqual((crm / 'private.env').stat().st_mode & 0o777, 0o600)
            self.assertTrue((crm / 'external').is_symlink())
            self.assertEqual((crm / 'hardlink.env').stat().st_ino, (crm / 'private.env').stat().st_ino)
            self.assertTrue(link.is_symlink())
            self.assertEqual(unit.read_text(), 'synthetic unit')

    def test_archive_validation_rejects_escape_paths_and_members_below_symlinks(self):
        with tempfile.TemporaryDirectory() as directory:
            base, archive = Path(directory), Path(directory) / 'malicious.tar'
            root = base / 'old'
            with patch.object(HELPER, 'OLD_HOMEPAGE', root):
                with tarfile.open(archive, 'w') as stream:
                    member = tarfile.TarInfo('../../etc/passwd')
                    stream.addfile(member)
                with self.assertRaises(HELPER.InspectError):
                    HELPER.validate_archive(archive, set())
                with tarfile.open(archive, 'w') as stream:
                    link = tarfile.TarInfo(str(root / 'link').lstrip('/'))
                    link.type = tarfile.SYMTYPE; link.linkname = '/etc'
                    stream.addfile(link)
                    child = tarfile.TarInfo(str(root / 'link' / 'passwd').lstrip('/'))
                    stream.addfile(child)
                with self.assertRaises(HELPER.InspectError):
                    HELPER.validate_archive(archive, set())


if __name__ == '__main__':
    unittest.main()
