import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import runner

class RunnerTests(unittest.TestCase):
    def test_full_frozen_year_including_leap_day(self):
        days = runner.dates({'start':'2024-01-01','end':'2024-12-31'})
        self.assertEqual(len(days),365)
        self.assertIn('2024-02-29',days)
        self.assertEqual(days[-1],'2024-12-30')

    def test_disk_floor_stops_all_lanes(self):
        runner.STOP.clear()
        try:
            with patch.object(runner.shutil,'disk_usage',return_value=SimpleNamespace(free=24*1024**3)):
                with self.assertRaisesRegex(RuntimeError,'STOP'):
                    runner.disk()
            self.assertTrue(runner.STOP.is_set())
        finally:
            runner.STOP.clear()

    def test_exact_counts_and_zero_days(self):
        with patch.object(runner,'source',return_value='2026-01-01\t123'), patch.object(runner,'ch',return_value='2026-01-01\t124'), patch.object(runner,'replay_filter',return_value=''):
            self.assertEqual(runner.counts(42,{'start':'2026-01-01','end':'2026-01-03'}), [('2026-01-01',123,124),('2026-01-02',0,0)])

    def test_replay_filter_only_known_events_for_same_team(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(runner,'ROOT',Path(tmp)):
            path = Path(tmp)/'replays-manifest.json'
            event_id = '00000000-0000-4000-8000-000000000001'
            path.write_text(json.dumps({'team':42,'sessions':[{'events':[{'uuid':event_id}]}]}))
            self.assertIn(f"toUUID('{event_id}')",runner.replay_filter(42))
            self.assertEqual(runner.replay_filter(43),'')
            path.write_text(json.dumps({'team':42,'sessions':[{'events':[{'uuid':"'); DROP TABLE x"}]}]}))
            with self.assertRaises(ValueError): runner.replay_filter(42)

if __name__ == '__main__': unittest.main()
