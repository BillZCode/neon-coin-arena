import {
  ddbClient,
  TABLE_NAME,
  getApiGwClient,
  scanArenaState,
  broadcast,
  makeDdbCommand,
  parsePlayerItem,
} from "../shared/ws-utils.mjs";
import { enqueueGameEvent, putGameMetric } from "../shared/aws-clients.mjs";

export const handler = async (event) => {
  const connectionId = event.requestContext.connectionId;

  try {
    const delRes = await ddbClient.send(
      await makeDdbCommand("DeleteItemCommand", {
        TableName: TABLE_NAME,
        Key: { pk: { S: `PLAYER#${connectionId}` } },
        ReturnValues: "ALL_OLD",
      })
    );

    const apigw = await getApiGwClient(event);
    const { players } = await scanArenaState();
    await broadcast(apigw, players, {
      type: "player_left",
      id: connectionId,
    });

    if (delRes?.Attributes) {
      const oldPlayer = parsePlayerItem(delRes.Attributes);
      if (oldPlayer.joined) {
        await Promise.all([
          enqueueGameEvent("player_left", {
            playerName: oldPlayer.name,
            color: oldPlayer.color,
            score: oldPlayer.score,
            coinsCollected: oldPlayer.coinsCollected,
          }),
          putGameMetric("PlayersLeft", 1),
        ]);
      }
    }

    return { statusCode: 200 };
  } catch (err) {
    console.error("Disconnect error:", err);
    return { statusCode: 500, body: "Failed to disconnect" };
  }
};
