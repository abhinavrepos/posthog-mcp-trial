#!/usr/bin/env python3
"""Offline safety checks. Run: python3 deploy/posthog/test-tuning.py"""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
import xml.etree.ElementTree as ET

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('tuning', HERE / 'tuning.py')
tuning = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tuning)

CADDY = '''{
    admin off
}
http://localhost {
    @lens_surveys_api {
        path /api/projects/*/surveys/*
        not header X-Lens-Survey-Gate aabbcc
    }
    handle @lens_surveys_api {
        respond "lens_only" 403
    }
    redir /project/*/surveys https://lens/replays/surveys 302
    encode gzip
    reverse_proxy web:8000
}
'''

class Tuning(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.env_file = self.root / '.env'
        self.env_file.write_text('COMPOSE_FILE=docker-compose.yml:docker-compose.lens-survey-lock.yml\nEXTRA_COMPOSE_FILES=docker-compose.lens-survey-lock.yml\n')
        (self.root / 'docker-compose.yml').write_text('services: {}\n')
        self.env = dict(os.environ, POSTHOG_DIR=str(self.root), LENS_TUNE_RAM_MB='16384')

    def run_tune(self, mode=None, **env):
        return subprocess.run(['bash', str(HERE / 'tune.sh')] + ([mode] if mode else []),
            env=dict(self.env, **env), text=True, capture_output=True, timeout=30)

    def test_dry_run_and_config_validation(self):
        result = self.run_tune('--dry-run')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('"workers": 2', result.stdout)
        self.assertIn('"workers": 3', self.run_tune('--dry-run', LENS_TUNE_RAM_MB='32768').stdout)
        for key, value in [('LENS_PH_WORKERS', '0'), ('LENS_CH_SPILL_MB', '99999'), ('LENS_CH_RAM_RATIO', '1.5'), ('LENS_CH_QUERY_MB', 'oops')]:
            self.assertNotEqual(self.run_tune('--dry-run', **{key: value}).returncode, 0)
        before = self.env_file.read_text()
        for mode in [True, True, False]:
            tuning.env_edit(self.env_file, mode)
            text = self.env_file.read_text()
            self.assertIn('COMPOSE_FILE=docker-compose.yml:docker-compose.lens-survey-lock.yml', text)
            self.assertEqual(text.count(tuning.OVERRIDE), 2 if mode else 0)
        self.assertEqual(self.env_file.read_text(), before)
        out = self.root / 'generated'
        tuning.generate(out, self.env_file)
        users = ET.parse(out/'users.xml')
        server = ET.parse(out/'server.xml')
        total = int(server.findtext('max_server_memory_usage'))
        ram = json.loads((out/'settings.json').read_text())['ram_mb']
        self.assertEqual(total, min(8192, max(1024, ram // 7)) * 1024 * 1024, 'about a seventh of RAM for ClickHouse')
        self.assertIsNone(server.find('max_server_memory_usage_to_ram_ratio'), 'no ratio unless set')
        per_query = int(users.findtext('profiles/default/max_memory_usage'))
        self.assertTrue(total // 2 < per_query < total, 'one query may use most, not all')
        self.assertLess(int(users.findtext('profiles/default/max_bytes_before_external_sort')), per_query, 'sorts spill before the query limit')
        self.assertGreater(float(users.findtext('profiles/default/max_bytes_ratio_before_external_group_by')), 0)
        # ClickHouse rejects (not clamps) queries whose SETTINGS exceed a constraint: PostHog sends its own.
        self.assertIsNone(users.find('profiles/default/constraints'), 'no constraints that could reject PostHog queries')
        self.assertIsNone(users.find('profiles/default/max_threads'), 'threads left to PostHog unless set')
        override = json.loads((out/tuning.OVERRIDE).read_text())
        self.assertNotIn('CADDYFILE', override['services']['proxy'].get('environment', {}))

    def test_proxy_preserves_the_effective_survey_lock(self):
        result = subprocess.run(['sh', str(HERE/'tuning-proxy.sh'), '--render'], input=CADDY, text=True,
            env=dict(self.env, LENS_TUNE_CADDY_BLOCK=str(HERE/'tuning-static.caddy')), capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.replace((HERE/'tuning-static.caddy').read_text(), ''), CADDY)
        invalid = subprocess.run(['sh', str(HERE/'tuning-proxy.sh'), '--render'], input='no site\n', text=True,
            env=dict(self.env, LENS_TUNE_CADDY_BLOCK=str(HERE/'tuning-static.caddy')), capture_output=True)
        self.assertNotEqual(invalid.returncode, 0)

    def fake_docker(self):
        docker = self.root/'docker'
        docker.write_text('''#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
root = Path(os.environ['POSTHOG_DIR'])
args = sys.argv[1:]
with (root/'commands.log').open('a') as f: f.write(' '.join(args)+'\\n')
if args[:2] == ['compose', 'config'] and '--format' in args:
    print(json.dumps({'services': {'web': {'image':'web:test'}, 'clickhouse': {'image':'ch:test'}, 'proxy': {'image':'proxy:test', 'environment': {'CADDYFILE': (root/'base.caddy').read_text(), 'CADDY_EXTRA_CONFIG': ''}}}}))
if args[0] == 'run' and 'granian' in args:
    print('--workers-lifetime' if not os.environ.get('MOCK_OLD_GRANIAN') else '--workers')
if args[0] == 'run' and '-i' in args:
    text = sys.stdin.read()
    assert '@lens_surveys_api' in text and 'respond "lens_only" 403' in text and '/project/*/surveys' in text
    if os.environ.get('MOCK_BAD_CADDY'): sys.exit(1)
if args[:2] == ['compose','exec'] and os.environ.get('MOCK_UNHEALTHY'): sys.exit(1)
if args[:2] == ['compose','up'] and os.environ.get('MOCK_FAIL_ONCE') and not (root/'failed.once').exists():
    (root/'failed.once').touch()
    sys.exit(1)
''')
        docker.chmod(0o755)
        (self.root/'base.caddy').write_text(CADDY)
        self.env['PATH'] = str(self.root) + os.pathsep + os.environ['PATH']

    def test_apply_idempotence_and_undo_keep_survey_override(self):
        self.fake_docker()
        before = self.env_file.read_text()
        result = self.run_tune()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(tuning.OVERRIDE, self.env_file.read_text())
        log = (self.root/'commands.log')
        log.write_text('')
        result = self.run_tune()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('already current', result.stdout)
        self.assertNotIn('compose up', log.read_text())
        result = self.run_tune('--undo')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.env_file.read_text(), before)
        self.assertFalse((self.root/tuning.OVERRIDE).exists())
        self.assertFalse((self.root/'lens-tuning').exists())

    def test_refuses_invalid_proxy_and_unsupported_granian_before_mutation(self):
        self.fake_docker()
        before = self.env_file.read_text()
        for option in ['MOCK_BAD_CADDY', 'MOCK_OLD_GRANIAN']:
            result = self.run_tune(**{option: '1'})
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(self.env_file.read_text(), before)
            self.assertFalse((self.root/tuning.OVERRIDE).exists())
        self.assertNotIn('compose up', (self.root/'commands.log').read_text())

    def test_failed_restart_rolls_back(self):
        self.fake_docker()
        before = self.env_file.read_text()
        result = self.run_tune(MOCK_FAIL_ONCE='1')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('restoring the previous deployment', result.stderr)
        self.assertEqual(self.env_file.read_text(), before)
        self.assertFalse((self.root/tuning.OVERRIDE).exists())
        self.assertFalse((self.root/'lens-tuning').exists())
        self.assertEqual((self.root/'commands.log').read_text().count('compose up'), 2)

    def test_health_timeout_rolls_back(self):
        self.fake_docker()
        before = self.env_file.read_text()
        result = self.run_tune(MOCK_UNHEALTHY='1', LENS_TUNE_HEALTH_SECONDS='1')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('PostHog did not become healthy', result.stderr)
        self.assertEqual(self.env_file.read_text(), before)
        self.assertFalse((self.root/tuning.OVERRIDE).exists())
        self.assertEqual((self.root/'commands.log').read_text().count('compose up'), 2)

if __name__ == '__main__':
    unittest.main()
