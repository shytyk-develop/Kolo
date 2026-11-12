import pytest

from notify.handles import handle_problem, is_room_code, normalize_handle
from notify.texts import LANGS, TEXTS, pick_lang, plain, t


@pytest.mark.parametrize(
    ("raw", "normalized"),
    [("alex718", "alex718"), ("  @Alex_718 ", "alex_718"), ("ALEX", "alex")],
)
def test_handles_are_normalized(raw, normalized):
    assert normalize_handle(raw) == normalized
    assert handle_problem(normalized) is None


@pytest.mark.parametrize(
    "handle",
    # Cyrillic "alex", fullwidth "alex"
    ["ab", "a" * 21, "alex-718", "alex 718", "alex.718", "\u0430\u043b\u0435\u043a\u0441", "\uff41\uff4c\uff45\uff58",
     "", "alex\n"],
)
def test_bad_handles(handle):
    assert handle_problem(handle) == "format"


@pytest.mark.parametrize("handle", ["admin", "support", "kolo", "kolo_team", "kolosupport", "telegram"])
def test_reserved_handles(handle):
    assert handle_problem(handle) == "reserved"


def test_edges_of_the_length_rule():
    assert handle_problem("abc") is None
    assert handle_problem("a" * 20) is None


@pytest.mark.parametrize(("code", "ok"), [("abc-defg-hij", True), ("ABC-DEFG-HIJ", False), ("abcdefghij", False),
                                          ("abc-defg-hi", False), ("abc-defg-hij/../x", False)])
def test_room_codes(code, ok):
    assert is_room_code(code) is ok


def test_names_are_escaped_in_messages():
    text = t("en", "invite", name='<b>Eve</b> & "co"', code="abc-defg-hij")
    assert "<b>Eve</b>" not in text
    assert "&lt;b&gt;Eve&lt;/b&gt; &amp; &quot;co&quot;" in text
    assert text.startswith("📞 <b>") and "<code>abc-defg-hij</code>" in text


def test_buttons_are_not_escaped():
    # buttons aren't HTML
    assert plain("en", "btn_block", name="Tom & Jerry") == "Block Tom & Jerry"


def test_language_pick():
    assert pick_lang("ru") == "ru"
    assert pick_lang("de-AT") == "de"
    assert pick_lang("uk") == "uk"
    assert pick_lang("pt-br") == "en"
    assert pick_lang(None) == "en"


def test_every_language_has_every_text_with_the_same_slots():
    import string

    slots = lambda s: {f for _, f, _, _ in string.Formatter().parse(s) if f}  # noqa: E731
    for lang in LANGS:
        assert TEXTS[lang].keys() == TEXTS["en"].keys(), lang
        for key, value in TEXTS["en"].items():
            assert slots(TEXTS[lang][key]) == slots(value), (lang, key)
