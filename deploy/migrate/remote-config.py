"""Run through manage.py shell; rebuild or verify every team's config.js."""
import importlib
import os
import urllib.request
from posthog.models import Team

if os.environ.get('REMOTE_CONFIG_VERIFY') != '1':
    RemoteConfig = None
    for module in ('posthog.models.remote_config', 'posthog.models', 'posthog.models.team.remote_config'):
        try:
            RemoteConfig = getattr(importlib.import_module(module), 'RemoteConfig')
            break
        except (ImportError, AttributeError):
            continue
    if RemoteConfig is None:
        from django.apps import apps
        RemoteConfig = next((m for m in apps.get_models() if m.__name__ == 'RemoteConfig'), None)
    if RemoteConfig is None:
        raise RuntimeError('RemoteConfig model not found in this version; locate RemoteConfig and run get_or_create(team=t)[0].sync() for every team')
    for team in Team.objects.all():
        config, _ = RemoteConfig.objects.get_or_create(team=team)
        config.sync()
        print('RemoteConfig synced for team', team.pk)
else:
    failures = []
    opener = urllib.request.build_opener(type('NoRedirect', (urllib.request.HTTPRedirectHandler,), {'redirect_request': lambda *args: None})())
    for team in Team.objects.all():
        try:
            with opener.open('http://proxy/array/' + team.api_token + '/config.js', timeout=20) as response:
                assert response.status == 200
            print('PASS config.js team', team.pk)
        except Exception as error:
            failures.append(team.pk)
            print('FAIL config.js team', team.pk, type(error).__name__, '; rebuild RemoteConfig')
    if failures:
        raise RuntimeError('config.js unavailable for teams ' + str(failures))
