# src/kolo/core/logging.py

"""Logs: colored in dev, json in prod."""
import logging
import re

import structlog

from kolo.core.config import Settings

TOKEN_IN_URL = re.compile(r"(token=)[^&\s\"']+")


def _redact(value):
    return TOKEN_IN_URL.sub(r"\1***", value) if isinstance(value, str) else value


class RedactTokens(logging.Filter):
    """Hides ?token= in uvicorn logs (it logs ws urls even with --no-access-log)."""

    def filter(self, record: logging.LogRecord) -> bool:
        record.msg = _redact(record.msg)
        if isinstance(record.args, tuple):
            # keep the tuple, uvicorn's access formatter reads it by position
            record.args = tuple(_redact(arg) for arg in record.args)
        return True


def configure_logging(settings: Settings) -> None:
    for name in ("uvicorn.error", "uvicorn.access"):
        logger = logging.getLogger(name)
        if not any(isinstance(f, RedactTokens) for f in logger.filters):  # create_app runs many times
            logger.addFilter(RedactTokens())

    renderer = (
        structlog.processors.JSONRenderer()
        if settings.env == "prod"
        else structlog.dev.ConsoleRenderer()
    )

    structlog.configure(
        processors=[
            structlog.contextvars.merge_contextvars,
            structlog.processors.add_log_level,
            structlog.processors.TimeStamper(fmt="iso"),
            renderer,
        ],
        wrapper_class=structlog.make_filtering_bound_logger(logging.INFO),
    )

log = structlog.get_logger()