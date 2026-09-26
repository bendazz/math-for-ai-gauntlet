/* view.js — how a question looks on the big screen. Shared by the projector (host.js)
   and the question-bank preview (bank.html). */

import { LETTERS, esc } from "./game.js";

export function docHTML(d) {
  const sep = d.sep === "\n\n" ? "\\n\\n" : d.sep === "\n" ? "\\n" : d.sep;
  const rows = d.text.split("\n").map((line) =>
    `<div class="doc-row"><span class="t">${line ? esc(line) : "&nbsp;"}</span><span class="n">${line ? line.length : ""}</span></div>`).join("");
  return `<div class="doc"><div class="doc-settings">Separator <code>${sep}</code> · Chunk Size <b>${d.size}</b> · Chunk Overlap <b>${d.overlap}</b></div>
    <div class="doc-head"><span>document</span><span>chars</span></div>${rows}</div>`;
}

export function promptHTML(q) {
  return q.prompt + (q.doc ? docHTML(q.doc) : "");
}

export function choicesHTML(q, reveal) {
  return `<ol class="choices">${q.choices.map((c, i) =>
    `<li class="${reveal ? (i === q.answer ? "right" : "wrong") : ""}"><span class="L">${LETTERS[i]}</span><span class="c">${c}</span></li>`).join("")}</ol>` +
    (reveal ? `<div class="explain"><b>${LETTERS[q.answer]}.</b> ${q.explain}</div>` : "");
}
