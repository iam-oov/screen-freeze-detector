"""Smallest check: the multipart body for Telegram sendPhoto is well-formed.

Run: uv run python test_telegram.py
"""

from freeze_detector import TelegramPoller, encode_multipart


def test_encode_multipart() -> None:
    boundary = "BOUNDARY123"
    png = b"\x89PNG\r\n\x1a\nFAKE\x00\xffDATA"
    body = encode_multipart(
        {"chat_id": "42", "caption": "Zone 1 frozen at 12:00:00"},
        "photo",
        "zone.png",
        png,
        boundary,
    )

    # One opening delimiter per part (2 fields + 1 file), plus the closing one.
    assert body.count(b"--BOUNDARY123\r\n") == 3
    assert body.endswith(b"--BOUNDARY123--\r\n")

    # Text fields present.
    assert b'name="chat_id"' in body and b"42" in body
    assert b'name="caption"' in body and b"Zone 1 frozen at 12:00:00" in body

    # File part present with the raw bytes intact (binary survives untouched).
    assert b'name="photo"; filename="zone.png"' in body
    assert b"Content-Type: image/png" in body
    assert png in body


def _update(chat_id, text):
    return {"update_id": 1, "message": {"chat": {"id": chat_id}, "text": text}}


def test_command_only_from_configured_chat() -> None:
    poller = TelegramPoller(token="t", chat_id="111")

    # Accepts text from the configured chat (id may arrive as int from JSON).
    assert poller._command_from(_update(111, "press play")) == "press play"

    # Rejects another chat — nobody else may type on this screen.
    assert poller._command_from(_update(999, "rm -rf /")) is None

    # Ignores non-text updates (photos, stickers, empty).
    assert poller._command_from({"update_id": 2, "message": {"chat": {"id": 111}}}) is None
    assert poller._command_from({"update_id": 3}) is None


if __name__ == "__main__":
    test_encode_multipart()
    test_command_only_from_configured_chat()
    print("ok")
