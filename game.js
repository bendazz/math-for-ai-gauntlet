/* game.js — the rules of the Gauntlet, shared by the projector and the phones.

   Track: every team starts on 0. Reaching +finish wins a place; falling to dq means
   disqualified.
     right answer        +1   (+2 with the double-down, once per game)
     wrong / no answer   −1   (−2 with the double-down)
     3 right in a row    +1 bonus step, and the streak starts over
     disqualified        keep answering: the first right answer puts the team back on the track
                         at dq + 2 (one redemption per game). Knocked out a second time = out for good.

   Team status: "in" racing · "out" disqualified, redemption available · "gone" out for good · "done" finished */

export const DEFAULTS = { finish: 8, dq: -5, scale: 1 };
export const LETTERS = ["A", "B", "C", "D"];
export const COLORS = ["#e4572e", "#1f7ab8", "#e0a100", "#6a4c93", "#11998e", "#d6417f", "#3d5a80", "#6f9e1b"];
export const STREAK = 3;

export function newTeam(name, uid) {
  return { name, uid, pos: 0, streak: 0, ddUsed: false, redemptionUsed: false, status: "in", place: 0, joined: Date.now() };
}

/* Work out one question's outcome.
   before:    teams snapshot taken at the reveal ({tid: team})
   answers:   {tid: {c, dd}} for this question
   answer:    index of the right choice
   overrides: {tid: true|false} host corrections ("mark right" / "mark wrong")
   Returns { teams: new team objects, results: {tid: {...what happened}} } */
export function score(before, answers, answer, overrides, settings) {
  const teams = {}, results = {};
  const doneAlready = Object.values(before).filter((t) => t.status === "done").length;
  const finishers = [];

  for (const [tid, b] of Object.entries(before)) {
    const t = { ...b };
    teams[tid] = t;
    if (b.status === "done" || b.status === "gone") continue;

    const a = (answers && answers[tid]) || null;
    const choice = a && Number.isInteger(a.c) ? a.c : null;
    let correct = choice === answer;
    const overridden = overrides && tid in overrides;
    if (overridden) correct = !!overrides[tid];
    const r = { choice, correct, overridden, delta: 0, bonus: 0, dd: false, note: "" };
    results[tid] = r;

    if (b.status === "out") {
      if (correct && !b.redemptionUsed) {
        t.status = "in"; t.pos = settings.dq + 2; t.redemptionUsed = true; t.streak = 0;
        r.note = "Back in the race!";
      } else {
        r.note = correct ? "" : "Still disqualified";
      }
      continue;
    }

    r.dd = !!(a && a.dd) && !b.ddUsed;
    if (r.dd) t.ddUsed = true;
    const step = r.dd ? 2 : 1;
    if (correct) {
      r.delta = step;
      t.streak = (b.streak || 0) + 1;
      if (t.streak >= STREAK) { r.bonus = 1; t.streak = 0; }
    } else {
      r.delta = -step;
      t.streak = 0;
      if (choice === null && !overridden) r.note = "No answer";
    }
    const raw = b.pos + r.delta + r.bonus;
    t.pos = Math.max(settings.dq, Math.min(settings.finish, raw));
    if (raw >= settings.finish) { t.status = "done"; finishers.push([tid, raw]); r.note = "Finished!"; }
    else if (raw <= settings.dq) {
      t.status = b.redemptionUsed ? "gone" : "out";
      r.note = b.redemptionUsed ? "Out for good" : "Disqualified!";
    }
  }

  // teams crossing on the same question: further past the line places higher
  finishers.sort((x, y) => y[1] - x[1] || before[x[0]].name.localeCompare(before[y[0]].name));
  finishers.forEach(([tid], i) => { teams[tid].place = doneAlready + i + 1; });
  return { teams, results };
}

export function activeTeams(teams) {
  return Object.entries(teams || {}).filter(([, t]) => t.status === "in" || t.status === "out");
}

export function ordinal(n) {
  const s = ["th", "st", "nd", "rd"], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

export function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// codes avoid look-alike letters (no I, L, O, 0, 1)
export function makeCode() {
  const A = "ABCDEFGHJKMNPQRSTUVWXYZ";
  return Array.from({ length: 4 }, () => A[Math.floor(Math.random() * A.length)]).join("");
}
