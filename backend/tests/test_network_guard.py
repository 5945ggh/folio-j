import socket

import pytest


def test_network_guard_blocks_dns_and_socket_connect() -> None:
    with pytest.raises(RuntimeError, match="Network access is forbidden"):
        socket.getaddrinfo("example.invalid", 80)
    with socket.socket() as connection:
        with pytest.raises(RuntimeError, match="Network access is forbidden"):
            connection.connect(("192.0.2.1", 80))
