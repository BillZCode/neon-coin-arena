import {
  ddbClient,
  TABLE_NAME,
  scanArenaState,
  spawnCoinItem,
  makeDdbCommand,
} from "../shared/ws-utils.mjs";
import {
  getGameConfig,
  putS3Json,
  putGameMetric,
} from "../shared/aws-clients.mjs";

const DEFAULT_STALE_MS = 10 * 60 * 1000;

export const handler = async () => {
  const staleWindowMs = Number(process.env.STALE_PLAYER_MS || DEFAULT_STALE_MS);
  const cutoff = Date.now() - staleWindowMs;

  const [state, config] = await Promise.all([
    scanArenaState(),
    getGameConfig(),
  ]);

  const stalePlayers = state.players.filter(
    (p) => p.updatedAt > 0 && p.updatedAt < cutoff
  );

  for (const player of stalePlayers) {
    await ddbClient.send(
      await makeDdbCommand("DeleteItemCommand", {
        TableName: TABLE_NAME,
        Key: { pk: { S: `PLAYER#${player.id}` } },
      })
    );
  }

  const desiredCoins = config.targetCoins || 12;
  const missingCoins = Math.max(0, desiredCoins - state.coins.length);
  if (missingCoins > 0) {
    await Promise.all(
      Array.from({ length: missingCoins }, () =>
        spawnCoinItem(config.scoreMultiplier)
      )
    );
  }

  const activePlayers = state.players.filter(
    (p) => p.joined && !(p.updatedAt > 0 && p.updatedAt < cutoff)
  );

  await Promise.all([
    putS3Json("snapshots/leaderboard.json", {
      generatedAt: new Date().toISOString(),
      activePlayers: activePlayers.length,
      hallOfFame: state.hallOfFame.slice(0, 20),
      stats: state.stats,
    }),
    putGameMetric("StalePlayersCleaned", stalePlayers.length),
    putGameMetric("ActiveArenaPlayers", activePlayers.length),
  ]);

  return {
    cleanedPlayers: stalePlayers.length,
    spawnedCoins: missingCoins,
    activePlayers: activePlayers.length,
  };
};
