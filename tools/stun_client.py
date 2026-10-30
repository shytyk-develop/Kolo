"""Mini STUN client: asks a STUN server "which address do you see me from?".

Format per RFC 5389. Run: python tools/stun_client.py stun.l.google.com 19302
"""
import os
import socket
import struct
import sys

MAGIC_COOKIE = 0x2112A442
BINDING_REQUEST = 0x0001
BINDING_SUCCESS = 0x0101
XOR_MAPPED_ADDRESS = 0x0020


def build_request() -> tuple[bytes, bytes]:
    transaction_id = os.urandom(12)  # 96 random bits to match the response with the request
    # 20 byte header: type (2), attributes length (2), magic cookie (4), transaction id (12)
    header = struct.pack("!HHI", BINDING_REQUEST, 0, MAGIC_COOKIE) + transaction_id
    return header, transaction_id


def parse_response(data: bytes, transaction_id: bytes) -> tuple[str, int]:
    msg_type, length, cookie = struct.unpack("!HHI", data[:8])
    if msg_type != BINDING_SUCCESS or cookie != MAGIC_COOKIE or data[8:20] != transaction_id:
        raise ValueError("Это не ответ на наш запрос")

    offset = 20
    while offset < 20 + length:
        attr_type, attr_len = struct.unpack("!HH", data[offset:offset + 4])
        value = data[offset + 4:offset + 4 + attr_len]

        if attr_type == XOR_MAPPED_ADDRESS:
            family = value[1]
            if family != 0x01:
                raise ValueError("Пример понимает только IPv4")
            port = struct.unpack("!H", value[2:4])[0] ^ (MAGIC_COOKIE >> 16)
            ip_int = struct.unpack("!I", value[4:8])[0] ^ MAGIC_COOKIE
            return socket.inet_ntoa(struct.pack("!I", ip_int)), port

        offset += 4 + attr_len + (-attr_len % 4)  # attributes are aligned to 4 bytes

    raise ValueError("В ответе нет XOR-MAPPED-ADDRESS")


def whats_my_address(host: str, port: int, timeout: float = 2.0) -> tuple[str, int]:
    request, transaction_id = build_request()
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        sock.settimeout(timeout)
        sock.sendto(request, (host, port))
        data, _ = sock.recvfrom(2048)
    return parse_response(data, transaction_id)


if __name__ == "__main__":
    host = sys.argv[1] if len(sys.argv) > 1 else "stun.l.google.com"
    port = int(sys.argv[2]) if len(sys.argv) > 2 else 19302
    ip, mapped_port = whats_my_address(host, port)
    print(f"STUN-сервер видит тебя как {ip}:{mapped_port}")
