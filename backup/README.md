# CODE CLASH — BORDERLAND PROTOCOL (OFFLINE BACKUP)

This is the **serverless, standalone client-side backup** of CODE CLASH. It delivers the **exact same UI and competition mechanics** as the Node.js/Express server version, but runs **entirely in the browser using HTML, CSS, and vanilla JavaScript** without requiring Node.js, npm, or any backend process.

---

## What is Included

- **`index.html`** — The single-page application structure for all views (Landing, Participant Login, Waiting Room, Round 1 Gauntlet, Visa/Game Over, Round 2 Lockdown, Admin Console, Live Leaderboard, and Winners Podium).
- **`style.css`** — The full Cyberpunk Borderland Protocol styling, animations, and responsive layout.
- **`questions.js`** — Complete question bank containing all 30 Round 1 MCQs and the 3 Round 2 Cases (The Shared Folder, The Student Portal, The Conference Wi-Fi) with exhibits and hints.
- **`script.js`** — The client-side game engine, authoritative timers, scoring, anti-cheat monitoring, admin controls, and cross-tab real-time synchronization.
- **`standalone.html`** — **All-in-one single file** containing the HTML, CSS, and JS embedded together. You can copy this single file to a USB stick and open it on any computer.

---

## How to Run

### Option 1: Direct File Open (Zero Setup)
Simply double-click either:
- [`backup/index.html`](file:///c:/Users/adith/OneDrive/Desktop/CODE-CLASH-V1-LAUNCH-main/backup/index.html)
- or [`backup/standalone.html`](file:///c:/Users/adith/OneDrive/Desktop/CODE-CLASH-V1-LAUNCH-main/backup/standalone.html)

It opens directly in your browser (`file:///...`) and functions 100% offline with zero CORS restrictions.

### Option 2: Any Static Web Server
Run with any lightweight static file server:
```powershell
# Python
python -m http.server 8080 -d backup

# Or npx serve
npx serve backup
```

---

## Features & Same Functional Parity

1. **Participant Registration & Login (`#login`):**
   - Validates name, register number, department, and event consent.
2. **Waiting Room / Lobby (`#lobby`):**
   - Displays participant badge, real-time registered count, standby countdown.
3. **Round 1 — THE GAUNTLET (`#game`):**
   - 30 multiple-choice questions.
   - Randomized question order and option order per participant.
   - Authoritative 20-second per-question countdown timer with visual danger cues.
   - Draft autosave, instant submission, immediate grading (Easy: 1, Medium: 1.5, Hard: 1.9, max 40 points).
   - Auto-advance on 20s expiry.
   - Anti-cheat monitoring (detects tab switches, window blur, and fullscreen exit). Displays warnings and locks out on repeat violations pending admin review.
4. **Qualification & Case Allocation:**
   - Admin cutoff (top finalists qualify; ties at cutoff also qualify).
   - Balanced distribution of Case A, B, and C among finalists.
   - Qualified participants see **VISA EXTENDED** and case briefs; non-qualifiers see **GAME OVER**.
5. **Round 2 — LAB LOCKDOWN:**
   - Real-world incident investigation cases with evidence exhibits.
   - 4 short-answer questions per case (4, 4, 6, 6 points).
   - 5-minute per-question timer + overall 20-minute round timer.
   - Optional Hint system (-1 point penalty applied only if answer is correct).
   - Strict string-normalization grading (`norm()`).
6. **Command Centre / Admin Console (`#admin`):**
   - **Password:** `AdminPass123!`
   - Real-time event controls: Start/End Round 1, Qualify, Start/End Round 2, Emergency Pause/Resume, Publish Winners, Reset.
   - Live searchable and sortable participant table.
   - Review and resolve cheat warnings (Restore / Disqualify).
   - Review short answers and accept manual overrides.
   - Audit trail and submission logs.
   - Export Results CSV, Export Violations CSV, and Download JSON Backup.
   - **Restore JSON Backup:** Load any `.json` backup file from the server or prior run.
   - **Load 12 Rehearsal Participants:** 1-click test data button to instantly simulate an event.
7. **Public Leaderboard (`#leaderboard`) & Winners Podium (`#winners`):**
   - 3D animated flip-card podium for 1st, 2nd, and 3rd place with full final ranking table.

---

## Multi-Tab Real-Time Sync

The offline backup uses standard HTML5 `BroadcastChannel` and `localStorage` events.
If you open:
- **Tab 1:** `#admin` (Host Control Room)
- **Tab 2:** `#login` (Participant)
- **Tab 3:** `#leaderboard` or `#winners` (Projector / Audience View)

Any action taken by the host in Tab 1 (such as starting Round 1 or qualifying finalists) **instantly updates Tab 2 and Tab 3 in real time** without refreshing.
