"""Pure tests: no network, Nginx subprocess, service startup or system writes."""

import importlib.util
import hashlib
import json
from pathlib import Path
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('nginx_test_site', Path(__file__).with_name('nginx-test-site.py'))
HELPER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(HELPER)

VHOST = '''# Keep the original HTTP redirect.
server {
    listen 80;
    server_name treefund.asia www.treefund.asia;
    return 301 https://$host$request_uri;
}
server {
    listen 443 ssl;
    http2 on;
    server_name treefund.asia www.treefund.asia;
    ssl_certificate /etc/nginx/ssl/www.treefund.asia.crt;
    ssl_certificate_key /etc/nginx/ssl/www.treefund.asia.key;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;
    root /var/www/my-homepage;
    index index.html index.htm;
    include /opt/pharmcube-customer-relay/app/nginx-locations.conf;
    location / {
        try_files $uri $uri/ =404;
    }
}
'''
RELAY = '''location = /pharmcube-crm-relay/v1/sharecrm {
    proxy_set_header Authorization "Bearer synthetic-private-value";
    proxy_pass http://127.0.0.1:3200;
}
location = /pharmcube-crm-relay/health {
    proxy_pass http://127.0.0.1:3200/health;
}
'''
DEFAULT = 'http { server { listen 80 default_server; listen [::]:80 default_server; server_name _; root /var/www/my-homepage; } }\n'


def files(source=VHOST, relay=RELAY):
    return {str(HELPER.CONFIG): {'_source': source, '_nodes': HELPER.parse(source), 'sha256': hashlib.sha256(source.encode()).hexdigest()},
            str(HELPER.RELAY): {'_source': relay, '_nodes': HELPER.parse(relay), 'sha256': hashlib.sha256(relay.encode()).hexdigest()}}


class NginxIntegrationTests(unittest.TestCase):
    def test_patch_preserves_http_apex_tls_and_relay_and_only_proxies_www(self):
        patched = HELPER.build_patch(files())
        before = HELPER.parse(VHOST)
        after = HELPER.parse(patched)
        self.assertEqual(len(after), 3)
        self.assertEqual(patched[:after[0]['end']], VHOST[:before[0]['end']])
        old_tls = VHOST[before[1]['start']:before[1]['end']]
        apex = patched[after[1]['start']:after[1]['end']]
        self.assertEqual(apex, old_tls.replace('server_name treefund.asia www.treefund.asia;', 'server_name treefund.asia;'))
        www = patched[after[2]['start']:after[2]['end']]
        self.assertIn('server_name www.treefund.asia;', www)
        self.assertEqual(www.count('proxy_pass http://127.0.0.1:3100;'), 1)
        self.assertNotIn('try_files', www)
        self.assertEqual(patched.count('include /opt/pharmcube-customer-relay/app/nginx-locations.conf;'), 2)
        self.assertEqual(patched.count('ssl_certificate_key /etc/nginx/ssl/www.treefund.asia.key;'), 2)
        self.assertEqual(files()[str(HELPER.RELAY)]['_source'], RELAY)

    def test_unknown_preempting_or_extra_routing_is_rejected(self):
        for source in (VHOST.replace('http2 on;', 'http2 on; return 302 /elsewhere;'),
                       VHOST.replace('location / {', 'location = / {'),
                       VHOST.replace('443 ssl;', '443 ssl default_server;'),
                       VHOST.replace('try_files $uri $uri/ =404;', 'try_files $uri $uri/ =404; include /etc/nginx/other.conf;')):
            with self.subTest(source=source), self.assertRaises(HELPER.ConfigError):
                HELPER.build_patch(files(source))
        with self.assertRaises(HELPER.ConfigError):
            HELPER.build_patch(files(relay=RELAY.replace('location = /pharmcube-crm-relay/health', 'location /')))

    def test_effective_config_rejects_duplicate_or_unknown_vhosts(self):
        HELPER.validate_global(DEFAULT + VHOST)
        HELPER.validate_global(DEFAULT + HELPER.build_patch(files()), configured=True)
        for source in (DEFAULT + VHOST + 'server { listen 443 ssl; server_name www.treefund.asia; }',
                       (DEFAULT + VHOST).replace('server_name _;', 'server_name *.treefund.asia;')):
            with self.assertRaises(HELPER.ConfigError):
                HELPER.validate_global(source)

    def test_inspection_redacts_secret_header_values_without_reading_keys(self):
        summary = json.dumps(HELPER.summary(HELPER.parse(RELAY)))
        self.assertNotIn('synthetic-private-value', summary)
        self.assertIn('proxy_set_header', summary)
        self.assertIn('/pharmcube-crm-relay/health', summary)
        self.assertEqual(HELPER.parse('server { return 301 https://${host}$request_uri; }')[0]['children'][0]['args'][1], 'https://${host}$request_uri')

    def test_snapshot_hash_covers_global_config_without_outputting_its_values(self):
        with patch.object(HELPER, 'configuration_files', return_value=files()), \
                patch.object(HELPER, 'run_nginx', return_value=(DEFAULT + VHOST).encode()):
            original = HELPER.inspect_config()
        with patch.object(HELPER, 'configuration_files', return_value=files()), \
                patch.object(HELPER, 'run_nginx', return_value=(DEFAULT + VHOST + '\n# synthetic-private-global-value\n').encode()):
            changed = HELPER.inspect_config()
        self.assertNotEqual(original['expectedHash'], changed['expectedHash'])
        self.assertNotIn('synthetic-private-global-value', json.dumps(changed))

    def test_readiness_requires_exact_commit_and_complete_integer_schema(self):
        class Response:
            status = 200

            def __init__(self, body):
                self.body = body

            def read(self, _limit):
                return json.dumps(self.body).encode()

        class Connection:
            def __init__(self, body):
                self.response = Response(body)

            def request(self, *_args, **_kwargs):
                pass

            def getresponse(self):
                return self.response

            def close(self):
                pass

        good = {'ok': True, 'commitSha': 'a' * 40, 'schema': {'schemaReady': True, 'applied': 34, 'total': 34, 'pending': 0}}
        HELPER.read_health(Connection(good), 'a' * 40)
        for bad in ({**good, 'commitSha': 'b' * 40}, {**good, 'schema': {**good['schema'], 'pending': 1}},
                    {**good, 'schema': {**good['schema'], 'total': True}}, [], {'ok': True, 'schema': []}):
            with self.subTest(body=bad), self.assertRaises(HELPER.ConfigError):
                HELPER.read_health(Connection(bad), 'a' * 40)

    def test_validation_failure_restores_before_reload(self):
        writes, calls = [], []

        def nginx(arguments):
            calls.append(arguments)
            if len(calls) == 1:
                raise HELPER.ConfigError('Synthetic validation failure.')

        with patch.object(HELPER, 'atomic_write', side_effect=lambda data, info: writes.append(data)), \
                patch.object(HELPER, 'run_nginx', side_effect=nginx), \
                patch.object(HELPER, 'check_public_route') as public:
            with self.assertRaisesRegex(HELPER.ConfigError, 'previous configuration was restored'):
                HELPER.activate_config(b'new', b'old', object(), 'a' * 40)
        self.assertEqual(writes, [b'new', b'old'])
        self.assertEqual(calls, [['-t'], ['-t'], ['-s', 'reload']])
        public.assert_not_called()

    def test_failed_https_probe_restores_and_reloads_previous_configuration(self):
        writes, calls = [], []
        with patch.object(HELPER, 'atomic_write', side_effect=lambda data, info: writes.append(data)), \
                patch.object(HELPER, 'run_nginx', side_effect=lambda arguments: calls.append(arguments)), \
                patch.object(HELPER, 'check_public_route', side_effect=HELPER.ConfigError('Synthetic wrong commit.')):
            with self.assertRaisesRegex(HELPER.ConfigError, 'previous configuration was restored'):
                HELPER.activate_config(b'new', b'old', object(), 'a' * 40)
        self.assertEqual(writes, [b'new', b'old'])
        self.assertEqual(calls, [['-t'], ['-s', 'reload'], ['-t'], ['-s', 'reload']])


if __name__ == '__main__':
    unittest.main()
