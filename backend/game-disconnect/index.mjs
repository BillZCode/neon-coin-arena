import { DeleteItemCommand } from "@aws-sdk/client-dynamodb";
import {
  ddbClient,
  TABLE_NAME,
  getApiGwClient,
  scanArenaState,
  broadcast,
} from "./ws-utils.mjs";

export const handler = async (event) => {
  const connectionId = event.requestContext.connectionId;

  try {
    await ddbClient.send(
      new DeleteItemCommand({
        TableName: TABLE_NAME,
        Key: { pk: { S: `PLAYER#${connectionId}` } },
      })
    );

    const apigw = getApiGwClient(event);
    const { players } = await scanArenaState();
    await broadcast(apigw, players, {
      type: "player_left",
      id: connectionId,
    });

    return { statusCode: 200 };
  } catch (err) {
    console.error("Disconnect error:", err);
    return { statusCode: 500, body: "Failed to disconnect" };
  }
};
