# E2E verification notes (MVP, 2026-09-23)

Environment: Fedora Linux (Ryzen 7950X), Bun 1.3.14, podman 5.x, Chromium (headless automation),
provider DeepSeek via the shared `~/.omp` auth store.

## Local dev topology

- hub: `bun src/server.ts`, `PORT=8471 HUB_TOKEN=dev-token` (8080 was taken by an unrelated
  container stack on this machine).
- agent: `bun src/main.ts --hub ws://localhost:8471 --token dev-token --name dev-machine`.
- demo cwd: `/tmp/omp-hub-demo`.

## Verified flows

| # | Flow | Result |
|---|---|---|
| 1 | Agent registers; `GET /api/machines` shows `dev-machine` connected | ✅ |
| 2 | Web token gate (wrong token → error, not persisted; right token + display name → home) | ✅ |
| 3 | Home start form (`cwd=/tmp/omp-hub-demo`, initial prompt `Reply with exactly: ok`) → 202 → `/s/<id>` starting card → status `live` with 4 links minted | ✅ |
| 4 | Session page: host badge prompt + streamed `ok` answer, model/thinking chips, participants | ✅ |
| 5 | Web composer prompt → author badge `sky`; agent ran `bash node index.js` (tool card, exit 0) and reported `hello from demo` | ✅ |
| 6 | Web interrupt during `bash sleep 60` → `aborted / Interrupted by user / sky interrupted` | ✅ |
| 7 | **omp client attach**: `omp join "ws://localhost:8471/r/<room>.<key>"` (omp v18.2.10, pty) → joined; TUI prompt landed on web with badge `skyrain`; answer visible both sides | ✅ |
| 8 | Stop from home → record `exited/"user stop"`; web guests get `session ended / room closed` + Rejoin/New link | ✅ |
| 9 | Hub restart → agent auto-reconnects and re-registers (sessions lost — in-memory registry, see M7) | ✅ |
| 10 | Responsive: 390×844 home (single column, ≥40px targets) and session (transcript, badges, tool cards, drawer) render correctly; 1440×900 two-column home + full session chrome | ✅ (screenshots reviewed) |
| 11 | Docker (podman): image builds (~52 s); container on `127.0.0.1:8480` serves health/API/web; host agent `docker-machine` connects; browser start → prompt `container-ok` streamed; stop → `exited` | ✅ |
| 12 | Web slash commands: `/` palette (8 commands, filter, keyboard nav, mobile sheet); `/model` picker switched deepseek-flash → v4-flash → v4-pro live (header chip + transcript entries update via state broadcast); `/thinking` xhigh; `/collab` links modal; unknown `/frobnicator` → "host-only or unknown command — not sent", nothing reaches the agent; palette-run commands clear the composer; palette suppressed while a modal is open | ✅ |
| 13 | Machine usage relay (protocol 0.3.0): hub + agent running, zero sessions on the machine; `GET /api/machines/:id/usage/api/stats?range=…` answered via `usage-req`/`usage-res` from the machine-local dashboard (agent started it on demand); home page Usage button → `/usage/<machineId>` renders overview cards, requests-over-time bars, and per-model table from live data; range switch refetches; `POST …/usage/api/sync` scans and returns counts; 404 unknown machine, 502 agent offline, 504 silent agent | ✅ |
| 14 | **omp profile start**: `mkdir -p ~/.omp/profiles/<name>/agent`; home form shows an "omp profile" dropdown fed by `GET /api/machines/:id/profiles` (`list-profiles`); start with profile `<name>` → `sessionFile` lands under `~/.omp/profiles/<name>/agent/sessions/`, child env carries `OMP_PROFILE`/`PI_PROFILE` (checked via `/proc/<pid>/environ`), record + session list show the profile; unknown profile → record `failed` with `profile "<name>" not found on this machine`; `default` selection starts with no profile env even under an ambient `OMP_PROFILE` daemon | ✅ |

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
- No session resume after agent restart (children die with the daemon; session files persist
  under `~/.omp/agent/sessions/…`). → M8.
