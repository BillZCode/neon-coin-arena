import test from "node:test";
import assert from "node:assert/strict";
import { setAwsClientsForTest } from "../shared/aws-clients.mjs";
import { handler as connectHandler } from "../game-connect/index.mjs";
import { handler as eventsHandler } from "../game-events/index.mjs";
import { handler as disconnectHandler } from "../game-disconnect/index.mjs";
import { handler as analyticsHandler } from "../game-analytics-worker/index.mjs";
import { handler as restHandler } from "../game-rest-api/index.mjs";
import { handler as cleanupHandler } from "../game-cleanup/index.mjs";

function createInMemoryAwsEnv() {
  const table = new Map();
  const sqsSent = [];
  const snsPublished = [];
  const cwMetrics = [];
  const s3Objects = new Map();
  const wsPosted = [];

  const dynamodb = {
    async send(cmd) {
      const name = cmd.__cmd || cmd.constructor?.name;
      const inp = cmd.input || cmd;
      if (name === "PutItemCommand") {
        table.set(inp.Item.pk.S, structuredClone(inp.Item));
        return {};
      }
      if (name === "GetItemCommand") {
        return { Item: table.get(inp.Key.pk.S) ? structuredClone(table.get(inp.Key.pk.S)) : undefined };
      }
      if (name === "DeleteItemCommand") {
        const pk = inp.Key.pk.S;
        const prev = table.get(pk);
        if (inp.ConditionExpression === "attribute_exists(pk)" && !prev) {
          const err = new Error("ConditionalCheckFailedException");
          err.name = "ConditionalCheckFailedException";
          throw err;
        }
        table.delete(pk);
        return { Attributes: prev ? structuredClone(prev) : undefined };
      }
      if (name === "UpdateItemCommand") {
        const pk = inp.Key.pk.S;
        const cur = table.get(pk) || { pk: { S: pk } };
        if (inp.ConditionExpression === "attribute_exists(pk)" && !table.has(pk)) {
          const err = new Error("ConditionalCheckFailedException");
          err.name = "ConditionalCheckFailedException";
          throw err;
        }
        const v = inp.ExpressionAttributeValues || {};
        if (v[":cid"]) cur.connectionId = v[":cid"];
        if (v[":name"]) cur.name = v[":name"];
        if (v[":color"]) cur.color = v[":color"];
        if (v[":joined"]) cur.joined = v[":joined"];
        if (v[":ts"]) cur.updatedAt = v[":ts"];
        if (v[":ttl"]) cur.ttl = v[":ttl"];
        if (v[":x"]) cur.x = v[":x"];
        if (v[":y"]) cur.y = v[":y"];
        if (v[":dir"]) cur.dir = v[":dir"];
        if (v[":boosting"]) cur.boosting = v[":boosting"];
        if (!cur.x && v[":dx"]) cur.x = v[":dx"];
        if (!cur.y && v[":dy"]) cur.y = v[":dy"];
        if (!cur.score && v[":zero"]) cur.score = { N: "0" };
        if (!cur.coinsCollected && v[":zero"]) cur.coinsCollected = { N: "0" };
        if (v[":val"]) cur.score = { N: String(Number(cur.score?.N || 0) + Number(v[":val"].N)) };
        if (v[":one"]) cur.coinsCollected = { N: String(Number(cur.coinsCollected?.N || 0) + Number(v[":one"].N)) };
        if (v[":pn"]) cur.playerName = v[":pn"];
        if (v[":c"]) cur.color = v[":c"];
        if (v[":hs"]) cur.highestScore = v[":hs"];
        if (v[":tc"]) cur.totalCoins = { N: String(Number(cur.totalCoins?.N || 0) + Number(v[":tc"].N)) };
        if (v[":gp"]) cur.gamesPlayed = { N: String(Number(cur.gamesPlayed?.N || 0) + Number(v[":gp"].N)) };
        if (v[":ev"]) cur.totalEvents = { N: String(Number(cur.totalEvents?.N || 0) + Number(v[":ev"].N)) };
        if (v[":cc"]) cur.totalCoinsCollected = { N: String(Number(cur.totalCoinsCollected?.N || 0) + Number(v[":cc"].N)) };
        if (v[":ch"]) cur.totalChats = { N: String(Number(cur.totalChats?.N || 0) + Number(v[":ch"].N)) };
        table.set(pk, cur);
        return { Attributes: structuredClone(cur) };
      }
      if (name === "ScanCommand") {
        return { Items: Array.from(table.values()).map((i) => structuredClone(i)) };
      }
      throw new Error(`Unexpected DynamoDB command: ${name}`);
    },
  };

  setAwsClientsForTest({
    dynamodb,
    apigw: {
      async send(cmd) {
        const inp = cmd.input || cmd;
        wsPosted.push({
          connectionId: inp.ConnectionId,
          payload: JSON.parse(new TextDecoder().decode(inp.Data)),
        });
      },
    },
    ssm: {
      async send() {
        return {
          Parameter: {
            Value: JSON.stringify({ targetCoins: 6, scoreMultiplier: 2, motd: "AWS Event Active!" }),
          },
        };
      },
    },
    sqs: {
      async send(cmd) {
        sqsSent.push(JSON.parse((cmd.input || cmd).MessageBody));
      },
    },
    sns: {
      async send(cmd) {
        snsPublished.push(cmd.input || cmd);
      },
    },
    cloudwatch: {
      async send(cmd) {
        cwMetrics.push(...((cmd.input || cmd).MetricData || []));
      },
    },
    s3: {
      async send(cmd) {
        const inp = cmd.input || cmd;
        s3Objects.set(inp.Key, JSON.parse(inp.Body));
      },
    },
  });

  process.env.SSM_CONFIG_PARAM = "/neon-coin-arena/config";
  process.env.SQS_QUEUE_URL = "https://sqs.us-east-1.amazonaws.com/000000000000/test-queue";
  process.env.SNS_TOPIC_ARN = "arn:aws:sns:us-east-1:000000000000:test-topic";
  process.env.DATA_BUCKET = "test-data-bucket";
  process.env.CW_NAMESPACE = "NeonCoinArena";

  return { table, sqsSent, snsPublished, cwMetrics, s3Objects, wsPosted };
}

test("Full serverless AWS pipeline across WebSocket, DynamoDB, SSM, SQS, SNS, S3, CloudWatch, HTTP API, EventBridge", async () => {
  const env = createInMemoryAwsEnv();

  // 1. $connect saves player with TTL
  const connRes = await connectHandler({ requestContext: { connectionId: "c1" } });
  assert.equal(connRes.statusCode, 200);
  assert.ok(env.table.get("PLAYER#c1").ttl.N);

  // 2. join reads SSM MOTD/targetCoins, emits welcome + CloudWatch + SQS
  const joinRes = await eventsHandler({
    requestContext: { connectionId: "c1", domainName: "ws.test", stage: "dev" },
    body: JSON.stringify({ action: "join", name: "Nova", color: "#38bdf8" }),
  });
  assert.equal(joinRes.statusCode, 200);
  const welcome = env.wsPosted.find((m) => m.payload.type === "welcome")?.payload;
  assert.equal(welcome.motd, "AWS Event Active!");
  assert.equal(welcome.coins.length, 6);

  // 3. collect updates score atomically and enqueues SQS event
  const coin = welcome.coins[0];
  await eventsHandler({
    requestContext: { connectionId: "c1", domainName: "ws.test", stage: "dev" },
    body: JSON.stringify({ action: "collect", coinId: coin.id, x: coin.x, y: coin.y }),
  });
  assert.ok(env.sqsSent.some((e) => e.eventType === "coin_collected" && e.playerName === "Nova"));

  // 4. SQS worker updates Hall of Fame, triggers SNS on >= 100 milestone, archives batch to S3
  const sqsRes = await analyticsHandler({
    Records: [
      { body: JSON.stringify({ eventType: "coin_collected", playerName: "Nova", color: "#38bdf8", newScore: 150 }) },
      { body: JSON.stringify({ eventType: "chat_message", playerName: "Nova", text: "Hello AWS" }) },
    ],
  });
  assert.equal(sqsRes.processed, 2);
  assert.equal(env.snsPublished.length, 1);
  assert.ok(Array.from(env.s3Objects.keys()).some((k) => k.startsWith("archives/")));

  // 5. HTTP API GET /leaderboard returns persistent Hall of Fame + MOTD
  const lbRes = await restHandler({ requestContext: { http: { method: "GET" } }, rawPath: "/leaderboard" });
  assert.equal(lbRes.statusCode, 200);
  const lbBody = JSON.parse(lbRes.body);
  assert.equal(lbBody.hallOfFame[0].name, "Nova");
  assert.equal(lbBody.hallOfFame[0].highestScore, 150);
  assert.equal(lbBody.motd, "AWS Event Active!");

  // 6. EventBridge cleanup removes stale players & snapshots leaderboard to S3
  env.table.get("PLAYER#c1").updatedAt = { N: String(Date.now() - 20 * 60 * 1000) };
  const cleanRes = await cleanupHandler({});
  assert.equal(cleanRes.cleanedPlayers, 1);
  assert.ok(env.s3Objects.has("snapshots/leaderboard.json"));

  // 7. disconnect removes connection cleanly
  const discRes = await disconnectHandler({ requestContext: { connectionId: "c1", domainName: "ws.test", stage: "dev" } });
  assert.equal(discRes.statusCode, 200);
  assert.ok(env.cwMetrics.some((m) => m.MetricName === "CoinsCollected"));

  setAwsClientsForTest(null);
});
