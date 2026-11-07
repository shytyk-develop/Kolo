# tools/bitrate.py

# max rtp video payload per packet
MTU_PAYLOAD = 1200
# headers per packet: ipv4 20 + udp 8 + rtp 12
IP_UDP_RTP_OVERHEAD_BYTES = 40


def raw_bitrate(width: int, height: int, fps: int, bpp: int = 12) -> float:
    """Calculate raw uncompressed video bitrate in bits per second."""
    return width * height * bpp * fps


def packets_per_second(bitrate: float, fps: int) -> float:
    """Calculate how many RTP packets must be sent per second for video."""
    bytes_per_frame = bitrate / fps / 8
    packets_per_frame = -(-bytes_per_frame // MTU_PAYLOAD)
    return packets_per_frame * fps


def opus_header_overhead(
    audio_bitrate_bps: float, frame_duration_ms: float
) -> dict:
    """Calculate header overhead for Opus audio stream at a given packet duration."""
    packets_per_sec = 1000.0 / frame_duration_ms
    audio_payload_bytes_per_sec = audio_bitrate_bps / 8
    header_bytes_per_sec = packets_per_sec * IP_UDP_RTP_OVERHEAD_BYTES

    overhead_bitrate_bps = header_bytes_per_sec * 8
    total_bitrate_bps = audio_bitrate_bps + overhead_bitrate_bps
    overhead_percentage = (overhead_bitrate_bps / total_bitrate_bps) * 100.0

    return {
        "duration_ms": frame_duration_ms,
        "packets_per_sec": packets_per_sec,
        "overhead_kbps": overhead_bitrate_bps / 1000.0,
        "total_kbps": total_bitrate_bps / 1000.0,
        "overhead_percent": overhead_percentage,
    }


PROFILES = {
    "360p": (640, 360, 30, 0.5e6),
    "720p": (1280, 720, 30, 1.5e6),
    "1080p": (1920, 1080, 30, 3.0e6),
}

if __name__ == "__main__":
    print("=== Video Bitrate & Packets ===")
    for name, (w, h, fps, encoded) in PROFILES.items():
        raw = raw_bitrate(w, h, fps)
        print(
            f"{name:>6}: raw {raw / 1e6:5.1f} Mbps | "
            f"encoded {encoded / 1e6:.1f} Mbps | "
            f"compression x{raw / encoded:3.0f} | "
            f"{packets_per_second(encoded, fps):.0f} pkts/s"
        )

    print("\n=== Opus Overhead (32 kbps base audio) ===")
    target_audio_bps = 32_000  # 32 kbps
    for ms in [10, 20, 40, 60]:
        stats = opus_header_overhead(target_audio_bps, ms)
        print(
            f"{ms:2d} ms: {stats['packets_per_sec']:5.1f} pkts/s | "
            f"headers {stats['overhead_kbps']:4.1f} kbps | "
            f"total {stats['total_kbps']:4.1f} kbps | "
            f"overhead {stats['overhead_percent']:4.1f}%"
        )