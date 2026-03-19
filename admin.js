(function () {
  const socket = io();
  const ui = {
    connectionStatus: document.getElementById("admin-connection-status"),
    timer: document.getElementById("admin-timer"),
    playerName: document.getElementById("admin-player-name"),
    playerMeta: document.getElementById("admin-player-meta"),
    currentPrice: document.getElementById("admin-current-price"),
    lastBidder: document.getElementById("admin-last-bidder"),
    roundBadge: document.getElementById("admin-round-badge"),
    progress: document.getElementById("admin-progress"),
    participantCount: document.getElementById("admin-participant-count"),
    statusCopy: document.getElementById("admin-status-copy"),
    bidLog: document.getElementById("admin-bid-log"),
    participantsList: document.getElementById("admin-participants-list"),
    teamGrid: document.getElementById("admin-team-grid"),
    chatLog: document.getElementById("admin-chat-log"),
    chatForm: document.getElementById("admin-chat-form"),
    chatInput: document.getElementById("admin-chat-input"),
    startBtn: document.getElementById("admin-start-btn"),
    pauseBtn: document.getElementById("admin-pause-btn"),
    soldBtn: document.getElementById("admin-sold-btn"),
    unsoldBtn: document.getElementById("admin-unsold-btn"),
    nextBtn: document.getElementById("admin-next-btn"),
    resetBtn: document.getElementById("admin-reset-btn"),
    overrideTeamSelect: document.getElementById("override-team-select"),
    overrideAmountInput: document.getElementById("override-amount-input"),
    overrideApplyBtn: document.getElementById("override-apply-btn"),
    completionPanel: document.getElementById("admin-completion"),
    resultsGrid: document.getElementById("admin-results-grid"),
    exportJsonBtn: document.getElementById("admin-export-json"),
    exportCsvBtn: document.getElementById("admin-export-csv")
  };

  let state = null;

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

  function renderParticipants() {
    const participants = state.connectedParticipants || [];
    ui.participantsList.innerHTML = participants.length
      ? participants.map((participant) => `<li>${participant.role === "admin" ? "Admin" : participant.spectator ? "Spectator" : participant.teamName || "Participant"}</li>`).join("")
      : "<li>No participants connected.</li>";
  }

  function renderBidLog() {
    const items = (state.currentPlayerBids || []).slice(-5).reverse();
    ui.bidLog.innerHTML = items.length
      ? items.map((entry) => `<li>${entry.teamName} bid ${formatMoney(entry.amount)}</li>`).join("")
      : "<li>No bids for the current player yet.</li>";
  }

  function renderTeams() {
    ui.teamGrid.innerHTML = state.teams.map((team) => {
      const spentPct = team.initialBalance <= 0 ? 0 : ((team.initialBalance - team.balance) / team.initialBalance) * 100;
      const isHighest = team.name === state.lastBidder;
      return `
        <article class="team-card ${isHighest ? "highlight" : ""}">
          <div class="team-card-head">
            <div>
              <strong>${team.name}</strong>
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

    ui.connectionStatus.textContent = `Connected • ${state.status}`;
    ui.timer.textContent = currentPlayer ? `${state.timerRemaining}s` : "--";
    ui.roundBadge.textContent = `Round ${state.round}`;
    ui.progress.textContent = `${state.progress.current} / ${state.progress.total}`;
    ui.participantCount.textContent = String(state.connectedParticipantCount || 0);
    ui.statusCopy.textContent = `Status: ${state.status}. Available teams: ${(state.availableTeams || []).length}.`;
    ui.lastBidder.textContent = state.lastBidder || "No bids yet";
    ui.currentPrice.textContent = currentPlayer
      ? `${state.currentBid === null ? "Base" : "Current"} ${formatMoney(state.currentBid === null ? state.openingBid : state.currentBid)}`
      : "Rs 0 Cr";

    if (currentPlayer) {
      ui.playerName.textContent = currentPlayer.name;
      ui.playerMeta.textContent = `${currentPlayer.role} • ${currentPlayer.country}`;
    } else {
      ui.playerName.textContent = state.status === "ended" ? "Auction completed" : "Waiting for auction to start";
      ui.playerMeta.textContent = "Role and country will appear here.";
    }

    ui.pauseBtn.disabled = state.status !== "running";
    ui.soldBtn.disabled = !state.lastBidder || state.currentPlayerClosed || state.status === "ended";
    ui.unsoldBtn.disabled = !state.currentPlayer || state.currentPlayerClosed || state.status === "ended";
    ui.nextBtn.disabled = !state.currentPlayerClosed || state.status === "ended";
    ui.overrideApplyBtn.disabled = !state.currentPlayer || state.currentPlayerClosed || state.status !== "running";
    ui.overrideTeamSelect.innerHTML = state.teams.map((team) => `<option value="${team.name}">${team.name}</option>`).join("");

    renderParticipants();
    renderBidLog();
    renderTeams();
    renderChat();
    renderCompletion();
  }

  ui.startBtn.addEventListener("click", () => socket.emit("admin-start-auction"));
  ui.pauseBtn.addEventListener("click", () => socket.emit("admin-pause-auction"));
  ui.soldBtn.addEventListener("click", () => socket.emit("admin-mark-sold"));
  ui.unsoldBtn.addEventListener("click", () => socket.emit("admin-mark-unsold"));
  ui.nextBtn.addEventListener("click", () => socket.emit("admin-next-player"));
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
    ui.connectionStatus.textContent = "Connected";
    socket.emit("join-auction", { role: "admin" });
  });

  socket.on("disconnect", () => {
    ui.connectionStatus.textContent = "Disconnected";
  });

  socket.on("auction-state-update", (nextState) => {
    state = nextState;
    renderState();
  });

  socket.on("error-message", (payload) => {
    window.alert(payload.message);
  });
})();
