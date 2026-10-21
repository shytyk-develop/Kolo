# src/kolo/core/security.py
import hashlib
import hmac
import secrets

def new_secret() -> str:
    """256 bits of randomness in a URL-safe format."""
    return secrets.token_urlsafe(32)

def hash_secret(secret: str) -> str:
    return hashlib.sha256(secret.encode()).hexdigest()

def verify_secret(secret: str, expected_hash: str) -> bool:
    return hmac.compare_digest(hash_secret(secret), expected_hash)