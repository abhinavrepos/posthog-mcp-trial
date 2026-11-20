"""Load deployment helpers without third-party dependencies."""
import runpy
from pathlib import Path
_helpers = runpy.run_path(str(Path(__file__).with_name('site-config.py')))
env = _helpers['env']
put = _helpers['put']
preserve = _helpers['preserve']
