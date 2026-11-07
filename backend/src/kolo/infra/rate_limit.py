# src/kolo/infra/rate_limit.py

"""Token bucket: holds capacity tokens, refills at rate per second, 1 request = 1 token."""
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
        # start full
        self.tokens = self.capacity
        self.updated_at = self.clock()

    def allow(self, cost: float = 1.0) -> bool:
        now = self.clock()
        elapsed = now - self.updated_at
        
        # refill by elapsed time, up to capacity
        self.tokens = min(self.capacity, self.tokens + elapsed * self.rate)
        self.updated_at = now
        
        if self.tokens >= cost:
            self.tokens -= cost
            return True
        return False


class KeyedRateLimiter:
    """Separate bucket per key (per ip)."""
    
    def __init__(self, capacity: float, rate: float, clock=time.monotonic, max_keys: int = 10_000):
        self._capacity = capacity
        self._rate = rate
        self._clock = clock
        self._buckets: dict[str, TokenBucket] = {}
        self._max_keys = max_keys

    def allow(self, key: str) -> bool:
        bucket = self._buckets.get(key)
        if bucket is None:
            # too many ips -> reset, so memory doesn't blow up
            if len(self._buckets) >= self._max_keys: 
                self._buckets.clear()
            
            bucket = self._buckets[key] = TokenBucket(self._capacity, self._rate, self._clock)
            
        return bucket.allow()