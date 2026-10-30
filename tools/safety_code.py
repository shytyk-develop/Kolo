"""Call "safety code" built from two DTLS fingerprints (like the safety number in Signal).

Both participants compute the same number. If the server swapped a fingerprint (a man-in-the-middle
attack), the numbers on their screens won't match.
"""
import hashlib


def safety_code(fingerprint_a: str, fingerprint_b: str) -> str:
    material = "|".join(sorted([fingerprint_a.upper(), fingerprint_b.upper()]))
    digest = hashlib.sha256(material.encode()).digest()
    number = int.from_bytes(digest[:8], "big") % 10**10  # 10 digits
    text = f"{number:010d}"
    return f"{text[:5]} {text[5:]}"


if __name__ == "__main__":
    a = (
        "sha-256 7B:8B:F0:65:5F:78:E2:51:3B:AC:6F:F3:3F:46:1B:35"
        ":DC:B8:5F:64:1A:24:C2:43:F0:A1:58:D0:A1:2C:19:08"
    )
    b = (
        "sha-256 1F:2E:3D:4C:5B:6A:79:88:97:A6:B5:C4:D3:E2:F1:00"
        ":11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:01"
    )
    print("Аня видит: ", safety_code(a, b))
    print("Боря видит:", safety_code(b, a))
