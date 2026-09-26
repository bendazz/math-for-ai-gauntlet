"""
build_questions.py — the ONE source of truth for the Gauntlet's question bank.

    ~/.langflow/.langflow-venv/bin/python tools/build_questions.py   # also checks chunking against the real Langflow splitter
    python3 tools/build_questions.py                                 # works anywhere; built-in splitter check only

It asserts every answer, then writes ../questions.js. Never edit questions.js by hand.

Question format — q(topic, prompt, choices, explain, doc=None)
  choices: list of 4 strings; the FIRST is the correct answer. The build places
           the correct answer so the letters come out balanced across A–D.
  explain: one or two short sentences, shown on the projector after the reveal.
  doc:     chunking only — (text, separator, chunk_size, chunk_overlap, expected_chunk_lengths).

Every number is chosen so the question can be done by hand in the time limit.
These questions are deliberately NOT copies of the practice tests or the textbook.
"""

import json, math, os, random
from fractions import Fraction as F

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "questions.js")
N, NN = "\n", "\n\n"

VEC = "Vectors"
DOT = "Dot product & cosine"
CHK = "Chunking"
EDGE = "Chunking edge cases"
PR = "Precision & recall in search"
CM = "Confusion matrix"
CPR = "Precision & recall"
THR = "Threshold"
F1S = "F1 score"

# seconds on the clock for each topic (the host can stretch all of them)
TIME = {VEC: 60, DOT: 75, CHK: 120, EDGE: 120, PR: 60, CM: 60, CPR: 75, THR: 90, F1S: 75}


def fr(a, b):
    return f'<span class="fr"><span>{a}</span><span>{b}</span></span>'


def v(*xs):
    return "(" + ", ".join(str(x).replace("-", "−") for x in xs) + ")"


def dot(a, b):
    return sum(x * y for x, y in zip(a, b))


def norm2(a):
    return dot(a, a)


def pct(a, b):
    return round(100 * a / b)


def f1(tp, fp, fn):
    return F(2 * tp, 2 * tp + fp + fn)


def counts(items, t):
    tp = sum(1 for s, y in items if s >= t and y)
    fp = sum(1 for s, y in items if s >= t and not y)
    fn = sum(1 for s, y in items if s < t and y)
    return tp, fp, fn, len(items) - tp - fp - fn


def grid(say_yes, say_no, is_yes, is_no, tp, fn, fp, tn):
    return (f'<table class="qt cm"><tr><td></td><th>{say_yes}</th><th>{say_no}</th></tr>'
            f'<tr><th>{is_yes}</th><td><b>{tp}</b><small>TP</small></td><td><b>{fn}</b><small>FN</small></td></tr>'
            f'<tr><th>{is_no}</th><td><b>{fp}</b><small>FP</small></td><td><b>{tn}</b><small>TN</small></td></tr></table>')


def table(head, rows):
    h = "".join(f"<th>{x}</th>" for x in head)
    b = "".join("<tr>" + "".join(f"<td>{x}</td>" for x in r) + "</tr>" for r in rows)
    return f'<table class="qt"><tr>{h}</tr>{b}</table>'


def score_rows(items, yes, no):
    return [[i + 1, f"{float(s):.2f}", yes if y else no] for i, (s, y) in enumerate(items)]


# ------------------------------------------------------------------ chunking check
def merge(text, sep, size, overlap):
    """langchain CharacterTextSplitter._merge_splits, keep_separator=False."""
    atoms = [a for a in text.split(sep) if a != ""]
    sl, cur, total, chunks = len(sep), [], 0, []
    for a in atoms:
        n = len(a)
        if total + n + (sl if cur else 0) > size and cur:
            chunks.append(sep.join(cur).strip())
            while total > overlap or (total + n + (sl if cur else 0) > size and total > 0):
                total -= len(cur[0]) + (sl if len(cur) > 1 else 0)
                cur = cur[1:]
        cur.append(a)
        total += n + (sl if len(cur) > 1 else 0)
    chunks.append(sep.join(cur).strip())
    return [c for c in chunks if c]


try:
    import logging
    logging.disable(logging.CRITICAL)
    from langchain_text_splitters import CharacterTextSplitter
    HAVE_LANGCHAIN = True
except Exception:
    HAVE_LANGCHAIN = False


def check_chunks(text, sep, size, overlap, expected):
    got = [len(c) for c in merge(text, sep, size, overlap)]
    assert got == expected, f"chunk lengths {got} != expected {expected}"
    if HAVE_LANGCHAIN:
        real = CharacterTextSplitter(separator=sep, chunk_size=size, chunk_overlap=overlap,
                                     keep_separator=False).split_text(text)
        assert [len(c) for c in real] == expected, f"REAL splitter gave {[len(c) for c in real]}"
    return merge(text, sep, size, overlap)


Q = []


def q(topic, prompt, choices, explain, doc=None):
    Q.append(dict(topic=topic, prompt=prompt, choices=choices, explain=explain, doc=doc))


# ================================================================== VECTORS
assert tuple(a + 2 * b for a, b in zip((4, -3), (-1, 5))) == (2, 7)
q(VEC, "<p>Compute (4, −3) + 2(−1, 5).</p>",
  [v(2, 7), v(3, 2), v(6, -13), v(7, -1)],
  "Scale first: 2(−1, 5) = (−2, 10). Then add: (4 − 2, −3 + 10) = (2, 7).")

assert math.isqrt(norm2((-7, 24))) == 25
q(VEC, "<p>Find the length ‖(−7, 24)‖.</p>",
  ["25", "17", "31", "625"],
  "√(49 + 576) = √625 = 25. Squaring wipes out the minus sign.")

assert math.isqrt(norm2((2, 3, 6))) == 7
q(VEC, "<p>Find the length of the 3-D vector (2, 3, 6).</p>",
  ["7", "11", "49", "√13"],
  "√(4 + 9 + 36) = √49 = 7. All three components get squared.")

vs = [(1, 5), (3, -1), (5, 2)]
assert tuple(F(sum(c), 3) for c in zip(*vs)) == (3, 2)
q(VEC, "<p>Mean-pool the word vectors (1, 5), (3, −1) and (5, 2) into one sentence vector.</p>",
  [v(3, 2), v(9, 6), "(4.5, 3)", "(3, " + fr(8, 3) + ")"],
  "Add them: (9, 6). Divide by the 3 words: (3, 2).")

assert math.isqrt(norm2((-8, 6))) == 10
q(VEC, "<p>Find the unit vector pointing the same way as (−8, 6).</p>",
  ["(−0.8, 0.6)", "(0.8, 0.6)", v(-4, 3), "(−" + fr(4, 7) + ", " + fr(3, 7) + ")"],
  "The length is √(64 + 36) = 10. Divide each component by 10: (−0.8, 0.6).")

# ================================================================== DOT PRODUCT & COSINE
assert dot((3, -2), (4, 5)) == 2
q(DOT, "<p>Compute the dot product (3, −2) · (4, 5).</p>",
  ["2", "22", "(12, −10)", "9"],
  "(3)(4) + (−2)(5) = 12 − 10 = 2. A dot product is one number.")

assert dot((0, 5), (3, 4)) == 20 and norm2((3, 4)) == 25
q(DOT, "<p>Find the cosine similarity of (0, 5) and (3, 4).</p>",
  ["0.8", "20", "2", "1"],
  "Dot product 0 + 20 = 20. Both lengths are 5, so 20 ÷ (5 × 5) = 0.8.")

assert dot((4, -2), (5, 10)) == 0
q(DOT, "<p>For what value of <em>k</em> is (<em>k</em>, −2) perpendicular to (5, 10)?</p>",
  ["4", "−4", "20", fr(1, 4)],
  "Perpendicular means dot product 0: 5k − 20 = 0, so k = 4.")

assert dot((1, -2, 4), (3, 1, -1)) == -3
q(DOT, "<p>Compute the 3-D dot product (1, −2, 4) · (3, 1, −1).</p>",
  ["−3", "5", "9", "(3, −2, −4)"],
  "(1)(3) + (−2)(1) + (4)(−1) = 3 − 2 − 4 = −3.")

base = (2, 1)
opts = [(-3, -1), (1, -1), (-1, 2), (1, 3)]
assert [dot(base, o) for o in opts] == [-7, 1, 0, 5]
q(DOT, "<p>Using only the <em>sign</em> of the dot product, which vector points broadly <strong>opposite</strong> to (2, 1)?</p>",
  [v(-3, -1), v(1, -1), v(-1, 2), v(1, 3)],
  "(2, 1) · (−3, −1) = −6 − 1 = −7. Negative means broadly opposite. The others give 1, 0 and 5.")

# ================================================================== CHUNKING
T = "Charge the drone.\nCheck the props.\nFind open space.\nStay low."
check_chunks(T, N, 40, 0, [34, 26])
q(CHK, "<p>Give the chunk lengths.</p>",
  ["34 and 26", "34 and 25", "51 and 9", "17, 16, 16 and 9"],
  "17 + 16 + 1 = 34. Adding line 3 would make 51, over 40, so emit 34. Then 16 + 9 + 1 = 26.",
  doc=(T, N, 40, 0))

T = "Open the box.\nRead the guide.\nAttach the legs.\nTighten each bolt.\nFlip the table over."
check_chunks(T, N, 55, 20, [46, 35, 39])
q(CHK, "<p>Which line appears in <strong>both</strong> chunk 1 and chunk 2?</p>",
  ["“Attach the legs.”", "“Read the guide.”", "“Tighten each bolt.”", "None of them"],
  "Chunk 1 = 46. Pop while over 20: 46 → 32 → 16. “Read the guide.” goes too (32 is still over 20), so “Attach the legs.” carries.",
  doc=(T, N, 55, 20))

T = "Rain is likely.\n\nBring a jacket.\n\nThe game starts at six.\n\nParking is free."
check_chunks(T, NN, 40, 0, [32, 23, 16])
q(CHK, "<p>How many chunks come out?</p>",
  ["3", "2", "4", "1"],
  "The separator is 2 characters. 15 + 15 + 2 = 32. Then 23 + 16 + 2 = 41, over 40, so the last two stay apart: 32, 23, 16.",
  doc=(T, NN, 40, 0))

T = "Stir.\nTaste.\nAdd salt.\nStir again.\nServe it hot.\nWash the pot."
check_chunks(T, N, 20, 0, [12, 9, 11, 13, 13, ])
q(CHK, "<p>What is chunk 1?</p>",
  ["“Stir.” and “Taste.” (12)", "“Stir.”, “Taste.” and “Add salt.” (22)", "“Stir.” by itself (5)", "“Stir.” through “Stir again.” (34)"],
  "5 + 6 + 1 = 12. Adding “Add salt.” makes 12 + 9 + 1 = 22, over 20. So chunk 1 is the first two lines.",
  doc=(T, N, 20, 0))

# ================================================================== CHUNKING EDGE CASES
T = "Aim high.\nTrain hard.\nRest well.\nRepeat."
check_chunks(T, N, 32, 0, [32, 7])
q(EDGE, "<p>How long is chunk 1?</p>",
  ["32", "21", "31", "40"],
  "9 + 11 + 1 = 21, then 21 + 10 + 1 = 32. That's equal to the size, not over it, so it fits.",
  doc=(T, N, 32, 0))

T = "Hi.\nThis single line is far too long to fit inside one chunk.\nBye."
check_chunks(T, N, 25, 0, [3, 57, 4])
q(EDGE, "<p>What comes out of the splitter?</p>",
  ["3 chunks, and the middle one is 57 characters", "4 chunks: the long line is cut into 25 + 25 + 7",
   "2 chunks: the long line is thrown away", "1 chunk: everything glued together"],
  "Atoms are never cut and never thrown away. A too-long atom comes out whole, over the size.",
  doc=(T, N, 25, 0))

T = "Grab a cart.\nFind the milk.\nGet some eggs.\nPay at the front."
check_chunks(T, N, 32, 14, [27, 29, 32])
q(EDGE, "<p>Give the chunk lengths.</p>",
  ["27, 29, 32", "27, 32", "27, 29, 17", "42, 32"],
  "Both times, popping stops at exactly 14 (not over 14), so one line carries. And the last chunk, 14 + 17 + 1 = 32, exactly fits.",
  doc=(T, N, 32, 14))

T = "Sign in.\nPick a seat.\nThe lecture covers vectors, dot products, and cosine similarity."
check_chunks(T, N, 80, 25, [21, 77])
q(EDGE, "<p>How long is chunk 2?</p>",
  ["77", "86", "64", "85"],
  "Chunk 1 = 21, already under 25. But the long line must fit: 21 + 64 + 1 = 86, over 80. Pop “Sign in.” → 12 + 64 + 1 = 77.",
  doc=(T, N, 80, 25))

# ================================================================== PRECISION & RECALL IN SEARCH
assert (pct(6, 8), pct(6, 12)) == (75, 50)
q(PR, "<p>A question has <strong>12 relevant</strong> sentences. You set <strong>k = 8</strong> and get <strong>6</strong> hits. "
      "Precision and recall?</p>",
  ["Precision 75%, recall 50%", "Precision 50%, recall 75%", "Precision 75%, recall 75%", "Precision 50%, recall 50%"],
  "Precision = hits ÷ k = 6 ÷ 8 = 75%. Recall = hits ÷ relevant = 6 ÷ 12 = 50%.")

assert pct(min(4, 10), 10) == 40
q(PR, "<p>A question has <strong>10 relevant</strong> sentences in a collection of 100. With <strong>k = 4</strong>, "
      "what is the <strong>best possible recall</strong>?</p>",
  ["40%", "100%", "4%", "25%"],
  "At most 4 hits come back, out of 10 relevant: 4 ÷ 10 = 40%.")

q(PR, "<p>You raise k from 5 to 10. What can happen to <strong>recall</strong>?</p>",
  ["It goes up or stays the same", "It goes down", "It always doubles", "It could go either way"],
  "More results can only add hits, and the number of relevant sentences doesn't change. Recall can't fall.")

assert (pct(5, 10), pct(5, 5)) == (50, 100)
q(PR, "<p>A collection of 50 sentences has <strong>5 relevant</strong> ones. With <strong>k = 10</strong>, the search finds all 5. "
      "Precision and recall?</p>",
  ["Precision 50%, recall 100%", "Precision 100%, recall 50%", "Precision 100%, recall 100%", "Precision 10%, recall 100%"],
  "Precision = 5 ÷ 10 = 50% (half the results are junk, unavoidably). Recall = 5 ÷ 5 = 100%.")

# ================================================================== CONFUSION MATRIX
q(CM, "<p>A smart doorbell watches for delivered packages. A package arrives, but the doorbell reports “no package.” "
      "Which outcome is this?</p>",
  ["False negative", "False positive", "True positive", "True negative"],
  "The doorbell hunts for packages, so “package” is the positive. It said no, and it was wrong: a miss, a false negative.")

assert (14, 20 - 14, 16 - 14, 80 - 20 - 2) == (14, 6, 2, 58)
q(CM, "<p>An app screens <strong>80</strong> people for diabetes. <strong>16</strong> have it. The app flags <strong>20</strong>, "
      "and <strong>14</strong> of those really have it. Which matrix is right?</p>",
  ["TP 14, FP 6, FN 2, TN 58", "TP 14, FP 2, FN 6, TN 58", "TP 14, FP 6, FN 2, TN 60", "TP 16, FP 4, FN 0, TN 60"],
  "FP = 20 − 14 = 6. FN = 16 − 14 = 2. TN = 80 − 14 − 6 − 2 = 58.")

assert (pct(40 + 140, 200), pct(140, 200), pct(20, 200), pct(40, 50)) == (90, 70, 10, 80)
q(CM, "<p>What is the <strong>accuracy</strong>?</p>" + grid("Said yes", "Said no", "Really yes", "Really no", 40, 10, 10, 140),
  ["90%", "70%", "10%", "80%"],
  "Correct calls ÷ everything: (40 + 140) ÷ 200 = 180 ÷ 200 = 90%.")

assert F(998, 1000) == F(998, 1000)
q(CM, "<p>An earthquake-warning AI is tested on <strong>1,000</strong> days, and <strong>2</strong> had an earthquake. "
      "It says “no earthquake” every single day. What is its accuracy?</p>",
  ["99.8%", "0.2%", "100%", "98%"],
  "It's right on 998 of 1,000 days: 99.8%. And it caught zero earthquakes. That's the accuracy trap.")

q(CM, "<p>A search-and-rescue drone looks for lost hikers. How many <strong>alerts</strong> did it raise?</p>"
      + grid("Drone said person", "Drone said no one", "Really a person", "Really no one", 9, 3, 6, 82),
  ["15", "12", "9", "91"],
  "Alerts are the “said person” column: 9 + 6 = 15. The row, 9 + 3, counts the real people.")

# ================================================================== PRECISION & RECALL (CLASSIFIERS)
assert (pct(36, 48), pct(36, 40), pct(36 + 148, 200), pct(36, 200)) == (75, 90, 92, 18)
q(CPR, "<p>A bird-song app listens for <strong>cardinals</strong>. Precision and recall?</p>"
       + grid("App said cardinal", "App said no", "Really cardinal", "Really not", 36, 4, 12, 148),
  ["Precision 75%, recall 90%", "Precision 90%, recall 75%", "Precision 92%, recall 90%", "Precision 18%, recall 90%"],
  "Precision reads the column: 36 ÷ (36 + 12) = 75%. Recall reads the row: 36 ÷ (36 + 4) = 90%.")

assert F(8, 10) * 25 == 20 and 20 / F(5, 10) == 40
q(CPR, "<p>A model flags <strong>25</strong> items with precision <strong>80%</strong> and recall <strong>50%</strong>. "
       "How many items were <strong>really positive</strong>?</p>",
  ["40", "20", "25", "45"],
  "80% of 25 flags are right: TP = 20. Those 20 are 50% of the real positives, so there are 40.")

q(CPR, "<p>An AI flags students for an <strong>academic-integrity hearing</strong>. Which should the school care about most?</p>",
  ["Precision: a false accusation does real harm", "Recall: catch every single cheater",
   "Accuracy: it covers both mistakes", "Neither: they always rise together"],
  "The harsh mistake here is the false alarm, an innocent student accused. That's precision.")

q(CPR, "<p>A model says <strong>yes to everything</strong>. What is its recall?</p>",
  ["100%", "0%", "50%", "It depends on the threshold"],
  "Every real positive gets a yes, so none are missed: recall = 100%. Its precision is terrible, though.")

# ================================================================== THRESHOLD
BONES = [(F(71, 100), True), (F(38, 100), False), (F(50, 100), True), (F(84, 100), False),
         (F(22, 100), True), (F(95, 100), True), (F(46, 100), False), (F(9, 100), False)]
assert counts(BONES, F(50, 100)) == (3, 1, 1, 3)
q(THR, "<p>An AI flags X-rays with a <strong>broken bone</strong> when the score is <strong>at or above 0.50</strong>. "
       "Which matrix is right?</p>" + table(["X-ray", "Score", "Really…"], score_rows(BONES, "broken", "fine")),
  ["TP 3, FP 1, FN 1, TN 3", "TP 2, FP 1, FN 2, TN 3", "TP 3, FP 2, FN 1, TN 2", "TP 4, FP 0, FN 0, TN 4"],
  "Flagged: 1, 3, 4, 6. Broken among them: 1, 3 (exactly 0.50 counts), 6 → TP 3. X-ray 4 is fine → FP 1. X-ray 5 (0.22) is missed → FN 1.")

q(THR, "<p>You <strong>raise</strong> the threshold. Which count can only go up or stay the same?</p>",
  ["FN (misses)", "TP", "FP", "The number of items flagged"],
  "A higher bar flags fewer items. Anything that loses its flag becomes a no — so misses can only pile up.")

ALERTS = [("0.8", 12, 2, 8), ("0.6", 16, 5, 4), ("0.4", 18, 10, 2), ("0.2", 20, 30, 0)]
assert [pct(tp, 20) for _, tp, _, _ in ALERTS] == [60, 80, 90, 100]
q(THR, "<p>The rule: catch <strong>at least 80%</strong> of the 20 real cases, then as few false alarms as possible. "
       "Which threshold?</p>" + table(["Threshold", "TP", "FP", "FN"], [list(r) for r in ALERTS]),
  ["0.6", "0.8", "0.4", "0.2"],
  "Recall: 0.8 → 60%, 0.6 → 80%, 0.4 → 90%, 0.2 → 100%. 0.6 is the first to reach 80%, with the fewest false alarms (5).")

q(THR, "<p>Which threshold will produce the <strong>most false alarms</strong>?</p>",
  ["0.2", "0.4", "0.6", "0.8"],
  "The lowest bar flags the most items, including the most that aren't really positive.")

LEAK = [(F(92, 100), True), (F(35, 100), False), (F(78, 100), False), (F(64, 100), True),
        (F(71, 100), True), (F(15, 100), False), (F(88, 100), True), (F(55, 100), True)]
tp, fp, fn, tn = counts(LEAK, F(70, 100))
assert (tp, fp) == (3, 1) and pct(tp, tp + fp) == 75
q(THR, "<p>A pipeline sensor AI flags a <strong>leak</strong> at or above <strong>0.70</strong>. What is its precision?</p>"
       + table(["Reading", "Score", "Really…"], score_rows(LEAK, "leak", "no leak")),
  ["75%", "60%", "100%", "80%"],
  "Flagged: 1, 3, 5, 7. Real leaks among them: 1, 5, 7. Precision = 3 ÷ 4 = 75%.")

# ================================================================== F1
assert F(2) * 1 * F(6, 10) / (1 + F(6, 10)) == F(3, 4)
q(F1S, "<p>Precision is <strong>1.0</strong> and recall is <strong>0.6</strong>. What is F1?</p>",
  ["0.75", "0.80", "0.60", "1.6"],
  "2 × 1.0 × 0.6 ÷ (1.0 + 0.6) = 1.2 ÷ 1.6 = 0.75. A bit below the plain average of 0.8.")

assert f1(9, 1, 5) == F(3, 4)
q(F1S, "<p>A model has <strong>TP 9, FP 1, FN 5</strong>. What is its F1?</p>",
  ["0.75", "0.60", "0.90", "About 0.64"],
  "Shortcut: 2TP ÷ (2TP + FP + FN) = 18 ÷ (18 + 1 + 5) = 18 ÷ 24 = 0.75.")

q(F1S, "<p>When is F1 exactly <strong>0</strong>?</p>",
  ["When TP = 0", "When FP = 0", "When FN = 0", "When TN = 0"],
  "F1 = 2TP ÷ (2TP + FP + FN). The top is 2TP, so F1 is 0 exactly when there are no true positives.")

fb = F(2) * F(9, 10) * F(4, 10) / (F(9, 10) + F(4, 10))
assert fb == F(72, 130) and F(6, 10) > fb
q(F1S, "<p>Model A: precision 0.6, recall 0.6. Model B: precision 0.9, recall 0.4. Which has the higher F1?</p>",
  ["Model A", "Model B", "They tie", "You can't tell without TN"],
  "A: F1 = 0.6. B: 2 × 0.9 × 0.4 ÷ 1.3 = 0.72 ÷ 1.3 ≈ 0.55. F1 rewards balance.")


# ------------------------------------------------------------------ assemble + check
LETTERS = "ABCD"
assert len(Q) == 40, len(Q)
rng = random.Random(1709)
slots = [i % 4 for i in range(len(Q))]
rng.shuffle(slots)

out, topic_count = [], {}
for i, (item, k) in enumerate(zip(Q, slots)):
    ch = item["choices"]
    assert len(ch) == 4 and len(set(ch)) == 4, item["prompt"]
    ordered = ch[1:k + 1] + [ch[0]] + ch[k + 1:]
    rec = dict(id=f"q{i + 1:02d}", topic=item["topic"], time=TIME[item["topic"]],
               prompt=item["prompt"], choices=ordered, answer=k, explain=item["explain"])
    if item["doc"]:
        text, sep, size, overlap = item["doc"]
        rec["doc"] = dict(text=text, sep=sep, size=size, overlap=overlap)
    out.append(rec)
    topic_count[item["topic"]] = topic_count.get(item["topic"], 0) + 1

with open(OUT, "w", encoding="utf-8") as f:
    f.write("/* GENERATED by tools/build_questions.py — do not edit by hand. */\n")
    f.write("window.GAUNTLET_QUESTIONS = ")
    json.dump(out, f, ensure_ascii=False, indent=1)
    f.write(";\n")

print(f"OK: {len(out)} questions, letters {[slots.count(i) for i in range(4)]}, topics {topic_count}, "
      f"chunking checked against {'REAL langchain splitter' if HAVE_LANGCHAIN else 'built-in algorithm only'}")
