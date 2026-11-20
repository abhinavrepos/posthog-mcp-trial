"""Run: python3 -m unittest discover -s deploy/offline -p 'test_*.py'"""
import importlib.util
from contextlib import nullcontext
import json
import os
from pathlib import Path
import runpy
import shutil
import subprocess
import tempfile
import types
import unittest
from unittest.mock import patch
from site_config_loader import env, preserve, put


class SiteConfigTests(unittest.TestCase):
    def test_remote_config_fallback_and_every_team_delivery(self):
        script = Path(__file__).parents[1] / 'migrate/remote-config.py'
        teams = [types.SimpleNamespace(pk=1, api_token='first'), types.SimpleNamespace(pk=2, api_token='second')]
        models = types.ModuleType('posthog.models')
        models.Team = types.SimpleNamespace(objects=types.SimpleNamespace(all=lambda: teams))
        fallback = types.ModuleType('posthog.models.team.remote_config')
        synced = []
        fallback.RemoteConfig = types.SimpleNamespace(objects=types.SimpleNamespace(
            get_or_create=lambda team: (types.SimpleNamespace(sync=lambda: synced.append(team.pk)), False)))
        with patch.dict('sys.modules', {'posthog': types.ModuleType('posthog'), 'posthog.models': models,
                                       'posthog.models.team.remote_config': fallback}):
            with patch.dict(os.environ, REMOTE_CONFIG_VERIFY='0'):
                runpy.run_path(str(script))
            self.assertEqual(synced, [1, 2])
            fetched = []
            def fetch(url, **kwargs):
                fetched.append(url)
                return nullcontext(types.SimpleNamespace(status=200))
            with patch.dict(os.environ, REMOTE_CONFIG_VERIFY='1'), patch('urllib.request.build_opener',
                    return_value=types.SimpleNamespace(open=fetch)):
                runpy.run_path(str(script))
            self.assertEqual(fetched, ['http://proxy/array/first/config.js', 'http://proxy/array/second/config.js'])
            with patch.dict(os.environ, REMOTE_CONFIG_VERIFY='1'), patch('urllib.request.build_opener',
                    return_value=types.SimpleNamespace(open=lambda *a, **k: nullcontext(types.SimpleNamespace(status=404)))):
                with self.assertRaisesRegex(RuntimeError, 'config.js unavailable'):
                    runpy.run_path(str(script))

    @unittest.skipUnless(shutil.which('docker'), 'Docker Compose CLI unavailable')
    def test_mcp_internal_url_wins_over_legacy_https_override(self):
        mcp = Path(__file__).resolve().parents[1] / 'posthog-mcp'
        with tempfile.TemporaryDirectory() as directory:
            legacy = Path(directory) / 'legacy.yml'
            legacy.write_text(json.dumps({'services': {'posthog-mcp': {'environment': {
                'POSTHOG_API_BASE_URL': 'https://company.example.com'}}}}))
            child_env = dict(os.environ, MCP_POSTHOG_API_URL='http://web:8000',
                             MCP_POSTHOG_PUBLIC_URL='https://company.example.com')
            child_env.pop('COMPOSE_FILE', None)
            result = json.loads(subprocess.check_output([
                'docker', 'compose', '-f', str(mcp / 'docker-compose.yml'),
                '-f', str(legacy), '-f', str(mcp / 'docker-compose.api.yml'),
                'config', '--format', 'json'], env=child_env))
            settings = result['services']['posthog-mcp']['environment']
            self.assertEqual(settings['POSTHOG_API_BASE_URL'], 'http://web:8000')
            self.assertEqual(settings['POSTHOG_PUBLIC_URL'], 'https://company.example.com')

    def test_public_mounts_under_private_umask_leave_secrets_private(self):
        repair = runpy.run_path(str(Path(__file__).with_name('public-mount-permissions.py')))['repair']
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            previous = os.umask(0o077)
            try:
                (root / 'compose').mkdir()
                (root / 'compose/wait').write_text('#!/bin/sh\n')
                (root / 'compose/wait').chmod(0o700)
                (root / 'share').mkdir()
                (root / 'share/GeoLite2-City.mmdb').write_bytes(b'data')
                (root / '.env.services').write_text('SECRET=private\n')
                repair(root)
            finally:
                os.umask(previous)
            self.assertEqual((root / 'compose').stat().st_mode & 0o777, 0o755)
            self.assertEqual((root / 'compose/wait').stat().st_mode & 0o777, 0o755)
            self.assertEqual((root / 'share/GeoLite2-City.mmdb').stat().st_mode & 0o777, 0o644)
            self.assertEqual((root / '.env.services').stat().st_mode & 0o777, 0o600)

    @unittest.skipUnless(shutil.which('docker'), 'Docker Compose CLI unavailable')
    def test_real_compose_resolution_and_dotenv_survive_repair_twice(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / '.env').write_text('DOMAIN=old.example.com\nCOMPOSE_FILE=docker-compose.yml\n')
            (root / 'docker-compose.yml').write_text(json.dumps({'services': {
                'web': {'image': 'unused', 'environment': {
                    'SITE_URL': 'https://old.example.com', 'COMPANY_SETTING': 'literal$$value',
                    'EXTRA_CSRF_TRUSTED_ORIGINS': 'https://login.example.com'}},
                'proxy': {'image': 'unused', 'environment': {
                    'CADDYFILE': '{\n admin off\n}\nold.example.com {\n reverse_proxy web:8000\n}\n'}}}}))
            addresses = 'https://new.example.com,http://10.0.0.2'
            for _ in range(2):
                preserve(root, addresses)
                child_env = dict(os.environ)
                child_env.pop('COMPOSE_FILE', None)
                result = json.loads(subprocess.check_output(
                    ['docker', 'compose', 'config', '--format', 'json'], cwd=root, env=child_env))
                web = result['services']['web']['environment']
                self.assertEqual(web['COMPANY_SETTING'], 'literal$$value')
                self.assertEqual(web['SECURE_COOKIES'], 'false')
                self.assertEqual(web['SITE_URL'], 'https://new.example.com')
                self.assertIn('http://10.0.0.2', result['services']['proxy']['environment']['CADDYFILE'])
                self.assertNotIn('https://10.0.0.2', result['services']['proxy']['environment']['CADDYFILE'])
                self.assertIn('http://login.example.com', web['EXTRA_CSRF_TRUSTED_ORIGINS'])

    def test_baked_caddy_names_and_explicit_http_are_preserved(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / '.env').write_text('DOMAIN=plain.example.com\n')
            config = {'services': {
                'web': {'environment': {'SITE_URL': 'http://plain.example.com'}},
                'proxy': {'environment': {'CADDYFILE': 'http://plain.example.com, https://extra.example.com {\n reverse_proxy web:8000\n}\n'}}}}
            with patch('subprocess.check_output', return_value=json.dumps(config).encode()):
                result = preserve(root)
            hosts = result['services']['proxy']['environment']['CADDY_HOST']
            self.assertIn('https://extra.example.com', hosts)
            self.assertNotIn('https://plain.example.com', hosts)

    def test_worker_company_settings_survive_without_resurrecting_old_services(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'posthog').mkdir()
            (root / 'posthog/docker-compose.hobby.yml').write_text(
                'services:\n    web:\n        environment:\n            SITE_URL: https://stock\n    worker:\n        image: current\n')
            config = {'services': {
                'web': {'environment': {'SITE_URL': 'https://company.example.com'}},
                'worker': {'environment': {'SITE_URL': 'https://old.example.com', 'COMPANY_WORKER_SETTING': 'keep'}},
                'removed-worker': {'environment': {'REMOVED_SETTING': 'obsolete'}}}}
            with patch('subprocess.check_output', return_value=json.dumps(config).encode()):
                result = preserve(root)
            self.assertEqual(result['services']['worker']['environment'], {
                'SITE_URL': 'https://company.example.com', 'COMPANY_WORKER_SETTING': 'keep'})
            self.assertNotIn('removed-worker', result['services'])

    def test_old_compose_survives_repeated_stock_replacement(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / '.env').write_text('DOMAIN=old.example.com\nEXTRA_COMPOSE_FILES=custom.yml\nSECRET=keep-me\n')
            (root / 'docker-compose.yml').write_text('''services:
    web:
        environment:
            EXTRA_CSRF_TRUSTED_ORIGINS: 'https://login.example.com,http://10.0.0.2'
            SITE_URL: https://old.example.com
            OPT_OUT_CAPTURE: 'true'
    proxy:
        environment:
            CADDY_HOST: 'https://old.example.com, http://10.0.0.2'
''')
            addresses = 'https://old.example.com,https://login.example.com,http://10.0.0.2'
            first = preserve(root, addresses, True)
            self.assertEqual(env(root / '.env')['SECRET'], 'keep-me')
            self.assertEqual(first['services']['web']['environment']['SECURE_COOKIES'], 'false')
            self.assertEqual(first['services']['web']['environment']['OPT_OUT_CAPTURE'], 'true')
            self.assertIn('http://login.example.com', first['services']['web']['environment']['EXTRA_CSRF_TRUSTED_ORIGINS'])
            with patch('subprocess.check_output', return_value=json.dumps(first).encode()):
                second = preserve(root, addresses)
                self.assertEqual(first, second)
                third = preserve(root, addresses)
                self.assertEqual(second, third)
            for key in ('COMPOSE_FILE', 'EXTRA_COMPOSE_FILES'):
                self.assertEqual(env(root / '.env')[key].split(':').count('docker-compose.site.yml'), 1)
            caddy = second['services']['proxy']['environment']['CADDY_HOST']
            self.assertIn('http://10.0.0.2', caddy)
            self.assertNotIn('https://10.0.0.2', caddy)
            self.assertEqual((root / 'docker-compose.site.yml').stat().st_mode & 0o777, 0o600)

    def test_rendered_caddyfile_updates_only_site_header(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / '.env').write_text('DOMAIN=old.example.com\n')
            config = {'services': {'proxy': {'environment': {'CADDYFILE': '{\n  admin off\n}\nold.example.com {\n  reverse_proxy web:8000\n}\n'}}}}
            with patch('subprocess.check_output', return_value=json.dumps(config).encode()):
                result = preserve(root, 'https://new.example.com,http://10.0.0.2')
                caddy = result['services']['proxy']['environment']['CADDYFILE']
                self.assertIn('https://new.example.com, http://10.0.0.2, http:// {', caddy)
                self.assertIn('reverse_proxy web:8000', caddy)
                self.assertNotIn('old.example.com {', caddy)
                result = preserve(root, 'https://new.example.com,http://10.0.0.2', before_upgrade=True)
                self.assertNotIn('CADDYFILE', result['services']['proxy']['environment'])

    def test_hobby_mixed_address_list(self):
        source = (Path(__file__).parents[1] / 'posthog/install-posthog-hobby.sh').read_text()
        functions = source[source.index('normalize_domain()'):source.index('check_resources()')]
        caddy = source[source.index('caddy_host()'):source.index('set_env_value()')]
        script = "set -euo pipefail\n" + functions + caddy + "\ndie() { echo \"$*\" >&2; exit 1; }; ok() { :; }; warn() { :; }; info() { :; }\nINSTALL_DIR=/missing\nask_domain 'https://a.example.com,http://10.0.0.2,https://b.example.com'\n[ \"$ANY_HTTP\" = 1 ]\n[ \"$HTTP_ONLY\" = 0 ]\n[ \"$SITE_URL\" = https://a.example.com ]\n[[ \"$ORIGINS\" = *http://a.example.com* ]]\n[[ \"$(caddy_host)\" = *http://10.0.0.2* ]]\n"
        subprocess.run(['bash', '-c', script], check=True)

    def test_installer_conf_and_site_override_stale_answers(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in ('conf', 'answers', 'secrets', 'config'):
                (root / name).write_text('CLIENT_FROM_DISTINCT_ID=1\nAPP_EVENTS_FILE=stale.json\n')
            (root / 'conf').write_text('CLIENT_FROM_DISTINCT_ID=3\n')
            site = root / 'offline/sites/test-host'
            site.mkdir(parents=True)
            (site / 'site.env').write_text('CLIENT_FROM_DISTINCT_ID=2\nAPP_EVENTS_FILE=config/app-events.reval.json\n')
            source = (Path(__file__).parents[1] / 'install.sh').read_text()
            functions = source[source.index('read_env_file()'):source.index('save_answer()')]
            script = 'set -euo pipefail\n' + functions + '\nhostname() { echo test-host; }\nHERE="$1" POSTHOG_LENS_CONF="$1/conf" CONFIG="$1/config" ANSWERS="$1/answers" SECRETS="$1/secrets"\n[ "$(known CLIENT_FROM_DISTINCT_ID)" = 3 ]\n[ "$(known APP_EVENTS_FILE)" = config/app-events.reval.json ]\n'
            subprocess.run(['bash', '-c', script, '_', str(root)], check=True)

    def test_resolution_failure_does_not_change_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / '.env').write_text('DOMAIN=keep.example.com\n')
            with patch('subprocess.check_output', side_effect=subprocess.CalledProcessError(1, 'docker')):
                with self.assertRaises(subprocess.CalledProcessError):
                    preserve(root)
            self.assertEqual((root / '.env').read_text(), 'DOMAIN=keep.example.com\n')
            self.assertFalse((root / 'docker-compose.site.yml').exists())

    def test_dotenv_edit_replaces_duplicates_and_preserves_other_values(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / '.env'
            path.write_text('COMPOSE_FILE=old\nSECRET=keep\nCOMPOSE_FILE=duplicate\n')
            put(path, {'COMPOSE_FILE': 'docker-compose.yml:docker-compose.site.yml'})
            self.assertEqual(path.read_text().count('COMPOSE_FILE='), 1)
            self.assertEqual(env(path)['SECRET'], 'keep')
            put(path, {'LITERAL': 'a"b\\c|d', 'DISTINCT_ID_SEPARATOR': '|'})
            self.assertEqual(env(path)['LITERAL'], 'a"b\\c|d')
            self.assertEqual(env(path)['DISTINCT_ID_SEPARATOR'], '|')

    def test_scale_reads_quoted_extra_compose_files(self):
        source = (Path(__file__).parents[1] / 'posthog/scale.sh').read_text()
        function = source[source.index('envget()'):source.index('setting()')]
        with tempfile.TemporaryDirectory() as directory:
            (Path(directory) / '.env').write_text('EXTRA_COMPOSE_FILES="docker-compose.site.yml:custom.yml"\n')
            result = subprocess.check_output(['bash', '-c', function + '\nenvget EXTRA_COMPOSE_FILES'], cwd=directory)
            self.assertEqual(result.decode().strip(), 'docker-compose.site.yml:custom.yml')

    def test_reval_event_detection(self):
        spec = importlib.util.spec_from_file_location('detect', Path(__file__).with_name('detect-settings.py'))
        detect = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(detect)
        with patch.object(detect, 'sample', return_value=[['X|Y|CLIENT|USER', {'dialog_id': 'example'}]]):
            self.assertEqual(detect.detect({}), {'APP_EVENTS_FILE': 'config/app-events.reval.json', 'CLIENT_FROM_DISTINCT_ID': '3', 'DISTINCT_ID_SEPARATOR': '|'})
        with patch.object(detect, 'sample', return_value=[['ordinary', {'client_id': 'example'}]]):
            self.assertEqual(detect.detect({}), {})


if __name__ == '__main__':
    unittest.main()
