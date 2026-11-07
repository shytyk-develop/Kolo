# src/kolo/infra/errors.py

"""Tells "redis/db is down" apart from "our bug"."""
from redis.exceptions import ConnectionError as RedisConnectionError
from redis.exceptions import TimeoutError as RedisTimeoutError
from sqlalchemy.exc import DBAPIError, InterfaceError, OperationalError
from sqlalchemy.exc import TimeoutError as PoolTimeoutError

# only candidates, check with is_dependency_error() (DBAPIError can be a bug too)
DEPENDENCY_ERROR_TYPES: tuple[type[Exception], ...] = (
    RedisConnectionError,
    RedisTimeoutError,
    PoolTimeoutError,
    DBAPIError,
    OSError,  # asyncpg raises raw socket errors on connect
)

# asyncpg errors come wrapped in DBAPIError, look at the SQLSTATE
_UNAVAILABLE_SQLSTATES = {
    "57P01",  # admin_shutdown
    "57P02",  # crash_shutdown
    "57P03",  # cannot_connect_now: pg is still starting
    "53300",  # too_many_connections
}


def is_dependency_error(exc: BaseException) -> bool:
    if isinstance(exc, DBAPIError):
        if exc.connection_invalidated or isinstance(exc, OperationalError | InterfaceError):
            return True
        sqlstate = getattr(exc.orig, "sqlstate", None) or ""
        # 08xxx = connection errors, anything else (like a missing table) is a bug
        return sqlstate.startswith("08") or sqlstate in _UNAVAILABLE_SQLSTATES

    return isinstance(exc, DEPENDENCY_ERROR_TYPES)
