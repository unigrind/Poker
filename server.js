// server.js
const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const { v4: uuidv4 } = require("uuid");
const { Hand } = require("pokersolver");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static("public"));
const PORT = process.env.PORT || 3000;

/** ---------- In-memory table state ---------- **/
const TABLE = {
  seats: Array(6).fill(null), // seat -> playerId or null
  players: {}, // playerId -> player object
  game: null, // active game or null
  dealerIndex: 0, // Persistent dealer button position
};

function mkDeck() {
  const suits = ["s", "h", "d", "c"];
  const ranks = [
    "2",
    "3",
    "4",
    "5",
    "6",
    "7",
    "8",
    "9",
    "T",
    "J",
    "Q",
    "K",
    "A",
  ];
  const deck = [];
  for (const r of ranks) for (const s of suits) deck.push(r + s);
  return deck;
}

function shuffle(deck) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
}

/** ---------- Helpers ---------- **/
function broadcast(msg) {
  const s = JSON.stringify(msg);
  wss.clients.forEach((c) => {
    if (c.readyState === WebSocket.OPEN) c.send(s);
  });
}

function sendTo(player, msg) {
  try {
    if (player?.ws?.readyState === WebSocket.OPEN)
      player.ws.send(JSON.stringify(msg));
  } catch {}
}

function activePlayers(game) {
  return game.seatOrder
    .map((s) => TABLE.players[s.pId])
    .filter((p) => p && p.active && !p.folded);
}

function nextActiveIndex(game, fromIndex) {
  const L = game.seatOrder.length;
  for (let step = 1; step <= L; step++) {
    const idx = (fromIndex + step) % L;
    const p = TABLE.players[game.seatOrder[idx].pId];
    if (p && p.active && !p.folded) return idx;
  }
  return -1;
}

function everyoneMatchedCurrentBet(game) {
  const cur = game.currentBet || 0;
  const aps = activePlayers(game);
  if (aps.length <= 1) return true;
  return aps.every((p) => p.bet === cur || (p.chips === 0 && p.bet <= cur));
}

function numActive(game) {
  return activePlayers(game).length;
}

/** ---------- Turn timer ---------- **/
let turnTimer = null;
function clearTurnTimer() {
  if (turnTimer) clearTimeout(turnTimer);
  turnTimer = null;
  if (TABLE.game) TABLE.game.turnEnd = null;
}
function startTurnTimer() {
  if (!TABLE.game) return;
  clearTurnTimer();
  const g = TABLE.game;
  const curIdx = g.turnIndex % g.seatOrder.length;
  const curPid = g.seatOrder[curIdx].pId;
  const timeoutMs = 20000; // 20s
  g.turnEnd = Date.now() + timeoutMs;
  broadcast({ type: "turn", playerId: curPid, turnEnd: g.turnEnd });
  turnTimer = setTimeout(() => {
    const p = TABLE.players[curPid];
    if (p && !p.folded) {
      p.folded = true;
      logToAll(`${p.name} timed out and folded.`);
      if (numActive(g) <= 1) {
        awardPotAndEnd();
        return;
      }
      advanceTurnAfterAction("fold");
    }
  }, timeoutMs);
}

/** ---------- Game lifecycle ---------- **/
function startGame() {
  // Clear previous game if showdown completed
  if (TABLE.game && TABLE.game.showdownComplete) {
    TABLE.game = null;
  }

  if (TABLE.game) return;
  const seatedIds = TABLE.seats.filter(Boolean);
  if (seatedIds.length < 2) return;

  broadcast({ type: "game-started" });

  const g = {
    id: uuidv4(),
    deck: mkDeck(),
    community: [],
    pot: 0,
    smallBlind: 10,
    bigBlind: 20,
    dealerIndex: TABLE.dealerIndex, // Use persistent dealer index
    seatOrder: TABLE.seats
      .map((pId, idx) => ({ pId, idx }))
      .filter((s) => s.pId !== null)
      .sort(
        (a, b) =>
          ((a.idx - TABLE.dealerIndex + 6) % 6) -
          ((b.idx - TABLE.dealerIndex + 6) % 6)
      ), // Rotate order based on dealer
    stage: "preflop",
    currentBet: 0,
    minRaise: 20,
    actionCount: 0,
    turnIndex: 0,
    toCall: 0,
    turnEnd: null,
    showdownComplete: false,
  };
  shuffle(g.deck);

  Object.values(TABLE.players).forEach((p) => {
    p.cards = [];
    p.folded = !(p.seat !== null);
    p.active = p.seat !== null;
    p.bet = 0;
    p.lastAction = null;
  });

  // deal two cards to each player
  for (let r = 0; r < 2; r++) {
    for (const s of g.seatOrder) {
      const p = TABLE.players[s.pId];
      if (p && p.active) p.cards.push(g.deck.pop());
    }
  }

  // blinds
  const sb = TABLE.players[g.seatOrder[0].pId];
  const bb = TABLE.players[g.seatOrder[1].pId];
  sb.chips = Math.max(0, sb.chips - g.smallBlind);
  sb.bet = g.smallBlind;
  g.pot += g.smallBlind;
  bb.chips = Math.max(0, bb.chips - g.bigBlind);
  bb.bet = g.bigBlind;
  g.pot += g.bigBlind;
  g.currentBet = g.bigBlind;
  g.minRaise = g.bigBlind;

  g.turnIndex = 2 % g.seatOrder.length;
  TABLE.game = g;

  // send private hands
  for (const s of g.seatOrder) {
    const p = TABLE.players[s.pId];
    sendTo(p, { type: "hand", cards: p.cards });
  }

  broadcastState();
  startTurnTimer();
  logToAll("New game started.");
}

function startBettingRound(stage) {
  const g = TABLE.game;
  if (!g) return;

  g.stage = stage;
  g.currentBet = 0;
  g.minRaise = g.bigBlind;
  g.actionCount = 0;
  g.turnIndex = (g.dealerIndex + 1) % g.seatOrder.length; // small blind starts post-flop

  // reset bets
  activePlayers(g).forEach((p) => (p.bet = 0));

  // deal community cards
  if (stage === "flop") {
    g.deck.pop(); // burn
    g.community.push(g.deck.pop(), g.deck.pop(), g.deck.pop());
  } else if (stage === "turn" || stage === "river") {
    g.deck.pop(); // burn
    g.community.push(g.deck.pop());
  }

  if (numActive(g) <= 1) {
    awardPotAndEnd();
    return;
  }

  broadcastState();
  startTurnTimer();
}

function finishShowdown() {
  const g = TABLE.game;
  if (!g) return;

  const aps = activePlayers(g);
  if (aps.length === 0) return;

  // reveal hands
  const hands = {};
  aps.forEach((p) => (hands[p.id] = p.cards));
  broadcast({ type: "reveal", hands, community: g.community });

  // evaluate
  const evaluated = aps.map((p) => {
    const fullHand = [...p.cards, ...g.community];
    const best = Hand.solve(fullHand);
    return { player: p, hand: best };
  });

  const winners = Hand.winners(evaluated.map((e) => e.hand));
  const winnerPlayers = evaluated
    .filter((e) => winners.includes(e.hand))
    .map((e) => e.player);

  // award pot
  const share = Math.floor(g.pot / winnerPlayers.length);
  winnerPlayers.forEach((p) => {
    p.chips += share;
  });
  g.pot = 0;

  // summary for log
  const summary = winnerPlayers.map((p) => ({
    id: p.id,
    name: p.name,
    description: evaluated.find((e) => e.player.id === p.id).hand.descr,
  }));

  broadcast({
    type: "game-ended",
    endedGame: { summary },
  });

  logToAll(
    `Showdown winners: ${summary
      .map((s) => s.name + " (" + s.description + ")")
      .join(", ")}`
  );

  // Update persistent dealer index for next round
  TABLE.dealerIndex = (TABLE.dealerIndex + 1) % TABLE.seats.length;

  // Reset game state and broadcast to show start button
  g.showdownComplete = true;
  clearTurnTimer();
  TABLE.game = null;
  broadcastState();
  logToAll("Game state reset, ready for new game.");
}

function awardPotAndEnd() {
  const g = TABLE.game;
  if (!g) return;

  const aps = activePlayers(g);
  if (aps.length === 0) return;

  // If only one left, award to them
  const winner = aps[0];
  winner.chips += g.pot;
  g.pot = 0;

  const summary = [
    { id: winner.id, name: winner.name, description: "last player standing" },
  ];

  broadcast({
    type: "game-ended",
    endedGame: { summary },
  });

  logToAll(`Round ended early: ${winner.name} wins by default.`);

  // Update persistent dealer index for next round
  TABLE.dealerIndex = (TABLE.dealerIndex + 1) % TABLE.seats.length;

  // Reset game state and broadcast
  clearTurnTimer();
  TABLE.game = null;
  broadcastState();
  logToAll("Game state reset, ready for new game.");
}
/** ---------- Actions ---------- **/
function processAction(playerId, action, amount) {
  const g = TABLE.game;
  if (!g) {
    sendTo(TABLE.players[playerId], {
      type: "error",
      message: "No game in progress",
    });
    return;
  }
  const curIdx = g.turnIndex % g.seatOrder.length;
  const curPid = g.seatOrder[curIdx].pId;
  if (curPid !== playerId) {
    sendTo(TABLE.players[playerId], {
      type: "error",
      message: "Not your turn",
    });
    return;
  }

  clearTurnTimer();

  const p = TABLE.players[playerId];
  const toCall = Math.max(0, g.currentBet - p.bet);
  let paid = 0;
  let raised = false;

  if (action === "fold") {
    p.folded = true;
    logToAll(`${p.name} folds.`);
    if (numActive(g) <= 1) {
      awardPotAndEnd();
      return;
    }
  } else if (action === "call" || action === "check") {
    if (toCall === 0) {
      logToAll(`${p.name} checks.`);
    } else {
      paid = Math.min(toCall, p.chips);
      p.chips -= paid;
      p.bet += paid;
      g.pot += paid;
      logToAll(`${p.name} calls ${paid}.`);
      broadcast({ type: "collect", playerId: p.id, amount: paid });
    }
  } else if (action === "raise") {
    if (amount < g.minRaise) {
      sendTo(TABLE.players[playerId], {
        type: "error",
        message: `Raise must be at least ${g.minRaise}`,
      });
      startTurnTimer();
      return;
    }
    const totalBet = p.bet + toCall + amount;
    paid = toCall + amount;
    if (paid > p.chips) {
      paid = p.chips;
      amount = paid - toCall;
    }
    p.chips -= paid;
    p.bet = totalBet;
    g.pot += paid;
    g.currentBet = totalBet;
    g.minRaise = amount;
    raised = true;
    broadcast({ type: "collect", playerId: p.id, amount: paid });
    logToAll(`${p.name} raises to ${g.currentBet}.`);
  } else {
    sendTo(TABLE.players[playerId], {
      type: "error",
      message: "Unknown action",
    });
    startTurnTimer();
    return;
  }

  advanceTurnAfterAction(raised ? "raise" : action);
}

function advanceTurnAfterAction(kind) {
  const g = TABLE.game;
  if (!g) return;

  // Increment action count for all actions except fold
  if (kind !== "fold") {
    g.actionCount += 1;
  }

  const nextIdx = nextActiveIndex(g, g.turnIndex);
  if (nextIdx === -1) {
    awardPotAndEnd();
    return;
  }
  g.turnIndex = nextIdx;

  const aps = activePlayers(g);
  if (aps.length <= 1) {
    awardPotAndEnd();
    return;
  }

  let roundComplete = false;
  if (g.currentBet === 0) {
    roundComplete = g.actionCount >= aps.length;
  } else {
    roundComplete = everyoneMatchedCurrentBet(g);
  }

  if (roundComplete) {
    g.actionCount = 0; // Reset action count for next round
    if (g.stage === "preflop") startBettingRound("flop");
    else if (g.stage === "flop") startBettingRound("turn");
    else if (g.stage === "turn") startBettingRound("river");
    else if (g.stage === "river") finishShowdown();
    return;
  }

  broadcastState();
  startTurnTimer();
}

/** ---------- Logging ---------- **/
function logToAll(msg) {
  broadcast({ type: "log", message: msg, at: Date.now() });
}

/** ---------- State broadcast ---------- **/
function broadcastState() {
  const g = TABLE.game;
  const playersPublic = Object.values(TABLE.players).map((p) => ({
    id: p.id,
    name: p.name,
    seat: p.seat,
    chips: p.chips,
    folded: p.folded,
  }));

  const state = {
    type: "state",
    seats: TABLE.seats,
    players: playersPublic,
    game: g
      ? {
          id: g.id,
          stage: g.stage,
          community: g.community,
          pot: g.pot,
          currentBet: g.currentBet,
          minRaise: g.minRaise,
          toCallMap: playersPublic.reduce((acc, pp) => {
            const pl = TABLE.players[pp.id];
            acc[pp.id] = Math.max(0, (g.currentBet || 0) - (pl?.bet || 0));
            return acc;
          }, {}),
          seatOrder: g.seatOrder.map((s) => s.pId),
          turnIndex: g.turnIndex,
          turnPlayerId: g.seatOrder[g.turnIndex % g.seatOrder.length].pId,
          turnEnd: g.turnEnd,
        }
      : null,
  };
  broadcast(state);
}

/** ---------- WS handlers ---------- **/
wss.on("connection", (ws) => {
  let player = TABLE.players[ws.id]; // Try to reuse existing player if reconnecting

  // If no player exists, create a new one
  if (!player) {
    ws.id = uuidv4();
    player = {
      id: ws.id,
      name: `Guest${Object.keys(TABLE.players).length + 1}`, // Default name
      ws,
      seat: null,
      chips: 1000,
      cards: [],
      folded: true,
      active: false,
      bet: 0,
      lastAction: null,
    };
    TABLE.players[ws.id] = player;
    sendTo(player, { type: "joined", id: ws.id, name: player.name });
    broadcastState();
  } else {
    // Reconnect case: update WebSocket
    player.ws = ws;
    sendTo(player, { type: "reconnected", id: ws.id, name: player.name });
  }

  ws.on("message", (raw) => {
    try {
      const data = JSON.parse(raw);
      if (data.type === "join") {
        if (player.seat !== null) {
          sendTo(player, { type: "error", message: "Already seated, cannot join again" });
          return;
        }
        player.name = (data.name || player.name).slice(0, 20);
        sendTo(player, { type: "joined", id: ws.id, name: player.name });
        broadcastState();
      } else if (data.type === "take-seat") {
        if (player.seat !== null) {
          sendTo(player, { type: "error", message: "Already seated, cannot take another seat" });
          return;
        }
        if (TABLE.game) {
          sendTo(player, { type: "error", message: "Game in progress: cannot change seats" });
          return;
        }
        const seat = data.seat;
        if (seat < 0 || seat > 5 || TABLE.seats[seat] !== null) return;
        TABLE.seats[seat] = ws.id;
        player.seat = seat;
        player.active = true;
        player.folded = false;
        logToAll(`${player.name} took seat ${seat + 1}.`);
        broadcastState();
      } else if (data.type === "leave-seat") {
        if (TABLE.game) {
          sendTo(player, { type: "error", message: "Game in progress: cannot change seats" });
          return;
        }
        if (player.seat !== null) {
          TABLE.seats[player.seat] = null;
          player.seat = null;
          player.active = false;
          player.folded = true;
          logToAll(`${player.name} left their seat.`);
          broadcastState();
        }
      } else if (data.type === "start-game") {
        startGame();
      } else if (data.type === "action") {
        processAction(ws.id, data.action, data.amount || 0);
      }
    } catch (e) {
      console.error("WS message error:", e);
    }
  });

  ws.on("close", () => {
    const p = TABLE.players[ws.id];
    if (p) {
      logToAll(`${p.name} disconnected.`);

      if (TABLE.game) {
        p.folded = true;
        p.active = false;

        if (TABLE.game.turnPlayerId === ws.id) {
          clearTurnTimer();
          advanceTurnAfterAction("fold");
        }

        if (numActive(TABLE.game) <= 1) {
          awardPotAndEnd();
        }
      }

      if (p.seat !== null) TABLE.seats[p.seat] = null;
      delete TABLE.players[ws.id];
      broadcastState();
    }
  });
});

server.listen(PORT, () => {
  console.log(`Poker server running on :${PORT}`);
});
