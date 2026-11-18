(() => {
  const APP_CFG = window.NEON_ARENA_CONFIG || {};
  const DEFAULT_AWS_WS_URL = "wss://YOUR_API_ID.execute-api.us-east-1.amazonaws.com/dev";
  const AWS_WS_URL = APP_CFG.AWS_WS_URL || DEFAULT_AWS_WS_URL;
  const AWS_HTTP_API_URL = APP_CFG.AWS_HTTP_API_URL || "";
  const VPS_HOST = APP_CFG.VPS_HOST || "";
  const SAME_ORIGIN_WS_URL =
    window.location.host && window.location.protocol !== "file:"
      ? `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}/ws`
      : "";
  const VPS_WS_URL = APP_CFG.VPS_WS_URL || SAME_ORIGIN_WS_URL;
  const ARENA_W = 960;
  const ARENA_H = 600;
  const PLAYER_RADIUS = 17;
  const PICKUP_RADIUS = 30;
  const BASE_SPEED = 275;
  const DASH_SPEED = 560;
  const TURBO_MULT = 1.48;
  const DASH_DURATION_MS = 210;
  const DASH_COOLDOWN_MS = 1800;
  const MOVE_SEND_INTERVAL_MS = 90;

  const COLORS = [
    "#38bdf8",
    "#f472b6",
    "#34d399",
    "#fbbf24",
    "#a78bfa",
    "#fb7185",
    "#22d3ee",
    "#f97316",
  ];

  const COIN_STYLE = {
    gold: { color: "#fbbf24", glow: "rgba(251, 191, 36, 0.55)", r: 10, label: "+10" },
    gem: { color: "#34d399", glow: "rgba(52, 211, 153, 0.6)", r: 12, label: "+25" },
    boost: { color: "#22d3ee", glow: "rgba(34, 211, 238, 0.65)", r: 12, label: "⚡+15" },
    star: { color: "#f472b6", glow: "rgba(244, 114, 182, 0.7)", r: 14, label: "★+50" },
  };

  // DOM Elements
  const canvas = document.getElementById("arenaCanvas");
  const ctx = canvas.getContext("2d");
  const lobbyOverlay = document.getElementById("lobbyOverlay");
  const joinForm = document.getElementById("joinForm");
  const nameInput = document.getElementById("nameInput");
  const serverPreset = document.getElementById("serverPreset");
  const wsUrlInput = document.getElementById("wsUrlInput");
  const colorPicker = document.getElementById("colorPicker");
  const lobbyError = document.getElementById("lobbyError");
  const lobbyErrorText = document.getElementById("lobbyErrorText");
  const lobbyErrorActions = document.getElementById("lobbyErrorActions");
  const fallbackVpsBtn = document.getElementById("fallbackVpsBtn");
  const downloadAppLink = document.getElementById("downloadAppLink");
  const connectBtn = document.getElementById("connectBtn");
  const disconnectBtn = document.getElementById("disconnectBtn");
  const statusPill = document.getElementById("statusPill");
  const statusText = document.getElementById("statusText");
  const pingPill = document.getElementById("pingPill");
  const onlinePill = document.getElementById("onlinePill");
  const soundBtn = document.getElementById("soundBtn");
  const dashFill = document.getElementById("dashFill");
  const turboBadge = document.getElementById("turboBadge");
  const dashBtn = document.getElementById("dashBtn");
  const selfScoreBadge = document.getElementById("selfScoreBadge");
  const leaderboardList = document.getElementById("leaderboardList");
  const tabLiveLb = document.getElementById("tabLiveLb");
  const tabHofLb = document.getElementById("tabHofLb");
  const hofStatsRow = document.getElementById("hofStatsRow");
  const chatMessages = document.getElementById("chatMessages");
  const chatForm = document.getElementById("chatForm");
  const chatInput = document.getElementById("chatInput");
  const chatSendBtn = document.getElementById("chatSendBtn");
  const quickChatBtns = document.querySelectorAll("[data-chat]");
  const logCard = document.getElementById("logCard");
  const toggleLogBtn = document.getElementById("toggleLogBtn");
  const wsLog = document.getElementById("wsLog");
  const clearLogBtn = document.getElementById("clearLogBtn");

  // State
  let ws = null;
  let selfId = null;
  let selectedColor = COLORS[0];
  let soundEnabled = true;
  let audioCtx = null;
  let pingTimer = null;
  let lastFrameTime = performance.now();
  let lastMoveSentAt = 0;
  let lastSentPos = { x: -1, y: -1, boosting: false };
  let dashUntil = 0;
  let dashCooldownUntil = 0;
  let turboUntil = 0;

  const players = new Map();
  const coins = new Map();
  const pendingCollects = new Map();
  const particles = [];
  const popups = [];
  const keys = new Set();
  const touchDirs = new Set();

  // Initialize Lobby Defaults
  const isEmbeddedApp =
    window.location.search.includes("app=1") ||
    navigator.userAgent.includes("NeonCoinArenaApp") ||
    window.location.protocol === "file:";
  if (isEmbeddedApp && downloadAppLink) {
    downloadAppLink.classList.add("hidden");
  }

  function syncPresetFromUrl(url) {
    if (serverPreset) {
      if (url === AWS_WS_URL) {
        serverPreset.value = "aws";
      } else if (VPS_WS_URL && url === VPS_WS_URL) {
        serverPreset.value = "vps";
      } else {
        serverPreset.value = "custom";
      }
    }
  }

  function showLobbyError(message, showVpsFallback = false) {
    if (lobbyErrorText) {
      lobbyErrorText.textContent = message;
    } else {
      lobbyError.textContent = message;
    }
    if (lobbyErrorActions) {
      lobbyErrorActions.classList.toggle("hidden", !showVpsFallback || !VPS_WS_URL);
    }
    lobbyError.classList.remove("hidden");
  }

  const randomTag = Math.floor(100 + Math.random() * 900);
  nameInput.value = localStorage.getItem("ws_game_name") || `Cyber-${randomTag}`;
  const isVpsHost = Boolean(VPS_HOST && window.location.hostname === VPS_HOST);
  const isPlaceholderAws = AWS_WS_URL.includes("YOUR_API_ID");
  const autoWsUrl = isVpsHost
    ? SAME_ORIGIN_WS_URL || VPS_WS_URL
    : !isPlaceholderAws
      ? AWS_WS_URL
      : VPS_WS_URL || AWS_WS_URL;
  const storedUrl = localStorage.getItem("ws_game_url");
  const initialUrl =
    storedUrl &&
    (storedUrl.startsWith("wss://") || storedUrl.startsWith("ws://")) &&
    !storedUrl.includes("YOUR_API_ID")
      ? storedUrl
      : autoWsUrl;
  wsUrlInput.value = initialUrl;
  syncPresetFromUrl(initialUrl);

  if (serverPreset) {
    serverPreset.addEventListener("change", () => {
      if (serverPreset.value === "aws") {
        wsUrlInput.value = AWS_WS_URL;
      } else if (serverPreset.value === "vps" && VPS_WS_URL) {
        wsUrlInput.value = VPS_WS_URL;
      } else {
        wsUrlInput.focus();
      }
    });
  }

  wsUrlInput.addEventListener("input", () => {
    syncPresetFromUrl(wsUrlInput.value.trim());
  });

  if (fallbackVpsBtn) {
    fallbackVpsBtn.addEventListener("click", () => {
      wsUrlInput.value = VPS_WS_URL;
      syncPresetFromUrl(VPS_WS_URL);
      localStorage.setItem("ws_game_url", VPS_WS_URL);
      lobbyError.classList.add("hidden");
      if (typeof joinForm.requestSubmit === "function") {
        joinForm.requestSubmit();
      } else {
        connectBtn.click();
      }
    });
  }

  COLORS.forEach((c, idx) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "color-swatch" + (idx === 0 ? " active" : "");
    btn.style.background = c;
    btn.dataset.color = c;
    btn.addEventListener("click", () => {
      selectedColor = c;
      colorPicker.querySelectorAll(".color-swatch").forEach((el) => el.classList.remove("active"));
      btn.classList.add("active");
    });
    colorPicker.appendChild(btn);
  });

  function ensureAudio() {
    if (!soundEnabled) return null;
    if (!audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) audioCtx = new AC();
    }
    if (audioCtx && audioCtx.state === "suspended") {
      audioCtx.resume().catch(() => {});
    }
    return audioCtx;
  }

  function playTone(freq, duration = 0.09, type = "sine", gainVal = 0.08) {
    const ac = ensureAudio();
    if (!ac) return;
    const now = ac.currentTime;
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, now);
    osc.frequency.exponentialRampToValueAtTime(freq * 1.35, now + duration);
    gain.gain.setValueAtTime(gainVal, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + duration);
    osc.connect(gain);
    gain.connect(ac.destination);
    osc.start(now);
    osc.stop(now + duration);
  }

  soundBtn.addEventListener("click", () => {
    soundEnabled = !soundEnabled;
    soundBtn.textContent = soundEnabled ? "🔊 Sound On" : "🔇 Muted";
  });

  function appendLog(dir, msg) {
    const el = document.createElement("div");
    el.className = dir === "out" ? "log-out" : dir === "in" ? "log-in" : "log-err";
    const t = new Date().toLocaleTimeString("en-GB", { hour12: false });
    const short = msg.length > 110 ? msg.slice(0, 110) + "…" : msg;
    el.textContent = `[${t}] ${dir === "out" ? "→" : dir === "in" ? "←" : "!"} ${short}`;
    wsLog.appendChild(el);
    while (wsLog.children.length > 45) wsLog.removeChild(wsLog.firstChild);
    wsLog.scrollTop = wsLog.scrollHeight;
  }

  clearLogBtn.addEventListener("click", () => {
    wsLog.innerHTML = "";
  });

  toggleLogBtn.addEventListener("click", () => {
    const hidden = logCard.classList.toggle("hidden");
    toggleLogBtn.textContent = hidden ? "⚙ Tampilkan Log Teknis" : "⚙ Sembunyikan Log Teknis";
  });

  quickChatBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      const text = btn.dataset.chat;
      if (text) sendWs({ action: "chat", text });
    });
  });

  function appendChat(author, color, text, isSystem = false, senderId = null, ts = Date.now()) {
    const emptyEl = chatMessages.querySelector(".chat-empty");
    if (emptyEl) emptyEl.remove();

    const line = document.createElement("div");
    if (isSystem) {
      line.className = "chat-sys";
      line.textContent = text;
    } else {
      const isSelf = Boolean(senderId && selfId && senderId === selfId);
      line.className = "chat-bubble" + (isSelf ? " is-self" : "");

      const meta = document.createElement("div");
      meta.className = "chat-meta";

      const authorWrap = document.createElement("span");
      authorWrap.className = "chat-author";
      authorWrap.style.color = color || "#38bdf8";

      const dot = document.createElement("span");
      dot.className = "chat-author-dot";
      dot.style.background = color || "#38bdf8";

      const nameText = document.createElement("span");
      nameText.textContent = isSelf ? `${author} (Kamu)` : author;
      authorWrap.append(dot, nameText);

      const timeEl = document.createElement("span");
      timeEl.className = "chat-time";
      timeEl.textContent = new Date(ts).toLocaleTimeString("id-ID", {
        hour: "2-digit",
        minute: "2-digit",
      });

      meta.append(authorWrap, timeEl);

      const bodyEl = document.createElement("div");
      bodyEl.className = "chat-body";
      bodyEl.textContent = text;

      line.append(meta, bodyEl);
    }

    chatMessages.appendChild(line);
    while (chatMessages.children.length > 60) chatMessages.removeChild(chatMessages.firstChild);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  function setConnectionStatus(state, label) {
    statusPill.classList.remove("pill-online", "pill-connecting", "pill-offline");
    statusPill.classList.add(`pill-${state}`);
    statusText.textContent = label;
    const isOnline = state === "online";
    disconnectBtn.classList.toggle("hidden", !isOnline);
    chatInput.disabled = !isOnline;
    chatSendBtn.disabled = !isOnline;
    quickChatBtns.forEach((btn) => {
      btn.disabled = !isOnline;
    });
  }

  function sendWs(payload) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    const raw = JSON.stringify(payload);
    ws.send(raw);
    if (payload.action !== "move" && payload.action !== "ping") {
      appendLog("out", raw);
    }
    return true;
  }

  let leaderboardMode = "live";

  function renderLeaderboardMessage(msg) {
    leaderboardList.innerHTML = "";
    const li = document.createElement("li");
    li.className = "empty-msg";
    li.textContent = msg;
    leaderboardList.appendChild(li);
  }

  function renderLeaderboardRows(rows, emptyMsg, scoreSelector) {
    leaderboardList.innerHTML = "";
    if (!rows.length) {
      renderLeaderboardMessage(emptyMsg);
      return;
    }

    rows.forEach((p, idx) => {
      const isSelf = p.id && p.id === selfId;
      const li = document.createElement("li");
      li.className = "lb-item" + (isSelf ? " is-self" : "");

      const left = document.createElement("div");
      left.className = "lb-left";

      const rank = document.createElement("span");
      rank.className = "lb-rank";
      rank.textContent = `#${idx + 1}`;

      const dot = document.createElement("span");
      dot.className = "lb-dot";
      dot.style.background = p.color || "#38bdf8";

      const name = document.createElement("span");
      name.className = "lb-name";
      name.textContent = isSelf ? `${p.name} (Kamu)` : p.name || "Player";

      left.append(rank, dot, name);

      const score = document.createElement("span");
      score.className = "lb-score";
      score.textContent = `${scoreSelector(p)} pts`;

      li.append(left, score);
      leaderboardList.appendChild(li);
    });
  }

  function updateLeaderboard() {
    const sorted = Array.from(players.values()).sort((a, b) => b.score - a.score);
    onlinePill.textContent = `Pemain: ${sorted.length}`;
    const me = selfId ? players.get(selfId) : null;
    selfScoreBadge.textContent = `Skor: ${me ? me.score : 0}`;
    if (leaderboardMode === "hof") return;
    if (hofStatsRow) hofStatsRow.classList.add("hidden");
    renderLeaderboardRows(sorted, "Belum ada pemain terhubung.", (p) => p.score ?? 0);
  }

  function resolveHttpLeaderboardUrl() {
    const curWs = wsUrlInput?.value?.trim() || "";
    const hasAwsHttp = AWS_HTTP_API_URL && !AWS_HTTP_API_URL.includes("YOUR_HTTP_API_ID");
    if (hasAwsHttp && curWs.includes(".amazonaws.com")) {
      return `${AWS_HTTP_API_URL.replace(/\/$/, "")}/leaderboard`;
    }
    if (VPS_WS_URL) {
      return VPS_WS_URL.replace(/^ws:/i, "http:").replace(/^wss:/i, "https:").replace(/\/ws$/, "/api/leaderboard");
    }
    if (window.location.protocol.startsWith("http")) {
      return `${window.location.origin}/api/leaderboard`;
    }
    return "";
  }

  async function refreshHallOfFame() {
    if (leaderboardMode !== "hof") return;
    const url = resolveHttpLeaderboardUrl();
    if (!url) {
      renderLeaderboardMessage("Endpoint Hall of Fame belum dikonfigurasi.");
      return;
    }

    renderLeaderboardMessage("Memuat Hall of Fame...");
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (leaderboardMode !== "hof") return;

      const rows = Array.isArray(data.hallOfFame) ? data.hallOfFame.slice(0, 10) : [];
      renderLeaderboardRows(
        rows,
        "Belum ada rekor Hall of Fame tersimpan.",
        (entry) => entry.highestScore ?? 0
      );

      if (hofStatsRow && data.stats) {
        hofStatsRow.textContent = `Total Event: ${data.stats.totalEvents || 0} • Koin Terkumpul: ${data.stats.totalCoinsCollected || 0}`;
        hofStatsRow.classList.remove("hidden");
      }
    } catch {
      if (leaderboardMode !== "hof") return;
      renderLeaderboardMessage("Hall of Fame sementara belum dapat dimuat.");
      if (hofStatsRow) hofStatsRow.classList.add("hidden");
    }
  }

  if (tabLiveLb && tabHofLb) {
    tabLiveLb.addEventListener("click", () => {
      leaderboardMode = "live";
      tabLiveLb.classList.add("active");
      tabHofLb.classList.remove("active");
      updateLeaderboard();
    });
    tabHofLb.addEventListener("click", () => {
      leaderboardMode = "hof";
      tabHofLb.classList.add("active");
      tabLiveLb.classList.remove("active");
      refreshHallOfFame();
    });
  }

  function spawnBurst(x, y, color, label = "") {
    for (let i = 0; i < 14; i++) {
      const a = (Math.PI * 2 * i) / 14 + Math.random() * 0.3;
      const spd = 60 + Math.random() * 140;
      particles.push({
        x,
        y,
        vx: Math.cos(a) * spd,
        vy: Math.sin(a) * spd,
        life: 0.45,
        maxLife: 0.45,
        color,
      });
    }
    if (label) {
      popups.push({ x, y: y - 10, text: label, color, life: 0.85 });
    }
  }

  function upsertPlayer(p, isSelf = false) {
    const existing = players.get(p.id);
    if (existing) {
      existing.name = p.name;
      existing.color = p.color;
      existing.score = p.score ?? existing.score;
      existing.coinsCollected = p.coinsCollected ?? existing.coinsCollected;
      if (!isSelf) {
        existing.tx = p.x;
        existing.ty = p.y;
        existing.dir = p.dir ?? existing.dir;
        existing.boosting = Boolean(p.boosting);
      }
    } else {
      players.set(p.id, {
        ...p,
        tx: p.x,
        ty: p.y,
        dir: p.dir ?? 0,
        boosting: Boolean(p.boosting),
      });
    }
  }

  function handleServerMessage(msg) {
    switch (msg.type) {
      case "welcome": {
        selfId = msg.selfId;
        players.clear();
        coins.clear();
        pendingCollects.clear();
        (msg.players || []).forEach((p) => upsertPlayer(p, p.id === selfId));
        (msg.coins || []).forEach((c) => coins.set(c.id, c));
        lobbyOverlay.classList.add("hidden");
        setConnectionStatus("online", "Connected");
        appendChat("System", null, "Berhasil masuk arena! Kumpulkan koin & bintang sebanyak mungkin.", true);
        playTone(520, 0.14, "triangle", 0.08);
        updateLeaderboard();
        break;
      }
      case "player_joined": {
        if (msg.player && msg.player.id !== selfId) {
          upsertPlayer(msg.player, false);
          appendChat("System", null, `${msg.player.name} bergabung ke arena.`, true);
          updateLeaderboard();
        }
        break;
      }
      case "player_moved": {
        if (msg.id && msg.id !== selfId) {
          const p = players.get(msg.id);
          if (p) {
            p.tx = msg.x;
            p.ty = msg.y;
            p.dir = msg.dir ?? p.dir;
            p.boosting = Boolean(msg.boosting);
          }
        }
        break;
      }
      case "player_left": {
        const gone = players.get(msg.id);
        if (gone) {
          players.delete(msg.id);
          appendChat("System", null, `${gone.name} keluar dari arena.`, true);
          updateLeaderboard();
        }
        break;
      }
      case "coin_collected": {
        const oldCoin = coins.get(msg.coinId);
        coins.delete(msg.coinId);
        pendingCollects.delete(msg.coinId);
        if (msg.spawnedCoin) {
          coins.set(msg.spawnedCoin.id, msg.spawnedCoin);
        }
        const collector = players.get(msg.playerId);
        if (collector) {
          collector.score = msg.newScore;
          collector.coinsCollected = msg.coinsCollected;
        }
        const style = COIN_STYLE[msg.kind] || COIN_STYLE.gold;
        if (oldCoin) {
          spawnBurst(oldCoin.x, oldCoin.y, style.color, style.label);
        }
        if (msg.playerId === selfId) {
          playTone(msg.kind === "star" ? 780 : msg.kind === "gem" ? 640 : 520, 0.11, "sine", 0.09);
          if (msg.kind === "boost") {
            turboUntil = performance.now() + 3500;
            appendChat("System", null, "⚡ Turbo aktif selama 3.5 detik!", true);
          }
        }
        if (msg.kind === "star") {
          appendChat("System", null, `★ ${msg.playerName} meraih Star (+50 pts)!`, true);
        }
        updateLeaderboard();
        break;
      }
      case "coin_missed": {
        coins.delete(msg.coinId);
        pendingCollects.delete(msg.coinId);
        break;
      }
      case "chat": {
        appendChat(msg.name, msg.color, msg.text, false, msg.id, msg.ts || Date.now());
        break;
      }
      case "pong": {
        const rtt = Math.max(1, Math.round(Date.now() - Number(msg.clientTs || Date.now())));
        pingPill.textContent = `Ping: ${rtt} ms`;
        break;
      }
      case "error": {
        appendLog("err", msg.message || "Server error");
        break;
      }
      default:
        break;
    }
  }

  function disconnectClean() {
    if (pingTimer) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
    if (ws) {
      ws.close(1000, "Player left");
      ws = null;
    }
    selfId = null;
    players.clear();
    coins.clear();
    setConnectionStatus("offline", "Disconnected");
    pingPill.textContent = "Ping: -- ms";
    lobbyOverlay.classList.remove("hidden");
    connectBtn.disabled = false;
    updateLeaderboard();
  }

  joinForm.addEventListener("submit", (e) => {
    e.preventDefault();
    ensureAudio();
    const nickname = nameInput.value.trim();
    const url = wsUrlInput.value.trim();

    if (!url.startsWith("wss://") && !url.startsWith("ws://")) {
      showLobbyError("URL harus diawali wss:// atau ws://");
      return;
    }
    if (url.includes("YOUR_API_ID")) {
      showLobbyError("Isi frontend/config.js atau pilih Server VPS 24/7 / URL kustom di Pengaturan Server.", Boolean(VPS_WS_URL));
      return;
    }

    lobbyError.classList.add("hidden");
    if (lobbyErrorActions) lobbyErrorActions.classList.add("hidden");
    localStorage.setItem("ws_game_name", nickname);
    localStorage.setItem("ws_game_url", url);
    syncPresetFromUrl(url);

    if (ws) ws.close();
    connectBtn.disabled = true;
    setConnectionStatus("connecting", "Connecting...");
    let hadSocketError = false;

    try {
      ws = new WebSocket(url);
    } catch (err) {
      showLobbyError(`Gagal membuka WebSocket: ${err.message}`, url !== VPS_WS_URL);
      setConnectionStatus("offline", "Disconnected");
      connectBtn.disabled = false;
      return;
    }

    ws.onopen = () => {
      appendLog("in", "$connect OK -> sending join");
      sendWs({ action: "join", name: nickname, color: selectedColor });
      sendWs({ action: "ping", clientTs: Date.now() });
      pingTimer = setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ action: "ping", clientTs: Date.now() }));
        }
      }, 8000);
    };

    ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data);
        if (msg.type !== "player_moved" && msg.type !== "pong") {
          appendLog("in", evt.data);
        }
        handleServerMessage(msg);
      } catch (err) {
        appendLog("err", `Parse error: ${err.message}`);
      }
    };

    ws.onerror = () => {
      hadSocketError = true;
      const isAws = url.includes(".amazonaws.com");
      const canFallback = Boolean(VPS_WS_URL && url !== VPS_WS_URL);
      if (isAws) {
        showLobbyError(
          canFallback
            ? "Server AWS WebSocket tidak merespons (kemungkinan sesi 4 jam AWS Academy Learner Lab sedang berhenti/expired). Klik tombol di bawah untuk langsung main lewat Server VPS 24/7, atau nyalakan kembali Lab AWS Anda."
            : "Server AWS WebSocket tidak merespons. Pastikan API Gateway aktif atau ubah URL server di Pengaturan Server.",
          canFallback
        );
      } else {
        showLobbyError(
          "Koneksi WebSocket gagal. Periksa endpoint URL atau status server.",
          canFallback
        );
      }
      appendLog("err", "WebSocket error");
    };

    ws.onclose = () => {
      appendLog("err", "$disconnect / Socket closed");
      const canFallback = Boolean(VPS_WS_URL && url !== VPS_WS_URL);
      const wasTryingAws = !selfId && !hadSocketError && url.includes(".amazonaws.com");
      disconnectClean();
      if (wasTryingAws) {
        showLobbyError(
          canFallback
            ? "Koneksi ke AWS WebSocket ditutup sebelum masuk arena. Pastikan Lab AWS aktif atau klik tombol di bawah untuk Server VPS 24/7."
            : "Koneksi ke AWS WebSocket ditutup sebelum masuk arena. Pastikan Lab/API Gateway aktif.",
          canFallback
        );
      }
    };
  });

  disconnectBtn.addEventListener("click", () => {
    disconnectClean();
  });

  chatForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = chatInput.value.trim();
    if (!text) return;
    sendWs({ action: "chat", text });
    chatInput.value = "";
    chatInput.blur();
  });

  function triggerDash() {
    const now = performance.now();
    if (!selfId || now < dashCooldownUntil) return;
    dashUntil = now + DASH_DURATION_MS;
    dashCooldownUntil = now + DASH_COOLDOWN_MS;
    playTone(320, 0.08, "sawtooth", 0.05);
  }

  dashBtn.addEventListener("click", triggerDash);

  window.addEventListener("keydown", (e) => {
    if (document.activeElement === chatInput || document.activeElement === nameInput || document.activeElement === wsUrlInput) {
      if (e.key === "Escape") document.activeElement.blur();
      return;
    }
    const k = e.key.toLowerCase();
    if (["w", "a", "s", "d", "arrowup", "arrowdown", "arrowleft", "arrowright", " "].includes(k)) {
      e.preventDefault();
    }
    if (k === " " || e.key === "Shift") {
      triggerDash();
      return;
    }
    keys.add(k);
  });

  window.addEventListener("keyup", (e) => {
    keys.delete(e.key.toLowerCase());
  });

  document.querySelectorAll("[data-dir]").forEach((btn) => {
    const dir = btn.dataset.dir;
    const start = (e) => {
      e.preventDefault();
      touchDirs.add(dir);
    };
    const end = (e) => {
      e.preventDefault();
      touchDirs.delete(dir);
    };
    btn.addEventListener("mousedown", start);
    btn.addEventListener("touchstart", start, { passive: false });
    btn.addEventListener("mouseup", end);
    btn.addEventListener("mouseleave", end);
    btn.addEventListener("touchend", end);
    btn.addEventListener("touchcancel", end);
  });

  function updateSimulation(dt, now) {
    const me = selfId ? players.get(selfId) : null;
    if (me) {
      let dx = 0;
      let dy = 0;
      if (keys.has("w") || keys.has("arrowup") || touchDirs.has("up")) dy -= 1;
      if (keys.has("s") || keys.has("arrowdown") || touchDirs.has("down")) dy += 1;
      if (keys.has("a") || keys.has("arrowleft") || touchDirs.has("left")) dx -= 1;
      if (keys.has("d") || keys.has("arrowright") || touchDirs.has("right")) dx += 1;

      const isDashing = now < dashUntil;
      const isTurbo = now < turboUntil;
      turboBadge.classList.toggle("hidden", !isTurbo);

      const cdRemain = Math.max(0, dashCooldownUntil - now);
      dashFill.style.width = `${Math.round((1 - cdRemain / DASH_COOLDOWN_MS) * 100)}%`;

      if (dx !== 0 || dy !== 0) {
        const len = Math.hypot(dx, dy);
        dx /= len;
        dy /= len;
        const speed = (isDashing ? DASH_SPEED : BASE_SPEED) * (isTurbo ? TURBO_MULT : 1);
        me.x = Math.max(22, Math.min(ARENA_W - 22, me.x + dx * speed * dt));
        me.y = Math.max(22, Math.min(ARENA_H - 22, me.y + dy * speed * dt));
        me.dir = Math.atan2(dy, dx);
        me.boosting = isDashing || isTurbo;
      } else {
        me.boosting = false;
      }

      const movedEnough =
        Math.hypot(me.x - lastSentPos.x, me.y - lastSentPos.y) > 2 ||
        me.boosting !== lastSentPos.boosting;

      if (movedEnough && now - lastMoveSentAt >= MOVE_SEND_INTERVAL_MS && ws?.readyState === WebSocket.OPEN) {
        lastMoveSentAt = now;
        lastSentPos = { x: me.x, y: me.y, boosting: me.boosting };
        ws.send(
          JSON.stringify({
            action: "move",
            x: Math.round(me.x),
            y: Math.round(me.y),
            dir: Number(me.dir.toFixed(2)),
            boosting: me.boosting,
          })
        );
      }

      // Coin collision check
      for (const coin of coins.values()) {
        const pendingAt = pendingCollects.get(coin.id) || 0;
        if (now - pendingAt < 1400) continue;
        if (Math.hypot(me.x - coin.x, me.y - coin.y) <= PICKUP_RADIUS) {
          pendingCollects.set(coin.id, now);
          sendWs({
            action: "collect",
            coinId: coin.id,
            x: Math.round(me.x),
            y: Math.round(me.y),
          });
        }
      }
    }

    // Smooth remote player interpolation
    const alpha = Math.min(1, dt * 14);
    for (const p of players.values()) {
      if (p.id !== selfId) {
        p.x += (p.tx - p.x) * alpha;
        p.y += (p.ty - p.y) * alpha;
      }
    }

    // Particles & popups
    for (let i = particles.length - 1; i >= 0; i--) {
      const pt = particles[i];
      pt.x += pt.vx * dt;
      pt.y += pt.vy * dt;
      pt.life -= dt;
      if (pt.life <= 0) particles.splice(i, 1);
    }
    for (let i = popups.length - 1; i >= 0; i--) {
      const pp = popups[i];
      pp.y -= 34 * dt;
      pp.life -= dt;
      if (pp.life <= 0) popups.splice(i, 1);
    }
  }

  function drawStar(x, y, spikes, outerR, innerR) {
    let rot = (Math.PI / 2) * 3;
    const step = Math.PI / spikes;
    ctx.beginPath();
    ctx.moveTo(x, y - outerR);
    for (let i = 0; i < spikes; i++) {
      ctx.lineTo(x + Math.cos(rot) * outerR, y + Math.sin(rot) * outerR);
      rot += step;
      ctx.lineTo(x + Math.cos(rot) * innerR, y + Math.sin(rot) * innerR);
      rot += step;
    }
    ctx.closePath();
  }

  function renderArena(now) {
    ctx.clearRect(0, 0, ARENA_W, ARENA_H);

    // Subtle cyber grid
    ctx.strokeStyle = "rgba(56, 189, 248, 0.08)";
    ctx.lineWidth = 1;
    for (let gx = 0; gx <= ARENA_W; gx += 48) {
      ctx.beginPath();
      ctx.moveTo(gx, 0);
      ctx.lineTo(gx, ARENA_H);
      ctx.stroke();
    }
    for (let gy = 0; gy <= ARENA_H; gy += 48) {
      ctx.beginPath();
      ctx.moveTo(0, gy);
      ctx.lineTo(ARENA_W, gy);
      ctx.stroke();
    }

    // Draw Coins
    const pulse = Math.sin(now * 0.005) * 2.2;
    for (const coin of coins.values()) {
      const style = COIN_STYLE[coin.kind] || COIN_STYLE.gold;
      ctx.save();
      ctx.shadowColor = style.glow;
      ctx.shadowBlur = 16;
      ctx.fillStyle = style.color;

      if (coin.kind === "star") {
        ctx.translate(coin.x, coin.y);
        ctx.rotate(now * 0.0018);
        drawStar(0, 0, 5, style.r + pulse * 0.5, style.r * 0.5);
        ctx.fill();
      } else if (coin.kind === "gem") {
        ctx.translate(coin.x, coin.y);
        ctx.rotate(Math.PI / 4 + Math.sin(now * 0.003) * 0.15);
        const s = style.r + pulse * 0.4;
        ctx.fillRect(-s * 0.75, -s * 0.75, s * 1.5, s * 1.5);
      } else {
        ctx.beginPath();
        ctx.arc(coin.x, coin.y, style.r + pulse * 0.35, 0, Math.PI * 2);
        ctx.fill();
        if (coin.kind === "boost") {
          ctx.fillStyle = "#06141d";
          ctx.font = "bold 12px sans-serif";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText("⚡", coin.x, coin.y + 1);
        }
      }
      ctx.restore();
    }

    // Draw Particles
    for (const pt of particles) {
      ctx.save();
      ctx.globalAlpha = Math.max(0, pt.life / pt.maxLife);
      ctx.fillStyle = pt.color;
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, 3.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // Draw Players
    for (const p of players.values()) {
      const isSelf = p.id === selfId;
      ctx.save();

      if (p.boosting) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, PLAYER_RADIUS + 7, 0, Math.PI * 2);
        ctx.strokeStyle = "rgba(34, 211, 238, 0.7)";
        ctx.lineWidth = 3;
        ctx.stroke();
      }

      ctx.shadowColor = p.color;
      ctx.shadowBlur = isSelf ? 20 : 12;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, PLAYER_RADIUS, 0, Math.PI * 2);
      ctx.fill();

      ctx.lineWidth = isSelf ? 3 : 2;
      ctx.strokeStyle = isSelf ? "#ffffff" : "rgba(255,255,255,0.5)";
      ctx.stroke();

      // Direction visor
      const vx = p.x + Math.cos(p.dir || 0) * (PLAYER_RADIUS - 3);
      const vy = p.y + Math.sin(p.dir || 0) * (PLAYER_RADIUS - 3);
      ctx.fillStyle = "#0b1020";
      ctx.beginPath();
      ctx.arc(vx, vy, 4.5, 0, Math.PI * 2);
      ctx.fill();

      // Nickname + Score label
      ctx.shadowBlur = 0;
      ctx.font = isSelf ? "700 13px Inter, sans-serif" : "600 12px Inter, sans-serif";
      ctx.textAlign = "center";
      ctx.fillStyle = "#f8fafc";
      ctx.fillText(`${p.name} · ${p.score}`, p.x, p.y - PLAYER_RADIUS - 9);

      ctx.restore();
    }

    // Draw Popups
    for (const pp of popups) {
      ctx.save();
      ctx.globalAlpha = Math.max(0, pp.life);
      ctx.font = "800 15px Inter, sans-serif";
      ctx.textAlign = "center";
      ctx.fillStyle = pp.color;
      ctx.fillText(pp.text, pp.x, pp.y);
      ctx.restore();
    }
  }

  function loop(now) {
    const dt = Math.min(0.05, (now - lastFrameTime) / 1000);
    lastFrameTime = now;
    updateSimulation(dt, now);
    renderArena(now);
    requestAnimationFrame(loop);
  }

  requestAnimationFrame(loop);
})();
