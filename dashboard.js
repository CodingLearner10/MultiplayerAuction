(function () {
  const socket = io();
  const params = new URLSearchParams(window.location.search);
  const spectatorMode = params.get("mode") === "spectate";
  const ui = {
    title: document.getElementById("dashboard-title"),
    statusPill: document.getElementById("dashboard-status-pill"),
    timer: document.getElementById("dashboard-timer"),
    timerChip: document.getElementById("dashboard-timer-chip"),
    heroTimer: document.getElementById("dashboard-hero-timer"),
    liveStatus: document.getElementById("dashboard-live-status"),
    selectionPanel: document.getElementById("team-selection-panel"),
    selectionGrid: document.getElementById("team-selection-grid"),
    selectionCopy: document.getElementById("selection-copy"),
    waitingMessage: document.getElementById("waiting-message"),
    setSelect: document.getElementById("dashboard-set-select"),
    setList: document.getElementById("dashboard-set-list"),
    liveView: document.getElementById("dashboard-live-view"),
    breakPanel: document.getElementById("dashboard-break-panel"),
    breakTitle: document.getElementById("dashboard-break-title"),
    breakMeta: document.getElementById("dashboard-break-meta"),
    breakCards: document.getElementById("dashboard-break-cards"),
    playerName: document.getElementById("dashboard-player-name"),
    playerMeta: document.getElementById("dashboard-player-meta"),
    currentPrice: document.getElementById("dashboard-current-price"),
    lastBidder: document.getElementById("dashboard-last-bidder"),
    roundBadge: document.getElementById("dashboard-round-badge"),
    progress: document.getElementById("dashboard-progress"),
    balance: document.getElementById("dashboard-balance"),
    affordability: document.getElementById("dashboard-affordability"),
    segmentProgress: document.getElementById("dashboard-segment-progress"),
    modeLabel: document.getElementById("dashboard-mode-label"),
    bidBanner: document.getElementById("bid-banner"),
    placeBidBtn: document.getElementById("place-bid-btn"),
    bidControls: document.getElementById("bid-controls"),
    bidLog: document.getElementById("dashboard-bid-log"),
    roster: document.getElementById("dashboard-roster"),
    teamGrid: document.getElementById("dashboard-team-grid"),
    liveSetHeading: document.getElementById("dashboard-live-set-heading"),
    liveSetCopy: document.getElementById("dashboard-live-set-copy"),
    liveSetPill: document.getElementById("dashboard-live-set-pill"),
    liveSetList: document.getElementById("dashboard-live-set-list"),
    upcomingSets: document.getElementById("dashboard-upcoming-sets"),
    checklist: document.getElementById("dashboard-checklist"),
    soldOverlay: document.getElementById("dashboard-sold-overlay"),
    soldOverlayTitle: document.getElementById("dashboard-sold-overlay-title"),
    soldOverlayCopy: document.getElementById("dashboard-sold-overlay-copy"),
    chatLog: document.getElementById("dashboard-chat-log"),
    chatForm: document.getElementById("dashboard-chat-form"),
    chatInput: document.getElementById("dashboard-chat-input"),
    chatSend: document.getElementById("dashboard-chat-send"),
    completionPanel: document.getElementById("dashboard-completion"),
    resultsGrid: document.getElementById("dashboard-results-grid"),
    exportJsonBtn: document.getElementById("dashboard-export-json"),
    exportCsvBtn: document.getElementById("dashboard-export-csv")
  };

  let state = null;
  let selectedTeam = null;
  let previousLastBidder = null;
  let overlayTimeout = null;
  let activeSetCode = null;
  const TEAM_COLORS = ["#38bdf8", "#f59e0b", "#10b981", "#f472b6", "#a78bfa", "#fb7185", "#22c55e", "#f97316", "#14b8a6", "#eab308"];

  if (spectatorMode) {
    ui.title.textContent = "Spectator Dashboard";
    ui.selectionCopy.textContent = "Spectator mode is read-only for bidding. You can still follow and chat in the live auction room.";
  }

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
    ui.statusPill.className = `status-pill ${status}`;
    ui.statusPill.textContent = text;
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

  function getMyTeam() {
    return state && selectedTeam ? state.teams.find((team) => team.name === selectedTeam) : null;
  }

  function getChecklistKey() {
    return `auction_checklist_${selectedTeam || (spectatorMode ? "spectator" : "guest")}`;
  }

  function loadChecklist() {
    try {
      return JSON.parse(localStorage.getItem(getChecklistKey()) || "[]");
    } catch {
      return [];
    }
  }

  function saveChecklist(list) {
    localStorage.setItem(getChecklistKey(), JSON.stringify(list));
  }

  function renderSelection() {
    if (spectatorMode) {
      ui.selectionGrid.innerHTML = '<div class="selection-card"><strong>Spectator mode enabled</strong><p class="muted">Live data and chat are available below. Bidding is disabled.</p></div>';
      return;
    }

    const teams = state ? state.availableTeams : [];
    ui.selectionGrid.innerHTML = teams.length
      ? teams.map((teamName) => `
        <button class="selection-card btn btn-ghost" data-team-select="${teamName}">
          <strong>${teamName}</strong>
          <span class="muted">Join this team</span>
        </button>
      `).join("")
      : '<div class="selection-card"><strong>All teams are currently assigned.</strong><p class="muted">Waiting for admin or a team to become free.</p></div>';

    ui.selectionGrid.querySelectorAll("[data-team-select]").forEach((button) => {
      button.addEventListener("click", () => {
        selectedTeam = button.dataset.teamSelect;
        socket.emit("join-auction", { role: "participant", teamName: selectedTeam, spectator: false });
        ui.waitingMessage.classList.remove("hidden");
        ui.waitingMessage.textContent = `Joined ${selectedTeam}. Waiting for auction to start...`;
        renderChecklist();
      });
    });
  }

  function renderSetOptions() {
    const sets = Object.values(state?.playerSets || {});
    if (!sets.length) return;
    if (!activeSetCode || !sets.some((set) => set.setCode === activeSetCode)) {
      activeSetCode = sets[0].setCode;
    }
    const options = sets.map((set) => `<option value="${set.setCode}">${set.setCode} • ${set.setLabel}</option>`).join("");
    ui.setSelect.innerHTML = options;
    ui.setSelect.value = activeSetCode;
  }

  function toggleChecklistPlayer(playerName) {
    const checklist = loadChecklist();
    const next = checklist.includes(playerName)
      ? checklist.filter((entry) => entry !== playerName)
      : [...checklist, playerName];
    saveChecklist(next);
    renderChecklist();
    renderPlanningLists();
    renderLiveAuctionSets();
  }

  function renderPlanningList(container, setCode) {
    const set = (state?.playerSets || {})[setCode];
    if (!set) {
      container.innerHTML = '<div class="planning-item">No set data available yet.</div>';
      return;
    }
    const checklist = loadChecklist();
    container.innerHTML = set.players.map((player) => `
      <article class="planning-item">
        <div class="planning-item-head">
          <div>
            <strong>${player.name}</strong>
            <div class="muted">${player.role} • ${player.country}</div>
          </div>
          <span class="mini-pill">${player.status}</span>
        </div>
        <div class="planning-item-actions">
          <span class="mini-pill">${player.capped ? "Capped" : "Uncapped"}</span>
          <span class="mini-pill">${player.isOverseas ? "Overseas" : "Indian"}</span>
          <span class="mini-pill">${formatMoney(player.basePrice)}</span>
          <button class="btn btn-ghost" type="button" data-check-player="${player.name}">
            ${checklist.includes(player.name) ? "Remove from checklist" : "Add to checklist"}
          </button>
        </div>
      </article>
    `).join("");
    container.querySelectorAll("[data-check-player]").forEach((button) => {
      button.addEventListener("click", () => toggleChecklistPlayer(button.dataset.checkPlayer));
    });
  }

  function renderPlanningLists() {
    renderSetOptions();
    renderPlanningList(ui.setList, activeSetCode);
  }

  function getAuctionSetPlayerStatus(player) {
    if (player.isCurrent) {
      return "Now bidding";
    }
    if (player.status === "sold") {
      return player.soldTo ? `Sold to ${player.soldTo}` : "Sold";
    }
    if (player.status === "unsold") {
      return "Unsold";
    }
    return "Upcoming";
  }

  function renderAuctionSetList(container, auctionSet) {
    if (!auctionSet) {
      container.innerHTML = '<div class="planning-item">No live set is active right now.</div>';
      return;
    }

    const checklist = loadChecklist();
    container.innerHTML = auctionSet.players.map((player) => `
      <article class="planning-item ${player.isCurrent ? "planning-item-current" : ""}">
        <div class="planning-item-head">
          <div>
            <strong>${player.name}</strong>
            <div class="muted">${player.role} - ${player.country}</div>
          </div>
          <span class="mini-pill">${getAuctionSetPlayerStatus(player)}</span>
        </div>
        <div class="planning-item-actions">
          <span class="mini-pill">${player.capped ? "Capped" : "Uncapped"}</span>
          <span class="mini-pill">${player.isOverseas ? "Overseas" : "Indian"}</span>
          <span class="mini-pill">${formatMoney(player.basePrice)}</span>
          <button class="btn btn-ghost" type="button" data-check-player="${player.name}">
            ${checklist.includes(player.name) ? "Remove from checklist" : "Add to checklist"}
          </button>
        </div>
      </article>
    `).join("");

    container.querySelectorAll("[data-check-player]").forEach((button) => {
      button.addEventListener("click", () => toggleChecklistPlayer(button.dataset.checkPlayer));
    });
  }

  function renderUpcomingSets() {
    const upcomingSets = state?.upcomingAuctionSets || [];
    if (!upcomingSets.length) {
      ui.upcomingSets.innerHTML = '<div class="planning-item">No more future sets in this round.</div>';
      return;
    }

    const checklist = loadChecklist();
    ui.upcomingSets.innerHTML = upcomingSets.map((set) => `
      <article class="planning-set-card">
        <div class="planning-item-head">
          <div>
            <strong>${set.setCode} - ${set.setLabel}</strong>
            <div class="muted">${set.pendingCount} players waiting in this set</div>
          </div>
          <span class="mini-pill">Set ${set.position}/${set.totalSets}</span>
        </div>
        <div class="planning-set-players">
          ${set.players.map((player) => `
            <div class="planning-set-player">
              <div>
                <strong>${player.name}</strong>
                <div class="muted">${player.role} - ${player.country}</div>
              </div>
              <button class="btn btn-ghost" type="button" data-check-player="${player.name}">
                ${checklist.includes(player.name) ? "Watching" : "Watch"}
              </button>
            </div>
          `).join("")}
        </div>
      </article>
    `).join("");

    ui.upcomingSets.querySelectorAll("[data-check-player]").forEach((button) => {
      button.addEventListener("click", () => toggleChecklistPlayer(button.dataset.checkPlayer));
    });
  }

  function renderLiveAuctionSets() {
    const activeSet = state?.activeAuctionSet;
    if (!activeSet) {
      ui.liveSetHeading.textContent = "Waiting for the auction to start";
      ui.liveSetCopy.textContent = "The current set and next sets will appear here once bidding begins.";
      ui.liveSetPill.textContent = "No active set";
      renderAuctionSetList(ui.liveSetList, null);
      renderUpcomingSets();
      return;
    }

    ui.liveSetHeading.textContent = `${activeSet.setCode} - ${activeSet.setLabel}`;
    ui.liveSetCopy.textContent = `${activeSet.pendingCount} players still to come in this set. Use this board to plan the current stretch and the sets coming up next.`;
    ui.liveSetPill.textContent = `Set ${activeSet.position}/${activeSet.totalSets}`;
    renderAuctionSetList(ui.liveSetList, activeSet);
    renderUpcomingSets();
  }

  function renderChecklist() {
    const checklist = loadChecklist();
    ui.checklist.innerHTML = checklist.length
      ? checklist.map((name) => `
        <article class="planning-item">
          <div class="planning-item-head">
            <strong>${name}</strong>
            <button class="btn btn-ghost" type="button" data-remove-check="${name}">Remove</button>
          </div>
        </article>
      `).join("")
      : '<div class="planning-item">Your planning checklist is empty.</div>';
    ui.checklist.querySelectorAll("[data-remove-check]").forEach((button) => {
      button.addEventListener("click", () => toggleChecklistPlayer(button.dataset.removeCheck));
    });
  }

  function renderBidLog() {
    const items = (state.currentPlayerBids || []).slice().reverse();
    ui.bidLog.innerHTML = items.length
      ? items.map((entry) => `<li><strong>${entry.teamName}</strong>${formatMoney(entry.amount)}</li>`).join("")
      : "<li>No bids yet for this player.</li>";
  }

  function renderRoster() {
    const myTeam = getMyTeam();
    if (spectatorMode) {
      ui.roster.innerHTML = '<div class="roster-row"><span>Spectator mode has no personal roster.</span></div>';
      return;
    }

    ui.roster.innerHTML = myTeam && myTeam.acquiredPlayers.length
      ? myTeam.acquiredPlayers.map((player) => `
        <div class="roster-row">
          <div>
            <strong>${player.name}</strong>
            <div class="muted">${player.role} - ${player.country}</div>
          </div>
          <strong>${formatMoney(player.price)}</strong>
        </div>
      `).join("")
      : '<div class="roster-row"><span>No players acquired yet.</span></div>';
  }

  function renderTeams() {
    ui.teamGrid.innerHTML = state.teams.map((team) => {
      const spentPct = team.initialBalance <= 0 ? 0 : ((team.initialBalance - team.balance) / team.initialBalance) * 100;
      const highlight = team.name === state.lastBidder || (!spectatorMode && team.name === selectedTeam);
      const teamColor = getTeamColor(team.name);
      return `
        <article class="team-card team-accent ${highlight ? "highlight" : ""}" style="--team-accent:${teamColor}">
          <strong class="team-name-chip">${team.name}</strong>
          <div class="muted">${team.playersCount} players • ${team.overseasCount} overseas</div>
          <div class="team-balance">${formatMoney(team.balance)}</div>
          <div class="budget-bar"><span style="width:${Math.min(100, spentPct)}%;background:${budgetColor(team.balance, team.initialBalance)}"></span></div>
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
      : '<article class="chat-item"><p class="chat-message">No messages yet. Chat stays in sync for all connected viewers.</p></article>';
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

  function renderBanner() {
    const myTeam = getMyTeam();
    ui.bidBanner.className = "banner banner-neutral";

    if (state.status === "break") {
      ui.bidBanner.className = "banner banner-warning";
      ui.bidBanner.textContent = "Segment break in progress. The admin will resume shortly.";
      return;
    }

    if (spectatorMode) {
      ui.bidBanner.textContent = "Spectator mode is live. You are viewing a read-only stream.";
      return;
    }

    if (!selectedTeam) {
      ui.bidBanner.textContent = "Select a team to join the auction.";
      return;
    }

    if (state.lastBidder === selectedTeam) {
      ui.bidBanner.className = "banner banner-success";
      ui.bidBanner.textContent = "You are currently the highest bidder.";
      return;
    }

    if (previousLastBidder === selectedTeam && state.lastBidder && state.lastBidder !== selectedTeam) {
      ui.bidBanner.className = "banner banner-danger";
      ui.bidBanner.textContent = "You have been outbid.";
      return;
    }

    if (myTeam && state.nextBidAmount && myTeam.balance < state.nextBidAmount) {
      ui.bidBanner.className = "banner banner-warning";
      ui.bidBanner.textContent = "Insufficient balance for the next bid.";
      return;
    }

    ui.bidBanner.textContent = state.status === "running" ? "Auction is live. Stay ready for the next bid." : `Auction is ${state.status}.`;
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
    const myTeam = getMyTeam();
    const currentPlayer = state.currentPlayer;
    const canBid = !spectatorMode && myTeam && state.status === "running" && !state.currentPlayerClosed && state.lastBidder !== myTeam.name && myTeam.balance >= state.nextBidAmount && myTeam.canBuyCurrentPlayer;

    setStatusPill(state.status, state.status);
    renderTimerOnly();
    ui.roundBadge.textContent = state.activeAuctionSet ? `Round ${state.round} - ${state.activeAuctionSet.setCode}` : `Round ${state.round}`;
    ui.progress.textContent = `${state.progress.current} / ${state.progress.total}`;
    ui.segmentProgress.textContent = `${(state.progress.segmentProgress || 0) + 1} / ${state.progress.segmentSize || 15}`;
    ui.modeLabel.textContent = state.status === "break" ? "Segment Break" : state.status;
    ui.balance.textContent = myTeam ? formatMoney(myTeam.balance) : spectatorMode ? "Read-only" : "Rs 0 Cr";
    ui.affordability.textContent = spectatorMode
      ? "Spectators can follow the action and chat live."
      : myTeam
        ? myTeam.canBuyCurrentPlayer
          ? `You can bid up to ${formatMoney(myTeam.balance)} right now. Squad: ${myTeam.squadCount}/25, Overseas: ${myTeam.overseasCount}/8.`
          : `This player would break your squad rules. Squad: ${myTeam.squadCount}/25, Overseas: ${myTeam.overseasCount}/8.`
        : "Select a team to see affordability.";
    ui.lastBidder.textContent = state.lastBidder || "No bids yet";
    ui.liveStatus.textContent = state.status === "break" ? "Segment break in progress" : state.status === "running" ? "Bidding is live" : state.status === "paused" ? "Auction paused" : state.status === "waiting" ? "Waiting for admin" : "Auction completed";

    if (currentPlayer) {
      ui.playerName.textContent = currentPlayer.name;
      ui.playerMeta.textContent = `${currentPlayer.role} - ${currentPlayer.country} - ${currentPlayer.setLabel}`;
      ui.currentPrice.textContent = `${state.currentBid === null ? "Base" : "Current"} ${formatMoney(state.currentBid === null ? state.openingBid : state.currentBid)}`;
    } else {
      ui.playerName.textContent = state.status === "ended" ? "Auction completed" : "Waiting for player";
      ui.playerMeta.textContent = "Role and country will appear here.";
      ui.currentPrice.textContent = "Rs 0 Cr";
    }

    ui.selectionPanel.classList.toggle("hidden", spectatorMode || Boolean(selectedTeam));
    ui.liveView.classList.remove("hidden");
    ui.breakPanel.classList.toggle("hidden", !(state.status === "break" && state.segmentBreak));
    ui.placeBidBtn.disabled = !canBid;
    if (spectatorMode) {
      ui.bidControls.classList.add("hidden");
      ui.chatInput.placeholder = "Send a message as a spectator";
      ui.chatSend.disabled = false;
    } else {
      ui.bidControls.classList.remove("hidden");
      ui.placeBidBtn.textContent = canBid ? `Place Bid (${formatMoney(state.nextBidAmount)})` : myTeam && !myTeam.canBuyCurrentPlayer ? "Squad Limit Reached" : myTeam && state.nextBidAmount && myTeam.balance < state.nextBidAmount ? "Insufficient Balance" : "Place Bid";
      ui.chatSend.disabled = !selectedTeam;
      ui.chatInput.placeholder = selectedTeam ? "Chat with the admin, teams, and spectators" : "Select a team before chatting";
    }

    renderBanner();
    renderBidLog();
    renderRoster();
    renderTeams();
    renderPlanningLists();
    renderLiveAuctionSets();
    renderChecklist();
    renderChat();
    renderBreakPanel();
    renderCompletion();
    previousLastBidder = state.lastBidder;
  }

  ui.placeBidBtn.addEventListener("click", () => {
    if (!selectedTeam || !state || !state.nextBidAmount) return;
    socket.emit("place-bid", { teamName: selectedTeam, amount: state.nextBidAmount, playerName: state.currentPlayer ? state.currentPlayer.name : null });
  });
  ui.exportJsonBtn.addEventListener("click", exportJson);
  ui.exportCsvBtn.addEventListener("click", exportCsv);
  ui.setSelect.addEventListener("change", (event) => {
    activeSetCode = event.target.value;
    renderPlanningLists();
  });
  ui.chatForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const message = ui.chatInput.value.trim();
    if (!message || ui.chatSend.disabled) return;
    socket.emit("send-chat-message", { message });
    ui.chatInput.value = "";
  });

  socket.on("connect", () => {
    setStatusPill("Connected", "waiting");
    if (spectatorMode) {
      socket.emit("join-auction", { role: "participant", spectator: true });
    }
  });

  socket.on("disconnect", () => {
    setStatusPill("Disconnected", "paused");
  });

  socket.on("auction-state-update", (nextState) => {
    state = nextState;
    renderSelection();
    renderState();
  });

  socket.on("timer-update", (payload) => {
    if (!state) return;
    state.timerRemaining = payload.secondsRemaining;
    renderTimerOnly();
  });

  socket.on("error-message", (payload) => {
    window.alert(payload.message);
    if (selectedTeam && state && !(state.connectedParticipants || []).some((participant) => participant.teamName === selectedTeam)) {
      selectedTeam = null;
      ui.waitingMessage.classList.add("hidden");
    }
    renderSelection();
    if (state) renderState();
  });

  socket.on("player-marked-sold", (payload) => {
    showSoldOverlay(payload.player, payload.winningTeam, payload.finalPrice);
  });
})();
