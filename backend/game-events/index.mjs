import {
  ddbClient,
  TABLE_NAME,
  ARENA_W,
  ARENA_H,
  TARGET_COINS,
  PLAYER_COLORS,
  getApiGwClient,
  scanArenaState,
  spawnCoinItem,
  parsePlayerItem,
  postJson,
  broadcast,
  clamp,
  makeDdbCommand,
  ttlEpochSeconds,
} from "../shared/ws-utils.mjs";
import {
  getGameConfig,
  enqueueGameEvent,
  putGameMetric,
} from "../shared/aws-clients.mjs";

function sanitizeName(raw, connectionId) {
  const cleaned = String(raw || "")
    .replace(/[\r\n\t<>]/g, " ")
    .trim()
    .slice(0, 18);
  return cleaned || `Player-${connectionId.slice(0, 4)}`;
}

function sanitizeColor(raw) {
  const str = String(raw || "").trim();
  return /^#[0-9a-fA-F]{6}$/.test(str)
    ? str
    : PLAYER_COLORS[Math.floor(Math.random() * PLAYER_COLORS.length)];
}

async function handleJoin(event, connectionId, body) {
  const [apigw, config] = await Promise.all([
    getApiGwClient(event),
    getGameConfig(),
  ]);
  const name = sanitizeName(body.name, connectionId);
  const color = sanitizeColor(body.color);
  const fallbackX = Math.round(80 + Math.random() * (ARENA_W - 160));
  const fallbackY = Math.round(80 + Math.random() * (ARENA_H - 160));
  const now = Date.now();

  const updated = await ddbClient.send(
    await makeDdbCommand("UpdateItemCommand", {
      TableName: TABLE_NAME,
      Key: { pk: { S: `PLAYER#${connectionId}` } },
      UpdateExpression:
        "SET connectionId = :cid, #n = :name, color = :color, joined = :joined, updatedAt = :ts, #ttl = :ttl, " +
        "x = if_not_exists(x, :dx), y = if_not_exists(y, :dy), dir = if_not_exists(dir, :zero), " +
        "boosting = if_not_exists(boosting, :bfalse), score = if_not_exists(score, :zero), " +
        "coinsCollected = if_not_exists(coinsCollected, :zero)",
      ExpressionAttributeNames: { "#n": "name", "#ttl": "ttl" },
      ExpressionAttributeValues: {
        ":cid": { S: connectionId },
        ":name": { S: name },
        ":color": { S: color },
        ":joined": { BOOL: true },
        ":ts": { N: String(now) },
        ":ttl": { N: String(ttlEpochSeconds(3600)) },
        ":dx": { N: String(fallbackX) },
        ":dy": { N: String(fallbackY) },
        ":zero": { N: "0" },
        ":bfalse": { BOOL: false },
      },
      ReturnValues: "ALL_NEW",
    })
  );

  const selfPlayer = parsePlayerItem(updated.Attributes);
  const { players, coins } = await scanArenaState();

  const desiredCoins = config.targetCoins || TARGET_COINS;
  const missingCoins = Math.max(0, desiredCoins - coins.length);
  if (missingCoins > 0) {
    const spawned = await Promise.all(
      Array.from({ length: missingCoins }, () => spawnCoinItem(config.scoreMultiplier))
    );
    coins.push(...spawned);
  }

  const activePlayers = players.filter((p) => p.joined);
  await postJson(apigw, connectionId, {
    type: "welcome",
    selfId: connectionId,
    arena: { width: ARENA_W, height: ARENA_H },
    motd: config.motd || "",
    players: activePlayers,
    coins,
  });

  await Promise.all([
    broadcast(
      apigw,
      activePlayers,
      { type: "player_joined", player: selfPlayer },
      connectionId
    ),
    putGameMetric("PlayersJoined", 1),
    enqueueGameEvent("player_joined", { playerName: name, color }),
  ]);

  return { statusCode: 200, body: "Joined" };
}

async function handleMove(event, connectionId, body) {
  const apigw = await getApiGwClient(event);
  const x = Math.round(clamp(body.x, 22, ARENA_W - 22, ARENA_W / 2));
  const y = Math.round(clamp(body.y, 22, ARENA_H - 22, ARENA_H / 2));
  const dir = Number.isFinite(Number(body.dir)) ? Number(body.dir) : 0;
  const boosting = Boolean(body.boosting);
  const now = Date.now();

  try {
    await ddbClient.send(
      await makeDdbCommand("UpdateItemCommand", {
        TableName: TABLE_NAME,
        Key: { pk: { S: `PLAYER#${connectionId}` } },
        ConditionExpression: "attribute_exists(pk)",
        UpdateExpression:
          "SET x = :x, y = :y, dir = :dir, boosting = :boosting, updatedAt = :ts, #ttl = :ttl",
        ExpressionAttributeNames: { "#ttl": "ttl" },
        ExpressionAttributeValues: {
          ":x": { N: String(x) },
          ":y": { N: String(y) },
          ":dir": { N: String(dir) },
          ":boosting": { BOOL: boosting },
          ":ts": { N: String(now) },
          ":ttl": { N: String(ttlEpochSeconds(3600)) },
        },
      })
    );
  } catch (err) {
    if (err?.name === "ConditionalCheckFailedException") {
      return { statusCode: 200, body: "Unknown player" };
    }
    throw err;
  }

  const { players } = await scanArenaState();
  await broadcast(
    apigw,
    players,
    { type: "player_moved", id: connectionId, x, y, dir, boosting, ts: now },
    connectionId
  );

  return { statusCode: 200, body: "Moved" };
}

async function handleCollect(event, connectionId, body) {
  const [apigw, config] = await Promise.all([
    getApiGwClient(event),
    getGameConfig(),
  ]);
  const coinId = String(body.coinId || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 48);
  if (!coinId) {
    return { statusCode: 400, body: "Invalid coinId" };
  }

  let deletedCoin;
  try {
    const delRes = await ddbClient.send(
      await makeDdbCommand("DeleteItemCommand", {
        TableName: TABLE_NAME,
        Key: { pk: { S: `COIN#${coinId}` } },
        ConditionExpression: "attribute_exists(pk)",
        ReturnValues: "ALL_OLD",
      })
    );
    deletedCoin = delRes.Attributes;
  } catch (err) {
    if (err?.name === "ConditionalCheckFailedException") {
      await postJson(apigw, connectionId, { type: "coin_missed", coinId });
      return { statusCode: 200, body: "Coin already claimed" };
    }
    throw err;
  }

  const value = Number(deletedCoin?.value?.N ?? 10);
  const kind = deletedCoin?.kind?.S || "gold";
  const x = Math.round(clamp(body.x, 22, ARENA_W - 22, Number(deletedCoin?.x?.N ?? ARENA_W / 2)));
  const y = Math.round(clamp(body.y, 22, ARENA_H - 22, Number(deletedCoin?.y?.N ?? ARENA_H / 2)));

  const updatedPlayer = await ddbClient.send(
    await makeDdbCommand("UpdateItemCommand", {
      TableName: TABLE_NAME,
      Key: { pk: { S: `PLAYER#${connectionId}` } },
      ConditionExpression: "attribute_exists(pk)",
      UpdateExpression:
        "ADD score :val, coinsCollected :one SET x = :x, y = :y, updatedAt = :ts, #ttl = :ttl",
      ExpressionAttributeNames: { "#ttl": "ttl" },
      ExpressionAttributeValues: {
        ":val": { N: String(value) },
        ":one": { N: "1" },
        ":x": { N: String(x) },
        ":y": { N: String(y) },
        ":ts": { N: String(Date.now()) },
        ":ttl": { N: String(ttlEpochSeconds(3600)) },
      },
      ReturnValues: "ALL_NEW",
    })
  );

  const player = parsePlayerItem(updatedPlayer.Attributes);
  const spawnedCoin = await spawnCoinItem(config.scoreMultiplier);
  const { players } = await scanArenaState();

  await Promise.all([
    broadcast(apigw, players, {
      type: "coin_collected",
      playerId: connectionId,
      playerName: player.name,
      coinId,
      kind,
      value,
      newScore: player.score,
      coinsCollected: player.coinsCollected,
      spawnedCoin,
    }),
    putGameMetric("CoinsCollected", 1),
    putGameMetric("ScoreAwarded", value),
    enqueueGameEvent("coin_collected", {
      playerName: player.name,
      color: player.color,
      kind,
      value,
      newScore: player.score,
      coinsCollected: player.coinsCollected,
    }),
  ]);

  return { statusCode: 200, body: "Collected" };
}

async function handleChat(event, connectionId, body) {
  const apigw = await getApiGwClient(event);
  const text = String(body.text || "")
    .replace(/[\r\n\t]/g, " ")
    .trim()
    .slice(0, 160);
  if (!text) {
    return { statusCode: 200, body: "Empty chat" };
  }

  const { players } = await scanArenaState();
  const sender = players.find((p) => p.id === connectionId);
  const senderName = sender?.name || `Player-${connectionId.slice(0, 4)}`;

  await Promise.all([
    broadcast(apigw, players, {
      type: "chat",
      id: connectionId,
      name: senderName,
      color: sender?.color || "#38bdf8",
      text,
      ts: Date.now(),
    }),
    putGameMetric("ChatMessages", 1),
    enqueueGameEvent("chat_message", { playerName: senderName, text }),
  ]);

  return { statusCode: 200, body: "Chat sent" };
}

export const handler = async (event) => {
  const connectionId = event.requestContext.connectionId;
  let body = {};
  try {
    body = event.body ? JSON.parse(event.body) : {};
  } catch {
    return { statusCode: 400, body: "Invalid JSON" };
  }

  const action = body.action || event.requestContext?.routeKey;

  try {
    switch (action) {
      case "join":
        return await handleJoin(event, connectionId, body);
      case "move":
        return await handleMove(event, connectionId, body);
      case "collect":
        return await handleCollect(event, connectionId, body);
      case "chat":
        return await handleChat(event, connectionId, body);
      case "ping": {
        const apigw = await getApiGwClient(event);
        await postJson(apigw, connectionId, {
          type: "pong",
          clientTs: Number(body.clientTs || Date.now()),
          serverTs: Date.now(),
        });
        return { statusCode: 200, body: "Pong" };
      }
      default: {
        const apigw = await getApiGwClient(event);
        await postJson(apigw, connectionId, {
          type: "error",
          message: `Unknown action: ${action}`,
        });
        return { statusCode: 400, body: "Unknown action" };
      }
    }
  } catch (err) {
    console.error(`Action ${action} failed:`, err);
    return { statusCode: 500, body: "Internal server error" };
  }
};
