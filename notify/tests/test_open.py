from urllib.parse import parse_qs, urlsplit

import pytest

from notify.signing import is_under, sign, verify
from notify.telegram import open_url, room_url
from tests.conftest import API_KEY

KOLO = "https://kolo-black.vercel.app"
ROOM = f"{KOLO}/r/abc-defg-hij"


def test_signed_room_url_verifies():
    assert verify(API_KEY, ROOM, sign(API_KEY, ROOM), KOLO)


def test_tampered_url_or_signature_fails():
    sig = sign(API_KEY, ROOM)
    assert not verify(API_KEY, ROOM.replace("abc", "xyz"), sig, KOLO)
    assert not verify(API_KEY, ROOM, sig[:-1] + ("A" if sig[-1] != "A" else "B"), KOLO)
    assert not verify(API_KEY, ROOM, "", KOLO)
    assert not verify("another-key-0123456789abcdef", ROOM, sig, KOLO)


@pytest.mark.parametrize(
    "url",
    [
        "https://evil.example/r/abc-defg-hij",
        "https://kolo-black.vercel.app.evil.example/r/x",
        "https://user:pw@kolo-black.vercel.app/r/x",
        "http://kolo-black.vercel.app/r/x",
        "javascript:alert(1)",
        "https://kolo-black.vercel.app\\@evil.example/",
        "https://kolo-black.vercel.app /r/x",
        "https://kolo-black.vercel.app",
    ],
)
def test_foreign_urls_fail_even_when_signed(url):
    assert not is_under(url, KOLO)
    assert not verify(API_KEY, url, sign(API_KEY, url), KOLO)


pytestmark = pytest.mark.anyio


def _open_path(settings, url: str) -> str:
    parts = urlsplit(open_url(settings, url, "en"))
    return f"{parts.path}?{parts.query}"


async def test_open_page_hands_the_link_to_telegram(client, settings):
    url = room_url(settings, "abc-defg-hij")
    r = await client.get(_open_path(settings, url))
    assert r.status_code == 200
    assert "telegram-web-app.js" in r.text and "openLink" in r.text
    assert f'href="{url}"' in r.text  # fallback outside Telegram
    csp = r.headers["content-security-policy"]
    assert "script-src 'nonce-" in csp and "default-src 'none'" in csp
    assert r.headers["cache-control"] == "no-store"


async def test_open_page_refuses_tampered_links(client, settings):
    good = open_url(settings, room_url(settings, "abc-defg-hij"), "en")
    query = parse_qs(urlsplit(good).query)
    r = await client.get("/open", params={"u": f"{KOLO}/r/zzz-zzzz-zzz", "s": query["s"][0]})
    assert r.status_code == 403
    assert "openLink" not in r.text and "zzz-zzzz-zzz" not in r.text
    r = await client.get("/open", params={"u": "https://evil.example/", "s": sign(API_KEY, "https://evil.example/")})
    assert r.status_code == 403 and "evil.example" not in r.text


async def test_open_page_escapes_what_it_shows(client, settings):
    # signed and under Kolo, but full of markup
    url = f"{KOLO}/r/</script><script>alert(1)</script>\"'&"
    r = await client.get("/open", params={"u": url, "s": sign(API_KEY, url)})
    assert r.status_code == 200
    assert "<script>alert(1)" not in r.text
    assert "\\u003c/script\\u003e" in r.text
    assert "&lt;/script&gt;" in r.text
