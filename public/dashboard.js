const socket = io();

const refs = {
  dashboardStatusBadge: document.getElementById("dashboardStatusBadge"),
  teamSelect: document.getElementById("teamSelect"),
  joinBtn: document.getElementById("joinBtn"),
  dashboardRound: document.getElementById("dashboardRound"),
  dashboardProgress: document.getElementById("dashboardProgress"),
  dashboardCurrentBid: document.getElementById("dashboardCurrentBid"),
  dashboardNextBid: document.getElementById("dashboardNextBid"),
  bidBtn: document.getElementById("bidBtn"),
  dashboardMessage: document.getElementById("dashboardMessage"),
  dashboardPlayerCard: document.getElementById("dashboardPlayerCard"),
  myTeamBalance: document.getElementById("myTeamBalance"),
  dashboardLastBidder: document.getElementById("dashboardLastBidder"),
  dashboardParticipants: document.getElementById("dashboardParticipants"),
  bidHistoryList: document.getElementById("bidHistoryList"),
  myPlayersList: document.getElementById("myPlayersList"),
  myTeamName: document.getElementById("myTeamName"),
  dashboardTeamsBoard: document.getElementById("dashboardTeamsBoard")
};

let latestState = null;
let selectedTeam = "";

function formatCrore(value) {
  return `${Number(value).toFixed(1).replace(".0", "")} Cr`;
}

function setMessage(message) {
  refs.dashboardMessage.textContent = message;
}

function populateTeams(teams) {
  const currentValue = refs.teamSelect.value;
  refs.teamSelect.innerHTML = "";
  teams.forEach((team) => {
    const option = document.createElement("option");
    option.value = team.name;
    option.textContent = team.name;
    refs.teamSelect.appendChild(option);
  });

  refs.teamSelect.value = selectedTeam || currentValue || (teams[0] ? teams[0].name : "");
}

function renderPlayerCard(player, roundBasePrice) {
  if (!player) {
    refs.dashboardPlayerCard.className = "player-card empty-state";
    refs.dashboardPlayerCard.textContent = "Waiting for the next player.";
    return;
  }

  refs.dashboardPlayerCard.className = "player-card";
  refs.dashboardPlayerCard.innerHTML = `
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

function renderBidHistory(bidHistory) {
  refs.bidHistoryList.innerHTML = "";
  if (!bidHistory.length) {
    refs.bidHistoryList.innerHTML = "<li>No bids yet.</li>";
    return;
  }

  bidHistory
    .slice()
    .reverse()
    .forEach((entry) => {
      const item = document.createElement("li");
      item.textContent = `${entry.teamName} bid ${formatCrore(entry.amount)}`;
      refs.bidHistoryList.appendChild(item);
    });
}

function renderMyTeam(team) {
  refs.myTeamName.textContent = team ? team.name : "No Team";
  refs.myTeamBalance.textContent = `Balance: ${team ? formatCrore(team.balance) : "-"}`;
  refs.myPlayersList.innerHTML = "";

  if (!team || !team.players.length) {
    refs.myPlayersList.innerHTML = "<li>No players acquired yet.</li>";
    return;
  }

  team.players.forEach((player) => {
    const item = document.createElement("li");
    item.textContent = `${player.name} - ${formatCrore(player.price)}`;
    refs.myPlayersList.appendChild(item);
  });
}

function renderTeams(teams) {
  refs.dashboardTeamsBoard.innerHTML = "";
  teams.forEach((team) => {
    const card = document.createElement("article");
    card.className = "team-card";
    card.innerHTML = `
      <div class="team-card-header">
        <h3>${team.name}</h3>
        <span class="pill pill-dark">${formatCrore(team.balance)}</span>
      </div>
      <p class="muted">Players Bought: ${team.players.length}</p>
      <ul class="mini-list">
        ${team.players.map((player) => `<li>${player.name} - ${formatCrore(player.price)}</li>`).join("") || "<li>No players acquired.</li>"}
      </ul>
    `;
    refs.dashboardTeamsBoard.appendChild(card);
  });
}

function updateBidButton(team, state) {
  const nextBid = Number(state.nextBidAmount || 0);
  const canBid =
    team &&
    state.currentPlayer &&
    state.auctionStatus === "active" &&
    state.lastBidder !== team.name &&
    team.balance >= nextBid;

  refs.bidBtn.disabled = !canBid;

  if (!selectedTeam) {
    setMessage("Choose your team to join live bidding.");
    return;
  }

  if (!state.currentPlayer) {
    setMessage("No player is live right now.");
    return;
  }

  if (state.auctionStatus !== "active") {
    setMessage(`Auction is currently ${state.auctionStatus}.`);
    return;
  }

  if (state.lastBidder === selectedTeam) {
    setMessage("Your team placed the most recent bid.");
    return;
  }

  if (team && team.balance < nextBid) {
    setMessage("Your team cannot afford the next bid.");
    return;
  }

  setMessage(`Ready to bid ${formatCrore(nextBid)} for ${state.currentPlayer.name}.`);
}

function renderState(state) {
  latestState = state;
  populateTeams(state.teams || []);

  refs.dashboardStatusBadge.textContent = state.auctionStatus;
  refs.dashboardStatusBadge.className = `status-badge ${state.auctionStatus}`;
  refs.dashboardRound.textContent = state.round;
  refs.dashboardProgress.textContent = `${state.progress.current} / ${state.progress.total}`;
  refs.dashboardCurrentBid.textContent = formatCrore(Math.max(state.currentBid, 0));
  refs.dashboardNextBid.textContent = formatCrore(Math.max(state.nextBidAmount, 0));
  refs.dashboardLastBidder.textContent = state.lastBidder || "-";
  refs.dashboardParticipants.textContent = (state.connectedParticipants || []).length;

  const roundBasePrice = state.round === 1
    ? Number(state.config.BASE_PRICE_ROUND1)
    : Number(state.config.BASE_PRICE_ROUND2);

  renderPlayerCard(state.currentPlayer, roundBasePrice);
  renderBidHistory(state.bidHistory || []);
  renderTeams(state.teams || []);

  const myTeam = (state.teams || []).find((team) => team.name === selectedTeam);
  renderMyTeam(myTeam);
  updateBidButton(myTeam, state);
}

socket.on("auction-state-update", (state) => {
  renderState(state);
});

socket.on("player-sold", (payload) => {
  setMessage(`${payload.playerName} sold to ${payload.teamName} for ${formatCrore(payload.amount)}.`);
});

socket.on("player-unsold", (payload) => {
  setMessage(`${payload.playerName} went unsold in round ${payload.round}.`);
});

socket.on("round-changed", (payload) => {
  setMessage(`Round ${payload.round} started with ${payload.playerCount} players.`);
});

socket.on("auction-ended", () => {
  setMessage("Auction completed. Review the final team squads below.");
});

socket.on("error-message", (payload) => {
  setMessage(payload.message);
});

refs.joinBtn.addEventListener("click", () => {
  selectedTeam = refs.teamSelect.value;
  socket.emit("join-auction", {
    role: "participant",
    teamName: selectedTeam,
    name: selectedTeam
  });

  refs.myTeamName.textContent = selectedTeam;
  setMessage(`Joined as ${selectedTeam}.`);
  if (latestState) {
    renderState(latestState);
  }
});

refs.bidBtn.addEventListener("click", () => {
  if (!selectedTeam) {
    setMessage("Join a team before placing bids.");
    return;
  }

  socket.emit("place-bid", selectedTeam);
});
