import sys
from pathlib import Path

# so `notify` imports on Vercel too
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from notify.app import app

__all__ = ["app"]
