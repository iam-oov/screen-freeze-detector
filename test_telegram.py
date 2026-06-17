"""Smallest check: the multipart body for Telegram sendPhoto is well-formed.

Run: uv run python test_telegram.py
"""

from freeze_detector import encode_multipart


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


if __name__ == "__main__":
    test_encode_multipart()
    print("ok")
