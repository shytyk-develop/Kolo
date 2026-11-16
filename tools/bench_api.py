"""Response times of the api, p50 / p95.

run: cd backend && uv run python ../tools/bench_api.py [http://localhost:8000]
"""
import statistics
import sys
import time

import httpx

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8000"
N = 200


def timed(client: httpx.Client, method: str, path: str, n: int = N, **kwargs) -> tuple[float, float, int]:
    times = []
    status = 0
    for _ in range(n):
        start = time.perf_counter()
        status = client.request(method, path, **kwargs).status_code
        times.append((time.perf_counter() - start) * 1000)
    times.sort()
    return statistics.median(times), times[int(len(times) * 0.95) - 1], status


def main() -> None:
    with httpx.Client(base_url=BASE, timeout=10) as client:
        room = client.post("/api/v1/rooms", json={}).json()
        code = room["code"]
        rows = [
            ("GET /health", timed(client, "GET", "/health")),
            ("GET /health/ready", timed(client, "GET", "/health/ready")),
            ("GET /api/v1/rooms/{code}", timed(client, "GET", f"/api/v1/rooms/{code}")),
            ("GET /api/v1/rooms/{unknown}", timed(client, "GET", "/api/v1/rooms/aaa-bbbb-ccc")),
            ("POST /api/v1/rooms/{code}/join", timed(client, "POST", f"/api/v1/rooms/{code}/join", json={"display_name": "Bench"})),
            ("GET /api/v1/me", timed(client, "GET", "/api/v1/me")),
            # 10 a minute per ip, so only a few
            ("POST /api/v1/rooms", timed(client, "POST", "/api/v1/rooms", n=5, json={})),
        ]
    print(f"{'endpoint':34} {'p50 ms':>8} {'p95 ms':>8}  last status")
    for name, (p50, p95, status) in rows:
        print(f"{name:34} {p50:8.2f} {p95:8.2f}  {status}")


if __name__ == "__main__":
    main()
