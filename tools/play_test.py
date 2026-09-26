"""
play_test.py — plays a whole game in headless Chrome and checks the result.

    ~/.langflow/.langflow-venv/bin/python tools/play_test.py local       # one-browser rehearsal mode, no Firebase
    ~/.langflow/.langflow-venv/bin/python tools/play_test.py firebase    # the real Firebase project
    ~/.langflow/.langflow-venv/bin/python tools/play_test.py firebase --base https://bendazz.github.io/math-for-ai-gauntlet

Needs Google Chrome and the `websockets` package (the Langflow Desktop venv has it). Without --base it serves this
folder on localhost itself. Screenshots of every screen go to tools/shots/ (git-ignored): look at them.

What it does, with the lobby's default settings (finish +8, disqualified at −5):
  1. Scoring edge cases straight against game.js: redemption, second knockout, used double-down, wrong double-down,
     two teams finishing on one question, a disqualified team staying out, a host override.
  2. A projector tab and three phone tabs (390×844). In firebase mode each phone is its own browser context,
     so each signs in separately like a real phone. Eight rounds, scripted:
        team 1 always right (double-downs in round 1) → streak bonuses, finishes 1st in round 6
        team 2 always wrong → disqualified in round 5, stays out
        team 3 silent for rounds 1–3 (you lock by hand), then right → ends on +3
     Round 2 also flips team 2 to "right" with the host override, then back.
  3. firebase mode only: six cheating attempts from a phone, each of which the security rules must refuse.
Exits non-zero if anything differs from the expected result.

It reaches into the pages through window.__gauntlet (set in host.js and play.js); keep those hooks.
"""

import argparse, asyncio, base64, json, os, shutil, subprocess, sys, tempfile, time, urllib.parse, urllib.request
import websockets

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
PORT, DBG = 8765, 9333

ap = argparse.ArgumentParser()
ap.add_argument("mode", choices=["local", "firebase"])
ap.add_argument("--base", help="test a deployed copy instead of serving this folder")
args = ap.parse_args()
MODE = args.mode
BASE = (args.base or f"http://localhost:{PORT}").rstrip("/")
Q = "?local" if MODE == "local" else "?"
SHOTS = os.path.join(HERE, "shots")
os.makedirs(SHOTS, exist_ok=True)
FAILS = []


def check(label, ok, detail=""):
    print(f"  {'ok  ' if ok else 'FAIL'} {label}{'' if ok else '  →  ' + str(detail)}")
    if not ok:
        FAILS.append(label)


class Tab:
    def __init__(self, ws, name):
        self.ws, self.name, self.n, self.logs = ws, name, 0, []

    async def cmd(self, method, **params):
        self.n += 1
        mid = self.n
        await self.ws.send(json.dumps({"id": mid, "method": method, "params": params}))
        while True:
            m = json.loads(await self.ws.recv())
            if m.get("method") == "Runtime.consoleAPICalled":
                self.logs.append(" ".join(str(a.get("value", a.get("description", ""))) for a in m["params"]["args"]))
            if m.get("method") == "Runtime.exceptionThrown":
                self.logs.append("EXC " + json.dumps(m["params"]["exceptionDetails"])[:400])
            if m.get("id") == mid:
                if "error" in m:
                    raise RuntimeError(m["error"])
                return m.get("result", {})

    async def js(self, expr):
        r = await self.cmd("Runtime.evaluate", expression=expr, awaitPromise=True, returnByValue=True)
        if r.get("exceptionDetails"):
            raise RuntimeError(f"{self.name}: {r['exceptionDetails']}")
        return r["result"].get("value")

    async def shot(self, fname):
        r = await self.cmd("Page.captureScreenshot", format="png")
        with open(os.path.join(SHOTS, fname), "wb") as f:
            f.write(base64.b64decode(r["data"]))


BROWSER = {}


async def new_tab(url, name, w=1600, h=900, mobile=False):
    if "b" not in BROWSER:
        v = json.load(urllib.request.urlopen(f"http://localhost:{DBG}/json/version"))
        BROWSER["b"] = Tab(await websockets.connect(v["webSocketDebuggerUrl"], max_size=50_000_000), "browser")
    b = BROWSER["b"]
    # firebase: a fresh browser context per tab = a separate phone. local: tabs must share storage.
    kw = {"browserContextId": (await b.cmd("Target.createBrowserContext"))["browserContextId"]} if MODE == "firebase" else {}
    tid = (await b.cmd("Target.createTarget", url="about:blank", **kw))["targetId"]
    tab = Tab(await websockets.connect(f"ws://localhost:{DBG}/devtools/page/{tid}", max_size=50_000_000), name)
    await tab.cmd("Runtime.enable")
    await tab.cmd("Page.enable")
    await tab.cmd("Emulation.setDeviceMetricsOverride", width=w, height=h, deviceScaleFactor=1, mobile=mobile)
    await tab.cmd("Emulation.setFocusEmulationEnabled", enabled=True)
    await tab.cmd("Page.navigate", url=url)
    return tab


async def wait_for(tab, expr, timeout=20):
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            if await tab.js(expr):
                return True
        except RuntimeError:
            pass  # page still loading
        await asyncio.sleep(0.3)
    body = await tab.js("document.body ? document.body.innerText.slice(0, 300) : ''")
    raise RuntimeError(f"timeout on {tab.name}: {expr}\n  screen: {body!r}\n  logs: {tab.logs[:6]}")


SCORING = """(async () => {
  const g = await import('./game.js'); const S = {finish: 8, dq: -5};
  const T = (o) => ({name: 'x', pos: 0, streak: 0, ddUsed: false, redemptionUsed: false, status: 'in', place: 0, ...o});
  const r = {};
  r.redeem = g.score({a: T({status: 'out', pos: -5})}, {a: {c: 1}}, 1, {}, S).teams.a;
  r.gone = g.score({a: T({pos: -4, redemptionUsed: true})}, {a: {c: 0}}, 1, {}, S).teams.a;
  r.ddUsed = g.score({a: T({ddUsed: true})}, {a: {c: 1, dd: true}}, 1, {}, S).results.a;
  r.ddWrong = g.score({a: T({pos: 1})}, {a: {c: 0, dd: true}}, 1, {}, S).teams.a;
  r.finish = g.score({a: T({name: 'A', pos: 7}), b: T({name: 'B', pos: 7, streak: 2}), c: T({name: 'C', status: 'done', place: 1, pos: 8})},
                     {a: {c: 1}, b: {c: 1}}, 1, {}, S).teams;
  r.stillOut = g.score({a: T({status: 'out', pos: -5})}, {a: {c: 0, dd: true}}, 1, {}, S).teams.a;
  r.override = g.score({a: T({pos: 2})}, {}, 1, {a: true}, S).teams.a;
  return r; })()"""


async def main():
    print("Scoring rules (game.js):")
    t = await new_tab(f"{BASE}/bank.html", "bank")
    await wait_for(t, "document.readyState === 'complete'")
    r = await t.js(SCORING)
    check("redemption puts a disqualified team back at −3", (r["redeem"]["status"], r["redeem"]["pos"], r["redeem"]["redemptionUsed"]) == ("in", -3, True), r["redeem"])
    check("second knockout is final", r["gone"]["status"] == "gone", r["gone"])
    check("a used double-down is ignored", (r["ddUsed"]["dd"], r["ddUsed"]["delta"]) == (False, 1), r["ddUsed"])
    check("wrong double-down costs 2", (r["ddWrong"]["pos"], r["ddWrong"]["ddUsed"]) == (-1, True), r["ddWrong"])
    check("same-question finishers ranked by overshoot", (r["finish"]["b"]["place"], r["finish"]["a"]["place"]) == (2, 3), r["finish"])
    check("disqualified team answering wrong stays out", (r["stillOut"]["status"], r["stillOut"]["ddUsed"]) == ("out", False), r["stillOut"])
    check("override can mark a silent team right", r["override"]["pos"] == 3, r["override"])

    print(f"\nFull game ({MODE}, {BASE}):")
    host = await new_tab(f"{BASE}/host.html{Q}", "host")
    await wait_for(host, "!!document.querySelector('#new')", 40)
    await host.shot("00-start.png")
    await host.js("document.querySelector('#new').click()")
    await wait_for(host, "!!document.querySelector('.code-big')")
    code = await host.js("document.querySelector('.code-big').textContent")
    print(f"  game code {code}")

    names = ["Team One", "Team Two", "Team Three"]
    players = []
    for i, nm in enumerate(names):
        p = await new_tab(f"{BASE}/index.html{Q}&g={code}", f"phone{i + 1}", 390, 844, True)
        await wait_for(p, "!!document.querySelector('#name')", 40)
        if i == 0:
            await p.shot("01-phone-join.png")
        await p.js(f"document.querySelector('#name').value={json.dumps(nm)}; document.querySelector('#join').requestSubmit()")
        await wait_for(p, "document.body.innerText.includes(\"You're in\")")
        players.append(p)
    await asyncio.sleep(1)
    await host.shot("02-lobby.png")
    await players[0].shot("03-phone-lobby.png")

    state = lambda: host.js("window.__gauntlet.game()")
    answer_of = lambda qid: host.js(f"window.GAUNTLET_QUESTIONS.find(q => q.id === '{qid}').answer")
    by_name = lambda g: {t["name"]: t for t in g["teams"].values()}

    await host.js("document.querySelector('#controls [data-id=start]').click()")
    for rnd in range(1, 9):
        await wait_for(host, "document.body.className === 'phase-question'")
        qid = (await state())["state"]["qid"]
        ans = await answer_of(qid)
        for i, p in enumerate(players):
            await wait_for(p, "!!document.querySelector('.ans') || /Finished|Knocked out/.test(document.body.innerText)")
            if await p.js("!document.querySelector('.ans')"):
                continue
            if i == 0:
                await p.js(f"document.querySelectorAll('.ans')[{ans}].click()")
                if rnd == 1:
                    await asyncio.sleep(0.5)
                    await p.js("document.querySelector('#dd').click()")
            elif i == 1:
                await p.js(f"document.querySelectorAll('.ans')[{(ans + 1) % 4}].click()")
            elif rnd >= 4:
                await p.js(f"document.querySelectorAll('.ans')[{ans}].click()")
        await asyncio.sleep(1.2)
        if rnd == 1:
            await host.shot("04-question.png")
            await players[0].shot("05-phone-question.png")
        if rnd <= 3:  # team 3 is silent, so the host locks by hand
            await host.js("document.querySelector('#controls [data-id=lock]')?.click()")
        await wait_for(host, "document.body.className === 'phase-locked'", 25)
        if rnd == 1:
            await players[0].shot("06-phone-locked.png")
        await host.js("document.querySelector('#controls [data-id=reveal]').click()")
        await wait_for(host, "document.body.className === 'phase-reveal'")
        await asyncio.sleep(2.2)
        g = await state()
        print(f"  round {rnd} ({qid}):", {n: (t["pos"], t["status"]) for n, t in by_name(g).items()})
        if rnd in (1, 5):
            await host.shot(f"07-reveal-round{rnd}.png")
            await players[0].shot(f"08-phone-right-round{rnd}.png")
            await players[1].shot(f"08-phone-wrong-round{rnd}.png")
        if rnd == 2:
            tids = await host.js("[...document.querySelectorAll('.lane')].map(l => l.dataset.tid)")
            await host.js(f"document.querySelector('.lane[data-tid={tids[1]}] .lab').click()")
            await asyncio.sleep(1.5)
            check("override flips Team Two to right (−1 → 0)", by_name(await state())["Team Two"]["pos"] == 0)
            await host.js(f"document.querySelector('.lane[data-tid={tids[1]}] .lab').click()")
            await asyncio.sleep(1.5)
            check("override flips it back (→ −2)", by_name(await state())["Team Two"]["pos"] == -2)
        await host.js("document.querySelector('#controls [data-id=next]')?.click()")

    g = by_name(await state())
    check("Team One finished 1st", (g["Team One"]["status"], g["Team One"]["place"]) == ("done", 1), g["Team One"])
    check("Team Two disqualified at −5", (g["Team Two"]["status"], g["Team Two"]["pos"]) == ("out", -5), g["Team Two"])
    check("Team Three on +3", (g["Team Three"]["status"], g["Team Three"]["pos"]) == ("in", 3), g["Team Three"])

    await wait_for(host, "document.body.className === 'phase-question'")
    await host.js("window.confirm = () => true; document.querySelector('#controls [data-id=end]').click()")
    await wait_for(host, "document.body.className === 'phase-over'")
    await asyncio.sleep(1.5)
    await host.shot("09-final.png")
    await players[0].shot("10-phone-final.png")

    if MODE == "firebase":
        print("\nSecurity rules (each must be refused):")
        cheats = {
            "phone moves its own token": "n.update(`games/${t.code}/teams/${t.tid}`, {pos: 8})",
            "phone changes the game state": "n.update(`games/${t.code}/state`, {phase: 'lobby'})",
            "phone answers after the game ended": "n.set(`games/${t.code}/answers/q01/${t.tid}`, {c: 1, dd: false})",
            "phone answers for another team": "n.set(`games/${t.code}/answers/q01/tSOMEONE`, {c: 1, dd: false})",
            "phone joins a new team already ahead": "n.set(`games/${t.code}/teams/tcheat`, {name: 'cheat', uid: n.uid, pos: 5, streak: 0, ddUsed: false, redemptionUsed: false, status: 'in', place: 0, joined: 1})",
            "phone takes over as host": "n.set(`games/${t.code}/host`, n.uid)",
        }
        before = {n: t["pos"] for n, t in by_name(await state()).items()}
        for label, op in cheats.items():
            res = await players[1].js(f"(async () => {{ const n = window.__gauntlet.net, t = window.__gauntlet.team(); "
                                      f"try {{ await {op}; return 'ALLOWED'; }} catch (e) {{ return 'DENIED'; }} }})()")
            check(label, res == "DENIED", res)
        check("positions unchanged afterwards", {n: t["pos"] for n, t in by_name(await state()).items()} == before)

    for t in [host] + players:
        errs = [l for l in t.logs if "EXC" in l]
        check(f"no page errors on {t.name}", not errs, errs[:3])


srv = None if args.base else subprocess.Popen([sys.executable, "-m", "http.server", str(PORT)], cwd=REPO,
                                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
prof = tempfile.mkdtemp(prefix="gauntlet-chrome-")
chrome = subprocess.Popen([CHROME, "--headless=new", f"--remote-debugging-port={DBG}", f"--user-data-dir={prof}",
                           "--no-first-run", "--window-size=1600,900", "about:blank"],
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(2)
try:
    asyncio.run(main())
except Exception as e:
    FAILS.append(str(e))
    print("\nSTOPPED:", e)
finally:
    chrome.terminate()
    if srv:
        srv.terminate()
    shutil.rmtree(prof, ignore_errors=True)

print(f"\n{'ALL PASSED' if not FAILS else f'{len(FAILS)} FAILED'} · screenshots in {os.path.relpath(SHOTS)}")
sys.exit(1 if FAILS else 0)
