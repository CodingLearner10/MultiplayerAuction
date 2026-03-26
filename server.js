const fs = require("fs");
const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const ROOT_DIR = __dirname;
const PORT = Number(process.env.PORT || 5000);
const SEGMENT_SIZE = 15;
const RTM_WINDOW_SECONDS = 15;
const AI_PRIMARY_ROLE_TARGETS = {
  wicketkeeper: 2,
  batsman: 5,
  allrounder: 4,
  fastbowler: 4,
  spinner: 2
};
const AI_UNCAPPED_TARGET = 6;
const AI_SQUAD_MIN = 18;
const AI_SQUAD_MAX = 25;
const AI_MIN_BALANCE_RESERVE = 12;
const AI_OPTIONAL_BID_CHANCE = 0.18;

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

function buildSetSequence(players) {
  const seen = new Set();
  const sequence = [];

  players.forEach((player) => {
    const setCode = player.setCode || "GEN";
    if (seen.has(setCode)) {
      return;
    }

    seen.add(setCode);
    sequence.push({
      setCode,
      setLabel: player.setLabel || "General"
    });
  });

  return sequence;
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

function createSeededValue(input, min, max) {
  let hash = 0;
  const text = String(input || "");
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) % 1000003;
  }
  return min + (hash % (max - min + 1));
}

function createPlayerRatings(player) {
  const role = String(player.role || "").toLowerCase();
  const setLabel = String(player.setLabel || "").toLowerCase();
  const cappedBoost = player.capped ? 1 : 0;
  const overseasBoost = player.isOverseas ? 1 : 0;
  let batting = createSeededValue(`${player.name}:bat`, 3, 6) + cappedBoost;
  let bowling = createSeededValue(`${player.name}:bowl`, 3, 6) + cappedBoost;
  let fielding = createSeededValue(`${player.name}:field`, 4, 7) + cappedBoost + overseasBoost;

  if (role.includes("batsman") || setLabel.includes("batter")) {
    batting += 3;
    bowling -= 1;
  } else if (role.includes("bowler") || setLabel.includes("bowler") || setLabel.includes("spinner")) {
    bowling += 3;
    batting -= 1;
  } else if (role.includes("all-rounder") || setLabel.includes("all-rounder")) {
    batting += 2;
    bowling += 2;
  } else if (role.includes("wicket")) {
    batting += 2;
    fielding += 2;
    bowling -= 2;
  }

  if (setLabel.includes("uncapped")) {
    batting -= 1;
    bowling -= 1;
    fielding -= 1;
  }
  if (setLabel.includes("marquee")) {
    batting += 1;
    bowling += 1;
    fielding += 1;
  }

  return {
    batting: Math.max(1, Math.min(10, batting)),
    fielding: Math.max(1, Math.min(10, fielding)),
    bowling: Math.max(1, Math.min(10, bowling))
  };
}

const sourcePlayers = loadJsonFile("players.json");
const sourceTeams = loadJsonFile("teams.json");
const config = loadJsonFile("config.json");
const SOURCE_SET_SEQUENCE = buildSetSequence(sourcePlayers);

validateSourceData(sourcePlayers, sourceTeams, config);

function createPlayersForRound(players, round) {
  const groupedPlayers = players.reduce((groups, player) => {
    const setCode = player.setCode || "GEN";
    if (!groups.has(setCode)) {
      groups.set(setCode, []);
    }
    groups.get(setCode).push(player);
    return groups;
  }, new Map());

  const orderedSetCodes = [
    ...SOURCE_SET_SEQUENCE.filter((entry) => groupedPlayers.has(entry.setCode)).map((entry) => entry.setCode),
    ...Array.from(groupedPlayers.keys()).filter((setCode) => !SOURCE_SET_SEQUENCE.some((entry) => entry.setCode === setCode))
  ];

  const orderedPlayers = orderedSetCodes.flatMap((setCode) => fisherYatesShuffle(groupedPlayers.get(setCode)));

  return orderedPlayers.map((player, index) => ({
    id: `${round}-${index + 1}-${player.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
    sourceId: player.sourceId,
    name: player.name,
    role: player.role || "Unspecified",
    country: player.country || "Unknown",
    basePriceOverride: Number.isFinite(Number(player.basePrice)) ? roundCurrency(player.basePrice) : null,
    setCode: player.setCode || "GEN",
    setLabel: player.setLabel || "General",
    capped: Boolean(player.capped),
    isOverseas: Boolean(player.isOverseas),
    iplProfileId: player.iplProfileId || null,
    iplProfileUrl: player.iplProfileUrl || null,
    officialStats: deepClone(player.officialStats || null),
    ratings: player.ratings || createPlayerRatings(player),
    previousTeam: player.previousTeam || null,
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
    basePrice: Number.isFinite(Number(player.basePrice)) ? roundCurrency(player.basePrice) : null,
    setCode: player.setCode || "GEN",
    setLabel: player.setLabel || "General",
    capped: Boolean(player.capped),
    isOverseas: Boolean(player.isOverseas),
    iplProfileId: player.iplProfileId || null,
    iplProfileUrl: player.iplProfileUrl || null,
    officialStats: deepClone(player.officialStats || null),
    ratings: player.ratings || createPlayerRatings(player),
    previousTeam: player.previousTeam || null
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
      acquiredPlayers: [],
      rtmSlotsUsed: 0
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
    chatLog: [],
    retainedPlayers: [],
    completedPlayers: [],
    segmentBreak: null,
    pendingRTM: null,
    aiTeams: [],
    aiBidTargets: {},
    timerMode: null,
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
let aiActionTimeout = null;
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

function isAITeam(teamName) {
  return auctionState.aiTeams.includes(teamName);
}

function normalizeAIPlayerRole(player) {
  const label = String(player.setLabel || "").toLowerCase();
  const role = String(player.role || "").toLowerCase();

  if (label.includes("wicketkeeper") || role.includes("wicket")) {
    return "wicketkeeper";
  }
  if (label.includes("spinner")) {
    return "spinner";
  }
  if (label.includes("fast bowler")) {
    return "fastbowler";
  }
  if (label.includes("all-rounder") || role.includes("all-rounder")) {
    return "allrounder";
  }
  if (label.includes("batter") || role.includes("batsman")) {
    return "batsman";
  }
  if (role.includes("bowler")) {
    return "fastbowler";
  }
  return "batsman";
}

function getAISquadComposition(team) {
  const composition = {
    wicketkeeper: 0,
    batsman: 0,
    allrounder: 0,
    fastbowler: 0,
    spinner: 0,
    uncapped: 0,
    total: team.acquiredPlayers.length
  };

  team.acquiredPlayers.forEach((player) => {
    const key = normalizeAIPlayerRole(player);
    composition[key] = (composition[key] || 0) + 1;
    if (!player.capped) {
      composition.uncapped += 1;
    }
  });

  return composition;
}

function getAIRoleNeedScore(team, player) {
  const composition = getAISquadComposition(team);
  const roleKey = normalizeAIPlayerRole(player);
  const target = AI_PRIMARY_ROLE_TARGETS[roleKey] || 0;
  const remainingForRole = Math.max(0, target - (composition[roleKey] || 0));
  const uncappedNeed = !player.capped && remainingForRole > 0 ? Math.max(0, AI_UNCAPPED_TARGET - composition.uncapped) : 0;
  const minimumSquadNeed = Math.max(0, AI_SQUAD_MIN - composition.total);
  const hasPrimaryNeed = remainingForRole > 0;
  const isOptionalDepth = !hasPrimaryNeed && minimumSquadNeed > 0 && Math.random() < AI_OPTIONAL_BID_CHANCE;

  return {
    roleKey,
    target,
    composition,
    remainingForRole,
    uncappedNeed,
    minimumSquadNeed,
    hasPrimaryNeed,
    isOptionalDepth,
    hasNeed: hasPrimaryNeed || uncappedNeed > 0 || isOptionalDepth
  };
}

function getAIPlayerValueScore(player, roleKey) {
  const ratings = player.ratings || createPlayerRatings(player);
  if (roleKey === "wicketkeeper") {
    return (ratings.batting * 0.45) + (ratings.fielding * 0.45) + (ratings.bowling * 0.1);
  }
  if (roleKey === "batsman") {
    return (ratings.batting * 0.65) + (ratings.fielding * 0.2) + (ratings.bowling * 0.15);
  }
  if (roleKey === "allrounder") {
    return (ratings.batting * 0.42) + (ratings.bowling * 0.42) + (ratings.fielding * 0.16);
  }
  if (roleKey === "spinner" || roleKey === "fastbowler") {
    return (ratings.bowling * 0.65) + (ratings.fielding * 0.2) + (ratings.batting * 0.15);
  }
  return (ratings.batting + ratings.fielding + ratings.bowling) / 3;
}

function notifyTeamClients(teamName, eventName, payload) {
  connectedClients.forEach((client, socketId) => {
    if (client.teamName === teamName && !client.spectator) {
      io.to(socketId).emit(eventName, payload);
    }
  });
}

function clearScheduledAIAction() {
  if (aiActionTimeout) {
    clearTimeout(aiActionTimeout);
    aiActionTimeout = null;
  }
}

function findTeam(teamName) {
  return auctionState.teams.find((team) => team.name === teamName) || null;
}

function getTeamSquadMetrics(team) {
  const squadCount = team.acquiredPlayers.length;
  const overseasCount = team.acquiredPlayers.filter((player) => player.isOverseas).length;
  return {
    squadCount,
    overseasCount
  };
}

function canTeamAcquirePlayer(team, player) {
  const metrics = getTeamSquadMetrics(team);
  if (metrics.squadCount >= 25) {
    return {
      allowed: false,
      reason: `${team.name} already has the maximum squad size of 25 players.`
    };
  }

  if (player.isOverseas && metrics.overseasCount >= 8) {
    return {
      allowed: false,
      reason: `${team.name} already has the maximum of 8 overseas players.`
    };
  }

  return {
    allowed: true,
    ...metrics
  };
}

function assignAITeamsForCurrentAuction() {
  const humanTeams = listAssignedTeamNames();
  auctionState.aiTeams = auctionState.teams
    .filter((team) => !humanTeams.has(team.name))
    .map((team) => team.name);
}

function buildAITargetPrice(team, player) {
  const openingBid = getOpeningBidForPlayer(player);
  const bidIncrement = roundCurrency(config.BID_INCREMENT);
  const squadMetrics = getTeamSquadMetrics(team);
  const roleNeed = getAIRoleNeedScore(team, player);
  const playerValue = getAIPlayerValueScore(player, roleNeed.roleKey);
  const availableBudget = Math.max(0, team.balance - AI_MIN_BALANCE_RESERVE);

  if (!roleNeed.hasPrimaryNeed && !roleNeed.isOptionalDepth) {
    return null;
  }

  if (availableBudget < openingBid) {
    return null;
  }

  const squadRoomFactor = Math.max(0.55, (AI_SQUAD_MAX - squadMetrics.squadCount) / AI_SQUAD_MAX);
  const balanceFactor = Math.max(0.65, Math.min(1.35, availableBudget / 20));
  const roleUrgencyFactor = 1 + (roleNeed.remainingForRole * 0.35) + (roleNeed.isOptionalDepth ? 0.08 : 0);
  const uncappedFactor = !player.capped && roleNeed.uncappedNeed > 0 ? 1.12 : 1;
  const ratingFactor = Math.max(0.9, playerValue / 6.5);
  const marqueeFactor = player.setCode && /^M/i.test(player.setCode) ? 1.25 : 1;
  const cappedFactor = player.capped ? 1.08 : 0.96;
  const overseasFactor = player.isOverseas ? 0.92 : 1;
  const previousTeamFactor = player.previousTeam === team.name ? 1.12 : 1;
  const weaknessPenalty = roleNeed.hasPrimaryNeed ? 1 : playerValue < 5.5 ? 0.62 : 0.82;
  const randomness = roleNeed.hasPrimaryNeed ? 0.84 + (Math.random() * 0.42) : 0.58 + (Math.random() * 0.24);
  const rawTarget = openingBid * balanceFactor * squadRoomFactor * roleUrgencyFactor * uncappedFactor * ratingFactor * marqueeFactor * cappedFactor * overseasFactor * previousTeamFactor * weaknessPenalty * randomness;
  const cappedTarget = Math.min(availableBudget, Math.max(openingBid, rawTarget));
  const roundedTarget = roundCurrency(Math.floor(cappedTarget / bidIncrement) * bidIncrement || openingBid);
  return roundedTarget >= openingBid ? roundedTarget : null;
}

function getAITargetPrice(teamName, player) {
  if (!player) {
    return null;
  }

  const cacheKey = `${player.id}:${teamName}`;
  if (Object.prototype.hasOwnProperty.call(auctionState.aiBidTargets, cacheKey)) {
    return auctionState.aiBidTargets[cacheKey];
  }

  const team = findTeam(teamName);
  if (!team) {
    auctionState.aiBidTargets[cacheKey] = null;
    return null;
  }

  const roleNeed = getAIRoleNeedScore(team, player);
  const squadMetrics = getTeamSquadMetrics(team);
  const isPreviousTeamPlayer = player.previousTeam === teamName;
  const targetPrice = ((roleNeed.hasNeed && squadMetrics.squadCount < AI_SQUAD_MAX) || isPreviousTeamPlayer)
    ? buildAITargetPrice(team, player)
    : null;
  auctionState.aiBidTargets[cacheKey] = targetPrice;
  return targetPrice;
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

  clearScheduledAIAction();
}

function emitTimerUpdate() {
  const payload = {
    secondsRemaining: auctionState.timerRemaining,
    mode: auctionState.timerMode
  };
  io.emit("timer-update", payload);
}

function stopBidTimer() {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
  auctionState.timerEndsAt = null;
  auctionState.timerMode = null;
}

function buildSegmentBreakSummary() {
  const completedInRound = auctionState.completedPlayers.filter((player) => player.round === auctionState.round);
  if (completedInRound.length === 0 || completedInRound.length % SEGMENT_SIZE !== 0) {
    return null;
  }

  const currentRoundPlayers = getCurrentRoundPlayers();
  if (completedInRound.length >= currentRoundPlayers.length) {
    return null;
  }

  const segmentNumber = completedInRound.length / SEGMENT_SIZE;
  const segmentPlayers = completedInRound.slice(completedInRound.length - SEGMENT_SIZE);
  const soldPlayers = segmentPlayers.filter((player) => player.status === "sold");
  const topBuy = soldPlayers.reduce((best, player) => {
    if (!best || player.price > best.price) {
      return player;
    }
    return best;
  }, null);

  return {
    round: auctionState.round,
    segmentNumber,
    segmentSize: SEGMENT_SIZE,
    startNumber: completedInRound.length - SEGMENT_SIZE + 1,
    endNumber: completedInRound.length,
    soldCount: soldPlayers.length,
    unsoldCount: segmentPlayers.length - soldPlayers.length,
    topBuy,
    teams: auctionState.teams.map((team) => ({
      name: team.name,
      balance: team.balance,
      initialBalance: team.initialBalance,
      playersInSegment: team.acquiredPlayers.filter((player) => player.round === auctionState.round).slice(-SEGMENT_SIZE)
    }))
  };
}

function enterSegmentBreak(summary) {
  stopBidTimer();
  auctionState.status = "break";
  auctionState.pauseReason = "segment-break";
  auctionState.segmentBreak = summary;
  appendReplayLog(`Segment ${summary.segmentNumber} completed in Round ${summary.round}`, "segment-break", {
    round: summary.round,
    segmentNumber: summary.segmentNumber
  });
  broadcastState("segment-break-started", summary);
}

function extendBidTimer(seconds) {
  if (auctionState.status !== "running" || !getCurrentPlayer() || auctionState.currentPlayerClosed || !auctionState.timerEndsAt) {
    return { success: false, message: "There is no active timer to extend right now." };
  }

  const extension = Number(seconds);
  if (!Number.isFinite(extension) || extension <= 0) {
    return { success: false, message: "Timer extension must be a positive number of seconds." };
  }

  auctionState.timerEndsAt += extension * 1000;
  auctionState.timerRemaining = Math.max(0, Math.ceil((auctionState.timerEndsAt - Date.now()) / 1000));
  appendReplayLog(`Admin extended the timer by ${extension}s for ${getCurrentPlayer().name}`, "timer-extended", {
    seconds: extension,
    playerName: getCurrentPlayer().name
  });
  emitTimerUpdate();
  broadcastState("timer-extended", {
    seconds: extension,
    timerRemaining: auctionState.timerRemaining,
    playerName: getCurrentPlayer().name
  });
  return { success: true };
}

function startBidTimer() {
  stopBidTimer();

  if (auctionState.status !== "running" || !getCurrentPlayer() || auctionState.currentPlayerClosed) {
    return;
  }

  auctionState.timerMode = "bid";
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

function startRTMDecisionTimer() {
  stopBidTimer();

  if (auctionState.status !== "rtm" || !auctionState.pendingRTM) {
    return;
  }

  auctionState.timerMode = "rtm";
  auctionState.timerRemaining = RTM_WINDOW_SECONDS;
  auctionState.timerEndsAt = Date.now() + RTM_WINDOW_SECONDS * 1000;
  emitTimerUpdate();

  timerInterval = setInterval(() => {
    const secondsRemaining = Math.max(0, Math.ceil((auctionState.timerEndsAt - Date.now()) / 1000));
    auctionState.timerRemaining = secondsRemaining;
    emitTimerUpdate();

    if (secondsRemaining <= 0) {
      stopBidTimer();
      handleRTMTimerExpiry();
    }
  }, 1000);
}

function maybeScheduleAutoAdvance(delayMs = 800) {
  clearScheduledAIAction();
  if (autoAdvanceTimeout) {
    clearTimeout(autoAdvanceTimeout);
  }
  autoAdvanceTimeout = setTimeout(() => {
    autoAdvanceTimeout = null;
    moveToNextPlayer();
  }, delayMs);
}

function queueNextAIAction() {
  clearScheduledAIAction();

  if (!canAcceptBids()) {
    return;
  }

  const currentPlayer = getCurrentPlayer();
  if (!currentPlayer) {
    return;
  }

  const nextBidAmount = auctionState.currentBid === null
    ? roundCurrency(auctionState.openingBid)
    : roundCurrency(auctionState.currentBid + Number(config.BID_INCREMENT));

  const candidates = auctionState.aiTeams
    .filter((teamName) => teamName !== auctionState.lastBidder)
    .map((teamName) => {
      const team = findTeam(teamName);
      if (!team) {
        return null;
      }

      const acquisition = canTeamAcquirePlayer(team, currentPlayer);
      const roleNeed = getAIRoleNeedScore(team, currentPlayer);
      const targetPrice = getAITargetPrice(teamName, currentPlayer);
      if (!acquisition.allowed || !Number.isFinite(targetPrice) || targetPrice < nextBidAmount || team.balance < nextBidAmount) {
        return null;
      }

      return {
        teamName,
        targetPrice,
        needScore: (roleNeed.remainingForRole * 4) + (roleNeed.uncappedNeed > 0 ? 1 : 0) + (roleNeed.isOptionalDepth ? 0.5 : 0)
      };
    })
    .filter(Boolean)
    .sort((left, right) => (right.needScore - left.needScore) || (right.targetPrice - left.targetPrice));

  if (!candidates.length) {
    return;
  }

  const shortList = candidates.slice(0, Math.min(3, candidates.length));
  const chosen = shortList[Math.floor(Math.random() * shortList.length)];
  const delayMs = 1200 + Math.floor(Math.random() * 1400);

  aiActionTimeout = setTimeout(() => {
    aiActionTimeout = null;

    if (!canAcceptBids() || getCurrentPlayer()?.name !== currentPlayer.name) {
      return;
    }

    const refreshedNextBid = auctionState.currentBid === null
      ? roundCurrency(auctionState.openingBid)
      : roundCurrency(auctionState.currentBid + Number(config.BID_INCREMENT));
    if (chosen.targetPrice < refreshedNextBid) {
      queueNextAIAction();
      return;
    }

    applyBid(chosen.teamName, refreshedNextBid, "ai");
  }, delayMs);
}

function queueAIRTMAction() {
  clearScheduledAIAction();

  if (auctionState.status !== "rtm" || !auctionState.pendingRTM) {
    return;
  }

  const pending = auctionState.pendingRTM;
  const actions = [];
  const soldTeam = findTeam(pending.soldTo);
  const originalTeam = findTeam(pending.originalTeam);

  if (isAITeam(pending.soldTo) && soldTeam) {
    const targetPrice = getAITargetPrice(pending.soldTo, getCurrentPlayer());
    if (Number.isFinite(targetPrice) && targetPrice > pending.priceToMatch && soldTeam.balance >= roundCurrency(targetPrice - pending.openingPrice)) {
      actions.push({ type: "raise", teamName: pending.soldTo, targetPrice });
    }
  }

  if (isAITeam(pending.originalTeam) && originalTeam) {
    const originalTarget = getAITargetPrice(pending.originalTeam, getCurrentPlayer());
    actions.push({
      type: Number.isFinite(originalTarget) && originalTarget >= pending.priceToMatch && originalTeam.rtmSlotsUsed < 4 ? "use" : "decline",
      teamName: pending.originalTeam
    });
  }

  if (!actions.length) {
    return;
  }

  const chosen = actions[Math.floor(Math.random() * actions.length)];
  const delayMs = 1800 + Math.floor(Math.random() * 2200);

  aiActionTimeout = setTimeout(() => {
    aiActionTimeout = null;

    if (auctionState.status !== "rtm" || !auctionState.pendingRTM) {
      return;
    }

    if (chosen.type === "raise") {
      const raiseFloor = roundCurrency(auctionState.pendingRTM.priceToMatch + Number(config.BID_INCREMENT));
      const raiseAmount = Math.max(raiseFloor, chosen.targetPrice);
      const result = raiseRTMBid({ teamName: chosen.teamName, amount: raiseAmount });
      if (result.ok) {
        queueAIRTMAction();
      }
      return;
    }

    const result = resolveRTM(chosen.type === "use", chosen.teamName, chosen.type === "use" ? "ai" : "ai-decline");
    if (!result.ok) {
      queueAIRTMAction();
    }
  }, delayMs);
}

function resetCurrentBidState() {
  const currentPlayer = getCurrentPlayer();
  auctionState.currentBid = null;
  auctionState.openingBid = getOpeningBidForPlayer(currentPlayer);
  auctionState.lastBidder = null;
  auctionState.currentPlayerClosed = false;
  auctionState.currentPlayerBids = [];
  auctionState.pendingRTM = null;
  auctionState.timerRemaining = Number(config.BID_TIMER_SECONDS);
  auctionState.aiBidTargets = {};
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
        ratings: player.ratings,
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
  const completedInRound = auctionState.completedPlayers.filter((player) => player.round === auctionState.round).length;
  return {
    round: auctionState.round,
    current: currentRoundPlayers.length === 0 ? 0 : Math.min(auctionState.currentPlayerIndex + 1, currentRoundPlayers.length),
    total: currentRoundPlayers.length,
    completed: auctionState.completedPlayers.length,
    completedInRound,
    segmentSize: SEGMENT_SIZE,
    segmentNumber: currentRoundPlayers.length === 0 ? 1 : Math.floor(completedInRound / SEGMENT_SIZE) + 1,
    segmentProgress: completedInRound % SEGMENT_SIZE
  };
}

function buildPlayerSetsSummary() {
  const retainedNames = new Set(auctionState.retainedPlayers.map((player) => player.name));
  const completedNames = new Set(auctionState.completedPlayers.map((player) => player.name));

  return createSourcePlayerState().reduce((sets, player) => {
    const key = player.setCode || "GEN";
    if (!sets[key]) {
      sets[key] = {
        setCode: key,
        setLabel: player.setLabel || "General",
        players: []
      };
    }
    sets[key].players.push({
      name: player.name,
      role: player.role,
      country: player.country,
      basePrice: player.basePrice,
      capped: player.capped,
      isOverseas: player.isOverseas,
      previousTeam: player.previousTeam,
      ratings: player.ratings,
      status: retainedNames.has(player.name) ? "retained" : completedNames.has(player.name) ? "auctioned" : "upcoming"
    });
    return sets;
  }, {});
}

function buildAuctionSetFlow() {
  const roundPlayers = getCurrentRoundPlayers();
  if (roundPlayers.length === 0) {
    return {
      activeAuctionSet: null,
      upcomingAuctionSets: [],
      completedAuctionSets: [],
      roundSetOrder: []
    };
  }

  const groupedSets = [];
  roundPlayers.forEach((player) => {
    const currentGroup = groupedSets[groupedSets.length - 1];
    if (!currentGroup || currentGroup.setCode !== player.setCode) {
      groupedSets.push({
        setCode: player.setCode || "GEN",
        setLabel: player.setLabel || "General",
        players: []
      });
    }

    groupedSets[groupedSets.length - 1].players.push(player);
  });

  const activePlayer = getCurrentPlayer();
  const activeSetIndex = activePlayer
    ? groupedSets.findIndex((group) => group.setCode === activePlayer.setCode)
    : groupedSets.findIndex((group) => group.players.some((player) => player.status === "pending"));

  const decorateGroup = (group, index) => {
    const pendingCount = group.players.filter((player) => player.status === "pending").length;
    const soldCount = group.players.filter((player) => player.status === "sold").length;
    const unsoldCount = group.players.filter((player) => player.status === "unsold").length;

    return {
      setCode: group.setCode,
      setLabel: group.setLabel,
      position: index + 1,
      totalSets: groupedSets.length,
      pendingCount,
      soldCount,
      unsoldCount,
    players: group.players.map((player) => ({
        name: player.name,
        role: player.role,
        country: player.country,
        basePrice: getOpeningBidForPlayer(player, auctionState.round),
        ratings: deepClone(player.ratings),
        status: player.status,
        isCurrent: Boolean(activePlayer && activePlayer.name === player.name),
        soldTo: player.soldTo,
        soldPrice: player.soldPrice,
        capped: player.capped,
        isOverseas: player.isOverseas
      }))
    };
  };

  return {
    activeAuctionSet: activeSetIndex >= 0 ? decorateGroup(groupedSets[activeSetIndex], activeSetIndex) : null,
    upcomingAuctionSets: groupedSets.slice(activeSetIndex + 1).map((group, index) => decorateGroup(group, activeSetIndex + index + 1)),
    completedAuctionSets: activeSetIndex > 0 ? groupedSets.slice(0, activeSetIndex).map((group, index) => decorateGroup(group, index)) : [],
    roundSetOrder: groupedSets.map((group, index) => ({
      setCode: group.setCode,
      setLabel: group.setLabel,
      position: index + 1,
      totalSets: groupedSets.length,
      remainingCount: group.players.filter((player) => player.status === "pending").length
    }))
  };
}

function buildPublicState() {
  const currentPlayer = getCurrentPlayer();
  const assignedTeams = listAssignedTeamNames();
  const nextBidAmount = currentPlayer
    ? roundCurrency((auctionState.currentBid ?? auctionState.openingBid ?? 0) + (auctionState.currentBid === null ? 0 : Number(config.BID_INCREMENT)))
    : null;
  const auctionSetFlow = buildAuctionSetFlow();

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
    segmentBreak: deepClone(auctionState.segmentBreak),
    pendingRTM: deepClone(auctionState.pendingRTM),
    teams: auctionState.teams.map((team) => ({
      ...getTeamSquadMetrics(team),
      ...team,
      controller: isAITeam(team.name) ? "ai" : assignedTeams.has(team.name) ? "human" : "open",
      playersCount: team.acquiredPlayers.length,
      canBuyCurrentPlayer: currentPlayer ? canTeamAcquirePlayer(team, currentPlayer).allowed : true,
      rtmSlotsRemaining: Math.max(0, 4 - team.rtmSlotsUsed),
      spentPercentage: team.initialBalance <= 0
        ? 0
        : roundCurrency(((team.initialBalance - team.balance) / team.initialBalance) * 100)
    })),
    playerSets: buildPlayerSetsSummary(),
    activeAuctionSet: auctionSetFlow.activeAuctionSet,
    upcomingAuctionSets: auctionSetFlow.upcomingAuctionSets,
    completedAuctionSets: auctionSetFlow.completedAuctionSets,
    roundSetOrder: auctionSetFlow.roundSetOrder,
    replayLog: deepClone(auctionState.replayLog),
    chatLog: deepClone(auctionState.chatLog),
    progress: getProgressSummary(),
    timerRemaining: auctionState.timerRemaining,
    connectedParticipants: Array.from(connectedClients.values()).map((client) => ({
      socketId: client.socketId,
      role: client.role,
      teamName: client.teamName,
      spectator: client.spectator
    })),
    connectedParticipantCount: Array.from(connectedClients.values()).filter((client) => client.role === "participant" && !client.spectator).length,
    aiTeamCount: auctionState.aiTeams.length,
    availableTeams: auctionState.teams
      .filter((team) => !assignedTeams.has(team.name) && !isAITeam(team.name))
      .map((team) => team.name),
    nextBidAmount,
    timerMode: auctionState.timerMode,
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

function getChatIdentity(socket) {
  const client = connectedClients.get(socket.id);
  if (!client) {
    return null;
  }

  if (client.role === "admin") {
    return { senderName: "Admin", senderType: "admin" };
  }

  if (client.spectator) {
    return { senderName: "Spectator", senderType: "spectator" };
  }

  return {
    senderName: client.teamName || "Participant",
    senderType: "participant"
  };
}

function addChatMessage(socket, rawMessage) {
  const identity = getChatIdentity(socket);
  if (!identity) {
    return { ok: false, message: "Join the auction before sending chat messages." };
  }

  const message = typeof rawMessage === "string" ? rawMessage.trim().replace(/\s+/g, " ") : "";
  if (!message) {
    return { ok: false, message: "Chat message cannot be empty." };
  }

  if (message.length > 240) {
    return { ok: false, message: "Chat message must be 240 characters or less." };
  }

  const timestamp = createTimestampParts();
  const chatEntry = {
    id: auctionState.chatLog.length + 1,
    senderName: identity.senderName,
    senderType: identity.senderType,
    message,
    timestamp: timestamp.iso,
    displayTime: timestamp.time
  };

  auctionState.chatLog.push(chatEntry);
  if (auctionState.chatLog.length > 100) {
    auctionState.chatLog = auctionState.chatLog.slice(-100);
  }

  return {
    ok: true,
    chatEntry
  };
}

function findUpcomingPlayerByName(playerName) {
  if (auctionState.status === "waiting") {
    const sourcePlayer = createSourcePlayerState().find((entry) => entry.name === playerName);
    if (sourcePlayer && !auctionState.retainedPlayers.some((player) => player.name === playerName)) {
      return { player: sourcePlayer, roundKey: "1" };
    }
  }
  for (const roundKey of ["1", "2"]) {
    const player = (auctionState.playersByRound[roundKey] || []).find((entry) => entry.name === playerName);
    if (player) {
      return { player, roundKey };
    }
  }
  return null;
}

function retainPlayerForTeam({ playerName, teamName, price }) {
  if (auctionState.status !== "waiting") {
    return { ok: false, message: "Retentions can only be configured before the auction starts." };
  }

  const team = findTeam(teamName);
  if (!team) {
    return { ok: false, message: "Selected team does not exist." };
  }

  const found = findUpcomingPlayerByName(playerName);
  if (!found) {
    return { ok: false, message: "Selected player is not available for retention." };
  }

  const retentionPrice = roundCurrency(price);
  if (!Number.isFinite(retentionPrice) || retentionPrice <= 0) {
    return { ok: false, message: "Retention price must be a positive number." };
  }

  if (team.balance < retentionPrice) {
    return { ok: false, message: `${team.name} cannot afford this retention price.` };
  }

  const squadValidation = canTeamAcquirePlayer(team, found.player);
  if (!squadValidation.allowed) {
    return { ok: false, message: squadValidation.reason };
  }

  team.balance = roundCurrency(team.balance - retentionPrice);
  const retainedPlayer = {
    id: found.player.sourceId,
    name: found.player.name,
    role: found.player.role,
    country: found.player.country,
    isOverseas: found.player.isOverseas,
    capped: found.player.capped,
    iplProfileId: found.player.iplProfileId,
    iplProfileUrl: found.player.iplProfileUrl,
    officialStats: found.player.officialStats,
    ratings: found.player.ratings,
    setCode: found.player.setCode,
    setLabel: found.player.setLabel,
    previousTeam: found.player.previousTeam,
    price: retentionPrice,
    round: 0,
    retained: true
  };
  team.acquiredPlayers.push(retainedPlayer);
  auctionState.retainedPlayers.push(retainedPlayer);

  if (auctionState.playersByRound[found.roundKey]?.length) {
    auctionState.playersByRound[found.roundKey] = auctionState.playersByRound[found.roundKey].filter((entry) => entry.name !== playerName);
  }
  appendReplayLog(`${team.name} retained ${playerName} for Rs ${retentionPrice} Cr`, "retention", {
    teamName,
    playerName,
    amount: retentionPrice
  });
  return { ok: true };
}

function maybeCreateRTM(player, soldTeamName, finalPrice) {
  return null;

  if (!player.previousTeam || player.previousTeam === soldTeamName) {
    return null;
  }

  const originalTeam = findTeam(player.previousTeam);
  if (!originalTeam) {
    return null;
  }

  if (originalTeam.balance < finalPrice) {
    return null;
  }

  const squadValidation = canTeamAcquirePlayer(originalTeam, player);
  if (!squadValidation.allowed) {
    return null;
  }

  if (originalTeam.rtmSlotsUsed >= 4) {
    return null;
  }

  const payload = {
    playerName: player.name,
    openingPrice: finalPrice,
    priceToMatch: finalPrice,
    soldTo: soldTeamName,
    originalTeam: originalTeam.name,
    raisedBy: null,
    raiseHistory: [],
    autoAdvanceAfterResolution: false
  };
  appendReplayLog(`RTM available for ${originalTeam.name} on ${player.name}`, "rtm-offered", payload);
  return payload;
}

function finalizeRTMSaleForWinningTeam(reason = "rtm-declined") {
  const pending = auctionState.pendingRTM;
  if (!pending) {
    return { ok: false, message: "There is no pending RTM sale to finalize." };
  }

  const player = getCurrentPlayer();
  const soldTeam = findTeam(pending.soldTo);
  if (!player || !soldTeam) {
    return { ok: false, message: "Unable to finalize the winning team sale." };
  }

  const acquiredPlayer = soldTeam.acquiredPlayers.find((entry) => entry.name === player.name && !entry.retained);
  if (!acquiredPlayer) {
    return { ok: false, message: "Winning team does not hold the active player." };
  }

  const extraAmount = roundCurrency(pending.priceToMatch - pending.openingPrice);
  if (extraAmount > 0) {
    if (soldTeam.balance < extraAmount) {
      return { ok: false, message: `${soldTeam.name} can no longer afford the raised RTM price.` };
    }
    soldTeam.balance = roundCurrency(soldTeam.balance - extraAmount);
    acquiredPlayer.price = pending.priceToMatch;
    player.soldPrice = pending.priceToMatch;
    const completedPlayer = auctionState.completedPlayers.find((entry) => entry.name === player.name && entry.round === auctionState.round && entry.status === "sold");
    if (completedPlayer) {
      completedPlayer.price = pending.priceToMatch;
    }
  }

  appendReplayLog(
    `${pending.originalTeam} ${reason === "rtm-expired" ? "did not use" : "declined"} RTM on ${player.name}. ${soldTeam.name} keeps the player for Rs ${pending.priceToMatch} Cr`,
    reason,
    {
      playerName: player.name,
      teamName: soldTeam.name,
      amount: pending.priceToMatch,
      originalTeam: pending.originalTeam
    }
  );
  broadcastState(reason === "rtm-expired" ? "rtm-expired" : "rtm-declined", pending);
  return { ok: true };
}

function finishRTMResolution() {
  const pending = auctionState.pendingRTM;
  const shouldAutoAdvance = Boolean(pending && pending.autoAdvanceAfterResolution);
  auctionState.pendingRTM = null;
  auctionState.status = "paused";
  auctionState.pauseReason = "player-closed";
  auctionState.timerRemaining = 0;
  stopBidTimer();

  const breakSummary = buildSegmentBreakSummary();
  if (breakSummary) {
    enterSegmentBreak(breakSummary);
    return;
  }

  broadcastState();
  if (shouldAutoAdvance) {
    maybeScheduleAutoAdvance();
  }
}

function raiseRTMBid({ teamName, amount }) {
  if (!auctionState.pendingRTM) {
    return { ok: false, message: "There is no active RTM decision." };
  }

  const pending = auctionState.pendingRTM;
  if (teamName !== pending.soldTo) {
    return { ok: false, message: "Only the winning bid team can raise the RTM price." };
  }

  const soldTeam = findTeam(teamName);
  if (!soldTeam) {
    return { ok: false, message: "Winning team could not be found." };
  }

  const raisedAmount = roundCurrency(amount);
  const minimumRaise = roundCurrency(pending.priceToMatch + Number(config.BID_INCREMENT));
  if (!Number.isFinite(raisedAmount) || raisedAmount < minimumRaise) {
    return { ok: false, message: `Raised price must be at least Rs ${minimumRaise} Cr.` };
  }

  const extraAmount = roundCurrency(raisedAmount - pending.openingPrice);
  if (soldTeam.balance < extraAmount) {
    return { ok: false, message: `${soldTeam.name} cannot afford a final RTM price of Rs ${raisedAmount} Cr.` };
  }

  pending.priceToMatch = raisedAmount;
  pending.raisedBy = teamName;
  pending.raiseHistory.push({
    teamName,
    amount: raisedAmount,
    timestamp: new Date().toISOString()
  });

  appendReplayLog(`${teamName} raised the RTM price for ${pending.playerName} to Rs ${raisedAmount} Cr`, "rtm-raised", {
    teamName,
    playerName: pending.playerName,
    amount: raisedAmount
  });
  notifyTeamClients(pending.originalTeam, "rtm-action-required", {
    ...pending,
    action: "decide"
  });
  broadcastState("rtm-raised", {
    teamName,
    playerName: pending.playerName,
    amount: raisedAmount
  });
  return { ok: true };
}

function resolveRTM(useRTM, actorTeamName = null, resolutionType = "participant") {
  if (!auctionState.pendingRTM) {
    return { ok: false, message: "There is no active RTM decision." };
  }

  const pending = auctionState.pendingRTM;
  const player = getCurrentPlayer();
  if (!player || player.name !== pending.playerName) {
    auctionState.pendingRTM = null;
    return { ok: false, message: "RTM state is out of sync with the active player." };
  }

  if (actorTeamName && actorTeamName !== pending.originalTeam) {
    return { ok: false, message: "Only the team with RTM rights can make this decision." };
  }

  if (useRTM) {
    const originalTeam = findTeam(pending.originalTeam);
    const soldTeam = findTeam(pending.soldTo);
    if (!originalTeam || !soldTeam) {
      return { ok: false, message: "Unable to resolve RTM teams." };
    }

    const soldIndex = soldTeam.acquiredPlayers.findIndex((entry) => entry.name === player.name && !entry.retained);
    if (soldIndex !== -1) {
      soldTeam.balance = roundCurrency(soldTeam.balance + pending.openingPrice);
      soldTeam.acquiredPlayers.splice(soldIndex, 1);
    }

    const squadValidation = canTeamAcquirePlayer(originalTeam, player);
    if (!squadValidation.allowed || originalTeam.balance < pending.priceToMatch) {
      return { ok: false, message: "Original team cannot complete the RTM." };
    }

    if (originalTeam.rtmSlotsUsed >= 4) {
      return { ok: false, message: `${originalTeam.name} has already used all 4 RTM slots.` };
    }

    originalTeam.balance = roundCurrency(originalTeam.balance - pending.priceToMatch);
    originalTeam.rtmSlotsUsed += 1;
    originalTeam.acquiredPlayers.push({
      id: player.sourceId,
      name: player.name,
      role: player.role,
      country: player.country,
      isOverseas: player.isOverseas,
      capped: player.capped,
      iplProfileId: player.iplProfileId,
      iplProfileUrl: player.iplProfileUrl,
      officialStats: player.officialStats,
      ratings: player.ratings,
      setCode: player.setCode,
      setLabel: player.setLabel,
      previousTeam: player.previousTeam,
      price: pending.priceToMatch,
      round: auctionState.round
    });
    player.soldTo = originalTeam.name;
    player.soldPrice = pending.priceToMatch;
    const completedPlayer = auctionState.completedPlayers.find((entry) => entry.name === player.name && entry.round === auctionState.round && entry.status === "sold");
    if (completedPlayer) {
      completedPlayer.teamName = originalTeam.name;
      completedPlayer.price = pending.priceToMatch;
    }
    appendReplayLog(`${originalTeam.name} used RTM on ${player.name} for Rs ${pending.priceToMatch} Cr`, "rtm-used", {
      ...pending,
      amount: pending.priceToMatch,
      resolutionType
    });
    broadcastState("rtm-used", {
      ...pending,
      amount: pending.priceToMatch
    });
  } else {
    const finalized = finalizeRTMSaleForWinningTeam("rtm-declined");
    if (!finalized.ok) {
      return finalized;
    }
  }

  finishRTMResolution();
  return { ok: true };
}

function requireAdmin(socket) {
  const client = connectedClients.get(socket.id);
  if (!client || client.role !== "admin") {
    emitError(socket, "Admin privileges are required for this action.");
    return null;
  }
  return client;
}

function requireParticipantTeam(socket) {
  const client = connectedClients.get(socket.id);
  if (!client || client.role !== "participant" || client.spectator || !client.teamName) {
    emitError(socket, "Join the auction with a team before using this action.");
    return null;
  }
  return client.teamName;
}

function canAcceptBids() {
  return auctionState.status === "running" && !!getCurrentPlayer() && !auctionState.currentPlayerClosed;
}

function finalizeAuction() {
  stopBidTimer();
  clearScheduledAIAction();
  auctionState.status = "ended";
  auctionState.currentBid = null;
  auctionState.openingBid = null;
  auctionState.lastBidder = null;
  auctionState.currentPlayerClosed = true;
  auctionState.pendingRTM = null;
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
  auctionState.segmentBreak = null;
  auctionState.currentPlayerIndex += 1;

  if (auctionState.currentPlayerIndex < currentRoundPlayers.length) {
    auctionState.status = "running";
    auctionState.pauseReason = null;
    resetCurrentBidState();
    startBidTimer();
    queueNextAIAction();
    broadcastState("next-player", { currentPlayer: getCurrentPlayer(), round: auctionState.round });
    return;
  }

  if (auctionState.round === 1 && auctionState.unsoldFromRoundOne.length > 0) {
    enterRound(2, auctionState.unsoldFromRoundOne);
    auctionState.unsoldFromRoundOne = [];
    auctionState.status = "running";
    auctionState.pauseReason = null;
    auctionState.segmentBreak = null;
    appendReplayLog("Round 2 started", "round-changed", { round: 2 });
    startBidTimer();
    queueNextAIAction();
    broadcastState("round-changed", { round: 2, currentPlayer: getCurrentPlayer() });
    return;
  }

  finalizeAuction();
}

function startFreshAuction() {
  clearPendingTimers();
  const retainedPlayers = deepClone(auctionState.retainedPlayers);
  const retainedTeams = auctionState.teams.map((team) => ({
    name: team.name,
    balance: team.balance,
    acquiredPlayers: deepClone(team.acquiredPlayers)
  }));
  auctionState = createInitialAuctionState();
  auctionState.retainedPlayers = retainedPlayers;
  auctionState.teams.forEach((team) => {
    const existing = retainedTeams.find((entry) => entry.name === team.name);
    if (existing) {
      team.balance = existing.balance;
      team.acquiredPlayers = existing.acquiredPlayers;
    }
  });
  const retainedNames = new Set(retainedPlayers.map((player) => player.name));
  const players = createSourcePlayerState().filter((player) => !retainedNames.has(player.name));
  auctionState.playersByRound["1"] = createPlayersForRound(players, 1);
  auctionState.currentPlayerIndex = 0;
  auctionState.status = "running";
  auctionState.startedAt = new Date().toISOString();
  assignAITeamsForCurrentAuction();
  resetCurrentBidState();
  appendReplayLog("Auction started", "auction-started");
  if (auctionState.aiTeams.length) {
    appendReplayLog(`AI joined for ${auctionState.aiTeams.length} unclaimed teams`, "ai-joined", {
      teams: deepClone(auctionState.aiTeams)
    });
  }
  startBidTimer();
  queueNextAIAction();
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
      basePrice: currentPlayer.basePriceOverride,
      iplProfileId: currentPlayer.iplProfileId,
      iplProfileUrl: currentPlayer.iplProfileUrl,
      officialStats: currentPlayer.officialStats,
      ratings: currentPlayer.ratings,
      setCode: currentPlayer.setCode,
      setLabel: currentPlayer.setLabel,
      capped: currentPlayer.capped,
      isOverseas: currentPlayer.isOverseas,
      previousTeam: currentPlayer.previousTeam
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

  if (reason !== "timer-expired") {
    const breakSummary = buildSegmentBreakSummary();
    if (breakSummary) {
      enterSegmentBreak(breakSummary);
    }
  }

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

  const squadValidation = canTeamAcquirePlayer(winningTeam, currentPlayer);
  if (!squadValidation.allowed) {
    return { success: false, message: squadValidation.reason };
  }

  stopBidTimer();
  winningTeam.balance = roundCurrency(winningTeam.balance - auctionState.currentBid);

  const acquiredPlayer = {
    id: currentPlayer.sourceId,
    name: currentPlayer.name,
    role: currentPlayer.role,
    country: currentPlayer.country,
    isOverseas: currentPlayer.isOverseas,
    capped: currentPlayer.capped,
    iplProfileId: currentPlayer.iplProfileId,
    iplProfileUrl: currentPlayer.iplProfileUrl,
    officialStats: currentPlayer.officialStats,
    ratings: currentPlayer.ratings,
    setCode: currentPlayer.setCode,
    setLabel: currentPlayer.setLabel,
    previousTeam: currentPlayer.previousTeam,
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

  const rtmPayload = maybeCreateRTM(currentPlayer, winningTeam.name, auctionState.currentBid);
  if (rtmPayload) {
    auctionState.pendingRTM = rtmPayload;
    auctionState.status = "rtm";
    auctionState.pauseReason = "rtm";
    startRTMDecisionTimer();
    broadcastState("rtm-offered", rtmPayload);
    notifyTeamClients(rtmPayload.originalTeam, "rtm-action-required", {
      ...rtmPayload,
      action: "decide"
    });
    notifyTeamClients(rtmPayload.soldTo, "rtm-action-required", {
      ...rtmPayload,
      action: "raise-or-wait"
    });
    queueAIRTMAction();
    return { success: true, player: currentPlayer, team: winningTeam };
  }

  const breakSummary = buildSegmentBreakSummary();
  if (breakSummary) {
    enterSegmentBreak(breakSummary);
  }

  return { success: true, player: currentPlayer, team: winningTeam };
}

function handleTimerExpiry() {
  const currentPlayer = getCurrentPlayer();
  if (!currentPlayer || auctionState.currentPlayerClosed) {
    return;
  }

  const result = auctionState.lastBidder && auctionState.currentBid !== null
    ? markCurrentPlayerSold()
    : markCurrentPlayerUnsold("timer-expired");
  if (!result.success) {
    return;
  }

  if (auctionState.lastBidder && auctionState.currentBid !== null) {
    if (auctionState.pendingRTM) {
      auctionState.pendingRTM.autoAdvanceAfterResolution = true;
    }
    broadcastState("timer-expired", {
      playerName: currentPlayer.name,
      round: auctionState.round,
      outcome: "auto-sold",
      winningTeam: auctionState.lastBidder,
      finalPrice: auctionState.currentBid
    });
  } else {
    broadcastState("timer-expired", {
      playerName: currentPlayer.name,
      round: auctionState.round,
      outcome: "unsold"
    });
  }

  const breakSummary = !auctionState.pendingRTM ? buildSegmentBreakSummary() : null;
  if (breakSummary) {
    enterSegmentBreak(breakSummary);
    return;
  }

  maybeScheduleAutoAdvance();
}

function handleRTMTimerExpiry() {
  if (!auctionState.pendingRTM) {
    return;
  }

  const finalized = finalizeRTMSaleForWinningTeam("rtm-expired");
  if (!finalized.ok) {
    return;
  }

  finishRTMResolution();
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

  const squadValidation = canTeamAcquirePlayer(team, currentPlayer);
  if (!squadValidation.allowed) {
    return { ok: false, message: squadValidation.reason };
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
  clearScheduledAIAction();
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
    origin === "admin-override" ? "admin-bid-override" : origin === "ai" ? "ai-bid" : "bid",
    { teamName, amount, playerName: currentPlayer.name }
  );
  startBidTimer();
  broadcastState("bid-placed", {
    teamName,
    amount,
    playerName: currentPlayer.name,
    origin
  });
  if (origin !== "ai") {
    queueNextAIAction();
  } else {
    queueNextAIAction();
  }
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

      if (isAITeam(requestedTeam)) {
        emitError(socket, "That team is currently being managed by AI for this auction.");
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

  socket.on("send-chat-message", (payload = {}) => {
    const result = addChatMessage(socket, payload.message);
    if (!result.ok) {
      emitError(socket, result.message);
      return;
    }

    broadcastState("chat-message", result.chatEntry);
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
      queueNextAIAction();
      broadcastState("auction-started", { currentPlayer: getCurrentPlayer(), round: auctionState.round, resumed: true });
      return;
    }

    if (auctionState.status === "break") {
      auctionState.status = "running";
      auctionState.pauseReason = null;
      auctionState.segmentBreak = null;
      startBidTimer();
      queueNextAIAction();
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

  socket.on("admin-retain-player", (payload = {}) => {
    if (!requireAdmin(socket)) {
      return;
    }

    const result = retainPlayerForTeam(payload);
    if (!result.ok) {
      emitError(socket, result.message);
      return;
    }

    broadcastState("player-retained", payload);
  });

  socket.on("admin-resolve-rtm", (payload = {}) => {
    if (!requireAdmin(socket)) {
      return;
    }

    const result = resolveRTM(Boolean(payload.useRTM), null, "admin");
    if (!result.ok) {
      emitError(socket, result.message);
    }
  });

  socket.on("participant-raise-rtm-bid", (payload = {}) => {
    const teamName = requireParticipantTeam(socket);
    if (!teamName) {
      return;
    }

    const result = raiseRTMBid({ teamName, amount: payload.amount });
    if (!result.ok) {
      emitError(socket, result.message);
      return;
    }

    queueAIRTMAction();
  });

  socket.on("participant-resolve-rtm", (payload = {}) => {
    const teamName = requireParticipantTeam(socket);
    if (!teamName) {
      return;
    }

    const result = resolveRTM(Boolean(payload.useRTM), teamName, "participant");
    if (!result.ok) {
      emitError(socket, result.message);
      return;
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

    if (auctionState.pendingRTM) {
      emitError(socket, "Resolve the RTM decision before moving to the next player.");
      return;
    }

    if (auctionState.status === "break") {
      auctionState.status = "running";
      auctionState.pauseReason = null;
      auctionState.segmentBreak = null;
      startBidTimer();
      broadcastState("auction-started", { currentPlayer: getCurrentPlayer(), round: auctionState.round, resumed: true });
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

  socket.on("admin-extend-timer", (payload = {}) => {
    if (!requireAdmin(socket)) {
      return;
    }

    const result = extendBidTimer(payload.seconds);
    if (!result.success) {
      emitError(socket, result.message);
    }
  });

  socket.on("disconnect", () => {
    const clientInfo = connectedClients.get(socket.id);
    connectedClients.delete(socket.id);
    if (clientInfo) {
      if (clientInfo.teamName && !clientInfo.spectator && clientInfo.role === "participant" && auctionState.status !== "waiting" && auctionState.status !== "ended" && !isAITeam(clientInfo.teamName)) {
        auctionState.aiTeams.push(clientInfo.teamName);
        appendReplayLog(`${clientInfo.teamName} switched to AI control after participant disconnect`, "ai-takeover", {
          teamName: clientInfo.teamName
        });
        if (auctionState.status === "running") {
          queueNextAIAction();
        }
        if (auctionState.status === "rtm") {
          queueAIRTMAction();
        }
      }
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
