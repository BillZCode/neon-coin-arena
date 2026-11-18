#!/usr/bin/env node
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_DIR = path.resolve(__dirname, "..", "frontend");
const RELEASES_DIR = path.resolve(__dirname, "..", "releases");

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || "0.0.0.0";
const ARENA_W = 960;
const ARENA_H = 600;
const TARGET_COINS = 12;

const PLAYER_COLORS = [
  "#38bdf8",
  "#f472b6",
  "#34d399",
  "#fbbf24",
  "#a78bfa",
  "#fb7185",
  "#22d3ee",
  "#f97316",
];

const COIN_CATALOG = [
  { kind: "gold", value: 10, weight: 62 },
  { kind: "gem", value: 25, weight: 22 },
  { kind: "boost", value: 15, weight: 10 },
  { kind: "star", value: 50, weight: 6 },
];

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".apk": "application/vnd.android.package-archive",
  ".exe": "application/vnd.microsoft.portable-executable",
  ".zip": "application/zip",
};

const clients = new Map();
const coins = new Map();
const hallOfFame = new Map();
const globalStats = { totalEvents: 0, totalCoinsCollected: 0, totalChats: 0 };

function recordHallOfFame(client, coinDelta = 0) {
  if (!client?.name) return;
  const key = client.name.trim().toLowerCase() || client.id;
  const cur = hallOfFame.get(key) || {
    name: client.name,
    color: client.color,
    highestScore: 0,
    totalCoins: 0,
    gamesPlayed: 0,
    updatedAt: Date.now(),
  };
  cur.name = client.name;
  cur.color = client.color;
  cur.highestScore = Math.max(cur.highestScore, client.score || 0);
  cur.totalCoins += coinDelta;
  cur.updatedAt = Date.now();
  hallOfFame.set(key, cur);
}

function pickCoinType() {
  const total = COIN_CATALOG.reduce((s, c) => s + c.weight, 0);
  let r = Math.random() * total;
  for (const item of COIN_CATALOG) {
    r -= item.weight;
    if (r <= 0) return item;
  }
  return COIN_CATALOG[0];
}

function spawnCoin() {
  const { kind, value } = pickCoinType();
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const margin = 46;
  const coin = {
    id,
    kind,
    value,
    x: Math.round(margin + Math.random() * (ARENA_W - margin * 2)),
    y: Math.round(margin + Math.random() * (ARENA_H - margin * 2)),
  };
  coins.set(id, coin);
  return coin;
}

function ensureCoins() {
  while (coins.size < TARGET_COINS) {
    spawnCoin();
  }
}

function encodeFrame(opcode, payloadBuf) {
  const len = payloadBuf.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x80 | opcode;
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payloadBuf]);
}

function sendJson(client, obj) {
  if (!client || client.closed || client.socket.destroyed) return;
  try {
    const buf = Buffer.from(JSON.stringify(obj), "utf8");
    client.socket.write(encodeFrame(0x1, buf));
  } catch {
    cleanupClient(client.id);
  }
}

function broadcast(obj, excludeId = null) {
  for (const c of clients.values()) {
    if (c.joined && c.id !== excludeId) {
      sendJson(c, obj);
    }
  }
}

function clamp(val, min, max, fallback) {
  const n = Number(val);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function sanitizeName(raw, id) {
  const cleaned = String(raw || "")
    .replace(/[\r\n\t<>]/g, " ")
    .trim()
    .slice(0, 18);
  return cleaned || `Player-${id.slice(0, 4)}`;
}

function sanitizeColor(raw) {
  const s = String(raw || "").trim();
  return /^#[0-9a-fA-F]{6}$/.test(s)
    ? s
    : PLAYER_COLORS[Math.floor(Math.random() * PLAYER_COLORS.length)];
}

function publicPlayer(c) {
  return {
    id: c.id,
    name: c.name,
    color: c.color,
    x: c.x,
    y: c.y,
    dir: c.dir,
    boosting: c.boosting,
    score: c.score,
    coinsCollected: c.coinsCollected,
    joined: c.joined,
  };
}

function cleanupClient(id) {
  const client = clients.get(id);
  if (!client || client.closed) return;
  client.closed = true;
  clients.delete(id);
  try {
    client.socket.destroy();
  } catch {
    // ignore
  }
  if (client.joined) {
    broadcast({ type: "player_left", id });
  }
}

function handleMessage(client, rawText) {
  let body;
  try {
    body = JSON.parse(rawText);
  } catch {
    sendJson(client, { type: "error", message: "Invalid JSON" });
    return;
  }

  const action = body.action;
  switch (action) {
    case "join": {
      client.name = sanitizeName(body.name, client.id);
      client.color = sanitizeColor(body.color);
      client.joined = true;
      ensureCoins();

      const activePlayers = Array.from(clients.values())
        .filter((c) => c.joined)
        .map(publicPlayer);

      sendJson(client, {
        type: "welcome",
        selfId: client.id,
        arena: { width: ARENA_W, height: ARENA_H },
        motd: "Server VPS 24/7 aktif — siap dimainkan bersama kapan saja!",
        players: activePlayers,
        coins: Array.from(coins.values()),
      });
      globalStats.totalEvents += 1;
      recordHallOfFame(client, 0);

      broadcast({ type: "player_joined", player: publicPlayer(client) }, client.id);
      break;
    }
    case "move": {
      if (!client.joined) return;
      client.x = Math.round(clamp(body.x, 22, ARENA_W - 22, client.x));
      client.y = Math.round(clamp(body.y, 22, ARENA_H - 22, client.y));
      client.dir = Number.isFinite(Number(body.dir)) ? Number(body.dir) : client.dir;
      client.boosting = Boolean(body.boosting);

      broadcast(
        {
          type: "player_moved",
          id: client.id,
          x: client.x,
          y: client.y,
          dir: client.dir,
          boosting: client.boosting,
          ts: Date.now(),
        },
        client.id
      );
      break;
    }
    case "collect": {
      if (!client.joined) return;
      const coinId = String(body.coinId || "").slice(0, 48);
      const coin = coins.get(coinId);
      if (!coin) {
        sendJson(client, { type: "coin_missed", coinId });
        return;
      }

      coins.delete(coinId);
      client.score += coin.value;
      client.coinsCollected += 1;
      client.x = Math.round(clamp(body.x, 22, ARENA_W - 22, client.x));
      client.y = Math.round(clamp(body.y, 22, ARENA_H - 22, client.y));
      globalStats.totalEvents += 1;
      globalStats.totalCoinsCollected += 1;
      recordHallOfFame(client, 1);

      const spawnedCoin = spawnCoin();
      broadcast({
        type: "coin_collected",
        playerId: client.id,
        playerName: client.name,
        coinId,
        kind: coin.kind,
        value: coin.value,
        newScore: client.score,
        coinsCollected: client.coinsCollected,
        spawnedCoin,
      });
      break;
    }
    case "chat": {
      if (!client.joined) return;
      const text = String(body.text || "")
        .replace(/[\r\n\t]/g, " ")
        .trim()
        .slice(0, 160);
      if (!text) return;
      broadcast({
        type: "chat",
        id: client.id,
        name: client.name,
        color: client.color,
        text,
        ts: Date.now(),
      });
      break;
    }
    case "ping": {
      sendJson(client, {
        type: "pong",
        clientTs: Number(body.clientTs || Date.now()),
        serverTs: Date.now(),
      });
      break;
    }
    default: {
      sendJson(client, { type: "error", message: `Unknown action: ${action}` });
    }
  }
}

function attachWebSocketFrames(client) {
  let buffer = Buffer.alloc(0);
  let fragments = [];
  let fragOpcode = 0;

  client.socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 2) {
      const b1 = buffer[0];
      const b2 = buffer[1];
      const fin = (b1 & 0x80) !== 0;
      const opcode = b1 & 0x0f;
      const masked = (b2 & 0x80) !== 0;
      let payloadLen = b2 & 0x7f;
      let offset = 2;

      if (payloadLen === 126) {
        if (buffer.length < 4) return;
        payloadLen = buffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLen === 127) {
        if (buffer.length < 10) return;
        payloadLen = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }

      if (payloadLen > 65536) {
        cleanupClient(client.id);
        return;
      }

      const maskLen = masked ? 4 : 0;
      if (buffer.length < offset + maskLen + payloadLen) return;

      let payload = buffer.subarray(offset + maskLen, offset + maskLen + payloadLen);
      if (masked) {
        const maskKey = buffer.subarray(offset, offset + 4);
        const unmasked = Buffer.allocUnsafe(payloadLen);
        for (let i = 0; i < payloadLen; i++) {
          unmasked[i] = payload[i] ^ maskKey[i % 4];
        }
        payload = unmasked;
      }

      buffer = buffer.subarray(offset + maskLen + payloadLen);

      if (opcode === 0x8) {
        try {
          client.socket.write(encodeFrame(0x8, Buffer.alloc(0)));
        } catch {
          // ignore
        }
        cleanupClient(client.id);
        return;
      }
      if (opcode === 0x9) {
        if (!client.socket.destroyed) {
          client.socket.write(encodeFrame(0xA, payload));
        }
        continue;
      }
      if (opcode === 0xA) {
        continue;
      }

      if (opcode !== 0x0) {
        fragOpcode = opcode;
        fragments = [payload];
      } else {
        fragments.push(payload);
      }

      if (fin && (fragOpcode === 0x1 || fragOpcode === 0x2)) {
        const full = Buffer.concat(fragments);
        fragments = [];
        fragOpcode = 0;
        handleMessage(client, full.toString("utf8"));
      }
    }
  });

  client.socket.on("close", () => cleanupClient(client.id));
  client.socket.on("error", () => cleanupClient(client.id));
}

const server = http.createServer((req, res) => {
  const reqUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  if (reqUrl.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, players: clients.size, coins: coins.size }));
    return;
  }

  if (reqUrl.pathname === "/api/leaderboard") {
    const livePlayers = Array.from(clients.values())
      .filter((c) => c.joined)
      .sort((a, b) => b.score - a.score)
      .slice(0, 20)
      .map(publicPlayer);
    const topHof = Array.from(hallOfFame.values())
      .sort((a, b) => b.highestScore - a.highestScore)
      .slice(0, 15);
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-cache",
    });
    res.end(
      JSON.stringify({
        hallOfFame: topHof,
        livePlayers,
        stats: globalStats,
        motd: "Server VPS 24/7 aktif — siap dimainkan bersama kapan saja!",
        updatedAt: Date.now(),
      })
    );
    return;
  }

  if (reqUrl.pathname.startsWith("/releases/")) {
    let relArtifact = "";
    try {
      relArtifact = decodeURIComponent(reqUrl.pathname.slice("/releases/".length));
    } catch {
      res.writeHead(400);
      res.end("Bad Request");
      return;
    }
    const artifactPath = path.resolve(RELEASES_DIR, relArtifact);
    if (!artifactPath.startsWith(RELEASES_DIR + path.sep)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }
    fs.stat(artifactPath, (err, stat) => {
      if (err || !stat.isFile()) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Release file not found");
        return;
      }
      const ext = path.extname(artifactPath).toLowerCase();
      const baseName = path.basename(artifactPath).replace(/[^a-zA-Z0-9._-]/g, "_");
      res.writeHead(200, {
        "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
        "Content-Length": stat.size,
        "Content-Disposition": `attachment; filename="${baseName}"`,
        "Cache-Control": "no-cache",
      });
      fs.createReadStream(artifactPath).pipe(res);
    });
    return;
  }

  let relPath = reqUrl.pathname === "/" ? "/index.html" : reqUrl.pathname;
  if (relPath === "/downloads" || relPath === "/downloads/") {
    relPath = "/downloads.html";
  }
  try {
    relPath = decodeURIComponent(relPath);
  } catch {
    res.writeHead(400);
    res.end("Bad Request");
    return;
  }

  const filePath = path.resolve(FRONTEND_DIR, `.${relPath}`);
  if (!filePath.startsWith(FRONTEND_DIR + path.sep) && filePath !== path.join(FRONTEND_DIR, "index.html")) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    res.end(data);
  });
});

server.on("upgrade", (req, socket) => {
  const key = req.headers["sec-websocket-key"];
  if (!key) {
    socket.destroy();
    return;
  }

  const accept = crypto
    .createHash("sha1")
    .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
    .digest("base64");

  socket.write(
    [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "",
      "",
    ].join("\r\n")
  );
  socket.setNoDelay(true);

  const id = crypto.randomBytes(8).toString("base64url");
  const client = {
    id,
    socket,
    name: `Player-${id.slice(0, 4)}`,
    color: PLAYER_COLORS[Math.floor(Math.random() * PLAYER_COLORS.length)],
    x: Math.round(80 + Math.random() * (ARENA_W - 160)),
    y: Math.round(80 + Math.random() * (ARENA_H - 160)),
    dir: 0,
    boosting: false,
    score: 0,
    coinsCollected: 0,
    joined: false,
    closed: false,
  };
  clients.set(id, client);
  attachWebSocketFrames(client);
});

ensureCoins();
server.listen(PORT, HOST, () => {
  console.log(`Neon Coin Arena listening on http://${HOST}:${PORT} (WebSocket at /ws)`);
});
