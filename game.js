// ─── FIREBASE IMPORTS ─────────────────────────────────────────────────────────
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import {
  getFirestore, doc, setDoc, updateDoc, getDoc, onSnapshot
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyCaJ-2d3r_qKcSs4aCdhvzZtjAImnZ8YM",
  authDomain: "odd1owt-ed87d.firebaseapp.com",
  projectId: "odd1owt-ed87d",
  storageBucket: "odd1owt-ed87d.appspot.com",
  messagingSenderId: "615629953512",
  appId: "1:615629953512:web:046f611961e7c1e556ec5d"
};

const app = initializeApp(firebaseConfig);
const db  = getFirestore(app);

// ─── PLAYER IDENTITY ──────────────────────────────────────────────────────────
const playerId = localStorage.getItem("odd1owt_pid") || crypto.randomUUID();
localStorage.setItem("odd1owt_pid", playerId);

// ─── MODULE STATE ─────────────────────────────────────────────────────────────
let roomId            = null;
let unsub             = null;
let timerInterval     = null;
let localRevealTimeout = null;

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function roomRef() { return doc(db, "rooms", roomId); }

function getName() {
  const typed = document.getElementById("nameInput").value.trim();
  if (typed) localStorage.setItem("odd1owt_name", typed);
  return localStorage.getItem("odd1owt_name");
}

function show(id) {
  document.querySelectorAll("section").forEach(s => s.style.display = "none");
  document.getElementById(id).style.display = "block";
}
window.show = show;

function randomCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function fmtTime(ms) {
  const t = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
}

function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, m =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[m])
  );
}

// ─── QUESTION PICKING (per-deck, no repeats) ──────────────────────────────────
function pickTwoQuestions(state) {
  const deckKey = state.activeDeck || "all";
  const deck    = DECKS[deckKey] || DECKS.all;
  const pool    = deck.questions;

  const usedKey = `usedQ_${deckKey}`;
  const lastKey = `lastQ_${deckKey}`;
  const used    = Array.isArray(state[usedKey]) ? state[usedKey] : [];

  // All indices in the pool
  let available = pool.map((_, i) => i).filter(i => !used.includes(i));

  // Reset if exhausted
  if (available.length < 2) available = pool.map((_, i) => i);

  // Avoid immediate repeats where possible
  const last = Array.isArray(state[lastKey]) ? state[lastKey] : [];
  const fresh = available.filter(i => !last.includes(i));
  if (fresh.length >= 2) available = fresh;

  // Pick two distinct indices
  const idx1      = available[Math.floor(Math.random() * available.length)];
  let   remaining = available.filter(i => i !== idx1);
  if (!remaining.length) remaining = pool.map((_, i) => i).filter(i => i !== idx1);
  const idx2 = remaining[Math.floor(Math.random() * remaining.length)];

  // Update the used list (reset if nearly exhausted)
  const currentUsed = Array.isArray(state[usedKey]) ? state[usedKey] : [];
  const nextUsed    = (currentUsed.length + 2 >= pool.length)
    ? [idx1, idx2]
    : [...new Set([...currentUsed, idx1, idx2])];

  return {
    normalQuestion: pool[idx1],
    oddQuestion:    pool[idx2],
    usedKey,
    nextUsed,
    lastKey,
    nextLast: [idx1, idx2]
  };
}

// ─── KICK PLAYER ──────────────────────────────────────────────────────────────
window.kickPlayer = async function(targetId) {
  const snap  = await getDoc(roomRef());
  if (!snap.exists()) return;
  const state = snap.data();
  if (state.hostId !== playerId) return;
  if (targetId === playerId)      return alert("Can't kick yourself!");

  const players  = { ...state.players };
  const scores   = { ...state.scores };
  const order    = (state.playerOrder || []).filter(pid => pid !== targetId);
  const p1Votes  = { ...(state.p1Votes || {}) };
  const p3Votes  = { ...(state.p3Votes || {}) };

  delete players[targetId];
  delete scores[targetId];
  delete p1Votes[targetId];
  delete p3Votes[targetId];

  // Remove any votes cast FOR the kicked player
  Object.keys(p1Votes).forEach(k => { if (p1Votes[k] === targetId) delete p1Votes[k]; });
  Object.keys(p3Votes).forEach(k => { if (p3Votes[k] === targetId) delete p3Votes[k]; });

  await updateDoc(roomRef(), { players, scores, playerOrder: order, p1Votes, p3Votes });
};

// ─── DECK SELECTION (host only) ───────────────────────────────────────────────
window.selectDeck = async function(deckKey) {
  const snap = await getDoc(roomRef());
  if (!snap.exists()) return;
  if (snap.data().hostId !== playerId) return;
  await updateDoc(roomRef(), { activeDeck: deckKey });
};

// ─── ROOM CREATION / JOINING ──────────────────────────────────────────────────
window.createRoom = async function() {
  const name = getName();
  if (!name) return alert("Enter your name first.");
  roomId = randomCode();
  await joinRoomInternal(true);
};

window.joinRoom = async function() {
  const name = getName();
  if (!name) return alert("Enter your name first.");
  roomId = document.getElementById("codeInput").value.trim().toUpperCase();
  if (!roomId) return alert("Enter a lobby code.");
  await joinRoomInternal(false);
};

async function joinRoomInternal(isHost) {
  const name = getName();
  const ref  = roomRef();
  const snap = await getDoc(ref);
  const data = snap.exists() ? snap.data() : null;

  // Duplicate-name check
  if (data?.players) {
    const taken = Object.entries(data.players).some(([pid, pname]) =>
      pid !== playerId && (pname || "").toLowerCase() === name.toLowerCase()
    );
    if (taken) return alert("That name is already taken in this lobby.");
  }

  const existingOrder = Array.isArray(data?.playerOrder) ? data.playerOrder : [];
  const nextOrder     = existingOrder.includes(playerId)
    ? existingOrder
    : [...existingOrder, playerId];

  await setDoc(ref, {
    createdAt:   data?.createdAt  || Date.now(),
    hostId:      isHost ? playerId : (data?.hostId || null),
    phase:       data?.phase      || "lobby",
    round:       data?.round      || 0,
    activeDeck:  data?.activeDeck || "all",
    playerOrder: nextOrder,
    players:     { ...(data?.players || {}), [playerId]: name },
    scores:      { ...(data?.scores  || {}), [playerId]: data?.scores?.[playerId] ?? 0 }
  }, { merge: true });

  listenRoom();
  show("lobby");
}

// ─── REAL-TIME LISTENER ───────────────────────────────────────────────────────
function listenRoom() {
  if (unsub) unsub();
  unsub = onSnapshot(roomRef(), snap => {
    if (!snap.exists()) return;
    const state = snap.data();

    // Kicked players are sent back to home
    if (!state.players?.[playerId]) {
      if (unsub) { unsub(); unsub = null; }
      alert("You were removed from the lobby.");
      show("home");
      return;
    }

    render(state);
    tryHostAdvance(state);
  });
}

// ─── HOST: START ROUND ────────────────────────────────────────────────────────
window.hostStartRound = async function() {
  const snap  = await getDoc(roomRef());
  if (!snap.exists()) return;
  const state = snap.data();
  if (state.hostId !== playerId) return alert("Only the host can start.");

  const ids = (Array.isArray(state.playerOrder) && state.playerOrder.length)
    ? state.playerOrder.filter(pid => state.players?.[pid])
    : Object.keys(state.players || {});

  if (ids.length < 3) return alert("Need at least 3 players.");

  const oddId = ids[Math.floor(Math.random() * ids.length)];
  const { normalQuestion, oddQuestion, usedKey, nextUsed, lastKey, nextLast } =
    pickTwoQuestions(state);

  await updateDoc(roomRef(), {
    phase: "p1_vote",
    round: (state.round || 0) + 1,
    oddId,
    normalQuestion,
    oddQuestion,
    [usedKey]: nextUsed,
    [lastKey]: nextLast,
    p1Votes:  {},
    p3Votes:  {},
    p2EndsAt: null,
    results:  null
  });
};

// ─── HOST: SKIP TO FINAL VOTE ─────────────────────────────────────────────────
window.hostSkipToFinal = async function() {
  const snap  = await getDoc(roomRef());
  if (!snap.exists()) return;
  const state = snap.data();
  if (state.hostId !== playerId) return;
  if (state.phase  !== "p2_interrogate") return;
  await updateDoc(roomRef(), { phase: "p3_finalvote" });
};

// ─── VOTING ───────────────────────────────────────────────────────────────────
async function castP1Vote(targetId) {
  const snap = await getDoc(roomRef());
  if (!snap.exists() || snap.data().phase !== "p1_vote") return;
  await updateDoc(roomRef(), { [`p1Votes.${playerId}`]: targetId });
}

async function castP3Vote(targetId) {
  const snap = await getDoc(roomRef());
  if (!snap.exists() || snap.data().phase !== "p3_finalvote") return;
  await updateDoc(roomRef(), { [`p3Votes.${playerId}`]: targetId });
}

// ─── HOST AUTO-ADVANCE ────────────────────────────────────────────────────────
async function tryHostAdvance(state) {
  if (state.hostId !== playerId) return;
  const playerCount = Object.keys(state.players || {}).length;

  if (state.phase === "p1_vote") {
    if (Object.keys(state.p1Votes || {}).length === playerCount && playerCount > 0) {
      await updateDoc(roomRef(), {
        phase: "p2_interrogate",
        p2EndsAt: Date.now() + 5 * 60 * 1000
      });
    }
    return;
  }

  if (state.phase === "p2_interrogate") {
    if ((state.p2EndsAt || 0) && Date.now() >= state.p2EndsAt) {
      await updateDoc(roomRef(), { phase: "p3_finalvote" });
    }
    return;
  }

  if (state.phase === "p3_finalvote") {
    if (Object.keys(state.p3Votes || {}).length === playerCount && playerCount > 0) {
      const { votedOutId, tally } = computeMostVoted(state.p3Votes);
      const caught  = votedOutId === state.oddId;
      const scores  = { ...(state.scores || {}) };
      const players = state.players || {};

      if (caught) {
        Object.keys(players).forEach(pid => {
          if (pid !== state.oddId) scores[pid] = (scores[pid] || 0) + 1;
        });
      } else {
        scores[state.oddId] = (scores[state.oddId] || 0) + 1;
      }

      await updateDoc(roomRef(), {
        phase: "p4_reveal",
        scores,
        results: {
          votedOutId,
          caught,
          tally,
          oddId:          state.oddId,
          normalQuestion: state.normalQuestion,
          oddQuestion:    state.oddQuestion
        }
      });
    }
  }
}

function computeMostVoted(voteMap) {
  const tally = {};
  Object.values(voteMap).forEach(t => tally[t] = (tally[t] || 0) + 1);
  const entries = Object.entries(tally).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return { votedOutId: entries[0]?.[0] || null, tally };
}

// ─── RENDER DISPATCHER ────────────────────────────────────────────────────────
function render(state) {
  document.getElementById("hostHint").textContent = state.hostId === playerId
    ? "You are the host."
    : `Host: ${state.players?.[state.hostId] || "—"}`;

  renderScores(state);

  const phase = state.phase;
  if (!phase || phase === "lobby")      { show("lobby"); renderLobbyPlayers(state); renderDeckSelector(state); return; }
  if (phase === "p1_vote")              { show("p1"); renderPhase1(state); return; }
  if (phase === "p2_interrogate")       { show("p2"); renderPhase2(state); return; }
  if (phase === "p3_finalvote")         { show("p3"); renderPhase3(state); return; }
  if (phase === "p4_reveal")            { show("p4"); renderPhase4(state); return; }

  show("lobby"); renderLobbyPlayers(state); renderDeckSelector(state);
}

function getOrder(state) {
  const players = state.players || {};
  const order   = Array.isArray(state.playerOrder) && state.playerOrder.length
    ? state.playerOrder.filter(pid => players[pid])
    : Object.keys(players);
  return order;
}

// ─── LOBBY ────────────────────────────────────────────────────────────────────
function renderLobbyPlayers(state) {
  const players = state.players || {};
  const order   = getOrder(state);
  const isHost  = state.hostId === playerId;

  let html = `<div style="font-size:12px;color:var(--muted);margin-bottom:10px;font-weight:700">
    Code: ${roomId} · ${order.length} player${order.length !== 1 ? "s" : ""}
  </div>`;

  order.forEach(pid => {
    const name       = players[pid];
    if (!name) return;
    const isMe       = pid === playerId;
    const isThisHost = pid === state.hostId;
    html += `
      <div class="player-row">
        <span class="player-name">
          ${escapeHtml(name)}
          ${isMe       ? '<span class="you-tag">(you)</span>'  : ""}
          ${isThisHost ? '<span class="you-tag">👑</span>'      : ""}
        </span>
        ${isHost && !isMe
          ? `<button class="kick-btn" onclick="kickPlayer('${pid}')">Kick</button>`
          : ""}
      </div>`;
  });

  document.getElementById("playersBox").innerHTML = html;
}

function renderDeckSelector(state) {
  const wrap     = document.getElementById("deckSelectorWrap");
  const viewWrap = document.getElementById("deckViewerWrap");
  const isHost   = state.hostId === playerId;
  const current  = state.activeDeck || "all";

  wrap.style.display     = isHost ? "block" : "none";
  viewWrap.style.display = isHost ? "none"  : "block";

  if (isHost) {
    const grid = document.getElementById("deckGrid");
    grid.innerHTML = "";

    Object.entries(DECKS).forEach(([key, deck]) => {
      const usedArr  = state[`usedQ_${key}`];
      const used     = Array.isArray(usedArr) ? usedArr.length : 0;
      const total    = deck.questions.length;
      const card     = document.createElement("div");
      card.className = `deck-card ${deck.cls}${current === key ? " active" : ""}`;
      card.innerHTML = `
        <div class="dk-check">✓</div>
        <div class="dk-icon">${deck.icon}</div>
        <div class="dk-name">${deck.name}</div>
        <div class="dk-desc">${deck.desc}</div>
        <div class="dk-desc" style="margin-top:4px;color:rgba(255,255,255,0.3)">${total - used}/${total} left</div>
      `;
      card.onclick = () => selectDeck(key);
      grid.appendChild(card);
    });

    const used  = Array.isArray(state[`usedQ_${current}`]) ? state[`usedQ_${current}`].length : 0;
    const total = DECKS[current]?.questions.length || 0;
    document.getElementById("deckUsedInfo").textContent =
      `Active: ${DECKS[current]?.name || "All"} — ${total - used}/${total} questions remaining`;
  } else {
    const icon = DECKS[current]?.icon || "🃏";
    const name = DECKS[current]?.name || "All Decks";
    document.getElementById("deckViewerLabel").textContent = `${icon} Deck: ${name}`;
  }
}

// ─── SCOREBOARD ───────────────────────────────────────────────────────────────
function renderScores(state) {
  const players = state.players || {};
  const scores  = state.scores  || {};
  const order   = getOrder(state);

  const rows = order.map(pid => {
    const name = players[pid];
    const sc   = scores[pid] || 0;
    return `<div class="scoreRow"><span>${escapeHtml(name)}</span><span class="scoreVal">${sc}</span></div>`;
  }).join("");

  const html = `<b>Scoreboard</b><div style="margin-top:8px">${rows || "<span class='small'>No scores yet.</span>"}</div>`;
  document.getElementById("scoreBox").innerHTML = html;
  const p4 = document.getElementById("p4Score");
  if (p4) p4.innerHTML = html;
}

// ─── PHASE 1 ──────────────────────────────────────────────────────────────────
function renderPhase1(state) {
  const isOdd = playerId === state.oddId;
  document.getElementById("p1Question").innerHTML =
    `<b>Your Prompt:</b><br>${escapeHtml(isOdd ? state.oddQuestion : state.normalQuestion || "…")}`;

  const list    = document.getElementById("p1VoteList");
  list.innerHTML = "";
  const players  = state.players || {};
  const myVote   = state.p1Votes?.[playerId];

  getOrder(state).forEach(pid => {
    const name = players[pid];
    if (!name) return;
    const b       = document.createElement("button");
    b.textContent = pid === playerId ? `${name} (You)` : name;
    b.className   = myVote === pid ? "selected" : "";
    b.onclick     = () => castP1Vote(pid);
    list.appendChild(b);
  });

  const total = Object.keys(players).length;
  const done  = Object.keys(state.p1Votes || {}).length;
  document.getElementById("p1Status").textContent = `${done}/${total} votes submitted`;
}

// ─── PHASE 2 ──────────────────────────────────────────────────────────────────
function renderPhase2(state) {
  document.getElementById("p2NormalQ").textContent = state.normalQuestion || "";

  const players = state.players || {};
  const p1      = state.p1Votes || {};
  let html = "<b>Who voted for who (Phase 1):</b><br><br>";
  Object.entries(p1).forEach(([voter, target]) => {
    html += `• ${escapeHtml(players[voter] || "Unknown")} voted ${escapeHtml(players[target] || "Unknown")}<br>`;
  });
  if (!Object.keys(p1).length) html += "<span class='small'>No votes yet.</span>";
  document.getElementById("p2WhoVoted").innerHTML = html;

  if (timerInterval) clearInterval(timerInterval);
  const endsAt = state.p2EndsAt || (Date.now() + 5 * 60 * 1000);
  const tick   = () => { document.getElementById("p2Timer").textContent = fmtTime(endsAt - Date.now()); };
  tick();
  timerInterval = setInterval(tick, 250);

  document.getElementById("skipBtn").style.display =
    state.hostId === playerId ? "block" : "none";
  document.getElementById("p2Status").textContent =
    `Discuss now. Phase 1 votes: ${Object.keys(p1).length}/${Object.keys(players).length}.`;
}

// ─── PHASE 3 ──────────────────────────────────────────────────────────────────
function renderPhase3(state) {
  const list     = document.getElementById("p3VoteList");
  list.innerHTML = "";
  const players  = state.players || {};
  const myVote   = state.p3Votes?.[playerId];

  getOrder(state).forEach(pid => {
    const name = players[pid];
    if (!name) return;
    const b       = document.createElement("button");
    b.textContent = pid === playerId ? `${name} (You)` : name;
    b.className   = myVote === pid ? "selected" : "";
    b.onclick     = () => castP3Vote(pid);
    list.appendChild(b);
  });

  const total = Object.keys(players).length;
  const done  = Object.keys(state.p3Votes || {}).length;
  document.getElementById("p3Status").textContent = `${done}/${total} final votes submitted`;
}

// ─── PHASE 4 ──────────────────────────────────────────────────────────────────
function renderPhase4(state) {
  const players = state.players || {};
  const res     = state.results;

  document.getElementById("nextRoundBtn").style.display =
    state.hostId === playerId ? "block" : "none";
  document.getElementById("p4HostNote").textContent = state.hostId === playerId
    ? "Start the next round when you're ready."
    : "Waiting for host to start next round…";

  if (localRevealTimeout) clearTimeout(localRevealTimeout);
  document.getElementById("p4Title").textContent    = "Counting votes...";
  document.getElementById("p4Details").innerHTML    = "<span class='small'>Stand by…</span>";

  localRevealTimeout = setTimeout(() => {
    const votedOutName = players[res.votedOutId] || "Unknown";
    const oddName      = players[res.oddId]      || "Unknown";
    const verdict      = res.caught
      ? `<span class="win">CAUGHT!</span>`
      : `<span class="lose">ESCAPED!</span>`;
    const tallyLines   = Object.entries(res.tally || {})
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([pid, n]) => `• ${escapeHtml(players[pid] || "Unknown")}: <b>${n}</b>`)
      .join("<br>");

    document.getElementById("p4Title").innerHTML  = verdict;
    document.getElementById("p4Details").innerHTML = `
      <b>Most votes:</b> ${escapeHtml(votedOutName)}<br>
      <b>The Odd1Owt was:</b> ${escapeHtml(oddName)}<br><br>
      <b>Final vote tally:</b><br>${tallyLines || "<span class='small'>No votes?</span>"}<br><br>
      <b>Questions this round:</b><br>
      Normal: ${escapeHtml(res.normalQuestion || "")}<br>
      Odd: ${escapeHtml(res.oddQuestion || "")}
    `;
  }, 1400);
}

// ─── COPY INVITE ──────────────────────────────────────────────────────────────
window.copyInvite = function() {
  navigator.clipboard.writeText(`${location.origin}${location.pathname}?room=${roomId}`);
  alert("Invite link copied!");
};

// ─── INIT ─────────────────────────────────────────────────────────────────────

// Restore saved name
const savedName = localStorage.getItem("odd1owt_name");
if (savedName) document.getElementById("nameInput").value = savedName;

// Auto-join from URL ?room= param
const params = new URLSearchParams(location.search);
if (params.get("room")) {
  document.getElementById("codeInput").value = params.get("room").toUpperCase();
  show("join");
}
