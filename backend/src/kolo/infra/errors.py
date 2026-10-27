# src/kolo/infra/errors.py

"""Tells "Redis or the database is unreachable right now" apart from "our code has a bug"."""
from redis.exceptions import ConnectionError as RedisConnectionError
from redis.exceptions import TimeoutError as RedisTimeoutError
from sqlalchemy.exc import DBAPIError, InterfaceError, OperationalError
from sqlalchemy.exc import TimeoutError as PoolTimeoutError

# Candidates only: always confirm with is_dependency_error(), DBAPIError also covers real bugs
DEPENDENCY_ERROR_TYPES: tuple[type[Exception], ...] = (
    RedisConnectionError,
    RedisTimeoutError,
    PoolTimeoutError,
    DBAPIError,
    OSError,  # asyncpg raises plain ConnectionRefusedError / socket errors while connecting
)

# asyncpg errors reach us as a generic DBAPIError, the SQLSTATE is the only reliable signal
_UNAVAILABLE_SQLSTATES = {
    "57P01",  # admin_shutdown
    "57P02",  # crash_shutdown
    "57P03",  # cannot_connect_now: the server is still starting up
    "53300",  # too_many_connections
}


def is_dependency_error(exc: BaseException) -> bool:
    if isinstance(exc, DBAPIError):
        if exc.connection_invalidated or isinstance(exc, OperationalError | InterfaceError):
            return True
        sqlstate = getattr(exc.orig, "sqlstate", None) or ""
        # class 08 = connection exceptions. Anything else, like a missing table, is a bug
        return sqlstate.startswith("08") or sqlstate in _UNAVAILABLE_SQLSTATES

    return isinstance(exc, DEPENDENCY_ERROR_TYPES)
