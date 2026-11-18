import { scanArenaState } from "../shared/ws-utils.mjs";
import { getGameConfig } from "../shared/aws-clients.mjs";

const CORS_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function jsonResponse(statusCode, payload) {
  return {
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify(payload),
  };
}

export const handler = async (event) => {
  const method =
    event?.requestContext?.http?.method || event?.httpMethod || "GET";
  if (method === "OPTIONS") {
    return { statusCode: 204, headers: CORS_HEADERS, body: "" };
  }

  const rawPath = event?.rawPath || event?.path || "/leaderboard";
  try {
    const [state, config] = await Promise.all([
      scanArenaState(),
      getGameConfig(),
    ]);
    const activePlayers = state.players
      .filter((p) => p.joined)
      .sort((a, b) => b.score - a.score)
      .slice(0, 20)
      .map((p) => ({
        name: p.name,
        color: p.color,
        score: p.score,
        coinsCollected: p.coinsCollected,
      }));

    if (rawPath.endsWith("/health")) {
      return jsonResponse(200, {
        ok: true,
        service: "neon-coin-arena-http-api",
        activePlayers: activePlayers.length,
        coins: state.coins.length,
        motd: config.motd || "",
      });
    }

    if (rawPath.endsWith("/stats")) {
      return jsonResponse(200, {
        stats: state.stats,
        activePlayers: activePlayers.length,
        coinsInArena: state.coins.length,
        config,
        updatedAt: Date.now(),
      });
    }

    return jsonResponse(200, {
      hallOfFame: state.hallOfFame.slice(0, 15),
      livePlayers: activePlayers,
      stats: state.stats,
      motd: config.motd || "",
      updatedAt: Date.now(),
    });
  } catch (err) {
    console.error("HTTP API error:", err);
    return jsonResponse(500, { ok: false, error: "Internal server error" });
  }
};
