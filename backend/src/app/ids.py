"""Time-sortable ULID identifiers with a 48-bit millisecond timestamp."""

import secrets
import time

ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"


def new_ulid() -> str:
    value = (int(time.time_ns() // 1_000_000) << 80) | secrets.randbits(80)
    return "".join(ALPHABET[(value >> shift) & 31] for shift in range(125, -1, -5))
