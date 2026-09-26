# The Gauntlet

A live, team-vs-team review game for CIS-170 (Math for AI), built for the class period before an exam.
Teams race along a track: right answers move them toward the finish, wrong answers toward disqualification,
and there's a clock on every question.

- **Projector:** `host.html`. You run the game from here.
- **Phones:** `index.html` (the site's front page). One phone per team; it shows only A/B/C/D buttons,
  so everyone else at the table works the problem on paper, like the exam.
- **Question bank:** `bank.html`. Every question with its answer and explanation, for reviewing before class.

Static pages served by GitHub Pages; live game state in Firebase Realtime Database (free tier is plenty).

## Rules of the game

| | |
|---|---|
| Right answer | +1 |
| Wrong or no answer | −1 |
| 3 right in a row | +1 bonus, and the streak starts over |
| Double down (once per game, on the phone) | +2 or −2 |
| Reach the red zone | Disqualified — but the next right answer puts the team back on the track (once per game). Knocked out a second time = out for good. |
| Reach the finish | Places are awarded in order; teams crossing on the same question are ranked by how far past the line they'd have gone |

The host can set the finish line (6–12), the disqualification line (−3 to −6), and the clock speed in the lobby.
Each question's base time depends on its topic (60 s for vectors, up to 120 s for chunking).

## Running a class

1. Open `host.html` on the projector computer, click **New game**.
2. Students scan the QR code or type the address, enter the 4-letter code and a team name (max 8 teams).
3. **Space** (or the big button) moves things along: Start → Lock answers → Reveal → Next question.
   Answers lock automatically when time runs out, or 3 seconds after every team has answered.
4. After the reveal, talk through the explanation. That's the teaching moment.
5. **End game** at any point shows the final standings.

**If a phone dies or the Wi-Fi fails:** that team can hold up a paper card. Click the team's name during a
question to type in its answer (each click cycles A → B → C → D → none).
**If you need to overrule a result:** after the reveal, click a team's name to flip it between right and wrong;
the scores recompute.
**If the projector computer refreshes:** open `host.html` again and click **Resume game**.
**If a team's phone refreshes:** it rejoins automatically.

**Rehearse alone:** add `?local` to both pages (`host.html?local`, `index.html?local`) and open the join page in
a few other tabs of the same browser. Everything runs in that one browser; no Firebase involved.

## One-time Firebase setup

1. <https://console.firebase.google.com> → **Create a project** (Analytics off).
2. **Build → Authentication → Get started → Sign-in method → Anonymous → Enable.**
3. **Build → Realtime Database → Create database** (locked mode). Then **Rules**: replace everything with the
   contents of `database.rules.json` and click **Publish**.
4. **Project settings → General → Your apps → Web `</>`** → register an app (no Hosting) and copy the
   `firebaseConfig` object into `firebase-config.js`.

The config is public by design; the rules are what protect the data. They let only the host's browser run the
game, let each phone answer only for its own team and only while the clock is running, and stop a phone from
moving its own token.

## Editing questions

Edit `tools/build_questions.py`, then rebuild:

    ~/.langflow/.langflow-venv/bin/python tools/build_questions.py

The build asserts every answer and checks every chunking question against the real Langflow text splitter before
writing `questions.js`. Never edit `questions.js` by hand.

Note: `questions.js` is public, so a determined student could read the answers in the page source. The phones
never load it, which keeps it out of casual reach during the game.
