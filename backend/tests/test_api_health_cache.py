def test_health_is_never_cached_and_reachable_through_the_api_proxy(client):
    for path in ("/health", "/api/v1/health", "/health/ready"):
        r = client.get(path)
        assert r.status_code == 200, path
        assert r.headers["cache-control"] == "no-store", path
    assert client.get("/api/v1/health").json() == {"status": "ok"}
