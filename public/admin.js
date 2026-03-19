const socket = io();

const refs = {
  adminStatusBadge: document.getElementById("adminStatusBadge"),
  adminPlayerCard: document.getElementById("adminPlayerCard"),
  adminRound: document.getElementById("adminRound"),
  adminProgress: document.getElementById("adminProgress"),
  adminCurrentBid: document.getElementById("adminCurrentBid"),
  adminLastBidder: document.getElementById("adminLastBidder"),
  adminStartBtn: document.getElementById("adminStartBtn"),
  adminSoldBtn: document.getElementById("adminSoldBtn"),
  adminUnsoldBtn: document.getElementById("adminUnsoldBtn"),
  adminNextBtn: document.getElementById("adminNextBtn"),
  adminResetBtn: document.getElementById("adminResetBtn"),
  participantCount: document.getElementById("participantCount"),
  participantsList: document.getElementById("participantsList"),
  adminTeamsBoard: document.getElementById("adminTeamsBoard"),
  adminEventFeed: document.getElementById("adminEventFeed")
};

function formatCrore(value) {
  return `${Number(value).toFixed(1).replace(".0", "")} Cr`;
}

function addFeedItem(text) {
  const item = document.createElement("li");
  item.textContent = `${new Date().toLocaleTimeString()} - ${text}`;
  refs.adminEventFeed.prepend(item);
}

function renderPlayerCard(player, roundBasePrice) {
  if (!player) {
    refs.adminPlayerCard.className = "player-card empty-state";
    refs.adminPlayerCard.textContent = "No active player on the podium.";
    return;
  }

  refs.adminPlayerCard.className = "player-card";
  refs.adminPlayerCard.innerHTML = `
    <div class="player-header">
      <div>
        <p class="eyebrow">Current Player</p>
        <h2>${player.name}</h2>
      </div>
      <span class="pill">${player.role}</span>
    </div>
    <div class="player-meta">
      <span>${player.country}</span>
      <span>Opening Price: ${formatCrore(Math.max(roundBasePrice, Number(player.basePrice)))}</span>
    </div>
  `;
}

function renderParticipants(participants) {
  refs.participantCount.textContent = `${participants.length} Online`;
  refs.participantsList.innerHTML = "";

  if (!participants.length) {
    refs.participantsList.innerHTML = "<li>No participants connected.</li>";
    return;
  }

  participants.forEach((participant) => {
    const item = document.createElement("li");
    item.textContent = `${participant.name} (${participant.role}${participant.teamName ? ` - ${participant.teamName}` : ""})`;
    refs.participantsList.appendChild(item);
  });
}

function renderTeams(teams) {
  refs.adminTeamsBoard.innerHTML = "";
  teams.forEach((team) => {
    const card = document.createElement("article");
    card.className = "team-card";
    card.innerHTML = `
      <div class="team-card-header">
        <h3>${team.name}</h3>
        <span class="pill pill-dark">${formatCrore(team.balance)}</span>
      </div>
      <p class="muted">Initial Balance: ${formatCrore(team.initialBalance)}</p>
      <p class="muted">Players Bought: ${team.players.length}</p>
      <ul class="mini-list">
        ${team.players.map((player) => `<li>${player.name} - ${formatCrore(player.price)}</li>`).join("") || "<li>No players acquired.</li>"}
      </ul>
    `;
    refs.adminTeamsBoard.appendChild(card);
  });
}

function renderState(state) {
  const roundBasePrice = state.round === 1
    ? Number(state.config.BASE_PRICE_ROUND1)
    : Number(state.config.BASE_PRICE_ROUND2);

  refs.adminStatusBadge.textContent = state.auctionStatus;
  refs.adminStatusBadge.className = `status-badge ${state.auctionStatus}`;
  refs.adminRound.textContent = state.round;
  refs.adminProgress.textContent = `${state.progress.current} / ${state.progress.total}`;
  refs.adminCurrentBid.textContent = formatCrore(Math.max(state.currentBid, 0));
  refs.adminLastBidder.textContent = state.lastBidder || "-";

  renderPlayerCard(state.currentPlayer, roundBasePrice);
  renderParticipants(state.connectedParticipants || []);
  renderTeams(state.teams || []);

  refs.adminSoldBtn.disabled = !(state.currentPlayer && state.lastBidder);
  refs.adminUnsoldBtn.disabled = !state.currentPlayer || state.auctionStatus !== "active";
  refs.adminNextBtn.disabled = state.auctionStatus !== "paused";
}

socket.emit("join-auction", {
  role: "admin",
  name: "Auction Admin"
});

socket.on("auction-state-update", (state) => {
  renderState(state);
});

socket.on("bid-placed", (payload) => {
  addFeedItem(`${payload.teamName} bid ${formatCrore(payload.amount)} for ${payload.playerName}`);
});

socket.on("player-sold", (payload) => {
  addFeedItem(`${payload.playerName} sold to ${payload.teamName} for ${formatCrore(payload.amount)}`);
});

socket.on("player-unsold", (payload) => {
  addFeedItem(`${payload.playerName} marked unsold in round ${payload.round}`);
});

socket.on("next-player", (payload) => {
  addFeedItem(`Moved to ${payload.currentPlayer ? payload.currentPlayer.name : "the next player"} in round ${payload.round}`);
});

socket.on("round-changed", (payload) => {
  addFeedItem(`Round ${payload.round} started with ${payload.playerCount} unsold players.`);
});

socket.on("auction-ended", () => {
  addFeedItem("Auction completed.");
});

socket.on("participant-joined", (payload) => {
  addFeedItem(`${payload.name} joined the auction.`);
});

socket.on("participant-left", (payload) => {
  addFeedItem(`${payload.name} left the auction.`);
});

socket.on("error-message", (payload) => {
  addFeedItem(`Error: ${payload.message}`);
});

refs.adminStartBtn.addEventListener("click", () => {
  socket.emit("admin-start-auction");
});

refs.adminSoldBtn.addEventListener("click", () => {
  socket.emit("admin-mark-sold");
});

refs.adminUnsoldBtn.addEventListener("click", () => {
  socket.emit("admin-mark-unsold");
});

refs.adminNextBtn.addEventListener("click", () => {
  socket.emit("admin-next-player");
});

refs.adminResetBtn.addEventListener("click", () => {
  if (window.confirm("Reset the entire auction state?")) {
    socket.emit("admin-reset-auction");
  }
});
