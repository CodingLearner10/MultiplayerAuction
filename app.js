(function () {
  const STORAGE_KEY = "ipl_auction_state";
  const CACHE_BUSTER = `v=${Date.now()}`;
  const ui = {
    homeScreen: document.getElementById("home-screen"),
    loadingScreen: document.getElementById("loading-screen"),
    auctionScreen: document.getElementById("auction-screen"),
    completionScreen: document.getElementById("completion-screen"),
    startAuctionBtn: document.getElementById("start-auction-btn"),
    resumeAuctionBtn: document.getElementById("resume-auction-btn"),
    clearSavedBtn: document.getElementById("clear-saved-btn"),
    savedSummary: document.getElementById("saved-summary"),
    playerName: document.getElementById("single-player-name"),
    playerMeta: document.getElementById("single-player-meta"),
    roundBadge: document.getElementById("single-round-badge"),
    currentPrice: document.getElementById("single-current-price"),
    lastBidder: document.getElementById("single-last-bidder"),
    progress: document.getElementById("single-progress"),
    unsoldCount: document.getElementById("single-unsold-count"),
    timer: document.getElementById("single-timer"),
    statusPill: document.getElementById("single-status-pill"),
    soldBtn: document.getElementById("single-sold-btn"),
    unsoldBtn: document.getElementById("single-unsold-btn"),
    nextBtn: document.getElementById("single-next-btn"),
    teamGrid: document.getElementById("single-team-grid"),
    bidLog: document.getElementById("single-bid-log"),
    completionSummary: document.getElementById("single-completion-summary"),
    exportJsonBtn: document.getElementById("single-export-json"),
    exportCsvBtn: document.getElementById("single-export-csv"),
    restartBtn: document.getElementById("single-restart-btn"),
    modal: document.getElementById("team-modal"),
    modalClose: document.getElementById("team-modal-close"),
    modalTitle: document.getElementById("team-modal-title"),
    modalBalance: document.getElementById("team-modal-balance"),
    modalRoster: document.getElementById("team-modal-roster")
  };

  let state = null;
  let dataBundle = null;
  let timerInterval = null;

  function roundCurrency(value) {
    return Number(Number(value).toFixed(2));
  }

  function shuffle(items) {
    const list = [...items];
    for (let index = list.length - 1; index > 0; index -= 1) {
      const swapIndex = Math.floor(Math.random() * (index + 1));
      [list[index], list[swapIndex]] = [list[swapIndex], list[index]];
    }
    return list;
  }

  function createDownload(filename, content, type) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  function formatMoney(value) {
    return `Rs ${roundCurrency(value)} Cr`;
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

  function formatRatings(ratings) {
    if (!ratings) {
      return "";
    }
    return `BAT ${ratings.batting}/10 • FLD ${ratings.fielding}/10 • BWL ${ratings.bowling}/10`;
  }

  function budgetColor(balance, initialBalance) {
    const spentPct = initialBalance <= 0 ? 0 : ((initialBalance - balance) / initialBalance) * 100;
    if (spentPct < 40) {
      return "#10b981";
    }
    if (spentPct < 75) {
      return "#f59e0b";
    }
    return "#ef4444";
  }

  function saveState() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    renderSavedSummary();
  }

  function clearState() {
    localStorage.removeItem(STORAGE_KEY);
    renderSavedSummary();
  }

  function loadSavedState() {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return null;
    }

    try {
      return JSON.parse(raw);
    } catch (error) {
      localStorage.removeItem(STORAGE_KEY);
      return null;
    }
  }

  function getCurrentRoundPlayers() {
    return state.round === 1 ? state.roundOnePlayers : state.roundTwoPlayers;
  }

  function getCurrentPlayer() {
    const players = getCurrentRoundPlayers();
    return players[state.currentPlayerIndex] || null;
  }

  function getOpeningBid(player) {
    if (!player) {
      return 0;
    }
    if (state.round === 1 && Number.isFinite(Number(player.basePrice))) {
      return roundCurrency(player.basePrice);
    }
    return roundCurrency(state.round === 1 ? dataBundle.config.BASE_PRICE_ROUND1 : dataBundle.config.BASE_PRICE_ROUND2);
  }

  function getNextBidAmount() {
    const currentPlayer = getCurrentPlayer();
    if (!currentPlayer) {
      return 0;
    }
    if (state.currentBid === null) {
      return getOpeningBid(currentPlayer);
    }
    return roundCurrency(state.currentBid + dataBundle.config.BID_INCREMENT);
  }

  function createInitialState(bundle) {
    return {
      status: "running",
      round: 1,
      roundOnePlayers: shuffle(bundle.players).map((player) => ({ ...player, ratings: player.ratings || createPlayerRatings(player), status: "pending" })),
      roundTwoPlayers: [],
      currentPlayerIndex: 0,
      currentBid: null,
      lastBidder: null,
      currentPlayerClosed: false,
      bidHistory: [],
      replayLog: [],
      unsoldFromRoundOne: [],
      teams: bundle.teams.map((team) => ({
        ...team,
        acquiredPlayers: []
      })),
      timerRemaining: bundle.config.BID_TIMER_SECONDS
    };
  }

  function renderSavedSummary() {
    const saved = loadSavedState();
    if (!saved) {
      ui.savedSummary.classList.add("hidden");
      ui.resumeAuctionBtn.disabled = true;
      return;
    }

    ui.savedSummary.classList.remove("hidden");
    ui.resumeAuctionBtn.disabled = false;
    ui.savedSummary.innerHTML = `
      <div>
        <strong>Saved auction found</strong>
        <div class="muted">Round ${saved.round} • ${saved.teams.length} teams • ${saved.replayLog.length} replay entries</div>
      </div>
      <div class="pill-note">${saved.status === "ended" ? "Completed" : "Ready to resume"}</div>
    `;
  }

  function setVisibleScreen(name) {
    ui.homeScreen.classList.toggle("hidden", name !== "home");
    ui.loadingScreen.classList.toggle("hidden", name !== "loading");
    ui.auctionScreen.classList.toggle("hidden", name !== "auction");
    ui.completionScreen.classList.toggle("hidden", name !== "completion");
  }

  function renderBidLog() {
    const items = state.bidHistory.slice(-5).reverse();
    ui.bidLog.innerHTML = items.length
      ? items.map((entry) => `<li>${entry.teamName} bid ${formatMoney(entry.amount)}</li>`).join("")
      : "<li>No bids placed for this player yet.</li>";
  }

  function openTeamModal(teamName) {
    const team = state.teams.find((entry) => entry.name === teamName);
    if (!team) {
      return;
    }
    ui.modalTitle.textContent = team.name;
    ui.modalBalance.textContent = `Remaining balance: ${formatMoney(team.balance)} of ${formatMoney(team.initialBalance)}`;
    ui.modalRoster.innerHTML = team.acquiredPlayers.length
      ? team.acquiredPlayers.map((player) => `
        <div class="roster-row">
          <div>
            <strong>${player.name}</strong>
            <div class="muted">${formatRatings(player.ratings)}</div>
            <div class="muted">${player.role} • ${player.country}</div>
          </div>
          <strong>${formatMoney(player.price)}</strong>
        </div>
      `).join("")
      : '<div class="roster-row"><span>No players acquired yet.</span></div>';
    ui.modal.classList.remove("hidden");
  }

  function renderTeams() {
    const currentPlayer = getCurrentPlayer();
    const nextBidAmount = getNextBidAmount();

    ui.teamGrid.innerHTML = state.teams.map((team) => {
      const isHighest = team.name === state.lastBidder;
      const canBid = state.status === "running" && !state.currentPlayerClosed && currentPlayer && team.balance >= nextBidAmount && state.lastBidder !== team.name;
      const spentPct = team.initialBalance <= 0 ? 0 : ((team.initialBalance - team.balance) / team.initialBalance) * 100;

      return `
        <article class="team-card clickable ${isHighest ? "highlight" : ""}" data-team-card="${team.name}">
          <div class="team-card-head">
            <div>
              <strong>${team.name}</strong>
              <div class="muted">${team.acquiredPlayers.length} players acquired</div>
            </div>
            ${isHighest ? '<span class="pill-note">Highest bidder</span>' : ""}
          </div>
          <div class="team-balance">${formatMoney(team.balance)}</div>
          <div class="budget-bar"><span style="width:${Math.min(100, spentPct)}%;background:${budgetColor(team.balance, team.initialBalance)}"></span></div>
          <div class="progress-meta">
            <span class="muted">Initial ${formatMoney(team.initialBalance)}</span>
            <span class="muted">${spentPct.toFixed(0)}% spent</span>
          </div>
          <div class="team-actions">
            <button class="btn btn-primary" data-bid-team="${team.name}" ${canBid ? "" : "disabled"}>
              ${canBid ? `Bid ${formatMoney(nextBidAmount)}` : team.balance < nextBidAmount ? "Insufficient Balance" : "Cannot Bid"}
            </button>
          </div>
        </article>
      `;
    }).join("");

    ui.teamGrid.querySelectorAll("[data-bid-team]").forEach((button) => {
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        placeBid(button.dataset.bidTeam);
      });
    });

    ui.teamGrid.querySelectorAll("[data-team-card]").forEach((card) => {
      card.addEventListener("click", () => openTeamModal(card.dataset.teamCard));
    });
  }

  function renderAuctionView() {
    const currentPlayer = getCurrentPlayer();
    const players = getCurrentRoundPlayers();
    const currentPrice = state.currentBid === null ? getOpeningBid(currentPlayer) : state.currentBid;

    ui.roundBadge.textContent = `Round ${state.round}`;
    ui.progress.textContent = `${players.length ? state.currentPlayerIndex + 1 : 0} / ${players.length}`;
    ui.unsoldCount.textContent = String(state.unsoldFromRoundOne.length);
    ui.statusPill.textContent = state.status === "ended" ? "Completed" : state.currentPlayerClosed ? "Player Closed" : "Running";
    ui.timer.textContent = `${state.timerRemaining}s`;

    if (!currentPlayer) {
      ui.playerName.textContent = "Auction completed";
      ui.playerMeta.textContent = "No players remaining.";
      ui.currentPrice.textContent = "Rs 0 Cr";
      ui.lastBidder.textContent = "No bids";
    } else {
      ui.playerName.textContent = currentPlayer.name;
      ui.currentPrice.textContent = `${state.currentBid === null ? "Base" : "Current"} ${formatMoney(currentPrice)}`;
      ui.playerMeta.textContent = `${currentPlayer.role} | ${currentPlayer.country} | ${formatRatings(currentPlayer.ratings)}`;
      ui.lastBidder.textContent = state.lastBidder || "No bids yet";
    }

    ui.soldBtn.disabled = !state.lastBidder || state.currentPlayerClosed || state.status === "ended";
    ui.unsoldBtn.disabled = state.currentPlayerClosed || state.status === "ended";
    ui.nextBtn.disabled = !state.currentPlayerClosed || state.status === "ended";

    renderBidLog();
    renderTeams();
  }

  function buildResultsPayload() {
    return {
      auctionDate: new Date().toISOString(),
      teams: state.teams.map((team) => ({
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
      }))
    };
  }

  function exportReplayCsv() {
    const rows = [["Time", "Type", "Message"]];
    state.replayLog.forEach((entry) => {
      rows.push([entry.displayTime, entry.type, entry.message]);
    });
    const content = rows.map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(",")).join("\n");
    createDownload("auction-replay-log.csv", content, "text/csv;charset=utf-8");
  }

  function renderCompletion() {
    setVisibleScreen("completion");
    ui.completionSummary.innerHTML = state.teams.map((team) => `
      <article class="summary-card">
        <div class="summary-card-head">
          <strong>${team.name}</strong>
          <span class="pill-note">${team.acquiredPlayers.length} players</span>
        </div>
        <p class="muted">Initial: ${formatMoney(team.initialBalance)}</p>
        <p class="muted">Final: ${formatMoney(team.balance)}</p>
      </article>
    `).join("");
    clearState();
  }

  function finishAuction() {
    state.status = "ended";
    saveState();
    renderCompletion();
  }

  function prepareRoundTwo() {
    state.round = 2;
    state.roundTwoPlayers = shuffle(state.unsoldFromRoundOne.map((player) => ({ ...player, status: "pending" })));
    state.unsoldFromRoundOne = [];
    state.currentPlayerIndex = 0;
    state.currentBid = null;
    state.lastBidder = null;
    state.currentPlayerClosed = false;
    state.bidHistory = [];
    state.timerRemaining = dataBundle.config.BID_TIMER_SECONDS;
    state.replayLog.push({
      displayTime: new Date().toLocaleTimeString("en-IN", { hour12: false }),
      type: "round-changed",
      message: "Round 2 started"
    });
    renderAuctionView();
  }

  function moveToNextPlayer() {
    state.currentPlayerIndex += 1;
    const players = getCurrentRoundPlayers();
    if (state.currentPlayerIndex < players.length) {
      state.currentBid = null;
      state.lastBidder = null;
      state.currentPlayerClosed = false;
      state.bidHistory = [];
      state.timerRemaining = dataBundle.config.BID_TIMER_SECONDS;
      saveState();
      renderAuctionView();
      restartTimer();
      return;
    }

    if (state.round === 1 && state.unsoldFromRoundOne.length > 0) {
      prepareRoundTwo();
      saveState();
      restartTimer();
      return;
    }

    stopTimer();
    finishAuction();
  }

  function markUnsold(reason) {
    const currentPlayer = getCurrentPlayer();
    if (!currentPlayer || state.currentPlayerClosed) {
      return;
    }
    currentPlayer.status = "unsold";
    state.currentPlayerClosed = true;
    state.replayLog.push({
      displayTime: new Date().toLocaleTimeString("en-IN", { hour12: false }),
      type: reason === "timer-expired" ? "timer-expired" : "player-unsold",
      message: `${currentPlayer.name} marked unsold in Round ${state.round}`
    });
    if (state.round === 1) {
      state.unsoldFromRoundOne.push({
        name: currentPlayer.name,
        role: currentPlayer.role,
        country: currentPlayer.country,
        ratings: currentPlayer.ratings,
        basePrice: currentPlayer.basePrice
      });
    }
    saveState();
    renderAuctionView();
  }

  function markSold() {
    const currentPlayer = getCurrentPlayer();
    if (!currentPlayer || !state.lastBidder || state.currentPlayerClosed) {
      return;
    }
    const winningTeam = state.teams.find((team) => team.name === state.lastBidder);
    if (!winningTeam || winningTeam.balance < state.currentBid) {
      return;
    }
    winningTeam.balance = roundCurrency(winningTeam.balance - state.currentBid);
    winningTeam.acquiredPlayers.push({
      name: currentPlayer.name,
      role: currentPlayer.role,
      country: currentPlayer.country,
      ratings: currentPlayer.ratings,
      price: state.currentBid
    });
    currentPlayer.status = "sold";
    currentPlayer.soldTo = winningTeam.name;
    currentPlayer.soldPrice = state.currentBid;
    state.currentPlayerClosed = true;
    state.replayLog.push({
      displayTime: new Date().toLocaleTimeString("en-IN", { hour12: false }),
      type: "player-sold",
      message: `${winningTeam.name} bought ${currentPlayer.name} for ${formatMoney(state.currentBid)}`
    });
    saveState();
    renderAuctionView();
  }

  function placeBid(teamName) {
    const team = state.teams.find((entry) => entry.name === teamName);
    const nextBidAmount = getNextBidAmount();
    if (!team || state.currentPlayerClosed || state.status !== "running") {
      return;
    }
    if (team.balance < nextBidAmount || state.lastBidder === teamName) {
      return;
    }

    state.currentBid = nextBidAmount;
    state.lastBidder = teamName;
    state.bidHistory.push({
      teamName,
      amount: nextBidAmount
    });
    state.replayLog.push({
      displayTime: new Date().toLocaleTimeString("en-IN", { hour12: false }),
      type: "bid",
      message: `${teamName} bid ${formatMoney(nextBidAmount)} on ${getCurrentPlayer().name}`
    });
    state.timerRemaining = dataBundle.config.BID_TIMER_SECONDS;
    saveState();
    renderAuctionView();
    restartTimer();
  }

  function stopTimer() {
    if (timerInterval) {
      clearInterval(timerInterval);
      timerInterval = null;
    }
  }

  function restartTimer() {
    stopTimer();
    if (state.status === "ended" || state.currentPlayerClosed || !getCurrentPlayer()) {
      return;
    }
    ui.timer.textContent = `${state.timerRemaining}s`;
    timerInterval = window.setInterval(() => {
      state.timerRemaining -= 1;
      ui.timer.textContent = `${Math.max(0, state.timerRemaining)}s`;
      saveState();
      if (state.timerRemaining <= 0) {
        stopTimer();
        markUnsold("timer-expired");
        window.setTimeout(moveToNextPlayer, 700);
      }
    }, 1000);
  }

  async function loadDataBundle() {
    const [players, teams, config] = await Promise.all([
      fetch(`/players.json?${CACHE_BUSTER}`).then((response) => response.json()),
      fetch(`/teams.json?${CACHE_BUSTER}`).then((response) => response.json()),
      fetch(`/config.json?${CACHE_BUSTER}`).then((response) => response.json())
    ]);

    return { players, teams, config };
  }

  async function beginAuction(mode) {
    setVisibleScreen("loading");
    dataBundle = await loadDataBundle();

    window.setTimeout(() => {
      state = mode === "resume" ? loadSavedState() : createInitialState(dataBundle);
      if (!state) {
        state = createInitialState(dataBundle);
      }
      setVisibleScreen(state.status === "ended" ? "completion" : "auction");
      if (state.status === "ended") {
        renderCompletion();
        return;
      }
      renderAuctionView();
      restartTimer();
      saveState();
    }, 5000);
  }

  ui.startAuctionBtn.addEventListener("click", () => {
    clearState();
    beginAuction("new");
  });
  ui.resumeAuctionBtn.addEventListener("click", () => beginAuction("resume"));
  ui.clearSavedBtn.addEventListener("click", () => {
    clearState();
    alert("Saved single-player auction data cleared.");
  });
  ui.soldBtn.addEventListener("click", () => {
    stopTimer();
    markSold();
  });
  ui.unsoldBtn.addEventListener("click", () => {
    stopTimer();
    markUnsold("manual-unsold");
  });
  ui.nextBtn.addEventListener("click", moveToNextPlayer);
  ui.exportJsonBtn.addEventListener("click", () => {
    createDownload("ipl-auction-results.json", JSON.stringify(buildResultsPayload(), null, 2), "application/json;charset=utf-8");
  });
  ui.exportCsvBtn.addEventListener("click", exportReplayCsv);
  ui.restartBtn.addEventListener("click", () => {
    clearState();
    setVisibleScreen("home");
  });
  ui.modalClose.addEventListener("click", () => ui.modal.classList.add("hidden"));
  ui.modal.addEventListener("click", (event) => {
    if (event.target === ui.modal) {
      ui.modal.classList.add("hidden");
    }
  });

  renderSavedSummary();
})();
