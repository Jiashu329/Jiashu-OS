"""Pure retirement inspection tests; no real systemd, process or Nginx access."""

import importlib.util
import json
from pathlib import Path
import tempfile
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


if __name__ == '__main__':
    unittest.main()
