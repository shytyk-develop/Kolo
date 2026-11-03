# src/kolo/infra/rate_limit.py

"""
Token bucket algorithm.
The bucket holds 'capacity' tokens. It refills at 'rate' tokens per second.
Every request costs 1 token. If the bucket is empty, the request is rejected.
"""
import time
from dataclasses import dataclass, field


@dataclass
class TokenBucket:
    capacity: float
    rate: float  # tokens per second
    clock: callable = time.monotonic
    tokens: float = field(init=False)
    updated_at: float = field(init=False)

    def __post_init__(self) -> None:
        # start with a full bucket
        self.tokens = self.capacity
        self.updated_at = self.clock()

    def allow(self, cost: float = 1.0) -> bool:
        now = self.clock()
        elapsed = now - self.updated_at
        
        # refill the bucket based on time passed, but don't overflow max capacity
        self.tokens = min(self.capacity, self.tokens + elapsed * self.rate)
        self.updated_at = now
        
        if self.tokens >= cost:
            self.tokens -= cost
            return True
        return False


class KeyedRateLimiter:
    """A separate token bucket for each key (e.g., per IP address)."""
    
    def __init__(self, capacity: float, rate: float, clock=time.monotonic, max_keys: int = 10_000):
        self._capacity = capacity
        self._rate = rate
        self._clock = clock
        self._buckets: dict[str, TokenBucket] = {}
        self._max_keys = max_keys

    def allow(self, key: str) -> bool:
        bucket = self._buckets.get(key)
        if bucket is None:
            # prevent memory blowup if we get spammed with millions of unique IPs
            if len(self._buckets) >= self._max_keys: 
                self._buckets.clear()
            
            bucket = self._buckets[key] = TokenBucket(self._capacity, self._rate, self._clock)
            
        return bucket.allow()