// client.js
let ws;
let myId = null;
let myName = null;
let myHand = [];
let revealedHands = {}; // shown after showdown
let currentTurnId = null;
let lastState = null;
let winnersLastRound = [];
let tickInterval = null;

const seatsEl = document.getElementById("seats");
const communityCardsEl = document.getElementById("community-cards");
const potEl = document.getElementById("pot");
const playersListEl = document.getElementById("playersList");
const myInfoEl = document.getElementById("myInfo");
const logEl = document.getElementById("log");

const btnLogin = document.getElementById("btnLogin");
const btnStart = document.getElementById("btnStart");
const btnFold = document.getElementById("fold");
const btnCall = document.getElementById("call");
const btnRaise = document.getElementById("raise");
const raiseInput = document.getElementById("raise-input");
const raiseRange = document.getElementById("raise-range");

function log(msg) {
  const d = document.createElement("div");
  d.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  logEl.prepend(d);
}

function connect() {
  if (ws && ws.readyState === WebSocket.OPEN) return;
  ws = new WebSocket(
    (location.protocol === "https:" ? "wss://" : "ws://") + location.host
  );

  ws.onopen = () => log("Connected");
  ws.onmessage = (e) => {
    const data = JSON.parse(e.data);

    if (data.type === "joined") {
      myId = data.id;
      myName = data.name;
      myInfoEl.innerText = `${myName} (${myId.slice(0, 6)})`;
      log(`Joined as ${myName}`);
    } else if (data.type === "state") {
      lastState = data;
      render();
    } else if (data.type === "game-started") {
      // clear old reveals & UI
      revealedHands = {};
      winnersLastRound = [];
      myHand = [];
      communityCardsEl.innerHTML = ""; // Clear community cards for new game
      btnStart.style.display = "none";
      log("Game started.");
      render();
    } else if (data.type === "turn") {
      currentTurnId = data.playerId;
      // kick a real-time ticker that re-renders once per second
      ensureTicker();
      render();
    } else if (data.type === "hand") {
      myHand = data.cards || [];
      log(`Your hand: ${myHand.join(" ")}`);
      render();
    } else if (data.type === "reveal") {
      revealedHands = data.hands || {};
      // community also in message (for safety)
      render();
    } else if (data.type === "collect") {
      animateChipsFromPlayer(data.playerId, data.amount || 0);
    } else if (data.type === "game-ended") {
      btnStart.style.display = "";
      const summary = (data.endedGame && data.endedGame.summary) || [];
      winnersLastRound = summary.map((s) => s.id);
      const names = summary
        .map((s) => `${s.name}${s.description ? ` (${s.description})` : ""}`)
        .join(", ");
      log(
        `Round ended — Winner${summary.length > 1 ? "s" : ""}: ${
          names || "N/A"
        }`
      );
      currentTurnId = null;
      if (tickInterval) {
        clearInterval(tickInterval);
        tickInterval = null;
      }
      render();
    } else if (data.type === "log") {
      log(data.message);
    } else if (data.type === "error") {
      log(`Server: ${data.message}`);
      if (data.message) alert(data.message);
    }
  };

  ws.onclose = () => log("Disconnected");
}

function ensureTicker() {
  if (tickInterval) return;
  tickInterval = setInterval(() => {
    if (!lastState || !lastState.game) return;
    render(); // re-render once per second for the timer
  }, 1000);
}

function send(obj) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(obj));
}

/* ---------- UI events ---------- */
btnLogin.onclick = () => {
  const name =
    document.getElementById("username").value.trim() ||
    "Guest" + Math.floor(Math.random() * 900);
  connect();
  send({ type: "join", name });
};
btnStart.onclick = () => send({ type: "start-game" });
btnFold.onclick = () => send({ type: "action", action: "fold" });
btnCall.onclick = () => send({ type: "action", action: "call" });
btnRaise.onclick = () => {
  const v = Number(raiseInput.value || 0);
  if (!v || v <= 0) {
    alert("Enter raise amount > 0");
    return;
  }
  send({ type: "action", action: "raise", amount: v });
  animateChipsFromPlayer(myId, v);
};

/* ---------- Render helpers ---------- */
function suitSymbol(s) {
  return s === "h"
    ? "♥"
    : s === "d"
    ? "♦"
    : s === "c"
    ? "♣"
    : s === "s"
    ? "♠"
    : "";
}
function suitClass(s) {
  return s === "h" || s === "d" ? "card red" : "card";
}
function renderCard(code, faceUp = true) {
  if (!faceUp) {
    const back = document.createElement("div");
    back.className = "card back";
    return back;
  }
  const rank = code[0];
  const suit = code[1];
  const el = document.createElement("div");
  el.className = suitClass(suit);
  el.innerHTML = `<div class="rank">${rank}</div><div class="suit">${suitSymbol(
    suit
  )}</div>`;
  return el;
}

function animateChipsFromPlayer(playerId, amount) {
  const seats = Array.from(seatsEl.children);
  const seatEl = seats.find((s) => s.dataset.pid === playerId);
  const potBox = document.querySelector(".pot-display").getBoundingClientRect(); // Assuming pot-display class for pot position
  const seatBox = seatEl.getBoundingClientRect();
  for (let i = 0; i < 5; i++) {
    // Animate multiple chips for visual effect
    const chip = document.createElement("div");
    chip.className = "chip";
    chip.textContent = "💠";
    chip.style.left = `${seatBox.left + Math.random() * seatBox.width}px`;
    chip.style.top = `${seatBox.top + Math.random() * seatBox.height}px`;
    document.body.appendChild(chip);
    setTimeout(() => {
      chip.style.transform = `translate(${
        potBox.left - seatBox.left + Math.random() * 20 - 10
      }px, ${potBox.top - seatBox.top + Math.random() * 20 - 10}px) scale(0.5)`;
      chip.style.opacity = "0";
      setTimeout(() => chip.remove(), 850);
    });
  }
}

function renderSeats(seats, players, game) {
  seatsEl.innerHTML = "";
  for (let i = 0; i < 6; i++) {
    const pid = seats[i];
    const seatDiv = document.createElement("div");
    seatDiv.className = "seat";
    seatDiv.dataset.pid = pid || "";

    const header = document.createElement("div");
    header.className = "seat-header";

    const timer = document.createElement("div");
    timer.className = "seat-timer";

    const cardArea = document.createElement("div");
    cardArea.className = "seat-cards";

    const chipInfo = document.createElement("div");
    chipInfo.className = "seat-chips";

    if (pid) {
      const p = players.find((x) => x.id === pid);
      const isTurn = game && game.turnPlayerId === pid;
      if (isTurn) seatDiv.classList.add("active-seat");
      if (winnersLastRound.includes(pid)) seatDiv.classList.add("winner-seat");

      header.innerText = p ? p.name : "player";

      // timer for current player
      if (isTurn && game.turnEnd) {
        const remain = Math.max(
          0,
          Math.round((game.turnEnd - Date.now()) / 1000)
        );
        timer.innerText = `Time: ${remain}s`;
      } else {
        timer.innerText = "";
      }

      // cards:
      const amIFolded = p?.folded;
      if (amIFolded) {
        // folded: hide cards
      } else if (pid === myId) {
        if (myHand && myHand.length)
          myHand.forEach((c) => cardArea.appendChild(renderCard(c, true)));
        else {
          cardArea.appendChild(renderCard("X", false));
          cardArea.appendChild(renderCard("X", false));
        }
      } else if (revealedHands[pid]) {
        revealedHands[pid].forEach((c) =>
          cardArea.appendChild(renderCard(c, true))
        );
      } else {
        // opponents: face down during the hand
        cardArea.appendChild(renderCard("X", false));
        cardArea.appendChild(renderCard("X", false));
      }

      chipInfo.innerText = `Chips: ${p ? p.chips : ""} 💠`;
    } else {
      header.innerText = "Empty";
      const empty = document.createElement("div");
      empty.className = "seat-empty";
      empty.innerText = "Click to sit";
      cardArea.appendChild(empty);
    }

    seatDiv.appendChild(header);
    seatDiv.appendChild(timer);
    seatDiv.appendChild(cardArea);
    seatDiv.appendChild(chipInfo);

    seatDiv.onclick = () => {
      if (!myId) {
        alert("Join first");
        return;
      }
      if (lastState && lastState.game) {
        alert("Game in progress: cannot change seats");
        return;
      }
      if (!pid) send({ type: "take-seat", seat: i });
      else if (pid === myId) send({ type: "leave-seat" });
      else alert("Seat taken");
    };

    seatsEl.appendChild(seatDiv);
  }
}

function renderCommunity(cards) {
  if (cards && cards.length > 0) {
    communityCardsEl.innerHTML = "";
    cards.forEach((c) => communityCardsEl.appendChild(renderCard(c, true)));
  }
  // If cards is [] or undefined, do nothing to keep previous cards visible
}

function renderPlayersList(players) {
  playersListEl.innerHTML = "";
  players.forEach((p) => {
    const d = document.createElement("div");
    d.textContent = `${p.name} — ${p.chips}` + (p.folded ? " (folded)" : "");
    playersListEl.appendChild(d);
  });
}

function updateActionButtons(game) {
  const isMyTurn = game && game.turnPlayerId === myId;
  btnFold.disabled = !isMyTurn;
  btnCall.disabled = !isMyTurn;
  btnRaise.disabled = !isMyTurn;
  raiseInput.disabled = !isMyTurn;
  raiseRange.disabled = !isMyTurn;

  const dim = (v) => (v ? "1" : "0.5");
  btnFold.style.opacity = dim(isMyTurn);
  btnCall.style.opacity = dim(isMyTurn);
  btnRaise.style.opacity = dim(isMyTurn);

  // update raise slider bounds
  const toCall = (game && game.toCallMap && game.toCallMap[myId]) || 0;
  const pot = (game && game.pot) || 0;
  const max = Math.max(pot, toCall);
  raiseRange.min = 1;
  raiseRange.max = Math.max(1, max);
  if (Number(raiseInput.value) > max) raiseInput.value = max;
  raiseRange.value = Math.min(
    max,
    Number(raiseInput.value || raiseRange.value || 1)
  );
  document.getElementById("raise-max").innerText = `min ${
    game ? game.minRaise : 0
  }, to-call ${toCall}`;
  raiseRange.oninput = () => {
    raiseInput.value = raiseRange.value;
  };
  raiseInput.oninput = () => {
    raiseRange.value = raiseInput.value;
  };
}

function render() {
  if (!lastState) return;

  // toggle start button visibility if game running
  btnStart.style.display = lastState.game ? "none" : "";

  // main renders
  renderSeats(lastState.seats, lastState.players, lastState.game || null);
  renderCommunity(lastState.game ? lastState.game.community : []);
  potEl.textContent = lastState.game ? lastState.game.pot : 0;
  renderPlayersList(lastState.players);

  if (lastState.game) {
    currentTurnId = lastState.game.turnPlayerId;
    updateActionButtons(lastState.game);
  } else {
    currentTurnId = null;
    updateActionButtons(null);
  }
}

// kick it off
connect();
