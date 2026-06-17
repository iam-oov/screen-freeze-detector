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


# User-writable config dir (XDG). The installed .deb runs from a Terminal=false
# .desktop launcher with no shell env, and /opt/screensound/ is root-owned — so
# the only place a user can drop secrets without sudo is here.
CONFIG_DIR = (
    Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config") / "screensound"
)
ENV_PATH = CONFIG_DIR / ".env"

# setdefault means first-set wins: real env vars (already loaded) beat both
# files; the local repo .env (dev) beats the user XDG .env (installed).
_load_dotenv(Path(__file__).parent / ".env")
_load_dotenv(ENV_PATH)

settings = SimpleNamespace(
    telegram_token=os.environ.get("SCREENSOUND_TELEGRAM_TOKEN", ""),
    telegram_chat_id=os.environ.get("SCREENSOUND_TELEGRAM_CHAT_ID", ""),
)


def save_telegram(token: str, chat_id: str) -> Path:
    """Persist Telegram creds to the user-writable XDG .env and update settings.

    ponytail: rewrites the whole file — it only ever holds these two screensound
    keys. chmod 0600 because the bot token is a secret.
    """
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    ENV_PATH.write_text(
        f"SCREENSOUND_TELEGRAM_TOKEN={token}\n"
        f"SCREENSOUND_TELEGRAM_CHAT_ID={chat_id}\n"
    )
    ENV_PATH.chmod(0o600)
    settings.telegram_token = token
    settings.telegram_chat_id = chat_id
    return ENV_PATH
