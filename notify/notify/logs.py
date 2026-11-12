# never log tokens, secrets or chat ids
from __future__ import annotations

import json
import logging
import sys
from typing import Any


class _Json(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        data: dict[str, Any] = {"level": record.levelname.lower(), "event": record.getMessage()}
        data.update(getattr(record, "fields", {}))
        if record.exc_info and record.exc_info[1] is not None:
            error = record.exc_info[1]
            data["error"] = f"{type(error).__name__}: {error}"
        return json.dumps(data, default=str)


_logger = logging.getLogger("notify")
if not _logger.handlers:
    _handler = logging.StreamHandler(sys.stdout)
    _handler.setFormatter(_Json())
    _logger.addHandler(_handler)
    _logger.setLevel(logging.INFO)
    _logger.propagate = False
# aiogram logs every update with ids
logging.getLogger("aiogram").setLevel(logging.WARNING)


def log(event: str, **fields: Any) -> None:
    _logger.info(event, extra={"fields": fields})


def log_warning(event: str, **fields: Any) -> None:
    _logger.warning(event, extra={"fields": fields})


def log_error(event: str, **fields: Any) -> None:
    # call inside except: logs the error type and message, no traceback
    _logger.error(event, exc_info=True, extra={"fields": fields})
