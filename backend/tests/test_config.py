# tests/test_config.py

from kolo.core.config import Settings


def test_settings_from_env(monkeypatch):
    monkeypatch.setenv("KOLO_ROOM_TTL_HOURS", "5")
    monkeypatch.setenv("KOLO_CORS_ORIGINS", '["https://kolo.app"]')
    monkeypatch.setenv("KOLO_JWT_SECRET", "super-secret")
    
    settings = Settings(_env_file=None)
    
    assert settings.room_ttl_hours == 5  
    assert settings.cors_origins == ["https://kolo.app"]
    assert "super-secret" not in repr(settings) 
    assert settings.jwt_secret.get_secret_value() == "super-secret"