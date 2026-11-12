from __future__ import annotations

import base64
import hashlib
import hmac
from urllib.parse import urlsplit


def sign(key: str, url: str) -> str:
    mac = hmac.new(key.encode(), b"open:" + url.encode(), hashlib.sha256).digest()
    return base64.urlsafe_b64encode(mac).rstrip(b"=").decode()


def is_under(url: str, base: str) -> bool:
    if any(ch.isspace() or ord(ch) < 32 or ch == "\\" for ch in url):
        return False
    try:
        got, want = urlsplit(url), urlsplit(base)
    except ValueError:
        return False
    if got.scheme not in ("https", "http") or got.scheme != want.scheme:
        return False
    # netloc includes user:pass@, so that fails too
    if got.netloc.lower() != want.netloc.lower():
        return False
    return got.path.startswith(want.path.rstrip("/") + "/")


def verify(key: str, url: str, signature: str, base: str) -> bool:
    if not url or not signature:
        return False
    if not hmac.compare_digest(sign(key, url).encode(), signature.encode()):
        return False
    return is_under(url, base)
