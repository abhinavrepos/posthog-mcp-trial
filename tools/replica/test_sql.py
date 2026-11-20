import datetime as dt
import unittest
from sql import COLUMNS, bounds, delete_day, maps, persons, select_day, team_id

class SQLTests(unittest.TestCase):
    def test_maps(self):
        clients, users, screens = maps()
        self.assertEqual(len(clients), 150)
        self.assertEqual(len(users), 900)
        self.assertEqual(len(screens[1:]), 40)
        self.assertEqual(dict(screens)['DlgTask03'], 'Amortization Report')
        self.assertEqual(dict(screens)['DlgTask01'], 'Cash Positions')

    def test_boundaries(self):
        self.assertIn("'2024-03-01'", bounds('2024-02-29'))
        self.assertIn("'2027-01-01'", bounds('2026-12-31'))
        with self.assertRaises(ValueError): bounds('2026-02-30')
        for value in ['0','-1','1; DROP TABLE x','1 OR 1=1','1.5']:
            with self.assertRaises(ValueError): team_id(value)

    def test_native_projection_and_rewrites(self):
        types = {c:'String' for c in COLUMNS}
        types.update(uuid='UUID', person_id='UUID', team_id='Int64', timestamp="DateTime64(6, 'UTC')")
        q = select_day(42, '2026-11-20', '2026-11-21', types)
        self.assertEqual(q.count(' AS `'), len(COLUMNS))
        self.assertIn('CAST(src.uuid AS UUID) AS `uuid`', q)
        self.assertIn("CAST(src.timestamp AS DateTime64(6, 'UTC')) AS `timestamp`", q)
        self.assertIn("'C1DEV|01|'", q)
        self.assertIn('SEMOPS', q)
        self.assertIn('"client_id":null', q)
        self.assertIn('toJSONString(src.`$session_id`)', q)
        self.assertIn('JSONMergePatch(src.properties,', q)
        self.assertIn('Asset/Liability & Revenue Recognition Report', q)
        self.assertIn("'2026-09-22'", q) # Exactly the last 60 calendar days.
        self.assertIn("'REVAL 27.0.0'", q)
        self.assertIn("'Task01'", q)
        self.assertIn('prefer_column_name_to_alias=1', q)
        self.assertTrue(q.endswith('FORMAT Native'))
        self.assertLess(len(q.encode()), 120_000) # Linux single-argument limit.

    def test_deletion_is_team_day_scoped_and_synchronous(self):
        q = delete_day(42,'2026-11-20')
        self.assertIn('team_id = 42 AND timestamp >=', q)
        self.assertIn("timestamp < toDateTime('2026-11-21', 'UTC')", q)
        self.assertTrue(q.endswith('mutations_sync=2'))

    def test_person_inserts_reconcile_existing_keys(self):
        queries = persons(42)
        self.assertEqual(len(queries),2)
        for q in queries:
            self.assertIn('GROUP BY distinct_id',q)
            self.assertIn('NOT IN (SELECT',q)
            self.assertIn('FINAL WHERE team_id = 42 AND is_deleted = 0',q)
        self.assertIn('any(person_id), min(timestamp)',queries[1])

if __name__ == '__main__': unittest.main()
