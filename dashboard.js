(function () {
  const socket = io();
  const params = new URLSearchParams(window.location.search);
  const spectatorMode = params.get("mode") === "spectate";
  const ui = {
    title: document.getElementById("dashboard-title"),
    statusPill: document.getElementById("dashboard-status-pill"),
    timer: document.getElementById("dashboard-timer"),
    selectionPanel: document.getElementById("team-selection-panel"),
    selectionGrid: document.getElementById("team-selection-grid"),
    selectionCopy: document.getElementById("selection-copy"),
    waitingMessage: document.getElementById("waiting-message"),
    liveView: document.getElementById("dashboard-live-view"),
    playerName: document.getElementById("dashboard-player-name"),
    playerMeta: document.getElementById("dashboard-player-meta"),
    currentPrice: document.getElementById("dashboard-current-price"),
    lastBidder: document.getElementById("dashboard-last-bidder"),
    roundBadge: document.getElementById("dashboard-round-badge"),
    progress: document.getElementById("dashboard-progress"),
    balance: document.getElementById("dashboard-balance"),
    bidBanner: document.getElementById("bid-banner"),
    placeBidBtn: document.getElementById("place-bid-btn"),
    bidControls: document.getElementById("bid-controls"),
    bidLog: document.getElementById("dashboard-bid-log"),
    roster: document.getElementById("dashboard-roster"),
    teamGrid: document.getElementById("dashboard-team-grid"),
    completionPanel: document.getElementById("dashboard-completion"),
    resultsGrid: document.getElementById("dashboard-results-grid"),
    exportJsonBtn: document.getElementById("dashboard-export-json"),
    exportCsvBtn: document.getElementById("dashboard-export-csv")
  };

  let state = null;
  let selectedTeam = null;
  let previousLastBidder = null;

  if (spectatorMode) {
    ui.title.textContent = "Spectator Dashboard";
    ui.selectionCopy.textContent = "Spectator mode is read-only. You can follow the live auction without selecting a team.";
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

  function renderSelection() {
    if (spectatorMode) {
      ui.selectionGrid.innerHTML = '<div class="selection-card"><strong>Spectator mode enabled</strong><p class="muted">Live data will appear below. Bidding is disabled.</p></div>';
      return;
    }

    const teams = state ? state.availableTeams : [];
    ui.selectionGrid.innerHTML = teams.length
      ? teams.map((teamName) => `
        <button class="selection-card btn btn-ghost" data-team-select="${teamName}">
          <strong>${teamName}</strong>
        </button>
      `).join("")
      : '<div class="selection-card"><strong>All teams are currently assigned.</strong><p class="muted">Waiting for admin or a team to become free.</p></div>';

    ui.selectionGrid.querySelectorAll("[data-team-select]").forEach((button) => {
      button.addEventListener("click", () => {
        selectedTeam = button.dataset.teamSelect;
        socket.emit("join-auction", { role: "participant", teamName: selectedTeam, spectator: false });
        ui.waitingMessage.classList.remove("hidden");
        ui.waitingMessage.textContent = `Joined ${selectedTeam}. Waiting for auction to start...`;
      });
    });
  }

  function renderBidLog() {
    const items = (state.currentPlayerBids || []).slice().reverse();
    ui.bidLog.innerHTML = items.length
      ? items.map((entry) => `<li>${entry.teamName} bid ${formatMoney(entry.amount)}</li>`).join("")
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
            <div class="muted">${player.role} • ${player.country}</div>
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
      return `
        <article class="team-card ${highlight ? "highlight" : ""}">
          <strong>${team.name}</strong>
          <div class="muted">${team.playersCount} players</div>
          <div class="team-balance">${formatMoney(team.balance)}</div>
          <div class="budget-bar"><span style="width:${Math.min(100, spentPct)}%;background:${budgetColor(team.balance, team.initialBalance)}"></span></div>
        </article>
      `;
    }).join("");
  }

  function renderBanner() {
    const myTeam = getMyTeam();
    ui.bidBanner.className = "banner banner-neutral";

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
      ui.bidBanner.textContent = "You're highest bidder.";
      return;
    }

    if (previousLastBidder === selectedTeam && state.lastBidder && state.lastBidder !== selectedTeam) {
      ui.bidBanner.className = "banner banner-danger";
      ui.bidBanner.textContent = "You've been outbid!";
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
    const canBid = !spectatorMode && myTeam && state.status === "running" && !state.currentPlayerClosed && state.lastBidder !== myTeam.name && myTeam.balance >= state.nextBidAmount;

    ui.selectionPanel.classList.toggle("hidden", spectatorMode || Boolean(selectedTeam));
    ui.liveView.classList.remove("hidden");
    ui.statusPill.textContent = state.status;
    ui.timer.textContent = currentPlayer ? `${state.timerRemaining}s` : "--";
    ui.roundBadge.textContent = `Round ${state.round}`;
    ui.progress.textContent = `${state.progress.current} / ${state.progress.total}`;
    ui.balance.textContent = myTeam ? formatMoney(myTeam.balance) : spectatorMode ? "Read-only" : "Rs 0 Cr";
    ui.lastBidder.textContent = state.lastBidder || "No bids yet";

    if (currentPlayer) {
      ui.playerName.textContent = currentPlayer.name;
      ui.playerMeta.textContent = `${currentPlayer.role} • ${currentPlayer.country}`;
      ui.currentPrice.textContent = `${state.currentBid === null ? "Base" : "Current"} ${formatMoney(state.currentBid === null ? state.openingBid : state.currentBid)}`;
    } else {
      ui.playerName.textContent = state.status === "ended" ? "Auction completed" : "Waiting for player";
      ui.playerMeta.textContent = "Role and country will appear here.";
      ui.currentPrice.textContent = "Rs 0 Cr";
    }

    ui.placeBidBtn.disabled = !canBid;
    if (spectatorMode) {
      ui.bidControls.classList.add("hidden");
    } else {
      ui.bidControls.classList.remove("hidden");
      ui.placeBidBtn.textContent = canBid ? `Place Bid (${formatMoney(state.nextBidAmount)})` : myTeam && state.nextBidAmount && myTeam.balance < state.nextBidAmount ? "Insufficient Balance" : "Place Bid";
    }

    renderBanner();
    renderBidLog();
    renderRoster();
    renderTeams();
    renderCompletion();
    previousLastBidder = state.lastBidder;
  }

  ui.placeBidBtn.addEventListener("click", () => {
    if (!selectedTeam || !state || !state.nextBidAmount) return;
    socket.emit("place-bid", { teamName: selectedTeam, amount: state.nextBidAmount, playerName: state.currentPlayer ? state.currentPlayer.name : null });
  });
  ui.exportJsonBtn.addEventListener("click", exportJson);
  ui.exportCsvBtn.addEventListener("click", exportCsv);

  socket.on("connect", () => {
    ui.statusPill.textContent = "Connected";
    if (spectatorMode) {
      socket.emit("join-auction", { role: "participant", spectator: true });
    }
  });

  socket.on("disconnect", () => {
    ui.statusPill.textContent = "Disconnected";
  });

  socket.on("auction-state-update", (nextState) => {
    state = nextState;
    renderSelection();
    renderState();
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
})();
