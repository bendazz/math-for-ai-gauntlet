/* play.js — a team's phone. It only ever shows four answer buttons (the question itself is
   on the projector), sends the team's pick, and reports how the team is doing. */

import { connect, LOCAL } from "./net.js";
import { LETTERS, STREAK, newTeam, ordinal, esc } from "./game.js";

const $ = (s) => document.querySelector(s);
const params = new URLSearchParams(location.search);
const MEM = "gauntlet-team";
// in local rehearsal every tab is its own team, so each tab remembers its own
const mem = LOCAL ? sessionStorage : localStorage;

let net, code, tid, game = null, unsub = null, lastKey = "";

async function boot() {
  try {
    net = await connect();
    window.__gauntlet = { net, team: () => ({ code, tid }) }; // for automated testing and console debugging
  } catch (e) {
    $("#app").innerHTML = `<div class="card"><h1>Can't connect</h1><p>${esc(e.message)}</p></div>`;
    return;
  }
  // rejoin automatically after a refresh or a closed tab
  const saved = JSON.parse(mem.getItem(MEM) || "null");
  if (saved && (!params.get("g") || params.get("g").toUpperCase() === saved.code)) {
    const t = await net.get(`games/${saved.code}/teams/${saved.tid}`);
    const phase = await net.get(`games/${saved.code}/state/phase`);
    if (t && t.uid === net.uid && phase && phase !== "over") return watch(saved.code, saved.tid);
  }
  showJoin();
}

function showJoin(msg) {
  $("#me").textContent = "";
  document.body.style.removeProperty("--c");
  $("#app").innerHTML = `
    <form class="card join" id="join" autocomplete="off">
      <h1>Join the race</h1>
      ${msg ? `<p class="err">${esc(msg)}</p>` : ""}
      <label>Game code<input id="code" maxlength="4" inputmode="text" autocapitalize="characters" spellcheck="false"
        value="${esc((params.get("g") || "").toUpperCase())}" placeholder="ABCD" required></label>
      <label>Team name<input id="name" maxlength="18" placeholder="e.g. The Outliers" required></label>
      <button class="go" type="submit">Join</button>
      <p class="small">One phone per team. Everyone else works on paper.</p>
    </form>`;
  const codeIn = $("#code");
  (codeIn.value ? $("#name") : codeIn).focus();
  $("#join").onsubmit = async (e) => {
    e.preventDefault();
    const c = codeIn.value.trim().toUpperCase();
    const name = $("#name").value.trim().slice(0, 18);
    if (!name) return;
    const g = await net.get(`games/${c}/state`);
    if (!g) return showJoin(`No game with code ${c}. Check the projector.`);
    if (g.phase === "over") return showJoin("That game has ended.");
    const teams = (await net.get(`games/${c}/teams`)) || {};
    if (Object.keys(teams).length >= 8) return showJoin("That game is full (8 teams).");
    const id = "t" + Math.random().toString(36).slice(2, 9);
    try {
      await net.set(`games/${c}/teams/${id}`, newTeam(name, net.uid));
    } catch (err) {
      return showJoin("Couldn't join: " + err.message);
    }
    mem.setItem(MEM, JSON.stringify({ code: c, tid: id }));
    watch(c, id);
  };
}

function watch(c, id) {
  code = c; tid = id;
  if (unsub) unsub();
  unsub = net.on(`games/${c}`, (g) => { game = g; render(); });
}

// ------------------------------------------------------------------ render
let timer = null;
function render() {
  if (!game) return;
  const me = (game.teams || {})[tid];
  if (!me) {
    mem.removeItem(MEM);
    return showJoin("Your team was removed from the game. Join again.");
  }
  const s = game.state || {}, set = game.settings || {};
  document.body.style.setProperty("--c", me.color || "#888");
  const where = me.status === "done" ? `Finished ${ordinal(me.place)}`
    : me.status === "gone" ? "Knocked out"
    : me.status === "out" ? "Disqualified"
    : `On ${me.pos > 0 ? "+" + me.pos : me.pos < 0 ? "−" + -me.pos : "0"} · ${set.finish - me.pos} to go`;
  $("#me").innerHTML = `<b>${esc(me.name)}</b> <span>${where}</span>`;

  const ans = s.qid ? ((game.answers || {})[s.qid] || {})[tid] : null;
  const key = JSON.stringify([s.phase, s.qid, s.n, ans, me.status, me.pos, me.ddUsed, s.results && s.results[tid]]);
  if (key === lastKey) return;
  lastKey = key;
  clearInterval(timer);

  const app = $("#app");
  if (s.phase === "lobby") {
    app.innerHTML = `<div class="card center"><h1>You're in!</h1><p>Watch the projector. The first question is coming.</p>
      <p class="small">Rules: right +1, wrong −1, ${STREAK} in a row +1 bonus. Once per game you can double down.</p></div>`;
    return;
  }
  if (s.phase === "over") {
    mem.removeItem(MEM);
    app.innerHTML = `<div class="card center"><h1>Game over</h1><p class="huge">${me.status === "done" ? ordinal(me.place) : "🏁"}</p>
      <p>${me.status === "done" ? "You crossed the finish line!" : "Check the projector for the final results."}</p></div>`;
    return;
  }
  if (me.status === "done") {
    app.innerHTML = `<div class="card center"><h1>Finished!</h1><p class="huge">${ordinal(me.place)}</p><p>Nice work. Keep solving on paper for practice.</p></div>`;
    return;
  }
  if (me.status === "gone") {
    app.innerHTML = `<div class="card center"><h1>Knocked out</h1><p>You've used your comeback. Keep working the questions on paper: the exam counts, this doesn't.</p></div>`;
    return;
  }

  if (s.phase === "question") {
    const canDD = me.status === "in" && !me.ddUsed;
    const dd = !!(ans && ans.dd);
    app.innerHTML = `
      <div class="q-top"><span>Question ${s.n}</span><span class="clock" id="clock"></span></div>
      ${me.status === "out" ? `<p class="out">You're disqualified. Get this right to come back (once).</p>` : ""}
      <div class="answers">${LETTERS.map((L, i) => `<button class="ans ${ans && ans.c === i ? "picked" : ""}" data-i="${i}">${L}</button>`).join("")}</div>
      ${canDD ? `<button class="dd ${dd ? "on" : ""}" id="dd">${dd ? "Double down is ON: +2 or −2" : "Double down (once per game)"}</button>` : ""}
      <p class="status">${ans ? `Locked in: <b>${LETTERS[ans.c]}</b>. Tap another to change.` : "Pick your team's answer."}</p>`;
    app.querySelectorAll(".ans").forEach((b) => (b.onclick = () => send(+b.dataset.i, dd)));
    if (canDD) $("#dd").onclick = () => {
      if (!ans) { $(".status").textContent = "Pick an answer first, then double down."; return; }
      send(ans.c, !dd);
    };
    const tick = () => {
      const left = Math.max(0, Math.ceil((s.deadline - net.now()) / 1000));
      const el = $("#clock");
      if (el) { el.textContent = left + "s"; el.classList.toggle("hurry", left <= 10); }
    };
    tick(); timer = setInterval(tick, 250);
    return;
  }

  if (s.phase === "locked") {
    app.innerHTML = `<div class="card center"><h1>Time!</h1>
      <p>${ans ? `Your answer: <span class="letter">${LETTERS[ans.c]}</span>${ans.dd ? " (double down)" : ""}` : "No answer this time."}</p>
      <p class="small">Eyes on the projector.</p></div>`;
    return;
  }

  if (s.phase === "reveal") {
    const r = (s.results || {})[tid];
    if (!r) { app.innerHTML = `<div class="card center"><p>Watch the projector.</p></div>`; return; }
    const move = r.delta + r.bonus;
    app.innerHTML = `<div class="card center result ${r.correct ? "good" : "bad"}">
      <h1>${r.correct ? "Correct!" : r.choice === null ? "No answer" : "Not quite"}</h1>
      ${move ? `<p class="huge">${move > 0 ? "+" + move : "−" + -move}</p>` : ""}
      ${r.bonus ? `<p>Streak bonus!</p>` : ""}${r.note ? `<p>${esc(r.note)}</p>` : ""}
      <p class="small">Next question soon.</p></div>`;
  }
}

async function send(c, dd) {
  try {
    await net.set(`games/${code}/answers/${game.state.qid}/${tid}`, { c, dd, t: net.serverTime });
  } catch (e) {
    const st = $(".status");
    if (st) st.textContent = "Too late: answers are locked.";
  }
}

boot();
