# tests/conftest.py

import pytest

from kolo.core.config import Settings


@pytest.fixture
def settings() -> Settings:
    # _env_file=None: tests must not depend on the developer's local .env (real Postgres and Redis)
    return Settings(_env_file=None, env="test", database_url="memory://", redis_url=None)
