"""Assert checks for config.save_telegram (round-trip + perms).

Sets XDG_CONFIG_HOME to a temp dir BEFORE importing config so CONFIG_DIR
resolves there. Run with: uv run python test_config.py
"""

import os
import tempfile
from pathlib import Path

_tmp = tempfile.mkdtemp()
os.environ["XDG_CONFIG_HOME"] = _tmp
# Make sure real env vars don't shadow what we write.
os.environ.pop("SCREENSOUND_TELEGRAM_TOKEN", None)
os.environ.pop("SCREENSOUND_TELEGRAM_CHAT_ID", None)

import config  # noqa: E402

path = config.save_telegram("tok123", "999")

assert path == Path(_tmp) / "screensound" / ".env", path
assert path.read_text() == (
    "SCREENSOUND_TELEGRAM_TOKEN=tok123\n"
    "SCREENSOUND_TELEGRAM_CHAT_ID=999\n"
), repr(path.read_text())
assert oct(path.stat().st_mode)[-3:] == "600", oct(path.stat().st_mode)
assert config.settings.telegram_token == "tok123"
assert config.settings.telegram_chat_id == "999"

# Re-parse the written file the same way config._load_dotenv would, into a
# fresh env, to prove it round-trips back to the same values.
fresh: dict[str, str] = {}
for line in path.read_text().splitlines():
    k, v = line.split("=", 1)
    fresh[k.strip()] = v.strip().strip("\"'")
assert fresh["SCREENSOUND_TELEGRAM_TOKEN"] == "tok123"
assert fresh["SCREENSOUND_TELEGRAM_CHAT_ID"] == "999"

print("test_config: OK")
