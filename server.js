const fs = require("fs");
const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const ROOT_DIR = __dirname;
const PORT = Number(process.env.PORT || 5000);

function loadJsonFile(filename) {
  return JSON.parse(fs.readFileSync(path.join(ROOT_DIR, filename), "utf8"));
}

function roundCurrency(value) {
  return Number(Number(value).toFixed(2));
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function fisherYatesShuffle(items) {
  const shuffled = [...items];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }
  return shuffled;
}

function createTimestampParts(date = new Date()) {
  const time = new Intl.DateTimeFormat("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZone: "Asia/Calcutta"
  }).format(date);

  return {
    iso: date.toISOString(),
    time
  };
}

function validateSourceData(players, teams, config) {
  if (!Array.isArray(players) || players.length === 0) {
    throw new Error("players.json must contain at least one player.");
  }

  if (!Array.isArray(teams) || teams.length === 0) {
    throw new Error("teams.json must contain at least one team.");
  }

  const uniqueTeams = new Set();
  teams.forEach((team) => {
    if (!team.name || typeof team.name !== "string") {
      throw new Error("Every team must have a unique name.");
    }
    if (uniqueTeams.has(team.name)) {
      throw new Error(`Duplicate team name found: ${team.name}`);
    }
    uniqueTeams.add(team.name);
  });

  players.forEach((player, index) => {
    if (!player.name || typeof player.name !== "string") {
      throw new Error(`Player at index ${index} is missing a valid name.`);
    }
  });

  ["BASE_PRICE_ROUND1", "BASE_PRICE_ROUND2", "BID_INCREMENT", "BID_TIMER_SECONDS"].forEach((key) => {
    const value = Number(config[key]);
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`config.json is missing a positive numeric value for ${key}.`);
    }
  });
}

const sourcePlayers = loadJsonFile("players.json");
const sourceTeams = loadJsonFile("teams.json");
const config = loadJsonFile("config.json");

validateSourceData(sourcePlayers, sourceTeams, config);

function createPlayersForRound(players, round) {
  return fisherYatesShuffle(players).map((player, index) => ({
    id: `${round}-${index + 1}-${player.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
    sourceId: player.sourceId,
    name: player.name,
    role: player.role || "Unspecified",
    country: player.country || "Unknown",
    basePriceOverride: Number.isFinite(Number(player.basePrice)) ? roundCurrency(player.basePrice) : null,
    roundEntered: round,
    status: "pending",
    soldTo: null,
    soldPrice: null
  }));
}

function createSourcePlayerState() {
  return sourcePlayers.map((player, index) => ({
    sourceId: index + 1,
    name: player.name,
    role: player.role || "Unspecified",
    country: player.country || "Unknown",
    basePrice: Number.isFinite(Number(player.basePrice)) ? roundCurrency(player.basePrice) : null
  }));
}

function createTeamState() {
  return sourceTeams.map((team, index) => {
    const initialBalance = Number.isFinite(Number(team.initialBalance))
      ? roundCurrency(team.initialBalance)
      : roundCurrency(team.balance);

    return {
      id: index + 1,
      name: team.name,
      balance: roundCurrency(Number(team.balance)),
      initialBalance,
      acquiredPlayers: []
    };
  });
}

function createInitialAuctionState() {
  return {
    status: "waiting",
    round: 1,
    playersByRound: {
      1: [],
      2: []
    },
    currentPlayerIndex: -1,
    currentBid: null,
    openingBid: null,
    lastBidder: null,
    currentPlayerClosed: false,
    currentPlayerBids: [],
    unsoldFromRoundOne: [],
    teams: createTeamState(),
    replayLog: [],
    completedPlayers: [],
    timerRemaining: Number(config.BID_TIMER_SECONDS),
    timerEndsAt: null,
    startedAt: null,
    endedAt: null,
    pauseReason: null
  };
}

let auctionState = createInitialAuctionState();
let timerInterval = null;
let autoAdvanceTimeout = null;
const connectedClients = new Map();

function getRoundBasePrice(round = auctionState.round) {
  return round === 1 ? roundCurrency(config.BASE_PRICE_ROUND1) : roundCurrency(config.BASE_PRICE_ROUND2);
}

function getCurrentRoundPlayers() {
  return auctionState.playersByRound[String(auctionState.round)] || [];
}

function getCurrentPlayer() {
  const currentPlayers = getCurrentRoundPlayers();
  return currentPlayers[auctionState.currentPlayerIndex] || null;
}

function getOpeningBidForPlayer(player, round = auctionState.round) {
  if (!player) {
    return null;
  }

  if (round === 1 && Number.isFinite(player.basePriceOverride)) {
    return roundCurrency(player.basePriceOverride);
  }

  return roundCurrency(getRoundBasePrice(round));
}

function listAssignedTeamNames() {
  return new Set(
    Array.from(connectedClients.values())
      .filter((client) => client.teamName && !client.spectator)
      .map((client) => client.teamName)
  );
}

function findTeam(teamName) {
  return auctionState.teams.find((team) => team.name === teamName) || null;
}

function appendReplayLog(message, type, extra = {}) {
  const timestamp = createTimestampParts();
  auctionState.replayLog.push({
    id: auctionState.replayLog.length + 1,
    type,
    message,
    timestamp: timestamp.iso,
    displayTime: timestamp.time,
    ...extra
  });
}

function clearPendingTimers() {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }

  if (autoAdvanceTimeout) {
    clearTimeout(autoAdvanceTimeout);
    autoAdvanceTimeout = null;
  }
}

function emitTimerUpdate() {
  const payload = { secondsRemaining: auctionState.timerRemaining };
  io.emit("timer-update", payload);
}

function stopBidTimer() {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
  auctionState.timerEndsAt = null;
}

function startBidTimer() {
  stopBidTimer();

  if (auctionState.status !== "running" || !getCurrentPlayer() || auctionState.currentPlayerClosed) {
    return;
  }

  auctionState.timerRemaining = Number(config.BID_TIMER_SECONDS);
  auctionState.timerEndsAt = Date.now() + auctionState.timerRemaining * 1000;
  emitTimerUpdate();

  timerInterval = setInterval(() => {
    const secondsRemaining = Math.max(0, Math.ceil((auctionState.timerEndsAt - Date.now()) / 1000));
    auctionState.timerRemaining = secondsRemaining;
    emitTimerUpdate();

    if (secondsRemaining <= 0) {
      stopBidTimer();
      handleTimerExpiry();
    }
  }, 1000);
}

function resetCurrentBidState() {
  const currentPlayer = getCurrentPlayer();
  auctionState.currentBid = null;
  auctionState.openingBid = getOpeningBidForPlayer(currentPlayer);
  auctionState.lastBidder = null;
  auctionState.currentPlayerClosed = false;
  auctionState.currentPlayerBids = [];
  auctionState.timerRemaining = Number(config.BID_TIMER_SECONDS);
}

function buildResultsPayload() {
  return {
    auctionDate: new Date().toISOString(),
    teams: auctionState.teams.map((team) => ({
      name: team.name,
      initialBalance: team.initialBalance,
      finalBalance: team.balance,
      playersAcquired: team.acquiredPlayers.map((player) => ({
        name: player.name,
        role: player.role,
        country: player.country,
        price: player.price
      }))
    })),
    replayLog: auctionState.replayLog.map((entry) => ({
      time: entry.displayTime,
      type: entry.type,
      message: entry.message
    }))
  };
}

function getProgressSummary() {
  const currentRoundPlayers = getCurrentRoundPlayers();
  return {
    round: auctionState.round,
    current: currentRoundPlayers.length === 0 ? 0 : Math.min(auctionState.currentPlayerIndex + 1, currentRoundPlayers.length),
    total: currentRoundPlayers.length,
    completed: auctionState.completedPlayers.length
  };
}

function buildPublicState() {
  const currentPlayer = getCurrentPlayer();
  const assignedTeams = listAssignedTeamNames();
  const nextBidAmount = currentPlayer
    ? roundCurrency((auctionState.currentBid ?? auctionState.openingBid ?? 0) + (auctionState.currentBid === null ? 0 : Number(config.BID_INCREMENT)))
    : null;

  return {
    status: auctionState.status,
    round: auctionState.round,
    currentPlayer,
    currentPlayerIndex: auctionState.currentPlayerIndex,
    currentBid: auctionState.currentBid,
    openingBid: auctionState.openingBid,
    lastBidder: auctionState.lastBidder,
    currentPlayerClosed: auctionState.currentPlayerClosed,
    currentPlayerBids: deepClone(auctionState.currentPlayerBids),
    unsoldCount: auctionState.unsoldFromRoundOne.length,
    teams: auctionState.teams.map((team) => ({
      ...team,
      playersCount: team.acquiredPlayers.length,
      spentPercentage: team.initialBalance <= 0
        ? 0
        : roundCurrency(((team.initialBalance - team.balance) / team.initialBalance) * 100)
    })),
    replayLog: deepClone(auctionState.replayLog),
    progress: getProgressSummary(),
    timerRemaining: auctionState.timerRemaining,
    connectedParticipants: Array.from(connectedClients.values()).map((client) => ({
      socketId: client.socketId,
      role: client.role,
      teamName: client.teamName,
      spectator: client.spectator
    })),
    connectedParticipantCount: Array.from(connectedClients.values()).filter((client) => client.role === "participant" && !client.spectator).length,
    availableTeams: auctionState.teams
      .filter((team) => !assignedTeams.has(team.name))
      .map((team) => team.name),
    nextBidAmount,
    config,
    results: auctionState.status === "ended" ? buildResultsPayload() : null
  };
}

function broadcastState(eventName, payload) {
  if (eventName) {
    io.emit(eventName, payload);
  }
  io.emit("auction-state-update", buildPublicState());
}

function emitError(socket, message) {
  socket.emit("error-message", { message });
}

function requireAdmin(socket) {
  const client = connectedClients.get(socket.id);
  if (!client || client.role !== "admin") {
    emitError(socket, "Admin privileges are required for this action.");
    return null;
  }
  return client;
}

function canAcceptBids() {
  return auctionState.status === "running" && !!getCurrentPlayer() && !auctionState.currentPlayerClosed;
}

function finalizeAuction() {
  stopBidTimer();
  auctionState.status = "ended";
  auctionState.currentBid = null;
  auctionState.openingBid = null;
  auctionState.lastBidder = null;
  auctionState.currentPlayerClosed = true;
  auctionState.timerRemaining = 0;
  auctionState.endedAt = new Date().toISOString();
  appendReplayLog("Auction completed", "auction-ended");
  broadcastState("auction-ended", { results: buildResultsPayload() });
}

function enterRound(round, sourcePlayersForRound) {
  auctionState.round = round;
  auctionState.playersByRound[String(round)] = createPlayersForRound(sourcePlayersForRound, round);
  auctionState.currentPlayerIndex = 0;
  resetCurrentBidState();
}

function moveToNextPlayer() {
  const currentRoundPlayers = getCurrentRoundPlayers();
  auctionState.currentPlayerIndex += 1;

  if (auctionState.currentPlayerIndex < currentRoundPlayers.length) {
    auctionState.status = "running";
    auctionState.pauseReason = null;
    resetCurrentBidState();
    startBidTimer();
    broadcastState("next-player", { currentPlayer: getCurrentPlayer(), round: auctionState.round });
    return;
  }

  if (auctionState.round === 1 && auctionState.unsoldFromRoundOne.length > 0) {
    enterRound(2, auctionState.unsoldFromRoundOne);
    auctionState.unsoldFromRoundOne = [];
    auctionState.status = "running";
    auctionState.pauseReason = null;
    appendReplayLog("Round 2 started", "round-changed", { round: 2 });
    startBidTimer();
    broadcastState("round-changed", { round: 2, currentPlayer: getCurrentPlayer() });
    return;
  }

  finalizeAuction();
}

function startFreshAuction() {
  clearPendingTimers();
  auctionState = createInitialAuctionState();
  const players = createSourcePlayerState();
  auctionState.playersByRound["1"] = createPlayersForRound(players, 1);
  auctionState.currentPlayerIndex = 0;
  auctionState.status = "running";
  auctionState.startedAt = new Date().toISOString();
  resetCurrentBidState();
  appendReplayLog("Auction started", "auction-started");
  startBidTimer();
}

function markCurrentPlayerUnsold(reason = "manual-unsold") {
  const currentPlayer = getCurrentPlayer();
  if (!currentPlayer || auctionState.currentPlayerClosed) {
    return { success: false, message: "No active player is available to mark as unsold." };
  }

  stopBidTimer();
  currentPlayer.status = "unsold";
  currentPlayer.soldTo = null;
  currentPlayer.soldPrice = null;
  auctionState.currentPlayerClosed = true;
  auctionState.status = "paused";
  auctionState.pauseReason = "player-closed";
  auctionState.completedPlayers.push({
    name: currentPlayer.name,
    status: "unsold",
    round: auctionState.round
  });

  if (auctionState.round === 1) {
    auctionState.unsoldFromRoundOne.push({
      sourceId: currentPlayer.sourceId,
      name: currentPlayer.name,
      role: currentPlayer.role,
      country: currentPlayer.country,
      basePrice: currentPlayer.basePriceOverride
    });
  }

  appendReplayLog(
    `${currentPlayer.name} marked unsold in Round ${auctionState.round}`,
    reason === "timer-expired" ? "timer-expired" : "player-unsold",
    { playerName: currentPlayer.name, round: auctionState.round }
  );

  broadcastState("player-marked-unsold", {
    playerName: currentPlayer.name,
    round: auctionState.round
  });

  return { success: true, player: currentPlayer };
}

function markCurrentPlayerSold() {
  const currentPlayer = getCurrentPlayer();
  if (!currentPlayer || auctionState.currentPlayerClosed) {
    return { success: false, message: "No active player is available to mark as sold." };
  }

  if (!auctionState.lastBidder || auctionState.currentBid === null) {
    return { success: false, message: "At least one bid is required before marking a player sold." };
  }

  const winningTeam = findTeam(auctionState.lastBidder);
  if (!winningTeam) {
    return { success: false, message: "Winning team could not be found." };
  }

  if (winningTeam.balance < auctionState.currentBid) {
    return { success: false, message: "Winning team no longer has enough balance." };
  }

  stopBidTimer();
  winningTeam.balance = roundCurrency(winningTeam.balance - auctionState.currentBid);

  const acquiredPlayer = {
    id: currentPlayer.sourceId,
    name: currentPlayer.name,
    role: currentPlayer.role,
    country: currentPlayer.country,
    price: auctionState.currentBid,
    round: auctionState.round
  };

  winningTeam.acquiredPlayers.push(acquiredPlayer);
  currentPlayer.status = "sold";
  currentPlayer.soldTo = winningTeam.name;
  currentPlayer.soldPrice = auctionState.currentBid;
  auctionState.currentPlayerClosed = true;
  auctionState.status = "paused";
  auctionState.pauseReason = "player-closed";
  auctionState.completedPlayers.push({
    name: currentPlayer.name,
    status: "sold",
    round: auctionState.round,
    teamName: winningTeam.name,
    price: auctionState.currentBid
  });

  appendReplayLog(
    `${winningTeam.name} bought ${currentPlayer.name} for Rs ${auctionState.currentBid} Cr`,
    "player-sold",
    { playerName: currentPlayer.name, teamName: winningTeam.name, amount: auctionState.currentBid }
  );

  broadcastState("player-marked-sold", {
    winningTeam: winningTeam.name,
    finalPrice: auctionState.currentBid,
    player: currentPlayer.name
  });

  return { success: true, player: currentPlayer, team: winningTeam };
}

function handleTimerExpiry() {
  const currentPlayer = getCurrentPlayer();
  if (!currentPlayer || auctionState.currentPlayerClosed) {
    return;
  }

  const result = markCurrentPlayerUnsold("timer-expired");
  if (!result.success) {
    return;
  }

  broadcastState("timer-expired", {
    playerName: currentPlayer.name,
    round: auctionState.round
  });

  autoAdvanceTimeout = setTimeout(() => {
    autoAdvanceTimeout = null;
    moveToNextPlayer();
  }, 800);
}

function validateBidRequest({ socket, teamName, amount, allowJumpBids = false, skipClientOwnership = false }) {
  if (!canAcceptBids()) {
    return { ok: false, message: "Auction is not accepting bids right now." };
  }

  if (!skipClientOwnership) {
    const client = connectedClients.get(socket.id);
    if (!client || client.role !== "participant" || client.spectator) {
      return { ok: false, message: "Only active participants can place bids." };
    }

    if (client.teamName !== teamName) {
      return { ok: false, message: "You can only bid for your assigned team." };
    }
  }

  const team = findTeam(teamName);
  const currentPlayer = getCurrentPlayer();
  if (!team || !currentPlayer) {
    return { ok: false, message: "Unable to resolve the active team or player." };
  }

  if (auctionState.lastBidder === teamName) {
    return { ok: false, message: "The same team cannot bid twice in a row." };
  }

  const bidIncrement = roundCurrency(config.BID_INCREMENT);
  const minimumNextBid = auctionState.currentBid === null
    ? roundCurrency(auctionState.openingBid)
    : roundCurrency(auctionState.currentBid + bidIncrement);
  const requestedAmount = roundCurrency(amount);

  if (!Number.isFinite(requestedAmount)) {
    return { ok: false, message: "Bid amount must be numeric." };
  }

  if (requestedAmount < minimumNextBid) {
    return { ok: false, message: `Minimum valid bid is Rs ${minimumNextBid} Cr.` };
  }

  if (!allowJumpBids && requestedAmount !== minimumNextBid) {
    return { ok: false, message: `Bid must be exactly Rs ${minimumNextBid} Cr.` };
  }

  if (allowJumpBids) {
    const delta = roundCurrency(requestedAmount - minimumNextBid);
    const multiples = roundCurrency(delta / bidIncrement);
    if (delta < 0 || Math.abs(multiples - Math.round(multiples)) > 0.0001) {
      return { ok: false, message: `Override bids must follow Rs ${bidIncrement} Cr increments.` };
    }
  }

  if (team.balance < requestedAmount) {
    return { ok: false, message: "Team balance is insufficient for this bid." };
  }

  return {
    ok: true,
    team,
    currentPlayer,
    requestedAmount
  };
}

function applyBid(teamName, amount, origin = "participant") {
  const currentPlayer = getCurrentPlayer();
  auctionState.currentBid = amount;
  auctionState.lastBidder = teamName;
  auctionState.currentPlayerBids.push({
    teamName,
    amount,
    playerName: currentPlayer.name,
    timestamp: new Date().toISOString()
  });
  appendReplayLog(
    `${teamName} bid Rs ${amount} Cr on ${currentPlayer.name}`,
    origin === "admin-override" ? "admin-bid-override" : "bid",
    { teamName, amount, playerName: currentPlayer.name }
  );
  startBidTimer();
  broadcastState("bid-placed", {
    teamName,
    amount,
    playerName: currentPlayer.name,
    origin
  });
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*"
  }
});

app.use(express.json());
app.use((req, res, next) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  next();
});

["/", "/index.html", "/admin.html", "/dashboard.html", "/style.css", "/app.js", "/admin.js", "/dashboard.js"].forEach((route) => {
  const filename = route === "/" ? "index.html" : route.slice(1);
  app.get(route, (req, res) => {
    res.sendFile(path.join(ROOT_DIR, filename));
  });
});

app.get("/players.json", (req, res) => res.json(sourcePlayers));
app.get("/teams.json", (req, res) => res.json(sourceTeams));
app.get("/config.json", (req, res) => res.json(config));
app.get("/health", (req, res) => res.json({ ok: true, status: auctionState.status }));

io.on("connection", (socket) => {
  socket.emit("auction-state-update", buildPublicState());

  socket.on("join-auction", (payload = {}) => {
    const role = payload.role === "admin" ? "admin" : "participant";
    const spectator = Boolean(payload.spectator);
    const requestedTeam = payload.teamName ? String(payload.teamName) : null;

    if (!spectator && role === "participant") {
      const team = findTeam(requestedTeam);
      if (!team) {
        emitError(socket, "Selected team does not exist.");
        return;
      }

      const assignedTeams = listAssignedTeamNames();
      if (assignedTeams.has(requestedTeam)) {
        emitError(socket, "That team is already assigned to another participant.");
        return;
      }
    }

    const clientInfo = {
      socketId: socket.id,
      role,
      teamName: spectator ? null : requestedTeam,
      spectator
    };

    connectedClients.set(socket.id, clientInfo);
    broadcastState("participant-joined", clientInfo);
  });

  socket.on("place-bid", (payload = {}) => {
    const validation = validateBidRequest({
      socket,
      teamName: payload.teamName,
      amount: payload.amount
    });

    if (!validation.ok) {
      emitError(socket, validation.message);
      return;
    }

    applyBid(validation.team.name, validation.requestedAmount);
  });

  socket.on("admin-start-auction", () => {
    if (!requireAdmin(socket)) {
      return;
    }

    if (auctionState.status === "waiting" || auctionState.status === "ended") {
      startFreshAuction();
      broadcastState("auction-started", { currentPlayer: getCurrentPlayer(), round: auctionState.round });
      return;
    }

    if (auctionState.status === "paused") {
      auctionState.status = "running";
      auctionState.pauseReason = null;
      startBidTimer();
      broadcastState("auction-started", { currentPlayer: getCurrentPlayer(), round: auctionState.round, resumed: true });
      return;
    }

    emitError(socket, "Auction is already running.");
  });

  socket.on("admin-pause-auction", () => {
    if (!requireAdmin(socket)) {
      return;
    }

    if (auctionState.status !== "running") {
      emitError(socket, "Auction is not currently running.");
      return;
    }

    stopBidTimer();
    auctionState.status = "paused";
    auctionState.pauseReason = "manual-pause";
    appendReplayLog("Auction paused by admin", "auction-paused");
    broadcastState();
  });

  socket.on("admin-mark-sold", () => {
    if (!requireAdmin(socket)) {
      return;
    }

    const result = markCurrentPlayerSold();
    if (!result.success) {
      emitError(socket, result.message);
    }
  });

  socket.on("admin-mark-unsold", () => {
    if (!requireAdmin(socket)) {
      return;
    }

    const result = markCurrentPlayerUnsold();
    if (!result.success) {
      emitError(socket, result.message);
    }
  });

  socket.on("admin-next-player", () => {
    if (!requireAdmin(socket)) {
      return;
    }

    if (auctionState.status === "ended") {
      emitError(socket, "Auction has already ended.");
      return;
    }

    if (!auctionState.currentPlayerClosed) {
      emitError(socket, "Mark the current player sold or unsold before moving on.");
      return;
    }

    moveToNextPlayer();
  });

  socket.on("admin-reset-auction", () => {
    if (!requireAdmin(socket)) {
      return;
    }

    clearPendingTimers();
    auctionState = createInitialAuctionState();
    appendReplayLog("Auction reset by admin", "auction-reset");
    broadcastState();
  });

  socket.on("admin-bid-override", (payload = {}) => {
    if (!requireAdmin(socket)) {
      return;
    }

    const validation = validateBidRequest({
      socket,
      teamName: payload.teamName,
      amount: payload.amount,
      allowJumpBids: true,
      skipClientOwnership: true
    });

    if (!validation.ok) {
      emitError(socket, validation.message);
      return;
    }

    applyBid(validation.team.name, validation.requestedAmount, "admin-override");
  });

  socket.on("disconnect", () => {
    const clientInfo = connectedClients.get(socket.id);
    connectedClients.delete(socket.id);
    if (clientInfo) {
      broadcastState("participant-left", { socketId: socket.id, teamName: clientInfo.teamName });
    } else {
      io.emit("auction-state-update", buildPublicState());
    }
  });
});

process.on("SIGINT", () => {
  clearPendingTimers();
  process.exit(0);
});

server.listen(PORT, () => {
  console.log(`IPL auction app running at http://localhost:${PORT}`);
});
