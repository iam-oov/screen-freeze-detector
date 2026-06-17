"""Application configuration.

Single entry point for environment / .env settings consumed by
freeze_detector.py. Every value is optional — this is a typed container,
not a gatekeeper.
"""

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="SCREENSOUND_",
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    telegram_token: str = ""
    telegram_chat_id: str = ""


settings = Settings()
