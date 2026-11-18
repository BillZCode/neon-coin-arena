#!/usr/bin/env python3
"""End-to-end 2-player WebSocket test for Neon Coin Arena."""

import base64
import json
import os
import socket
import ssl
import struct
import sys
import urllib.parse


class WSClient:
    def __init__(self, url: str):
        parsed = urllib.parse.urlparse(url)
        host = parsed.hostname
        port = parsed.port or (443 if parsed.scheme == "wss" else 80)
        path = parsed.path or "/"
        raw = socket.create_connection((host, port), timeout=15)
        if parsed.scheme == "wss":
            ctx = ssl.create_default_context()
            self.sock = ctx.wrap_socket(raw, server_hostname=host)
        else:
            self.sock = raw

        key = base64.b64encode(os.urandom(16)).decode()
        req = (
            f"GET {path} HTTP/1.1\r\n"
            f"Host: {host}\r\n"
            f"Upgrade: websocket\r\n"
            f"Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            f"Sec-WebSocket-Version: 13\r\n\r\n"
        )
        self.sock.sendall(req.encode())

        buf = b""
        while b"\r\n\r\n" not in buf:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise EOFError("Handshake closed early")
            buf += chunk
        head, extra = buf.split(b"\r\n\r\n", 1)
        status = head.decode().splitlines()[0]
        assert "101" in status, f"Unexpected handshake: {status}"
        self.rx = bytearray(extra)

    def _recv_exact(self, n: int) -> bytes:
        while len(self.rx) < n:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise EOFError("Socket closed")
            self.rx.extend(chunk)
        out = bytes(self.rx[:n])
        del self.rx[:n]
        return out

    def send_json(self, obj: dict):
        payload = json.dumps(obj).encode()
        mask = os.urandom(4)
        hdr = bytearray([0x81])
        n = len(payload)
        if n < 126:
            hdr.append(0x80 | n)
        else:
            hdr.append(0x80 | 126)
            hdr.extend(struct.pack("!H", n))
        hdr.extend(mask)
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        self.sock.sendall(bytes(hdr) + masked)

    def recv_json(self) -> dict:
        while True:
            b1, b2 = self._recv_exact(2)
            op = b1 & 0x0F
            length = b2 & 0x7F
            if length == 126:
                length = struct.unpack("!H", self._recv_exact(2))[0]
            elif length == 127:
                length = struct.unpack("!Q", self._recv_exact(8))[0]
            data = self._recv_exact(length)
            if op == 0x8:
                raise EOFError("Close frame received")
            if op == 0x9:
                mask = os.urandom(4)
                self.sock.sendall(bytes([0x8A, 0x80]) + mask)
                continue
            return json.loads(data.decode())

    def close(self):
        mask = os.urandom(4)
        self.sock.sendall(bytes([0x88, 0x80]) + mask)
        self.sock.close()


def recv_until(client: WSClient, expected_type: str, max_msgs: int = 12) -> dict:
    for _ in range(max_msgs):
        msg = client.recv_json()
        if msg.get("type") == expected_type:
            return msg
    raise AssertionError(f"Did not receive {expected_type}")


def main():
    if len(sys.argv) < 2:
        print("Usage: test_game_ws.py <wss_url>")
        sys.exit(1)
    url = sys.argv[1]

    p1 = WSClient(url)
    p2 = WSClient(url)
    print("[1] Connected Player-1 and Player-2")

    p1.send_json({"action": "join", "name": "Alpha", "color": "#38bdf8"})
    w1 = recv_until(p1, "welcome")
    print(f"[2] Alpha joined (id={w1['selfId']}, coins={len(w1['coins'])})")
    assert len(w1["coins"]) >= 12

    p2.send_json({"action": "join", "name": "Bravo", "color": "#f472b6"})
    w2 = recv_until(p2, "welcome")
    joined_evt = recv_until(p1, "player_joined")
    print(f"[3] Bravo joined (id={w2['selfId']}) -> Alpha notified: {joined_evt['player']['name']}")

    p1.send_json({"action": "move", "x": 320, "y": 240, "dir": 0.5, "boosting": True})
    move_evt = recv_until(p2, "player_moved")
    assert move_evt["x"] == 320 and move_evt["y"] == 240 and move_evt["boosting"] is True
    print("[4] Alpha move synced to Bravo:", move_evt)

    target_coin = w1["coins"][0]
    p1.send_json({"action": "collect", "coinId": target_coin["id"], "x": target_coin["x"], "y": target_coin["y"]})
    c1 = recv_until(p1, "coin_collected")
    c2 = recv_until(p2, "coin_collected")
    assert c1["coinId"] == target_coin["id"] and c1["newScore"] == target_coin["value"]
    assert c2["spawnedCoin"]["id"] != target_coin["id"]
    print(f"[5] Alpha collected {target_coin['kind']} (+{target_coin['value']}) -> score={c1['newScore']}, spawned={c2['spawnedCoin']['id']}")

    p2.send_json({"action": "collect", "coinId": target_coin["id"], "x": target_coin["x"], "y": target_coin["y"]})
    missed = recv_until(p2, "coin_missed")
    assert missed["coinId"] == target_coin["id"]
    print(f"[5b] Atomic coin lock OK: Bravo got coin_missed for already-claimed {missed['coinId']}")

    p2.send_json({"action": "chat", "text": "GG Alpha!"})
    chat1 = recv_until(p1, "chat")
    chat2 = recv_until(p2, "chat")
    assert chat1["text"] == "GG Alpha!" and chat2["text"] == "GG Alpha!"
    print(f"[6] Chat broadcast OK: {chat1['name']}: {chat1['text']}")

    p1.send_json({"action": "ping", "clientTs": 123456})
    pong = recv_until(p1, "pong")
    assert pong["clientTs"] == 123456
    print("[7] Ping/Pong OK")

    p2.close()
    left_evt = recv_until(p1, "player_left")
    assert left_evt["id"] == w2["selfId"]
    print(f"[8] Bravo disconnected -> Alpha notified: player_left {left_evt['id']}")

    p1.close()
    print("=== ALL GAME WEBSOCKET TESTS PASSED ===")


if __name__ == "__main__":
    main()
