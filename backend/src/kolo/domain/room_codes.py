# src/kolo/domain/room_codes.py

"""Google Meet style room codes: abc-defg-hij."""
import re
import secrets
import string

ALPHABET = string.ascii_lowercase  # 26 letters
CODE_LETTERS = 10
CODE_RE = re.compile(r"^[a-z]{3}-[a-z]{4}-[a-z]{3}$")

def generate_room_code() -> str:
    letters = "".join(secrets.choice(ALPHABET) for _ in range(CODE_LETTERS))
    return f"{letters[:3]}-{letters[3:7]}-{letters[7:]}"

def normalize_room_code(raw: str) -> str:
    """'ABC DEFG HIJ', 'abcdefghij', ' abc-defg-hij ' -> 'abc-defg-hij'."""
    letters = "".join(ch for ch in raw.lower() if ch in ALPHABET)
    if len(letters) != CODE_LETTERS:
        return raw.strip().lower()
    return f"{letters[:3]}-{letters[3:7]}-{letters[7:]}"

def is_valid_room_code(code: str) -> bool:
    return bool(CODE_RE.fullmatch(code))