# src/kolo/core/logging.py

"""Structured logs: colored strings in development, JSON for Loki/ELK in production."""
import logging

import structlog

from kolo.core.config import Settings


def configure_logging(settings: Settings) -> None:
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