# E2E verification notes (MVP, 2026-09-23)

Environment: Linux, Bun 1.3.14, podman 5.x, Chromium (headless automation),
with a configured provider in the local omp auth store.

## Local dev topology

- hub: `bun src/server.ts`, `PORT=8471 HUB_TOKEN=dev-token` (local test port).
- agent: `bun src/main.ts --hub ws://localhost:8471 --token dev-token --name dev-machine`.
- demo cwd: `/tmp/omp-hub-demo`.

## Verified flows

| # | Flow | Result |
|---|---|---|
| 1 | Agent registers; `GET /api/machines` shows `dev-machine` connected | ✅ |
| 2 | Web token gate (wrong token → error, not persisted; right token + display name → home) | ✅ |
| 3 | Home start form (`cwd=/tmp/omp-hub-demo`, initial prompt `Reply with exactly: ok`) → 202 → `/s/<id>` starting card → status `live` with 4 links minted | ✅ |
| 4 | Session page: host badge prompt + streamed `ok` answer, model/thinking chips, participants | ✅ |
| 5 | Web composer prompt → author badge; agent ran `bash node index.js` (tool card, exit 0) and reported `hello from demo` | ✅ |
| 6 | Web interrupt during `bash sleep 60` → `aborted / Interrupted by user` | ✅ |
| 7 | **omp client attach**: `omp join "ws://localhost:8471/r/<room>.<key>"` (omp v18.2.10, pty) → joined; TUI prompt landed on web with author badge; answer visible both sides | ✅ |
| 8 | Stop from home → record `exited/"user stop"`; web guests get `session ended / room closed` + Rejoin/New link | ✅ |
| 9 | Hub restart → agent auto-reconnects and re-registers (sessions lost — in-memory registry, see M7) | ✅ |
| 10 | Responsive: 390×844 home (single column, ≥40px targets) and session (transcript, badges, tool cards, drawer) render correctly; 1440×900 two-column home + full session chrome | ✅ (screenshots reviewed) |
| 11 | Docker (podman): image builds (~52 s); container on `127.0.0.1:8480` serves health/API/web; host agent `docker-machine` connects; browser start → prompt `container-ok` streamed; stop → `exited` | ✅ |
| 12 | Web slash commands: `/` palette (8 commands at the time of this run, filter, keyboard nav, mobile sheet); `/model` picker switched deepseek-flash → v4-flash → v4-pro live (header chip + transcript entries update via state broadcast); `/thinking` xhigh; `/collab` links modal; unknown `/frobnicator` → "host-only or unknown command — not sent", nothing reaches the agent; palette-run commands clear the composer; palette suppressed while a modal is open. `/rewind` was added later and is not covered here. | ✅ |
| 13 | Machine usage relay (protocol 0.3.0): hub + agent running, zero sessions on the machine; `GET /api/machines/:id/usage/api/stats?range=…` answered via `usage-req`/`usage-res` from the machine-local dashboard (agent started it on demand); home page Usage button → `/usage/<machineId>` renders overview cards, requests-over-time bars, and per-model table from live data; range switch refetches; `POST …/usage/api/sync` scans and returns counts; 404 unknown machine, 502 agent offline, 504 silent agent | ✅ |
| 14 | **omp profile start**: `mkdir -p ~/.omp/profiles/<name>/agent`; home form shows an "omp profile" dropdown fed by `GET /api/machines/:id/profiles` (`list-profiles`); start with profile `<name>` → `sessionFile` lands under `~/.omp/profiles/<name>/agent/sessions/`, child env carries `OMP_PROFILE`/`PI_PROFILE` (checked via `/proc/<pid>/environ`), record + session list show the profile; unknown profile → record `failed` with `profile "<name>" not found on this machine`; `default` selection starts with no profile env even under an ambient `OMP_PROFILE` daemon | ✅ |
| 15 | **Session ops (2026-09-23, feat/web-session-ops)**: live hub `:18080` + agent + real SDK session, driven from the browser session page. `/extended-context` → toast "extended context on"; `/extended-context off` (arg form) → "off"; `/retry` on a fresh session → 409 surfaced as "Nothing to retry." toast; `/compact` → "compaction started" (background dispatch; progress arrives via transcript); `/goal` modal: status card "no goal", Set with objective + budget → card flips to `active` with the objective and "0 tokens", Pause → `paused`, Drop → back to "no goal"; `/loop` modal: invalid limit `abc` → local warning, no request; Enable with a 10m limit → status card `running` with duration + deadline and Disable/Pause armed; Disable → "no loop"; `/` palette filters (`/lo` → `/loop`); `/help` lists all six new commands; `get-state` carries `extendedContext`/`goal`/`loop` (header chips render through the existing path). Agent-side real-host smoke: `packages/agent/test/session-host-ops.test.ts` drives `get-state`/`loop`/`set-extended-context`/`goal` against a live session-host child. | ✅ |
| 16 | **Profile-aware history (2026-09-23, feat/profile-history)**: worktree hub `:8091` + worktree agent (real SDK, this machine's `glm`/`flagos` profiles). `GET /api/machines/:id/sessions` sends `list-sessions allProfiles` and returns one merged recency listing — 22 `glm` + 1 `flagos` rows, each stamped with `profile`, no duplicates even though the daemon ran under ambient `OMP_PROFILE=glm` (named scans claim their paths first). Home History panel renders rows with the profile chip; filter `flagos` narrows to the flagged row; clicking a `glm` row resumed it with `profile: "glm"` (record shows the profile), the session reached `live`, and stop → `exited/"user stop"` | ✅ |

## Environment quirks observed (not product bugs)

- **IPv6 localhost vs podman/pasta**: `curl http://localhost:8480` (→ `::1`) is accepted then
  reset by this machine's pasta stack; `127.0.0.1` works. Use IPv4 literals for podman-published
  ports here.
- **Newer TUI guests keep reconnecting after `room-closed`**: repo-version web guests end
  cleanly; the installed omp v18.2.10 guest treats host loss as transient and retries (upstream
  host-return recovery). Same relay contract, different guest policy.
- `HEALTHCHECK` in the Dockerfile is dropped silently by podman's default OCI image format
  (warning only); it works under `docker build` or `podman build --format docker`.

## Known MVP limitations (by design, see milestones)

- Hub registry is in-memory: hub restart forgets sessions/machines (agents re-register; live
  collab rooms die with the process). → M7.
- All authenticated web users receive the full (write) link. → M6 per-user ACL.
- Agent restart kills live children and invalidates their links; persisted session files can be
  resumed as new live sessions through the machine's recent-sessions list after reconnection.
