# tests/test_rate_limit.py

from kolo.infra.rate_limit import KeyedRateLimiter, TokenBucket


class FakeClock:
    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        return self.now


def test_token_bucket_burst_then_refill():
    clock = FakeClock()
    bucket = TokenBucket(capacity=3, rate=1, clock=clock)  # 3 at once, then 1 per second
    assert [bucket.allow() for _ in range(4)] == [True, True, True, False]

    clock.now = 1.0
    assert bucket.allow() is True
    assert bucket.allow() is False

    clock.now = 100.0  # long pause: refilled, but not over capacity
    assert [bucket.allow() for _ in range(4)] == [True, True, True, False]


def test_keyed_limiter_gives_each_key_its_own_bucket():
    clock = FakeClock()
    limiter = KeyedRateLimiter(capacity=1, rate=1, clock=clock)

    assert limiter.allow("1.1.1.1") is True
    assert limiter.allow("1.1.1.1") is False
    assert limiter.allow("2.2.2.2") is True  # other ip isn't affected
