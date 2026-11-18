import {
  getDynamoClient,
  getApiGwManagementClient,
  makeAwsCommand,
} from "./aws-clients.mjs";

export const TABLE_NAME = process.env.TABLE_NAME || "websocket-game-db";
export const ARENA_W = 960;
export const ARENA_H = 600;
export const TARGET_COINS = 12;

export const PLAYER_COLORS = [
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

/**
 * Builds an AWS SDK command instance, falling back to plain descriptors in unit tests.
 */
export async function makeDdbCommand(name, input) {
  return makeAwsCommand("@aws-sdk/client-dynamodb", name, input);
}

async function makePostToConnCommand(input) {
  return makeAwsCommand(
    "@aws-sdk/client-apigatewaymanagementapi",
    "PostToConnectionCommand",
    input
  );
}

export async function ddbSend(cmd) {
  const client = await getDynamoClient();
  return client.send(cmd);
}

/**
 * DynamoDB client helper compatible with Lambda and mocked unit tests.
 */
export const ddbClient = {
  send: ddbSend,
};

/**
 * Returns a cached ApiGatewayManagementApiClient for the incoming request endpoint.
 */
export async function getApiGwClient(event) {
  const domain = event?.requestContext?.domainName;
  const stage = event?.requestContext?.stage;
  const endpoint =
    process.env.WS_CALLBACK_URL ||
    (domain && stage ? `https://${domain}/${stage}` : "");
  if (!endpoint) {
    throw new Error("Missing WebSocket callback endpoint");
  }
  return getApiGwManagementClient(endpoint);
}

function pickCoinType() {
  const total = COIN_CATALOG.reduce((sum, item) => sum + item.weight, 0);
  let r = Math.random() * total;
  for (const item of COIN_CATALOG) {
    r -= item.weight;
    if (r <= 0) return item;
  }
  return COIN_CATALOG[0];
}

/**
 * Builds a randomized coin object and persists it to DynamoDB.
 */
export async function spawnCoinItem(multiplier = 1) {
  const { kind, value } = pickCoinType();
  const scaledValue = Math.round(value * Math.max(1, multiplier));
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const margin = 46;
  const x = Math.round(margin + Math.random() * (ARENA_W - margin * 2));
  const y = Math.round(margin + Math.random() * (ARENA_H - margin * 2));

  await ddbClient.send(
    await makeDdbCommand("PutItemCommand", {
      TableName: TABLE_NAME,
      Item: {
        pk: { S: `COIN#${id}` },
        coinId: { S: id },
        kind: { S: kind },
        value: { N: String(scaledValue) },
        x: { N: String(x) },
        y: { N: String(y) },
      },
    })
  );

  return { id, kind, value: scaledValue, x, y };
}

/**
 * Parses a raw DynamoDB player item into a plain object.
 */
export function parsePlayerItem(item) {
  return {
    id: item.connectionId?.S || "",
    name: item.name?.S || "Player",
    color: item.color?.S || "#38bdf8",
    x: Number(item.x?.N ?? ARENA_W / 2),
    y: Number(item.y?.N ?? ARENA_H / 2),
    dir: Number(item.dir?.N ?? 0),
    boosting: Boolean(item.boosting?.BOOL),
    score: Number(item.score?.N ?? 0),
    coinsCollected: Number(item.coinsCollected?.N ?? 0),
    joined: Boolean(item.joined?.BOOL),
    updatedAt: Number(item.updatedAt?.N ?? 0),
  };
}

/**
 * Parses a raw DynamoDB coin item into a plain object.
 */
export function parseCoinItem(item) {
  return {
    id: item.coinId?.S || "",
    kind: item.kind?.S || "gold",
    value: Number(item.value?.N ?? 10),
    x: Number(item.x?.N ?? ARENA_W / 2),
    y: Number(item.y?.N ?? ARENA_H / 2),
  };
}

/**
 * Parses a persistent Hall-of-Fame DynamoDB entry.
 */
export function parseHallOfFameItem(item) {
  return {
    name: item.playerName?.S || item.pk?.S?.replace(/^HALL_OF_FAME#/, "") || "Player",
    color: item.color?.S || "#38bdf8",
    highestScore: Number(item.highestScore?.N ?? 0),
    totalCoins: Number(item.totalCoins?.N ?? 0),
    gamesPlayed: Number(item.gamesPlayed?.N ?? 0),
    updatedAt: Number(item.updatedAt?.N ?? 0),
  };
}

/**
 * Scans the shared arena DynamoDB table and partitions items cleanly.
 */
export async function scanArenaState() {
  const players = [];
  const coins = [];
  const hallOfFame = [];
  let stats = { totalEvents: 0, totalCoinsCollected: 0, totalChats: 0 };
  let ExclusiveStartKey;

  do {
    const res = await ddbClient.send(
      await makeDdbCommand("ScanCommand", {
        TableName: TABLE_NAME,
        ExclusiveStartKey,
      })
    );
    for (const item of res.Items || []) {
      const pk = item.pk?.S || "";
      if (pk.startsWith("PLAYER#")) {
        players.push(parsePlayerItem(item));
      } else if (pk.startsWith("COIN#")) {
        coins.push(parseCoinItem(item));
      } else if (pk.startsWith("HALL_OF_FAME#")) {
        hallOfFame.push(parseHallOfFameItem(item));
      } else if (pk === "STATS#GLOBAL") {
        stats = {
          totalEvents: Number(item.totalEvents?.N ?? 0),
          totalCoinsCollected: Number(item.totalCoinsCollected?.N ?? 0),
          totalChats: Number(item.totalChats?.N ?? 0),
        };
      }
    }
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey);

  hallOfFame.sort((a, b) => b.highestScore - a.highestScore);
  return { players, coins, hallOfFame, stats };
}

/**
 * Posts JSON data to a WebSocket connection, deleting stale records on 410 GoneException.
 */
export async function postJson(apigw, connectionId, payload) {
  const data = new TextEncoder().encode(JSON.stringify(payload));
  try {
    await apigw.send(
      await makePostToConnCommand({
        ConnectionId: connectionId,
        Data: data,
      })
    );
    return true;
  } catch (err) {
    if (err?.name === "GoneException" || err?.$metadata?.httpStatusCode === 410) {
      await ddbClient
        .send(
          await makeDdbCommand("DeleteItemCommand", {
            TableName: TABLE_NAME,
            Key: { pk: { S: `PLAYER#${connectionId}` } },
          })
        )
        .catch(() => {});
      return false;
    }
    console.error(`Failed posting to ${connectionId}:`, err);
    return false;
  }
}

/**
 * Broadcasts a JSON payload to all joined players, excluding an optional connectionId.
 */
export async function broadcast(apigw, players, payload, excludeId = null) {
  const targets = players.filter(
    (p) => p.id && p.joined && p.id !== excludeId
  );
  await Promise.all(targets.map((p) => postJson(apigw, p.id, payload)));
}

/**
 * Clamps a numeric coordinate within the arena bounds.
 */
export function clamp(val, min, max, fallback) {
  const n = Number(val);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

/**
 * Computes DynamoDB TTL epoch seconds ahead of now.
 */
export function ttlEpochSeconds(secondsAhead = 3600) {
  return Math.floor(Date.now() / 1000) + secondsAhead;
}
