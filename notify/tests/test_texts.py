"""Every message in every language: a snapshot, plus the house style checked by machine."""

import json
import os
import re
from pathlib import Path

import pytest

from notify.texts import LANGS, TEXTS, plain, t

SNAPSHOT = Path(__file__).parent / "snapshots" / "texts.json"
# a name that must never turn into markup
VALUES = {"name": 'Eve <b>&</b> "co"', "handle": "alex718", "code": "abc-defg-hij"}

MESSAGE = re.compile(r"^(?!(btn|cb|cmd|open)_)")


def is_message(key: str) -> bool:
    return bool(MESSAGE.match(key))


def render_all() -> dict:
    return {
        lang: {key: (t if is_message(key) else plain)(lang, key, **VALUES) for key in TEXTS["en"]} for lang in LANGS
    }


def test_snapshot():
    rendered = render_all()
    if os.environ.get("UPDATE_SNAPSHOTS") or not SNAPSHOT.exists():
        SNAPSHOT.write_text(json.dumps(rendered, ensure_ascii=False, indent=2) + "\n")
    assert rendered == json.loads(SNAPSHOT.read_text()), "texts changed: rerun with UPDATE_SNAPSHOTS=1 and review"


@pytest.mark.parametrize("lang", LANGS)
def test_names_are_escaped_everywhere(lang):
    for key in TEXTS["en"]:
        if is_message(key) and "{name}" in TEXTS[lang][key]:
            text = t(lang, key, **VALUES)
            assert "Eve &lt;b&gt;&amp;&lt;/b&gt; &quot;co&quot;" in text, key
            assert "<b>&</b>" not in text, key


def emoji(text: str) -> list[str]:
    return [ch for ch in text if ord(ch) >= 0x1F000 or 0x2600 <= ord(ch) <= 0x27BF]


@pytest.mark.parametrize("lang", LANGS)
def test_house_style(lang):
    for key, template in TEXTS[lang].items():
        assert "!" not in template, (lang, key)
        assert len(emoji(template)) <= 1, (lang, key)
        if key.startswith("btn_"):
            assert len(template) <= 20, (lang, key)
        if is_message(key):
            sample = t(lang, key, name="Alexandra", handle="alex718", code="abc-defg-hij")
            for line in re.sub(r"<[^>]+>", "", sample).split("\n"):
                assert len(line) <= 40, (lang, key, line)


def test_only_the_invite_has_an_emoji():
    with_emoji = {key for key, value in TEXTS["en"].items() if emoji(value)}
    assert with_emoji == {"invite"}
