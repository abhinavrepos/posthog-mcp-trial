#!/usr/bin/env python3
"""Make public code/config bind mounts readable under umask 077; leave secrets alone."""
import os
from pathlib import Path
import stat
import sys


def repair(folder):
    root = Path(folder)
    # These directories are mounted into web, worker, plugins, ClickHouse and Kafka.
    # Compose inputs (.env*, docker-compose*.yml) are read by root on the host only.
    for relative in ('compose', 'share', 'posthog/docker', 'posthog/posthog/idl',
                     'posthog/posthog/user_scripts', 'lens-tuning'):
        path = root / relative
        if not path.exists():
            continue
        for current, dirs, files in os.walk(path, followlinks=False):
            for entry in [Path(current), *(Path(current) / name for name in files)]:
                if entry.is_symlink():
                    continue
                mode = stat.S_IMODE(entry.stat().st_mode)
                # Preserve executability while exposing only public configuration and code.
                entry.chmod(mode | 0o444 | (0o111 if entry.is_dir() or mode & 0o111 else 0))
    print('Public bind-mount permissions checked (private Compose inputs unchanged).')


if __name__ == '__main__':
    repair(sys.argv[1])
