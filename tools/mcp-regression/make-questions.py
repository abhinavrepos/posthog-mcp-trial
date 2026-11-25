# Writes questions.json: the 100 regression questions with ClickHouse ground truth (posthog.events, team 1) or expected
# behaviour. Run from the repo root: python3 tools/mcp-regression/make-questions.py
import json
Q = []
E = "posthog.events"
def cl(c): return f"team_id=1 AND splitByChar('|',distinct_id)[3]='{c}'"
def P(k): return f"JSONExtractString(properties,'{k}')"
RW = "timestamp >= {from} AND timestamp < {to}"          # rolling window, filled by the runner
def fx(a, b): return f"timestamp >= '{a} 00:00:00' AND timestamp < '{b} 00:00:00'"  # fixed [a, b)
def add(cat, q, **kw): Q.append(dict(id=f"q{len(Q)+1:03d}", category=cat, question=q, **kw))

# 1. client lookups (10)
add('client_lookup', 'Which client does the Reval user U1688 belong to? Give the client code.', kind='text', sql=f"SELECT any(splitByChar('|',distinct_id)[3]) FROM {E} WHERE team_id=1 AND splitByChar('|',distinct_id)[4]='U1688'")
add('client_lookup', 'Which client is user U46 from?', kind='text', sql=f"SELECT any(splitByChar('|',distinct_id)[3]) FROM {E} WHERE team_id=1 AND splitByChar('|',distinct_id)[4]='U46'")
add('client_lookup', 'Who is the distinct id PROD|01|C46|U1006: which client code?', kind='text', expect_text='C46')
add('client_lookup', 'Resolve the client "c08" and tell me its code exactly as stored.', kind='text', expect_text='C08')
add('client_lookup', 'Resolve client SEM. How many events did SEM have in the last 30 days? Answer with the number.', kind='count', window_days=30, sql=f"SELECT count() FROM {E} WHERE {cl('SEM')} AND {RW}", note='SEM receives live simulator events during the run; bounds cover them')
add('client_lookup', 'Resolve the user U1757. How many events did that user have in the last 7 days?', kind='count', window_days=7, sql=f"SELECT count() FROM {E} WHERE team_id=1 AND splitByChar('|',distinct_id)[4]='U1757' AND {RW}")
add('client_lookup', 'When was client C33 last seen (last event before now)? Give the date YYYY-MM-DD.', kind='text', sql=f"SELECT toString(toDate(max(timestamp))) FROM {E} WHERE {cl('C33')} AND timestamp < now()")
add('client_lookup', 'How many distinct users does client C17 have in the last 30 days?', kind='count', window_days=30, sql=f"SELECT uniq(distinct_id) FROM {E} WHERE {cl('C17')} AND {RW}")
add('client_lookup', 'How many different clients (client codes) sent events in the last 7 days?', kind='count', window_days=7, sql=f"SELECT uniq(splitByChar('|',distinct_id)[3]) FROM {E} WHERE team_id=1 AND {RW}", note='includes simulator clients SEM and ACME')
add('client_lookup', 'Which client has the most events between 2026-11-01 and 2026-11-24 (inclusive, UTC)? Give the code.', kind='text', sql=f"SELECT splitByChar('|',distinct_id)[3] c FROM {E} WHERE team_id=1 AND {fx('2026-11-01','2026-11-25')} GROUP BY c ORDER BY count() DESC LIMIT 1")

# 2. counts over 1/7/30/90/365 days (15)
for c, d in [('C08',1),('C08',7),('C08',30),('C08',90),('C08',365),('C02',1),('C02',7),('C46',30),('C54',90),('C11',365)]:
    add('counts', f'How many events did client {c} have in the last {d} day{"s" if d>1 else ""}?', kind='count', window_days=d, sql=f"SELECT count() FROM {E} WHERE {cl(c)} AND {RW}")
add('counts', 'How many events were recorded in the whole project in the last 7 days?', kind='count', window_days=7, sql=f"SELECT count() FROM {E} WHERE team_id=1 AND {RW}")
add('counts', 'How many PageView events did client C19 have between 2026-11-16 and 2026-11-22 (inclusive, UTC)?', kind='count', sql=f"SELECT count() FROM {E} WHERE {cl('C19')} AND event='PageView' AND {fx('2026-11-16','2026-11-23')}")
add('counts', 'How many Event (interaction) events did client C27 have on 2026-11-20 (UTC)?', kind='count', sql=f"SELECT count() FROM {E} WHERE {cl('C27')} AND event='Event' AND {fx('2026-11-20','2026-11-21')}")
add('counts', 'How many events did client C05 have in October 2026?', kind='count', sql=f"SELECT count() FROM {E} WHERE {cl('C05')} AND {fx('2026-10-01','2026-11-01')}")
add('counts', 'How many events did the whole project have on Saturday 2026-11-21 (UTC)?', kind='count', sql=f"SELECT count() FROM {E} WHERE team_id=1 AND {fx('2026-11-21','2026-11-22')}")

# 3. top screens / buttons (10)
for c in ['C08','C17','C33']:
    add('top_screens_buttons', f'Which 5 dialogs (dialog_id) did client {c} open most often (PageView with action OPEN) between 2026-11-01 and 2026-11-24 inclusive? List the dialog ids, most first.', kind='list', k=5,
        sql=f"SELECT {P('dialog_id')} d FROM {E} WHERE {cl(c)} AND event='PageView' AND {P('action')}='OPEN' AND {fx('2026-11-01','2026-11-25')} GROUP BY d ORDER BY count() DESC LIMIT 5")
for c in ['C08','C46','C02']:
    add('top_screens_buttons', f'What are the top 5 buttons (action_name on Event, excluding messagebox and toast dialogs) pressed by client {c} between 2026-11-01 and 2026-11-24 inclusive? List them, most first.', kind='list', k=5,
        sql=f"SELECT {P('action_name')} b FROM {E} WHERE {cl(c)} AND event='Event' AND {P('dialog_id')} NOT IN ('messagebox','toast','menuCmb') AND b!='' AND {fx('2026-11-01','2026-11-25')} GROUP BY b ORDER BY count() DESC LIMIT 5")
add('top_screens_buttons', 'Which dialog_id had the most PageView events in the whole project on 2026-11-24 (UTC)?', kind='text', sql=f"SELECT {P('dialog_id')} d FROM {E} WHERE team_id=1 AND event='PageView' AND {fx('2026-11-24','2026-11-25')} GROUP BY d ORDER BY count() DESC LIMIT 1")
add('top_screens_buttons', 'How many times was the dialog LinkListReqv (Hedge Designation report) opened (PageView, action OPEN) by client C11 between 2026-11-01 and 2026-11-24 inclusive?', kind='count', sql=f"SELECT count() FROM {E} WHERE {cl('C11')} AND event='PageView' AND {P('action')}='OPEN' AND {P('dialog_id')}='LinkListReqv' AND {fx('2026-11-01','2026-11-25')}")
add('top_screens_buttons', 'How many distinct dialog_id values did client C54 use between 2026-11-16 and 2026-11-22 inclusive?', kind='count', sql=f"SELECT uniq({P('dialog_id')}) FROM {E} WHERE {cl('C54')} AND {fx('2026-11-16','2026-11-23')}")
add('top_screens_buttons', 'How many times did client C17 press Save (action_name exactly "Save") between 2026-11-01 and 2026-11-24 inclusive?', kind='count', sql=f"SELECT count() FROM {E} WHERE {cl('C17')} AND event='Event' AND {P('action_name')}='Save' AND {fx('2026-11-01','2026-11-25')}")

# 4. exports (8)
for lab, c in [('Export','C08'),('XLS Export','C11'),('XLSX Export','C17'),('CSV Export','C46')]:
    add('exports', f'How many times did client {c} press the "{lab}" button (exact label) between 2026-11-01 and 2026-11-24 inclusive?', kind='count', sql=f"SELECT count() FROM {E} WHERE {cl(c)} AND event='Event' AND {P('action_name')}='{lab}' AND {fx('2026-11-01','2026-11-25')}")
add('exports', 'How many exports of any kind (Export, XLS Export, XLSX Export, CSV Export) did client C02 do in the last 30 days?', kind='count', window_days=30, sql=f"SELECT count() FROM {E} WHERE {cl('C02')} AND event='Event' AND {P('action_name')} IN ('Export','XLS Export','XLSX Export','CSV Export') AND {RW}")
add('exports', 'Which export button label (Export, XLS Export, XLSX Export or CSV Export) was used most across all clients between 2026-11-16 and 2026-11-22 inclusive?', kind='text', sql=f"SELECT {P('action_name')} b FROM {E} WHERE team_id=1 AND event='Event' AND b IN ('Export','XLS Export','XLSX Export','CSV Export') AND {fx('2026-11-16','2026-11-23')} GROUP BY b ORDER BY count() DESC LIMIT 1")
add('exports', 'How many exports (any of the four export buttons) were done from inside the LinkListReqv dialog by client C08 between 2026-11-01 and 2026-11-24 inclusive?', kind='count', sql=f"SELECT count() FROM {E} WHERE {cl('C08')} AND event='Event' AND {P('dialog_id')}='LinkListReqv' AND {P('action_name')} IN ('Export','XLS Export','XLSX Export','CSV Export') AND {fx('2026-11-01','2026-11-25')}")
add('exports', 'How many distinct users of client C33 used CSV Export between 2026-11-01 and 2026-11-24 inclusive?', kind='count', sql=f"SELECT uniq(distinct_id) FROM {E} WHERE {cl('C33')} AND event='Event' AND {P('action_name')}='CSV Export' AND {fx('2026-11-01','2026-11-25')}")

# 5. errors / messagebox / toast (10)
MSG = f"JSONExtractString({P('action_name')},1)"
add('errors_messages', 'How many messagebox events did client C08 get between 2026-11-01 and 2026-11-24 inclusive?', kind='count', sql=f"SELECT count() FROM {E} WHERE {cl('C08')} AND event='Event' AND {P('dialog_id')}='messagebox' AND {fx('2026-11-01','2026-11-25')}")
add('errors_messages', 'How many toast notices did client C46 get on 2026-11-24 (UTC)?', kind='count', sql=f"SELECT count() FROM {E} WHERE {cl('C46')} AND event='Event' AND {P('dialog_id')}='toast' AND {fx('2026-11-24','2026-11-25')}")
add('errors_messages', 'How many times did users of client C17 see the message "Error saving trade" (in a messagebox or a toast) between 2026-11-01 and 2026-11-24 inclusive?', kind='count', sql=f"SELECT count() FROM {E} WHERE {cl('C17')} AND event='Event' AND {P('dialog_id')} IN ('messagebox','toast') AND {MSG}='Error saving trade' AND {fx('2026-11-01','2026-11-25')}")
add('errors_messages', 'What was the most frequent messagebox text for client C02 between 2026-11-16 and 2026-11-22 inclusive?', kind='text', sql=f"SELECT {MSG} m FROM {E} WHERE {cl('C02')} AND event='Event' AND {P('dialog_id')}='messagebox' AND m!='' AND {fx('2026-11-16','2026-11-23')} GROUP BY m ORDER BY count() DESC LIMIT 1")
add('errors_messages', 'How many "Error saving trade" messages (messagebox or toast) were shown across the whole project in the last 7 days?', kind='count', window_days=7, sql=f"SELECT count() FROM {E} WHERE team_id=1 AND event='Event' AND {P('dialog_id')} IN ('messagebox','toast') AND {MSG}='Error saving trade' AND {RW}")
add('errors_messages', 'Which user of client C33 saw "Error saving trade" most often between 2026-11-01 and 2026-11-24 inclusive? Give the user code.', kind='text', sql=f"SELECT splitByChar('|',distinct_id)[4] u FROM {E} WHERE {cl('C33')} AND event='Event' AND {P('dialog_id')} IN ('messagebox','toast') AND {MSG}='Error saving trade' AND {fx('2026-11-01','2026-11-25')} GROUP BY u ORDER BY count() DESC LIMIT 1")
add('errors_messages', 'How many "Report has been scheduled" notices (toast only) did client C54 get between 2026-11-16 and 2026-11-22 inclusive?', kind='count', sql=f"SELECT count() FROM {E} WHERE {cl('C54')} AND event='Event' AND {P('dialog_id')}='toast' AND {MSG}='Report has been scheduled' AND {fx('2026-11-16','2026-11-23')}")
add('errors_messages', 'List the distinct message texts that appeared in messagebox dialogs for client C08 between 2026-11-01 and 2026-11-24 inclusive.', kind='list', k=4, sql=f"SELECT DISTINCT {MSG} m FROM {E} WHERE {cl('C08')} AND event='Event' AND {P('dialog_id')}='messagebox' AND m!='' AND {fx('2026-11-01','2026-11-25')}")
add('errors_messages', 'How many messagebox events showed "No entry selected" for client C11 in the last 30 days?', kind='count', window_days=30, sql=f"SELECT count() FROM {E} WHERE {cl('C11')} AND event='Event' AND {P('dialog_id')}='messagebox' AND {MSG}='No entry selected' AND {RW}")
add('errors_messages', 'What share (percent, one decimal) of client C08 Event events between 2026-11-01 and 2026-11-24 inclusive were messagebox or toast events?', kind='number', tolerance=0.051, sql=f"SELECT round(100*countIf({P('dialog_id')} IN ('messagebox','toast'))/count(),1) FROM {E} WHERE {cl('C08')} AND event='Event' AND {fx('2026-11-01','2026-11-25')}")

# 6. active users trends (8)
add('active_users', 'How many distinct users did client C08 have on 2026-11-24 (UTC)?', kind='count', sql=f"SELECT uniq(distinct_id) FROM {E} WHERE {cl('C08')} AND {fx('2026-11-24','2026-11-25')}")
add('active_users', 'Give the daily active users (distinct users) of the whole project for each day from 2026-11-16 to 2026-11-22 (UTC), as a comma-separated list of 7 numbers in date order.', kind='numbers', sql=f"SELECT uniq(distinct_id) FROM {E} WHERE team_id=1 AND {fx('2026-11-16','2026-11-23')} GROUP BY toDate(timestamp) ORDER BY toDate(timestamp)")
add('active_users', 'How many distinct users did the whole project have between 2026-11-16 and 2026-11-22 inclusive (weekly active users)?', kind='count', sql=f"SELECT uniq(distinct_id) FROM {E} WHERE team_id=1 AND {fx('2026-11-16','2026-11-23')}")
add('active_users', 'How many distinct users did client C46 have in the last 90 days?', kind='count', window_days=90, sql=f"SELECT uniq(distinct_id) FROM {E} WHERE {cl('C46')} AND {RW}")
add('active_users', 'Did the number of distinct active users of client C17 go up, down or stay the same from the week 2026-11-09..2026-11-15 to the week 2026-11-16..2026-11-22? Answer up, down or same.', kind='text', sql=f"SELECT multiIf(b>a,'up',b<a,'down','same') FROM (SELECT uniqIf(distinct_id,{fx('2026-11-09','2026-11-16')}) a, uniqIf(distinct_id,{fx('2026-11-16','2026-11-23')}) b FROM {E} WHERE {cl('C17')})")
add('active_users', 'How many events per day on average did client C02 have over 2026-11-16..2026-11-22 (7 days)? Round to a whole number.', kind='number', tolerance=1, sql=f"SELECT round(count()/7) FROM {E} WHERE {cl('C02')} AND {fx('2026-11-16','2026-11-23')}")
add('active_users', 'Which weekday (Monday..Sunday) had the most events across the project between 2026-11-02 and 2026-11-22 inclusive?', kind='text', sql=f"SELECT dateName('weekday', toDate(timestamp)) w FROM {E} WHERE team_id=1 AND {fx('2026-11-02','2026-11-23')} GROUP BY w ORDER BY count() DESC LIMIT 1")
add('active_users', 'How many distinct users did client C33 have in the last 365 days?', kind='count', window_days=365, sql=f"SELECT uniq(distinct_id) FROM {E} WHERE {cl('C33')} AND {RW}")

# 7. sessions + replay links (10)
SESS = f"{P('$session_id')}"
add('sessions', 'Find a session of client C08 in the last 7 days in which the user opened the Hedge Designation report (dialog LinkListReqv). Give its session id.', kind='answer_sql', sql=f"SELECT count() FROM {E} WHERE {cl('C08')} AND {SESS}={{answer}} AND {P('dialog_id')}='LinkListReqv'", tool='find_sessions')
add('sessions', 'Find a session of client C17 in the last 30 days where someone pressed "CSV Export". Give the session id.', kind='answer_sql', sql=f"SELECT count() FROM {E} WHERE {cl('C17')} AND {SESS}={{answer}} AND {P('action_name')}='CSV Export'", tool='find_sessions')
add('sessions', 'Find the most recent session of user U1688 and give its session id.', kind='answer_sql', sql=f"SELECT count() FROM {E} WHERE team_id=1 AND splitByChar('|',distinct_id)[4]='U1688' AND {SESS}={{answer}}", tool='find_sessions')
add('sessions', 'How many sessions did user U1757 have on 2026-11-24 (UTC)?', kind='count', sql=f"SELECT uniq({SESS}) FROM {E} WHERE team_id=1 AND splitByChar('|',distinct_id)[4]='U1757' AND {fx('2026-11-24','2026-11-25')}")
add('sessions', 'Find a recent session of client C46 where the message "Error saving trade" appeared, and give me a replay link for it. Answer with the session id.', kind='answer_sql', sql=f"SELECT count() FROM {E} WHERE {cl('C46')} AND {SESS}={{answer}} AND {MSG}='Error saving trade'", tool='find_sessions')
add('sessions', 'Get the replay link for session b0b07a50-a614-43d1-cb4d-d52df885cb71. Is there a recording? Answer yes or no.', kind='behaviour', expect=dict(tool='get_replay_link', answer='^no\\b', any_text='recording|replay'), note='simulated data has no recordings')
add('sessions', 'Find sessions of client C08 with screen LinkListReqv in the last 1 day that have a recording I can watch. How many are there?', kind='behaviour', expect=dict(tool='find_sessions', answer='^(0|none|no)\\b'), note='no recordings in this project')
add('sessions', 'How many distinct sessions did client C02 have on 2026-11-24 (UTC)?', kind='count', sql=f"SELECT uniq({SESS}) FROM {E} WHERE {cl('C02')} AND {fx('2026-11-24','2026-11-25')}")
add('sessions', 'Give me the Lens clip page URL (not the PostHog replay) for the most recent session of user U46.', kind='behaviour', expect=dict(tool='find_sessions', answer='https?://\\S+'))
add('sessions', 'In the last 7 days, find a session of client C33 where the user typed or touched the field "Trade Date". Give the session id, or say none if there is no such session.', kind='behaviour', expect=dict(tool='find_sessions', answer='^(none|no|n/?a|0)\\b|not found|no session'), note='the simulated data has no "Trade Date" field (action is CHANGE/CLICK): the right answer is none')

# 8. surveys (10)
add('surveys', 'How many surveys exist in total (any status) according to list_surveys?', kind='count', expected=22, note='22 surveys at run time; stable unless a new survey is created')
add('surveys', 'How many times was the survey "Hedge export mwv7w5ry" shown (all time)?', kind='count', sql=f"SELECT count() FROM {E} WHERE team_id=1 AND event='survey shown' AND {P('$survey_id')}='01a20f7f-a88f-0000-e846-86bf537bde32'", note='list_surveys or survey_results both report it')
add('surveys', 'How many responses (answers) has the survey "Hedge export mwvlqpv2" received?', kind='count', sql=f"SELECT count() FROM {E} WHERE team_id=1 AND event='survey sent' AND {P('$survey_id')}='01a210e2-972b-0000-d447-ecd431f4e366'")
add('surveys', 'Design (do not save) a survey that shows after a user opens LinkListReqv and then presses Export in that dialog, for client C08, with one 1-5 rating question "How easy was the export?". Did Lens report any errors (not warnings)? Answer yes or no.', kind='behaviour', expect=dict(tool='design_survey', answer='^no\\b'))
add('surveys', 'Design (do not save) a survey shown after a user opens the dialog DlgHedgeDesigListReport and then presses Export there, one rating question. What dialog id does Lens suggest instead? Answer with the id.', kind='behaviour', expect=dict(tool='design_survey', answer='LinkListReqv'))
add('surveys', 'Design (do not save) a survey shown after the user presses the button "Exprot" in LinkListReqv, one thumbs question. Does Lens warn that the button matched nothing? Answer yes or no.', kind='behaviour', expect=dict(tool='design_survey', answer='^yes\\b'))
add('surveys', 'Design (do not save) a survey for client "ZZZ9" (no such client) shown after opening LinkListReqv, one yes/no question. Does Lens warn about the audience? Answer yes or no.', kind='behaviour', expect=dict(tool='design_survey', answer='^yes\\b'))
add('surveys', 'Design (do not save) a survey shown after opening LinkListReqv then pressing Export, for all clients, over the last 365 days of history. What window does the reach estimate use? Answer with the number of days.', kind='behaviour', expect=dict(tool='design_survey', answer='\\b90\\b'), note='design_survey caps reach to 90 days')
add('surveys', 'Which survey has been shown the most times? Give its name.', kind='text', expect_text_any=['Hedge export mwv7w5ry', 'Hedge export mwvlqpv2'], note='tie: both 60')
add('surveys', 'Is the survey "Hedge export mwv7w5ry" currently running or stopped? Answer running or stopped.', kind='text', expect_text='stopped')

# 9. pinned (6)
add('pinned', 'Pin a bar chart titled "Regression Q-pin-1" with x ["Mon","Tue","Wed"] and one series "events" with values [3,5,8]. Then unpin it again. Did both succeed? Answer yes or no.', kind='behaviour', expect=dict(tool='pin_graph', tool2='unpin_graph', answer='^yes\\b', no_tool_error=True))
add('pinned', 'Pin a table titled "Regression Q-pin-2" with columns client and events and rows [C08, 100] and [C02, 90]. Then list pinned graphs and tell me whether it is in the list (yes or no). Afterwards unpin it.', kind='behaviour', expect=dict(tool='pin_graph', tool2='list_pinned', answer='^yes\\b'))
add('pinned', 'Pin a line chart titled "Regression Q-pin-3" with x ["a","b","c"] and series "s" with values [1,2] (exactly as given, do not fix it). Did Lens accept it? Answer yes or no.', kind='behaviour', expect=dict(tool='pin_graph', answer='^no\\b', any_text='length|match|x'))
add('pinned', 'Unpin the graph with id 6f1e2d3c-4b5a-4c7d-8e9f-0a1b2c3d4e5f. Did it work? Answer yes or no.', kind='behaviour', expect=dict(tool='unpin_graph', answer='^no\\b'))
add('pinned', 'Make a bar chart of client C08 events per day for 2026-11-16..2026-11-22 (UTC), pin it titled "Regression Q-pin-5", then unpin it. Give the value for 2026-11-20.', kind='count', sql=f"SELECT count() FROM {E} WHERE {cl('C08')} AND {fx('2026-11-20','2026-11-21')}", tool='pin_graph')
add('pinned', 'Pin a line chart titled "Regression Q-pin-6" with 21 series (s1..s21), x ["a","b"], each series values [1,2]. Did Lens accept it? Answer yes or no.', kind='behaviour', expect=dict(tool='pin_graph', answer='^no\\b'), note='at most 20 series')

# 10. edge cases (13)
add('edge_cases', 'How many events did client ZZZ9 have in the last 30 days?', kind='behaviour', expect=dict(tool='resolve_client', answer='^(0|none|n/?a|unknown|no)\\b|not found|no such|does not exist|unknown'))
add('edge_cases', 'How many events did client C08 have in the last 2 years?', kind='count', window_days=730, sql=f"SELECT count() FROM {E} WHERE {cl('C08')} AND {RW}", note='data starts 2025-11-24: the answer is all data up to now')
add('edge_cases', 'Find sessions of client C08 with screen LinkListReqv between 2024-01-01 and 2026-11-25. How many days of history can find_sessions search at most? Answer with a number.', kind='behaviour', expect=dict(tool='find_sessions', answer='\\b(365|366)\\b'))
add('edge_cases', 'How many events did client C08 have on 2025-01-01 (UTC)?', kind='count', expected=0)
add('edge_cases', 'How many events did client C0 have in the last 7 days?', kind='behaviour', expect=dict(tool='resolve_client', any_text='C0\\d|ambig|which|several|multiple'), note='ambiguous: C00..C09')
add('edge_cases', 'How many events did client "SME" have in the last 7 days? (I may have mistyped the client.)', kind='behaviour', expect=dict(tool='resolve_client', any_text='SEM'))
add('edge_cases', 'Run this exact HogQL through PostHog and tell me the result: SELECT count( FROM events', kind='behaviour', expect=dict(tool='posthog_exec', answer='error|syntax|invalid|fail', any_text='error|syntax|invalid'))
add('edge_cases', 'List every distinct_id that had an event in the last 30 days, all of them, with one PostHog SQL query (no aggregation). How many rows did PostHog return?', kind='behaviour', expect=dict(tool='posthog_exec', answer='\\b500\\b'), note='execute-sql caps at 500 rows; ground truth 2,392 distinct ids')
add('edge_cases', 'Use the PostHog tool "query-run" (call it via posthog_exec) to count events in the last day. What happened?', kind='behaviour', expect=dict(tool='posthog_exec', any_text='query-run'), note='query-run was removed by PostHog: the call must say so, not "unavailable"')
add('edge_cases', 'How many events did client C08 have between 2026-12-01 and 2026-12-31?', kind='behaviour', expect=dict(answer='^(0|none|no)\\b|future|not yet|no data'))
add('edge_cases', 'How many events did the client "Brightwater Logistics" have in the last 90 days?', kind='behaviour', expect=dict(tool='resolve_client', answer='^(0|none|n/?a|unknown|no)\\b|not found|no such|does not exist|unknown|no client'))
add('edge_cases', 'How many events did user U999999 have in the last 7 days?', kind='behaviour', expect=dict(answer='^(0|none|n/?a|unknown|no)\\b|not found|no such|does not exist|unknown'))
add('edge_cases', 'Count C08 events in the last 7 days, but use the posthog_exec command "tools" first to see which PostHog tools exist. How many events?', kind='count', window_days=7, sql=f"SELECT count() FROM {E} WHERE {cl('C08')} AND {RW}")

assert len(Q) == 100, len(Q)
json.dump(Q, open('tools/mcp-regression/questions.json', 'w'), indent=1)
from collections import Counter; print(Counter(q['category'] for q in Q))
