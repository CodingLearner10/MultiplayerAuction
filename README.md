# MultiplayerAuction

A real-time IPL-style player auction web app with an admin control panel, live participant dashboards, spectator mode, and an offline-capable single-player mode.

Built with Node.js, Express, Socket.IO, and vanilla HTML, CSS, and JavaScript.

## Features

- Real-time multiplayer bidding with WebSocket updates
- Admin dashboard for starting, pausing, selling, marking unsold, advancing players, and resetting the auction
- Participant dashboard with live team balance, outbid alerts, acquired players, and bid history
- Spectator mode for read-only live viewing
- Single-player mode with local save/resume support
- Two-round auction flow with unsold players automatically moving into Round 2
- Config-driven base prices, bid increment, and bid timer
- Budget tracker bars for every team
- Admin bid override support
- Replay log export as CSV
- Auction results export as JSON

## Tech Stack

- Node.js
- Express
- Socket.IO
- Vanilla HTML5
- Vanilla CSS3
- Vanilla JavaScript (ES6+)

## Project Structure

```text
project/
├── index.html
├── admin.html
├── dashboard.html
├── style.css
├── app.js
├── admin.js
├── dashboard.js
├── server.js
├── package.json
├── players.json
├── teams.json
├── config.json
└── README.md
```

## Getting Started

### 1. Install dependencies

```bash
npm install
```

### 2. Start the server

```bash
node server.js
```

By default, the app runs on:

```text
http://localhost:5000
```

## App URLs

- Single-player: `http://localhost:5000/`
- Admin panel: `http://localhost:5000/admin.html`
- Participant dashboard: `http://localhost:5000/dashboard.html`
- Spectator mode: `http://localhost:5000/dashboard.html?mode=spectate`

## How It Works

### Single-Player Mode

- Start a new auction from the home page
- Resume a saved auction using localStorage
- Run through Round 1 and Round 2
- Export final results as JSON
- Export the replay log as CSV

### Multiplayer Mode

1. The admin opens `admin.html`
2. Participants open `dashboard.html`
3. Each participant selects an available team
4. The admin starts the auction
5. Bidding happens live across all connected clients
6. The admin marks players as sold or unsold and moves to the next player

## Auction Rules

- The server is the single source of truth for multiplayer mode
- Bids are validated server-side
- Teams cannot bid above their balance
- Bids must follow the configured increment
- The same team cannot bid twice in a row
- The bid timer resets after each valid bid
- If the timer expires, the player is automatically marked unsold

## Configuration

Edit [config.json](./config.json) to change auction behavior:

```json
{
  "BASE_PRICE_ROUND1": 2,
  "BASE_PRICE_ROUND2": 1,
  "BID_INCREMENT": 0.5,
  "BID_TIMER_SECONDS": 30
}
```

You can also replace:

- [players.json](./players.json)
- [teams.json](./teams.json)

without changing the code.

## Deployment Notes

For remote multiplayer sessions, you can:

- run it locally and expose it with Cloudflare Tunnel
- deploy it to a Node-friendly host like Render or Railway

Important:

- multiplayer state is currently stored in memory on the server
- restarting the server resets the live auction state

## Future Improvements

- persistent database-backed multiplayer state
- room-based auctions for multiple simultaneous leagues
- authentication for admin access
- team logos and richer UI polish
- automated tests for bid concurrency and reconnect flows

## License

This project is for learning and personal use.
