"""Toy STUN server, replies with the client's address. For testing the client."""
import socket
import struct

from stun_client import BINDING_SUCCESS, MAGIC_COOKIE, XOR_MAPPED_ADDRESS


def make_response(transaction_id: bytes, ip: str, port: int) -> bytes:
    xport = port ^ (MAGIC_COOKIE >> 16)
    xip = struct.unpack("!I", socket.inet_aton(ip))[0] ^ MAGIC_COOKIE
    attr_value = struct.pack("!BBHI", 0, 0x01, xport, xip)
    attr = struct.pack("!HH", XOR_MAPPED_ADDRESS, len(attr_value)) + attr_value
    return struct.pack("!HHI", BINDING_SUCCESS, len(attr), MAGIC_COOKIE) + transaction_id + attr


if __name__ == "__main__":
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        sock.bind(("127.0.0.1", 3479))
        print("Toy STUN listening on 127.0.0.1:3479")
        while True:
            data, (ip, port) = sock.recvfrom(2048)
            sock.sendto(make_response(data[8:20], ip, port), (ip, port))
