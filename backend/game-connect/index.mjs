import { PutItemCommand } from "@aws-sdk/client-dynamodb";
import {
  ddbClient,
  TABLE_NAME,
  ARENA_W,
  ARENA_H,
  PLAYER_COLORS,
} from "./ws-utils.mjs";

export const handler = async (event) => {
  const connectionId = event.requestContext.connectionId;
  const x = Math.round(80 + Math.random() * (ARENA_W - 160));
  const y = Math.round(80 + Math.random() * (ARENA_H - 160));
  const color = PLAYER_COLORS[Math.floor(Math.random() * PLAYER_COLORS.length)];
  const defaultName = `Player-${connectionId.slice(0, 4)}`;

  try {
    await ddbClient.send(
      new PutItemCommand({
        TableName: TABLE_NAME,
        Item: {
          pk: { S: `PLAYER#${connectionId}` },
          connectionId: { S: connectionId },
          name: { S: defaultName },
          color: { S: color },
          x: { N: String(x) },
          y: { N: String(y) },
          dir: { N: "0" },
          boosting: { BOOL: false },
          score: { N: "0" },
          coinsCollected: { N: "0" },
          joined: { BOOL: false },
          updatedAt: { N: String(Date.now()) },
        },
      })
    );
    return { statusCode: 200 };
  } catch (err) {
    console.error("Connect error:", err);
    return { statusCode: 500, body: "Failed to connect" };
  }
};
