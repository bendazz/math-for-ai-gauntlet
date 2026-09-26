/* host.js — the projector screen. The host's browser is the only one that moves the
   game forward: it picks questions, runs the clock, locks answers, and scores. */

import { connect, LOCAL } from "./net.js";
import { DEFAULTS, LETTERS, COLORS, STREAK, score, activeTeams, ordinal, esc, makeCode } from "./game.js";
import { promptHTML, choicesHTML } from "./view.js";

const QUESTIONS = window.GAUNTLET_QUESTIONS;
const BY_ID = Object.fromEntries(QUESTIONS.map((q) => [q.id, q]));
const MAX_TEAMS = 8;

const $ = (s) => document.querySelector(s);
let net, code, game = null, unsub = null;
let lastStageKey = "", allInSince = 0, lockFor = "";

// ------------------------------------------------------------------ sound
const sound = {
  on: localStorage.getItem("gauntlet-mute") !== "1",
  ctx: null,
  beep(freq, dur = 0.12, type = "sine", vol = 0.18) {
    if (!this.on) return;
    try {
      this.ctx = this.ctx || new AudioContext();
      const o = this.ctx.createOscillator(), g = this.ctx.createGain(), t = this.ctx.currentTime;
      o.type = type; o.frequency.value = freq;
      g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      o.connect(g).connect(this.ctx.destination); o.start(t); o.stop(t + dur);
    } catch (e) { /* no audio: fine */ }
  },
  tick() { this.beep(880, 0.08, "square", 0.08); },
  lock() { this.beep(220, 0.35, "sawtooth", 0.12); },
  reveal() { [523, 659, 784].forEach((f, i) => setTimeout(() => this.beep(f, 0.18, "triangle"), i * 110)); },
};
function renderMute() { $("#mute").classList.toggle("off", !sound.on); }
$("#mute").onclick = () => { sound.on = !sound.on; localStorage.setItem("gauntlet-mute", sound.on ? "0" : "1"); renderMute(); };
renderMute();

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg; t.classList.add("show");
  clearTimeout(toast.h); toast.h = setTimeout(() => t.classList.remove("show"), 2600);
}

// ------------------------------------------------------------------ boot
async function boot() {
  try {
    net = await connect();
    window.__gauntlet = { net, game: () => game }; // for automated testing and console debugging
  } catch (e) {
    $("#stage").innerHTML = `<div class="panel center"><h1>Can't connect</h1><p>${esc(e.message)}</p></div>`;
    return;
  }
  const saved = localStorage.getItem("gauntlet-host-code" + (LOCAL ? "-local" : ""));
  let resumable = null;
  if (saved) {
    const g = await net.get(`games/${saved}`);
    if (g && g.host === net.uid && g.state && g.state.phase !== "over") resumable = saved;
  }
  showStart(resumable);
}

function showStart(resumable) {
  document.body.className = "phase-start";
  $("#track").innerHTML = "";
  $("#controls").innerHTML = "";
  $("#stage").innerHTML = `
    <div class="panel center start">
      <h1 class="big-title">The Gauntlet</h1>
      <p class="lede">Teams race from the middle of the track. Right answers move you toward the finish.
      Wrong answers push you toward disqualification. The clock is always running.</p>
      <div class="row">
        ${resumable ? `<button class="btn primary" id="resume">Resume game ${resumable}</button>` : ""}
        <button class="btn ${resumable ? "" : "primary"}" id="new">New game</button>
      </div>
      ${LOCAL ? `<p class="hint">Local rehearsal mode: open the join page in other tabs of <em>this</em> browser to play teams.</p>` : ""}
    </div>`;
  $("#new").onclick = newGame;
  if (resumable) $("#resume").onclick = () => open(resumable);
}

async function newGame() {
  let c;
  for (let i = 0; i < 20; i++) { c = makeCode(); if (!(await net.get(`games/${c}/host`))) break; }
  // written as a multi-path update so the security rules can check each part
  await net.update(`games/${c}`, {
    host: net.uid,
    created: Date.now(),
    settings: { ...DEFAULTS },
    state: { phase: "lobby", n: 0, used: "" },
  });
  open(c);
}

function open(c) {
  code = c;
  localStorage.setItem("gauntlet-host-code" + (LOCAL ? "-local" : ""), c);
  if (unsub) unsub();
  unsub = net.on(`games/${c}`, (g) => { game = g; if (g) render(); });
}

// ------------------------------------------------------------------ actions
const S = () => game.settings || DEFAULTS;
const st = () => game.state || {};
const teamsOf = () => game.teams || {};

// Host actions run one at a time, in order. A click that lands while the previous write is still
// on its way to Firebase waits its turn instead of being dropped; each action re-checks the phase
// when it runs, so a double-press can't skip a question.
let chain = Promise.resolve();
function act(fn) {
  chain = chain.then(fn).catch((e) => { console.error(e); toast("Something went wrong: " + e.message); });
  return chain;
}

function pickQuestion() {
  const used = new Set((st().used || "").split(",").filter(Boolean));
  let pool = QUESTIONS.filter((q) => !used.has(q.id));
  if (!pool.length) { used.clear(); pool = QUESTIONS; }
  const q = pool[Math.floor(Math.random() * pool.length)];
  used.add(q.id);
  return { q, used: [...used].join(",") };
}

function nextQuestion() {
  return act(async () => {
    if (st().phase !== "lobby" && st().phase !== "reveal") return;
    if (!activeTeams(teamsOf()).length) return finishGame();
    const { q, used } = pickQuestion();
    const dur = Math.round(q.time * (S().scale || 1));
    allInSince = 0;
    await net.set(`games/${code}/state`, {
      phase: "question", qid: q.id, n: (st().n || 0) + 1, used,
      dur, deadline: net.now() + dur * 1000,
    });
  });
}

function lock() {
  return act(async () => {
    if (st().phase !== "question") return;
    sound.lock();
    await net.update(`games/${code}/state`, { phase: "locked", deadline: Math.min(st().deadline, net.now()) });
  });
}

function reveal(overrides = {}, overridesGiven = false) {
  return act(async () => {
    const s = st();
    if (s.phase !== "locked" && !(s.phase === "reveal" && overridesGiven)) return;
    const before = s.phase === "reveal" ? s.before : teamsOf();
    const answers = (game.answers || {})[s.qid] || {};
    const { teams, results } = score(before, answers, BY_ID[s.qid].answer, overrides, S());
    const patch = { "state/phase": "reveal", "state/before": before, "state/results": results, "state/overrides": overrides };
    for (const [tid, t] of Object.entries(teams)) patch[`teams/${tid}`] = t;
    if (s.phase !== "reveal") sound.reveal();
    await net.update(`games/${code}`, patch);
  });
}

function finishGame() {
  if (st().phase === "over") return;
  return net.update(`games/${code}/state`, { phase: "over" });
}

function setting(key, value) {
  return act(() => net.update(`games/${code}/settings`, { [key]: value }));
}

// click a team: fix its answer while answering (paper-card fallback), or flip its result after the reveal
function teamClick(tid) {
  const s = st(), t = teamsOf()[tid];
  if (!t) return;
  if (s.phase === "lobby") {
    if (confirm(`Remove team “${t.name}”?`)) act(() => net.remove(`games/${code}/teams/${tid}`));
  } else if (s.phase === "question" || s.phase === "locked") {
    const cur = ((game.answers || {})[s.qid] || {})[tid];
    const next = cur == null ? 0 : cur.c >= 3 ? null : cur.c + 1;
    act(() => net.set(`games/${code}/answers/${s.qid}/${tid}`,
      next === null ? null : { c: next, dd: !!(cur && cur.dd), manual: true, t: net.serverTime }));
  } else if (s.phase === "reveal" && s.results && s.results[tid]) {
    const ov = { ...(s.overrides || {}) };
    const r = s.results[tid];
    ov[tid] = !r.correct;
    reveal(ov, true);
    toast(`${t.name} marked ${ov[tid] ? "right" : "wrong"}`);
  }
}

// ------------------------------------------------------------------ clock
function clock() {
  if (!game || !game.state) return;
  const s = game.state;
  const ring = $("#ring");
  if (s.phase === "question") {
    const left = Math.max(0, s.deadline - net.now());
    const secs = Math.ceil(left / 1000);
    if (ring) {
      ring.style.setProperty("--p", (left / (s.dur * 1000)).toFixed(4));
      ring.classList.toggle("hurry", secs <= 10);
      const num = ring.querySelector(".num");
      if (num.textContent !== String(secs)) {
        num.textContent = secs;
        if (secs <= 5 && secs > 0) sound.tick();
      }
    }
    if (left <= 0) { if (lockFor !== s.qid) { lockFor = s.qid; lock(); } return; }
    // everyone still in the game has answered: give them 3 seconds to change their minds, then lock
    const act_ = activeTeams(teamsOf()).map(([tid]) => tid);
    const ans = (game.answers || {})[s.qid] || {};
    if (act_.length && act_.every((tid) => ans[tid])) {
      if (!allInSince) allInSince = Date.now();
      else if (Date.now() - allInSince > 3000 && lockFor !== s.qid) { lockFor = s.qid; lock(); }
    } else allInSince = 0;
  }
}
setInterval(clock, 100);

// ------------------------------------------------------------------ assign team colors as they join
function assignColors() {
  const teams = teamsOf();
  const used = new Set(Object.values(teams).map((t) => t.color).filter(Boolean));
  const patch = {};
  Object.entries(teams).sort((a, b) => a[1].joined - b[1].joined).forEach(([tid, t], i) => {
    if (i >= MAX_TEAMS) { patch[tid] = null; return; }
    if (!t.color) {
      const c = COLORS.find((x) => !used.has(x)) || COLORS[i % COLORS.length];
      used.add(c); patch[`${tid}/color`] = c;
    }
  });
  if (Object.keys(patch).length) net.update(`games/${code}/teams`, patch);
}

// ------------------------------------------------------------------ render
function joinURL() {
  const base = location.href.replace(/host\.html.*$/, "");
  return `${base}?g=${code}${LOCAL ? "&local" : ""}`;
}
function prettyURL() {
  return location.host + location.pathname.replace(/host\.html$/, "");
}

function render() {
  const s = st();
  document.body.className = `phase-${s.phase}`;
  if (s.phase === "lobby") assignColors();

  const q = s.qid ? BY_ID[s.qid] : null;
  $("#qinfo").innerHTML = q && s.phase !== "over"
    ? `<span class="qn">Question ${s.n}</span><span class="chip">${esc(q.topic)}</span>` : "";
  $("#joininfo").innerHTML = s.phase === "lobby" ? "" :
    `Join: <b>${esc(prettyURL())}</b> · code <b class="code">${code}</b>`;

  renderTrack();
  const key = `${s.phase}|${s.qid}|${s.n}`;
  if (key !== lastStageKey || s.phase === "lobby" || s.phase === "reveal" || s.phase === "over") {
    renderStage();
    lastStageKey = key;
  }
  renderAnswered();
  renderControls();
}

function renderTrack() {
  const s = st(), set = S(), teams = teamsOf();
  const span = set.finish - set.dq;
  const X = (p) => ((p - set.dq) / span) * 100;
  const el = $("#track");
  const entries = Object.entries(teams).sort((a, b) => a[1].joined - b[1].joined);

  if (!entries.length) { el.innerHTML = ""; return; }

  // the rail (ticks, zones) only rebuilds when the settings change
  const railKey = `${set.dq}|${set.finish}`;
  if (el.dataset.rail !== railKey) {
    el.dataset.rail = railKey;
    let ticks = "";
    for (let p = set.dq; p <= set.finish; p++) {
      ticks += `<span class="tick ${p === 0 ? "zero" : ""}" style="left:${X(p)}%"><i>${p > 0 ? "+" + p : p === 0 ? "START" : "−" + -p}</i></span>`;
    }
    el.innerHTML = `
      <div class="rail-head"><span class="dq-label">Disqualified</span><span class="fin-label">Finish</span></div>
      <div class="lanes" id="lanes"><div class="zones"><div class="zone dq" style="width:${X(set.dq + 0.5)}%"></div>
        <div class="zone fin" style="left:${X(set.finish - 0.5)}%"></div>${ticks}</div></div>`;
  }
  const lanes = $("#lanes");
  const seen = new Set();
  for (const [tid, t] of entries) {
    seen.add(tid);
    let lane = lanes.querySelector(`[data-tid="${tid}"]`);
    if (!lane) {
      lane = document.createElement("div");
      lane.className = "lane"; lane.dataset.tid = tid;
      lane.innerHTML = `<button class="lab"></button><div class="way"><div class="token"><span></span></div><div class="res"></div></div>`;
      lane.querySelector(".lab").onclick = () => teamClick(tid);
      lanes.appendChild(lane);
    }
    lane.style.setProperty("--c", t.color || "#888");
    lane.className = `lane st-${t.status}`;
    const badges = [];
    if (t.status === "done") badges.push(`<em class="b gold">${ordinal(t.place)}</em>`);
    if (t.status === "out") badges.push(`<em class="b red">DQ</em>`);
    if (t.status === "gone") badges.push(`<em class="b grey">OUT</em>`);
    if (t.status === "in" && t.streak > 0) badges.push(`<em class="b fire" title="streak">${"●".repeat(t.streak)}${"○".repeat(STREAK - t.streak)}</em>`);
    if (!t.ddUsed && (t.status === "in")) badges.push(`<em class="b dd" title="double-down still available">2×</em>`);
    lane.querySelector(".lab").innerHTML = `<span class="nm">${esc(t.name)}</span>${badges.join("")}`;
    lane.querySelector(".token").style.left = X(t.pos) + "%";
    lane.querySelector(".token span").textContent = t.pos > 0 ? "+" + t.pos : t.pos < 0 ? "−" + -t.pos : "0";

    const res = lane.querySelector(".res");
    const r = s.phase === "reveal" && s.results ? s.results[tid] : null;
    if (r) {
      const letter = r.choice === null ? "—" : LETTERS[r.choice];
      const move = r.delta ? (r.delta > 0 ? "+" + r.delta : "−" + -r.delta) : "";
      const parts = [`<b class="${r.correct ? "ok" : "bad"}">${letter}</b>`];
      if (move) parts.push(`<span class="${r.delta > 0 ? "ok" : "bad"}">${move}${r.dd ? " (2×)" : ""}</span>`);
      if (r.bonus) parts.push(`<span class="ok">+1 streak!</span>`);
      if (r.note) parts.push(`<span class="note">${esc(r.note)}</span>`);
      if (r.overridden) parts.push(`<span class="note">(marked by host)</span>`);
      res.innerHTML = parts.join(" ");
      res.style.left = X(t.pos) + "%";
      res.classList.toggle("flip", X(t.pos) > 62);
      res.classList.add("show");
    } else {
      res.classList.remove("show");
    }
  }
  lanes.querySelectorAll(".lane").forEach((l) => { if (!seen.has(l.dataset.tid)) l.remove(); });
}

function renderAnswered() {
  const s = st();
  const ans = s.qid ? ((game.answers || {})[s.qid] || {}) : {};
  document.querySelectorAll(".lane").forEach((lane) => {
    const tid = lane.dataset.tid;
    const a = ans[tid];
    const showing = s.phase === "question" || s.phase === "locked";
    lane.classList.toggle("answered", showing && !!a);
    let tag = lane.querySelector(".lab .got");
    if (showing && a) {
      if (!tag) { tag = document.createElement("em"); tag.className = "b got"; lane.querySelector(".lab").appendChild(tag); }
      // letters stay hidden until the reveal, except ones the host typed in by hand
      tag.textContent = a.manual ? `✓ ${LETTERS[a.c]}` : "✓";
    } else if (tag) tag.remove();
  });
  const cnt = $("#answered-count");
  if (cnt) {
    const act_ = activeTeams(game.teams);
    cnt.textContent = `${act_.filter(([tid]) => ans[tid]).length} of ${act_.length} teams answered`;
  }
}

function renderStage() {
  const s = st(), set = S();
  const stage = $("#stage");

  if (s.phase === "lobby") {
    const teams = Object.values(teamsOf()).sort((a, b) => a.joined - b.joined);
    let qr = "";
    try {
      const g = window.qrcode(0, "M"); g.addData(joinURL()); g.make();
      qr = g.createSvgTag({ cellSize: 6, margin: 2, scalable: true });
    } catch (e) { /* QR is a nicety */ }
    stage.innerHTML = `
      <div class="lobby">
        <div class="join-card">
          <div class="qr">${qr}</div>
          <div>
            <p class="step">On one phone per team, go to</p>
            <p class="url">${esc(prettyURL())}</p>
            <p class="step">and enter the code</p>
            <p class="code-big">${code}</p>
          </div>
        </div>
        <div class="lobby-side">
          <h2>Teams <span class="count">${teams.length} / ${MAX_TEAMS}</span></h2>
          <ul class="team-list">${teams.map((t) => `<li style="--c:${t.color || "#888"}">${esc(t.name)}</li>`).join("") || `<li class="empty">Waiting for teams to join…</li>`}</ul>
          <div class="rules">
            <h3>How it works</h3>
            <ul>
              <li>Right answer: <b>+1</b>. Wrong or no answer: <b>−1</b>.</li>
              <li>Get ${STREAK} right in a row: <b>+1 bonus</b>.</li>
              <li>Once per game, <b>double down</b> on your phone: <b>+2</b> or <b>−2</b>.</li>
              <li>Hit the red zone and you're <b>disqualified</b>, but your next right answer brings you back (once).</li>
              <li>Answer changes are allowed until time runs out.</li>
            </ul>
          </div>
          <div class="settings">
            <label>Finish at <select id="set-finish">${[6, 8, 10, 12].map((n) => `<option ${n === set.finish ? "selected" : ""}>${n}</option>`).join("")}</select></label>
            <label>Disqualified at <select id="set-dq">${[-3, -4, -5, -6].map((n) => `<option value="${n}" ${n === set.dq ? "selected" : ""}>${String(n).replace("-", "−")}</option>`).join("")}</select></label>
            <label>Clock <select id="set-scale">${[[0.75, "Fast"], [1, "Normal"], [1.5, "Relaxed"], [2, "Slow"]].map(([v, l]) => `<option value="${v}" ${v === set.scale ? "selected" : ""}>${l}</option>`).join("")}</select></label>
          </div>
        </div>
      </div>`;
    $("#set-finish").onchange = (e) => setting("finish", +e.target.value);
    $("#set-dq").onchange = (e) => setting("dq", +e.target.value);
    $("#set-scale").onchange = (e) => setting("scale", +e.target.value);
    return;
  }

  if (s.phase === "over") {
    const all = Object.values(teamsOf());
    const rank = (t) => (t.status === "done" ? t.place : 100 + (st().n || 0) - t.pos + (t.status === "gone" ? 1000 : 0));
    const order = all.sort((a, b) => rank(a) - rank(b));
    stage.innerHTML = `
      <div class="podium">
        <h1 class="big-title">Final results</h1>
        <ol>${order.map((t, i) => `<li style="--c:${t.color}" class="${i === 0 ? "win" : ""}">
          <span class="pl">${ordinal(i + 1)}</span><span class="nm">${esc(t.name)}</span>
          <span class="how">${t.status === "done" ? "finished" : t.status === "gone" ? "knocked out" : "on " + (t.pos > 0 ? "+" + t.pos : String(t.pos).replace("-", "−"))}</span></li>`).join("")}</ol>
      </div>
      <div class="confetti">${Array.from({ length: 48 }, (_, i) => `<i style="--x:${(Math.random() * 100).toFixed(1)}%;--d:${(2.6 + Math.random() * 2.4).toFixed(2)}s;--w:${(-Math.random() * 5).toFixed(2)}s;--c:${COLORS[i % COLORS.length]}"></i>`).join("")}</div>`;
    return;
  }

  const q = BY_ID[s.qid];
  if (!q) return;
  const showAnswer = s.phase === "reveal";
  stage.innerHTML = `
    <div class="question ${showAnswer ? "revealed" : ""}">
      <div class="prompt">${promptHTML(q)}</div>
      <div class="side">
        <div class="ring" id="ring" style="--p:${s.phase === "question" ? 1 : 0}"><svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="44"/><circle class="fg" cx="50" cy="50" r="44"/></svg><span class="num">${s.phase === "question" ? Math.ceil(s.dur) : s.phase === "locked" ? "🔒" : "✓"}</span></div>
        <p class="count" id="answered-count"></p>
      </div>
      ${choicesHTML(q, showAnswer)}
    </div>`;
}

function renderControls() {
  const s = st();
  const c = $("#controls");
  const btn = (id, label, primary, fn) => ({ id, label, primary, fn });
  let list = [];
  if (s.phase === "lobby") list = [btn("start", "Start game", true, nextQuestion)];
  if (s.phase === "question") list = [btn("lock", "Lock answers now", true, lock)];
  if (s.phase === "locked") list = [btn("reveal", "Reveal answer", true, () => reveal())];
  if (s.phase === "reveal") {
    list = activeTeams(game.teams).length
      ? [btn("next", "Next question", true, nextQuestion)]
      : [btn("final", "Final results", true, () => act(finishGame))];
  }
  if (s.phase === "over") list = [btn("again", "New game", true, newGame)];
  if (s.phase !== "over" && s.phase !== "lobby") list.push(btn("end", "End game", false, () => { if (confirm("End the game and show final results?")) act(finishGame); }));

  const tip = s.phase === "question" || s.phase === "locked" ? "Click a team's name to enter its answer by hand"
    : s.phase === "reveal" ? "Click a team's name to flip right/wrong" : s.phase === "lobby" ? "Click a team to remove it" : "";
  const key = list.map((b) => b.id).join() + tip + (s.phase === "lobby" ? Object.keys(teamsOf()).length : "");
  if (c.dataset.key === key) return;
  c.dataset.key = key;
  c.innerHTML = (tip ? `<span class="tip">${tip}</span>` : "") +
    list.map((b) => `<button class="btn ${b.primary ? "primary" : "ghost"}" data-id="${b.id}">${b.label}${b.primary ? " <kbd>space</kbd>" : ""}</button>`).join("");
  list.forEach((b) => { c.querySelector(`[data-id="${b.id}"]`).onclick = b.fn; });
  const start = c.querySelector('[data-id="start"]');
  if (start) start.disabled = !Object.keys(teamsOf()).length;
}

document.addEventListener("keydown", (e) => {
  if (e.target.closest("input, select, textarea")) return;
  if (e.key === "m" || e.key === "M") { $("#mute").click(); return; }
  if (e.key === " " || e.key === "Enter") {
    const p = document.querySelector("#controls .btn.primary");
    if (p && !p.disabled) { e.preventDefault(); p.click(); }
  }
});

boot();
