# Moves every organization, project and user from an upgraded copy of the old PostHog database into
# this PostHog's database. Run by posthog-import.sh inside a container of the NEW PostHog:
#
#   python manage.py shell < import_postgres.py       (env SOURCE_DB_NAME, STATE_DIR, DRY_RUN=1 to test)
#
# The old database has already been restored and migrated to this PostHog's version (phase 2), so both
# sides have the same tables and Django models. This script copies rows, model by model:
#   - which rows: everything that belongs to the old organizations, found by following foreign keys
#     (a dashboard belongs to a project, a tile to a dashboard, an API key to a user, and so on);
#   - ids: rows get new ids where this database numbers them itself; UUID ids are kept. Every foreign
#     key is rewritten to the new id, and so are cohort and action ids kept inside settings (JSON),
#     such as {"type": "cohort", "value": 12} in an insight, a cohort or a feature flag;
#   - project tokens, persons, distinct ids and UUIDs are kept, so events and replays still match;
#   - users who already exist here (same email) are reused instead of copied.
# Everything runs in one transaction: if anything fails, nothing is written.
# The old-to-new id maps go to STATE_DIR/idmap.json for the ClickHouse and storage phases.
import json
import os
import time
from collections import defaultdict

from django.apps import apps
from django.db import connections, models, transaction

SRC, LIVE = "migration_source", "default"
STATE_DIR = os.environ.get("STATE_DIR", "/migration/state")
DRY_RUN = os.environ.get("DRY_RUN") == "1"
t0 = time.time()


def log(*a):
    print(f"[{time.time() - t0:6.1f}s]", *a, flush=True)


cfg = dict(connections.databases[LIVE])
cfg["NAME"] = os.environ["SOURCE_DB_NAME"]
connections.databases[SRC] = cfg
src_tables = set(connections[SRC].introspection.table_names())
live_tables = set(connections[LIVE].introspection.table_names())

# Global to an install, rebuilt by PostHog, or meaningless elsewhere. Rows that need one of these are
# skipped (with a count); optional links to them are cleared unless the same row exists here.
SKIP_APPS = {"contenttypes", "sessions", "admin", "axes", "django_celery_beat", "django_otp", "otp_static", "otp_totp", "social_django", "two_factor", "oauth2_provider"}
SKIP_MODELS = {
    "posthog.instancesetting", "posthog.asyncmigration", "posthog.asyncmigrationerror", "posthog.hogfunctiontemplate",
    "posthog.plugin", "posthog.pluginsourcefile", "posthog.pluginattachment", "auth.permission", "auth.group",
}
# Large tables with JSON that never holds cohort or action ids: skipped by the id-rewriting pass.
NO_JSON_REMAP = {"posthog.person", "posthog.persondistinctid", "posthog.group", "posthog.eventdefinition", "posthog.propertydefinition", "posthog.eventproperty"}
ROOT = "posthog.organization"


def key(m):
    return m._meta.label_lower


every = {}
for m in apps.get_models(include_auto_created=True):
    if not m._meta.managed or m._meta.proxy or m._meta.app_label in SKIP_APPS or key(m) in SKIP_MODELS:
        continue
    if m._meta.db_table in src_tables and m._meta.db_table in live_tables:
        every[key(m)] = m
known = {key(m) for m in apps.get_models(include_auto_created=True)}
fks = {k: [f for f in m._meta.concrete_fields if f.is_relation and (f.many_to_one or f.one_to_one)] for k, m in every.items()}


def target(f):
    return key(f.related_model._meta.concrete_model)


def qs(k, db):
    return every[k]._base_manager.using(db)


# ------------------------------------------------------------------ 1. which rows belong to the old orgs
scoped = defaultdict(set)
scoped[ROOT] = set(qs(ROOT, SRC).values_list("pk", flat=True))
log(f"{len(scoped[ROOT])} organization(s) in the old database")


def pointing_at(k, attname, ids, chunk=20000):
    ids, out = list(ids), set()
    for i in range(0, len(ids), chunk):
        out.update(qs(k, SRC).filter(**{f"{attname}__in": ids[i : i + chunk]}).values_list("pk", flat=True))
    return out


changed, rounds = True, 0
while changed:
    changed, rounds = False, rounds + 1
    for k, fields in fks.items():
        for f in fields:
            t = target(f)
            if scoped.get(t):  # children of rows being copied
                new = pointing_at(k, f.attname, scoped[t]) - scoped[k]
                if new:
                    scoped[k] |= new
                    changed = True
    for k in [k for k in scoped if scoped[k] and k in fks]:  # parents of rows being copied (users, mostly)
        for f in fks[k]:
            t = target(f)
            if t not in every or t == k:
                continue
            vals = set()
            ids = list(scoped[k])
            for i in range(0, len(ids), 20000):
                vals.update(qs(k, SRC).filter(pk__in=ids[i : i + 20000]).exclude(**{f"{f.attname}__isnull": True}).values_list(f.attname, flat=True).distinct())
            new = vals - scoped[t]
            if new:
                scoped[t] |= new
                changed = True
log(f"rows found in {rounds} passes: " + ", ".join(f"{k}={len(v)}" for k, v in sorted(scoped.items()) if v))

# ------------------------------------------------------------------ 2. order: what a row needs comes first
deps = {k: {target(f) for f in fks[k] if scoped.get(target(f)) and target(f) != k and not f.null} for k in scoped if scoped[k]}
order, seen = [], set()


def visit(k, stack=()):
    if k in seen:
        return
    if k in stack:
        raise RuntimeError(f"required links form a loop: {' -> '.join(stack + (k,))}")
    for d in sorted(deps.get(k, ())):
        visit(d, stack + (k,))
    seen.add(k)
    order.append(k)


for k in sorted(deps):
    visit(k)

idmap = defaultdict(dict)
later = []  # (model, old pk, field, target model, old target pk): optional links to rows copied after
skipped = defaultdict(int)
team_like = {"team_id", "project_id", "environment_id", "parent_team_id"}


def is_auto(m):
    return isinstance(m._meta.pk, (models.AutoField, models.BigAutoField, models.SmallAutoField))


def next_team_id():
    with connections[LIVE].cursor() as c:
        c.execute("SELECT nextval(pg_get_serial_sequence('posthog_team', 'id'))")
        return c.fetchone()[0]


def remap_json(v):
    if isinstance(v, list):
        return [remap_json(x) for x in v]
    if not isinstance(v, dict):
        return v
    out = {k: remap_json(x) for k, x in v.items()}
    t = out.get("type")
    for field, table, applies in (
        ("value", idmap.get("posthog.cohort", {}), t in ("cohort", "precalculated-cohort", "static-cohort", "dynamic-cohort")),
        ("id", idmap.get("posthog.action", {}), t == "actions" or out.get("kind") == "ActionsNode"),
    ):
        if not applies or field not in out:
            continue
        try:
            old = int(out[field])
        except (TypeError, ValueError):
            continue
        if old in table:
            out[field] = str(table[old]) if isinstance(out[field], str) else table[old]
    return out


def copy_all():
    for k in order:
        m = every[k]
        ids = sorted(scoped[k], key=str)
        copied = reused = 0
        for i in range(0, len(ids), 2000):
            objs, olds = [], []
            for r in qs(k, SRC).filter(pk__in=ids[i : i + 2000]).values():
                old_pk = r[m._meta.pk.attname]
                if k == "posthog.user":
                    existing = qs(k, LIVE).filter(email__iexact=r["email"]).values_list("pk", flat=True).first()
                    if existing:
                        idmap[k][old_pk] = existing
                        reused += 1
                        continue
                elif not is_auto(m) and k not in ("posthog.team", "posthog.project") and qs(k, LIVE).filter(pk=old_pk).exists():
                    idmap[k][old_pk] = old_pk
                    reused += 1
                    continue
                ok = True
                for f in fks[k]:
                    v = r.get(f.attname)
                    if v is None:
                        continue
                    t = target(f)
                    if v in idmap.get(t, {}):
                        r[f.attname] = idmap[t][v]
                    elif v in scoped.get(t, ()):
                        if not f.null:
                            raise RuntimeError(f"{k}.{f.name} needs {t} {v}, which is not copied yet")
                        later.append((k, old_pk, f.attname, t, v))
                        r[f.attname] = None
                    elif t in every and qs(t, LIVE).filter(pk=v).exists():
                        pass  # a global row that exists here too
                    elif f.null:
                        r[f.attname] = None
                    else:
                        ok = False  # needs something that is not moved (old plugin code, for example)
                        break
                if not ok:
                    skipped[k] += 1
                    continue
                for f in m._meta.concrete_fields:
                    if f.attname in team_like and not f.is_relation and r.get(f.attname) is not None:
                        r[f.attname] = idmap["posthog.team"].get(r[f.attname], r[f.attname])
                if k == "posthog.organization" and r.get("slug") and qs(k, LIVE).filter(slug=r["slug"]).exists():
                    r["slug"] = f"{r['slug']}-moved"[:48]
                if k == "posthog.project":
                    r["id"] = next_team_id()  # a project shares its number with its first environment
                elif k == "posthog.team":
                    pmap = idmap.get("posthog.project", {})
                    # The project's first environment keeps the project's number; others get new ones.
                    r["id"] = r["project_id"] if old_pk in pmap and pmap[old_pk] == r.get("project_id") else next_team_id()
                elif is_auto(m):
                    r[m._meta.pk.attname] = None
                objs.append(m(**r))
                olds.append(old_pk)
            if objs:
                made = qs(k, LIVE).bulk_create(objs, batch_size=1000)
                for o, old in zip(made, olds):
                    idmap[k][old] = o.pk
                copied += len(made)
        log(f"{k}: {copied} copied" + (f", {reused} already here" if reused else "") + (f", {skipped[k]} skipped" if skipped[k] else ""))

    n = 0
    for k, old_pk, attname, t, old_target in later:
        new_pk, new_target = idmap[k].get(old_pk), idmap.get(t, {}).get(old_target)
        if new_pk is not None and new_target is not None:
            qs(k, LIVE).filter(pk=new_pk).update(**{attname: new_target})
            n += 1
    log(f"{n} links set after their rows were copied")

    rewritten = defaultdict(int)
    for k in order:
        m = every[k]
        jf = [f for f in m._meta.concrete_fields if isinstance(f, models.JSONField)]
        if not jf or k in NO_JSON_REMAP or not idmap.get(k):
            continue
        new_ids = list(idmap[k].values())
        for i in range(0, len(new_ids), 2000):
            for row in qs(k, LIVE).filter(pk__in=new_ids[i : i + 2000]).values("pk", *[f.attname for f in jf]):
                upd = {}
                for f in jf:
                    if row[f.attname] is not None:
                        after = remap_json(row[f.attname])
                        if after != row[f.attname]:
                            upd[f.attname] = after
                if upd:
                    qs(k, LIVE).filter(pk=row["pk"]).update(**upd)
                    rewritten[k] += 1
    log(f"cohort and action ids rewritten inside settings: {dict(rewritten) or 'none needed'}")
    with connections[LIVE].cursor() as c:
        c.execute("SELECT setval(pg_get_serial_sequence('posthog_team', 'id'), (SELECT max(id) FROM posthog_team))")
    if DRY_RUN:
        raise RuntimeError("DRY_RUN=1: everything checked, nothing written")


with transaction.atomic(using=LIVE):
    copy_all()

os.makedirs(STATE_DIR, exist_ok=True)
with open(os.path.join(STATE_DIR, "idmap.json"), "w") as fh:
    json.dump(
        {
            name: {str(a): (str(b) if not isinstance(b, int) else b) for a, b in idmap.get(f"posthog.{name}", {}).items()}
            for name in ("team", "project", "cohort", "action", "hogfunction", "featureflag", "organization", "user")
        }
        | {"counts": {k: len(v) for k, v in idmap.items()}, "skipped": dict(skipped)},
        fh,
        indent=2,
    )
log("done. projects, old id -> new id:", dict(idmap.get("posthog.team", {})))
