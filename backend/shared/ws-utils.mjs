import {
  DynamoDBClient,
  ScanCommand,
  DeleteItemCommand,
  PutItemCommand,
} from "@aws-sdk/client-dynamodb";
import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
} from "@aws-sdk/client-apigatewaymanagementapi";

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

export const ddbClient = new DynamoDBClient({});
const apigwCache = new Map();

/**
 * Returns a cached ApiGatewayManagementApiClient for the incoming request endpoint.
 */
export function getApiGwClient(event) {
  const domain = event?.requestContext?.domainName;
  const stage = event?.requestContext?.stage;
  const endpoint =
    process.env.WS_CALLBACK_URL ||
    (domain && stage ? `https://${domain}/${stage}` : "");
  if (!endpoint) {
    throw new Error("Missing WebSocket callback endpoint");
  }
  if (!apigwCache.has(endpoint)) {
    apigwCache.set(endpoint, new ApiGatewayManagementApiClient({ endpoint }));
  }
  return apigwCache.get(endpoint);
}

/**
 * Picks a random element or weighted coin type.
 */
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
export async function spawnCoinItem() {
  const { kind, value } = pickCoinType();
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const margin = 46;
  const x = Math.round(margin + Math.random() * (ARENA_W - margin * 2));
  const y = Math.round(margin + Math.random() * (ARENA_H - margin * 2));

  await ddbClient.send(
    new PutItemCommand({
      TableName: TABLE_NAME,
      Item: {
        pk: { S: `COIN#${id}` },
        coinId: { S: id },
        kind: { S: kind },
        value: { N: String(value) },
        x: { N: String(x) },
        y: { N: String(y) },
      },
    })
  );

  return { id, kind, value, x, y };
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
 * Scans the shared arena DynamoDB table and partitions items into players and coins.
 */
export async function scanArenaState() {
  const players = [];
  const coins = [];
  let ExclusiveStartKey;

  do {
    const res = await ddbClient.send(
      new ScanCommand({
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
      }
    }
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey);

  return { players, coins };
}

/**
 * Posts JSON data to a WebSocket connection, deleting stale records on 410 GoneException.
 */
export async function postJson(apigw, connectionId, payload) {
  const data = new TextEncoder().encode(JSON.stringify(payload));
  try {
    await apigw.send(
      new PostToConnectionCommand({
        ConnectionId: connectionId,
        Data: data,
      })
    );
    return true;
  } catch (err) {
    if (err?.name === "GoneException" || err?.$metadata?.httpStatusCode === 410) {
      await ddbClient
        .send(
          new DeleteItemCommand({
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
