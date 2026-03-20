(function () {
  const socket = io();
  const ui = {
    connectionStatus: document.getElementById("admin-connection-status"),
    timer: document.getElementById("admin-timer"),
    timerChip: document.getElementById("admin-timer-chip"),
    heroTimer: document.getElementById("admin-hero-timer"),
    liveStatus: document.getElementById("admin-live-status"),
    playerName: document.getElementById("admin-player-name"),
    playerMeta: document.getElementById("admin-player-meta"),
    currentPrice: document.getElementById("admin-current-price"),
    lastBidder: document.getElementById("admin-last-bidder"),
    roundBadge: document.getElementById("admin-round-badge"),
    progress: document.getElementById("admin-progress"),
    segmentProgress: document.getElementById("admin-segment-progress"),
    modeLabel: document.getElementById("admin-mode-label"),
    participantCount: document.getElementById("admin-participant-count"),
    statusCopy: document.getElementById("admin-status-copy"),
    bidLog: document.getElementById("admin-bid-log"),
    participantsList: document.getElementById("admin-participants-list"),
    teamGrid: document.getElementById("admin-team-grid"),
    soldOverlay: document.getElementById("admin-sold-overlay"),
    soldOverlayTitle: document.getElementById("admin-sold-overlay-title"),
    soldOverlayCopy: document.getElementById("admin-sold-overlay-copy"),
    chatLog: document.getElementById("admin-chat-log"),
    chatForm: document.getElementById("admin-chat-form"),
    chatInput: document.getElementById("admin-chat-input"),
    breakPanel: document.getElementById("admin-break-panel"),
    breakTitle: document.getElementById("admin-break-title"),
    breakMeta: document.getElementById("admin-break-meta"),
    breakCards: document.getElementById("admin-break-cards"),
    startBtn: document.getElementById("admin-start-btn"),
    continueBtn: document.getElementById("admin-continue-btn"),
    pauseBtn: document.getElementById("admin-pause-btn"),
    soldBtn: document.getElementById("admin-sold-btn"),
    unsoldBtn: document.getElementById("admin-unsold-btn"),
    nextBtn: document.getElementById("admin-next-btn"),
    resetBtn: document.getElementById("admin-reset-btn"),
    extend10Btn: document.getElementById("admin-extend-10-btn"),
    extend15Btn: document.getElementById("admin-extend-15-btn"),
    extend30Btn: document.getElementById("admin-extend-30-btn"),
    overrideTeamSelect: document.getElementById("override-team-select"),
    overrideAmountInput: document.getElementById("override-amount-input"),
    overrideApplyBtn: document.getElementById("override-apply-btn"),
    completionPanel: document.getElementById("admin-completion"),
    resultsGrid: document.getElementById("admin-results-grid"),
    exportJsonBtn: document.getElementById("admin-export-json"),
    exportCsvBtn: document.getElementById("admin-export-csv")
  };

  let state = null;
  let overlayTimeout = null;
  const TEAM_COLORS = ["#38bdf8", "#f59e0b", "#10b981", "#f472b6", "#a78bfa", "#fb7185", "#22c55e", "#f97316", "#14b8a6", "#eab308"];

  function roundCurrency(value) {
    return Number(Number(value || 0).toFixed(2));
  }

  function formatMoney(value) {
    return `Rs ${roundCurrency(value)} Cr`;
  }

  function budgetColor(balance, initialBalance) {
    const spentPct = initialBalance <= 0 ? 0 : ((initialBalance - balance) / initialBalance) * 100;
    if (spentPct < 40) return "#10b981";
    if (spentPct < 75) return "#f59e0b";
    return "#ef4444";
  }

  function getTeamColor(teamName) {
    const index = state ? state.teams.findIndex((team) => team.name === teamName) : -1;
    return TEAM_COLORS[index >= 0 ? index % TEAM_COLORS.length : 0];
  }

  function showSoldOverlay(playerName, winningTeam, finalPrice) {
    if (overlayTimeout) {
      clearTimeout(overlayTimeout);
    }
    ui.soldOverlayTitle.textContent = `${playerName} SOLD`;
    ui.soldOverlayCopy.textContent = `${winningTeam} for ${formatMoney(finalPrice)}`;
    ui.soldOverlay.classList.remove("hidden");
    overlayTimeout = window.setTimeout(() => {
      ui.soldOverlay.classList.add("hidden");
      overlayTimeout = null;
    }, 1800);
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

  function exportJson() {
    if (!state || !state.results) return;
    createDownload("ipl-auction-results.json", JSON.stringify(state.results, null, 2), "application/json;charset=utf-8");
  }

  function exportCsv() {
    if (!state) return;
    const rows = [["Time", "Type", "Message"]];
    state.replayLog.forEach((entry) => rows.push([entry.displayTime, entry.type, entry.message]));
    const content = rows.map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(",")).join("\n");
    createDownload("auction-replay-log.csv", content, "text/csv;charset=utf-8");
  }

  function timerClass(seconds) {
    if (seconds <= 5) return "danger";
    if (seconds <= 10) return "warning";
    return "";
  }

  function renderTimerOnly() {
    if (!state) return;
    const hasCurrentPlayer = Boolean(state.currentPlayer);
    const timerText = hasCurrentPlayer ? `${state.timerRemaining}s` : "--";
    const urgencyClass = hasCurrentPlayer ? timerClass(state.timerRemaining) : "";
    ui.timer.textContent = timerText;
    ui.heroTimer.textContent = timerText;
    ui.heroTimer.className = `hero-timer-value ${urgencyClass}`.trim();
  }

  function setStatusPill(text, status) {
    ui.connectionStatus.className = `status-pill ${status}`;
    ui.connectionStatus.textContent = text;
  }

  function renderParticipants() {
    const participants = state.connectedParticipants || [];
    ui.participantsList.innerHTML = participants.length
      ? participants.map((participant) => `<li>${participant.role === "admin" ? "Admin" : participant.spectator ? "Spectator" : participant.teamName || "Participant"}</li>`).join("")
      : "<li>No participants connected.</li>";
  }

  function renderBidLog() {
    const items = (state.currentPlayerBids || []).slice(-5).reverse();
    ui.bidLog.innerHTML = items.length
      ? items.map((entry) => `<li><strong>${entry.teamName}</strong>${formatMoney(entry.amount)}</li>`).join("")
      : "<li>No bids for the current player yet.</li>";
  }

  function renderTeams() {
    ui.teamGrid.innerHTML = state.teams.map((team) => {
      const spentPct = team.initialBalance <= 0 ? 0 : ((team.initialBalance - team.balance) / team.initialBalance) * 100;
      const isHighest = team.name === state.lastBidder;
      const teamColor = getTeamColor(team.name);
      return `
        <article class="team-card team-accent ${isHighest ? "highlight" : ""}" style="--team-accent:${teamColor}">
          <div class="team-card-head">
            <div>
              <strong class="team-name-chip">${team.name}</strong>
              <div class="muted">${team.playersCount} players acquired</div>
            </div>
            ${isHighest ? '<span class="pill-note">Highest bidder</span>' : ""}
          </div>
          <div class="team-balance">${formatMoney(team.balance)}</div>
          <div class="budget-bar"><span style="width:${Math.min(100, spentPct)}%;background:${budgetColor(team.balance, team.initialBalance)}"></span></div>
          <div class="progress-meta">
            <span class="muted">Initial ${formatMoney(team.initialBalance)}</span>
            <span class="muted">${spentPct.toFixed(0)}% spent</span>
          </div>
        </article>
      `;
    }).join("");
  }

  function renderChat() {
    const items = state.chatLog || [];
    ui.chatLog.innerHTML = items.length
      ? items.map((entry) => `
        <article class="chat-item">
          <div class="chat-meta">
            <div>
              <strong>${entry.senderName}</strong>
              <span class="chat-badge ${entry.senderType}">${entry.senderType}</span>
            </div>
            <span>${entry.displayTime}</span>
          </div>
          <p class="chat-message">${entry.message}</p>
        </article>
      `).join("")
      : '<article class="chat-item"><p class="chat-message">No messages yet. Use chat to coordinate the auction room.</p></article>';
    ui.chatLog.scrollTop = ui.chatLog.scrollHeight;
  }

  function renderBreakPanel() {
    const breakState = state.segmentBreak;
    const visible = state.status === "break" && breakState;
    ui.breakPanel.classList.toggle("hidden", !visible);
    if (!visible) return;

    ui.breakTitle.textContent = `Round ${breakState.round} - Segment ${breakState.segmentNumber} complete`;
    ui.breakMeta.textContent = `Players ${breakState.startNumber} to ${breakState.endNumber} are done. Sold: ${breakState.soldCount}. Unsold: ${breakState.unsoldCount}.`;

    const cards = [];
    if (breakState.topBuy) {
      cards.push(`
        <article class="summary-card">
          <div class="summary-card-head">
            <strong>Top Buy</strong>
            <span class="pill-note">${formatMoney(breakState.topBuy.price)}</span>
          </div>
          <p>${breakState.topBuy.name}</p>
          <p class="muted">${breakState.topBuy.teamName}</p>
        </article>
      `);
    }

    breakState.teams.forEach((team) => {
      cards.push(`
        <article class="summary-card">
          <div class="summary-card-head">
            <strong>${team.name}</strong>
            <span class="pill-note">${team.playersInSegment.length} buys</span>
          </div>
          <p class="muted">Balance: ${formatMoney(team.balance)}</p>
          <p class="muted">${team.playersInSegment.length ? team.playersInSegment.map((player) => player.name).join(", ") : "No buys this segment"}</p>
        </article>
      `);
    });

    ui.breakCards.innerHTML = cards.join("");
  }

  function renderCompletion() {
    const visible = state.status === "ended" && state.results;
    ui.completionPanel.classList.toggle("hidden", !visible);
    if (!visible) return;
    ui.resultsGrid.innerHTML = state.results.teams.map((team) => `
      <article class="summary-card">
        <div class="summary-card-head">
          <strong>${team.name}</strong>
          <span class="pill-note">${team.playersAcquired.length} players</span>
        </div>
        <p class="muted">Initial: ${formatMoney(team.initialBalance)}</p>
        <p class="muted">Final: ${formatMoney(team.finalBalance)}</p>
      </article>
    `).join("");
  }

  function renderState() {
    if (!state) return;
    const currentPlayer = state.currentPlayer;

    setStatusPill(`Connected - ${state.status}`, state.status);
    renderTimerOnly();
    ui.roundBadge.textContent = `Round ${state.round}`;
    ui.progress.textContent = `${state.progress.current} / ${state.progress.total}`;
    ui.segmentProgress.textContent = `${(state.progress.segmentProgress || 0) + 1} / ${state.progress.segmentSize || 15}`;
    ui.modeLabel.textContent = state.status === "break" ? "Segment Break" : state.status;
    ui.participantCount.textContent = String(state.connectedParticipantCount || 0);
    ui.statusCopy.textContent = `Status: ${state.status}. Available teams: ${(state.availableTeams || []).length}.`;
    ui.liveStatus.textContent = state.status === "break" ? "Segment break in progress" : state.status === "running" ? "Live bidding open" : state.status === "paused" ? "Auction paused by admin" : state.status === "waiting" ? "Waiting to start" : "Auction completed";
    ui.lastBidder.textContent = state.lastBidder || "No bids yet";
    ui.currentPrice.textContent = currentPlayer
      ? `${state.currentBid === null ? "Base" : "Current"} ${formatMoney(state.currentBid === null ? state.openingBid : state.currentBid)}`
      : "Rs 0 Cr";

    if (currentPlayer) {
      ui.playerName.textContent = currentPlayer.name;
      ui.playerMeta.textContent = `${currentPlayer.role} - ${currentPlayer.country}`;
    } else {
      ui.playerName.textContent = state.status === "ended" ? "Auction completed" : "Waiting for auction to start";
      ui.playerMeta.textContent = "Role and country will appear here.";
    }

    ui.startBtn.textContent = state.status === "waiting" || state.status === "ended" ? "Start Auction" : "Resume Auction";
    ui.pauseBtn.disabled = state.status !== "running";
    ui.soldBtn.disabled = !state.lastBidder || state.currentPlayerClosed || state.status !== "running";
    ui.unsoldBtn.disabled = !state.currentPlayer || state.currentPlayerClosed || state.status !== "running";
    ui.nextBtn.disabled = !(state.currentPlayerClosed || state.status === "break") || state.status === "ended";
    ui.continueBtn.disabled = state.status !== "break";
    ui.extend10Btn.disabled = state.status !== "running";
    ui.extend15Btn.disabled = state.status !== "running";
    ui.extend30Btn.disabled = state.status !== "running";
    ui.overrideApplyBtn.disabled = !state.currentPlayer || state.currentPlayerClosed || state.status !== "running";
    ui.overrideTeamSelect.innerHTML = state.teams.map((team) => `<option value="${team.name}">${team.name}</option>`).join("");

    renderParticipants();
    renderBidLog();
    renderTeams();
    renderChat();
    renderBreakPanel();
    renderCompletion();
  }

  ui.startBtn.addEventListener("click", () => socket.emit("admin-start-auction"));
  ui.continueBtn.addEventListener("click", () => socket.emit("admin-next-player"));
  ui.pauseBtn.addEventListener("click", () => socket.emit("admin-pause-auction"));
  ui.soldBtn.addEventListener("click", () => socket.emit("admin-mark-sold"));
  ui.unsoldBtn.addEventListener("click", () => socket.emit("admin-mark-unsold"));
  ui.nextBtn.addEventListener("click", () => socket.emit("admin-next-player"));
  ui.extend10Btn.addEventListener("click", () => socket.emit("admin-extend-timer", { seconds: 10 }));
  ui.extend15Btn.addEventListener("click", () => socket.emit("admin-extend-timer", { seconds: 15 }));
  ui.extend30Btn.addEventListener("click", () => socket.emit("admin-extend-timer", { seconds: 30 }));
  ui.resetBtn.addEventListener("click", () => {
    if (window.confirm("Reset the full auction? This clears the live multiplayer state for everyone.")) {
      socket.emit("admin-reset-auction");
    }
  });
  ui.overrideApplyBtn.addEventListener("click", () => {
    const amount = Number(ui.overrideAmountInput.value);
    const teamName = ui.overrideTeamSelect.value;
    if (!teamName || !Number.isFinite(amount)) {
      window.alert("Choose a team and enter a valid override amount.");
      return;
    }
    if (window.confirm(`Apply an admin override bid of ${formatMoney(amount)} for ${teamName}?`)) {
      socket.emit("admin-bid-override", { teamName, amount });
      ui.overrideAmountInput.value = "";
    }
  });
  ui.exportJsonBtn.addEventListener("click", exportJson);
  ui.exportCsvBtn.addEventListener("click", exportCsv);
  ui.chatForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const message = ui.chatInput.value.trim();
    if (!message) return;
    socket.emit("send-chat-message", { message });
    ui.chatInput.value = "";
  });

  socket.on("connect", () => {
    setStatusPill("Connected - waiting", "waiting");
    socket.emit("join-auction", { role: "admin" });
  });

  socket.on("disconnect", () => {
    setStatusPill("Disconnected", "paused");
  });

  socket.on("auction-state-update", (nextState) => {
    state = nextState;
    renderState();
  });

  socket.on("timer-update", (payload) => {
    if (!state) return;
    state.timerRemaining = payload.secondsRemaining;
    renderTimerOnly();
  });

  socket.on("error-message", (payload) => {
    window.alert(payload.message);
  });

  socket.on("player-marked-sold", (payload) => {
    showSoldOverlay(payload.player, payload.winningTeam, payload.finalPrice);
  });
})();
