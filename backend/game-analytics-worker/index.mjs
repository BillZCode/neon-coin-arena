import {
  ddbClient,
  TABLE_NAME,
  makeDdbCommand,
} from "../shared/ws-utils.mjs";
import {
  publishAlert,
  putS3Json,
  putGameMetric,
} from "../shared/aws-clients.mjs";

function normalizeNameKey(name) {
  return String(name || "player")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "_")
    .slice(0, 24) || "player";
}

async function updateHallOfFame(playerName, color, score, coinIncrement, gameIncrement) {
  const key = `HALL_OF_FAME#${normalizeNameKey(playerName)}`;
  const now = Date.now();

  const existing = await ddbClient.send(
    await makeDdbCommand("GetItemCommand", {
      TableName: TABLE_NAME,
      Key: { pk: { S: key } },
    })
  );

  const prevHigh = Number(existing?.Item?.highestScore?.N ?? 0);
  const newHigh = Math.max(prevHigh, Number(score || 0));
  const brokeRecord = Number(score || 0) > prevHigh && Number(score || 0) >= 100;

  await ddbClient.send(
    await makeDdbCommand("UpdateItemCommand", {
      TableName: TABLE_NAME,
      Key: { pk: { S: key } },
      UpdateExpression:
        "SET playerName = :pn, color = :c, highestScore = :hs, updatedAt = :ts " +
        "ADD totalCoins :tc, gamesPlayed :gp",
      ExpressionAttributeValues: {
        ":pn": { S: String(playerName || "Player").slice(0, 18) },
        ":c": { S: String(color || "#38bdf8") },
        ":hs": { N: String(newHigh) },
        ":ts": { N: String(now) },
        ":tc": { N: String(coinIncrement) },
        ":gp": { N: String(gameIncrement) },
      },
    })
  );

  if (brokeRecord) {
    await Promise.all([
      publishAlert(
        `New High Score: ${playerName} (${newHigh})`,
        `Pemain ${playerName} mencetak rekor baru di Neon Coin Arena dengan skor ${newHigh}!`
      ),
      putGameMetric("HighScoreUpdated", newHigh, "None"),
    ]);
  }
}

export const handler = async (event) => {
  const records = Array.isArray(event?.Records) ? event.Records : [];
  if (records.length === 0) {
    return { batchItemFailures: [], processed: 0 };
  }

  let coinsDelta = 0;
  let chatsDelta = 0;
  const archiveItems = [];

  for (const rec of records) {
    let payload;
    try {
      payload = JSON.parse(rec.body || "{}");
    } catch {
      continue;
    }
    archiveItems.push(payload);

    if (payload.eventType === "coin_collected") {
      coinsDelta += 1;
      await updateHallOfFame(
        payload.playerName,
        payload.color,
        payload.newScore,
        1,
        0
      );
    } else if (payload.eventType === "player_left") {
      await updateHallOfFame(
        payload.playerName,
        payload.color,
        payload.score,
        0,
        1
      );
    } else if (payload.eventType === "chat_message") {
      chatsDelta += 1;
    }
  }

  if (archiveItems.length > 0) {
    await ddbClient.send(
      await makeDdbCommand("UpdateItemCommand", {
        TableName: TABLE_NAME,
        Key: { pk: { S: "STATS#GLOBAL" } },
        UpdateExpression:
          "SET updatedAt = :ts ADD totalEvents :ev, totalCoinsCollected :cc, totalChats :ch",
        ExpressionAttributeValues: {
          ":ts": { N: String(Date.now()) },
          ":ev": { N: String(archiveItems.length) },
          ":cc": { N: String(coinsDelta) },
          ":ch": { N: String(chatsDelta) },
        },
      })
    );

    const day = new Date().toISOString().slice(0, 10);
    const key = `archives/${day}/batch-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.json`;
    await Promise.all([
      putS3Json(key, { count: archiveItems.length, events: archiveItems }),
      putGameMetric("AnalyticsBatchProcessed", archiveItems.length),
    ]);
  }

  return { batchItemFailures: [], processed: archiveItems.length };
};
