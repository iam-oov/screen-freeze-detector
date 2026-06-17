"""Application configuration.

Single entry point for env / .env values consumed by freeze_detector.py.
Plain stdlib — every value is optional, read from the environment (and a local
.env if present, which never overrides a real environment variable).
"""

import os
from pathlib import Path
from types import SimpleNamespace


def _load_dotenv(path: Path) -> None:
    try:
        text = path.read_text()
    except OSError:
        return
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip("\"'"))


_load_dotenv(Path(__file__).parent / ".env")

settings = SimpleNamespace(
    telegram_token=os.environ.get("SCREENSOUND_TELEGRAM_TOKEN", ""),
    telegram_chat_id=os.environ.get("SCREENSOUND_TELEGRAM_CHAT_ID", ""),
)
