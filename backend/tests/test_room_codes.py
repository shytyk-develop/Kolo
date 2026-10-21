# tests/test_room_codes.py

import math

from kolo.domain.room_codes import generate_room_code, is_valid_room_code, normalize_room_code

def test_generated_codes_look_like_meet():
    for _ in range(1000):
        assert is_valid_room_code(generate_room_code())

def test_normalize_accepts_human_input():
    assert normalize_room_code(" ABC DEFG HIJ ") == "abc-defg-hij"
    assert normalize_room_code("abcdefghij") == "abc-defg-hij"
    assert normalize_room_code("abc-defg-hij") == "abc-defg-hij"

def test_code_space_is_huge():
    space = 26**10
    assert space == 141_167_095_653_376
    assert round(math.log2(space), 1) == 47.0