# Milestones

## MVP

### M1 — Hub server (`packages/hub`)
Bun.serve single port: relay (`/r/:room`), agent channel (`/agent`), API (`/api/*`),
static dist + SPA fallback, `/healthz`, env config (`PORT`, `HUB_TOKEN`, `HUB_PUBLIC_URL`,
`HUB_TLS_CERT`, `HUB_TLS_KEY`, `WEB_DIST`). In-memory stores. Unit tests: relay routing contract
(host/guest/peerId rewrite/broadcast/4004/4009/room-closed), API auth + start/stop flow against a
fake agent socket.
**Acceptance:** `bun test` green; `bun run dev` serves health + dist.

### M2 — Wrapper agent (`packages/agent`)
Supervisor + hub WSS client (token, reconnect 1s→30s, heartbeat 15s) + per-session child
(`session-host.ts`): SDK session (isolated settings, autoApprove, `agentId` unique), default-deny
23-member UI context wired via `setToolUIContext` + `initializeExtensions`, stub
InteractiveModeContext, `CollabHost.start`, link report, stop → dispose. Resolves
`@oh-my-pi/pi-coding-agent` from the sibling `oh-my-pi` checkout (dev) — see package README.
**Acceptance:** against a local hub, `start` yields a live session with 4 links; guest prompts
execute tools; `stop` tears down the room (guests get `room-closed`); child exit propagates
`session-exit`.

### M3 — Web UI (`packages/web`)
Vendor collab-web; path router; token gate + profile name; home (machines, start form, session
list with stop/copy-link); session page (full guest powers); `/join` arbitrary link page.
Responsive verified at 390px and 1440px.
**Acceptance:** `bun run build` emits dist; full flow in a real browser.

### M4 — Local E2E
hub + agent + browser: token login → start session on `dev-machine` → live transcript streams →
prompt from web → interrupt → subagent panel → stop. `omp join "<link>"` attach from a terminal:
transcript renders, prompt from TUI lands with author badge. Mobile viewport spot-check.
**Acceptance:** scripted verification notes in repo (`docs/e2e.md`).

### M5 — Docker
Multi-stage `docker/Dockerfile` (build web → runtime hub), `.dockerignore`, compose convenience
file. Single port, `HUB_TOKEN` env.
**Acceptance:** image builds; container serves health/API/web; agent on host connects to
containerized hub; session driven end-to-end. (If no container runtime on the dev machine:
verify by container-layout emulation and document.)

## Delivered after MVP

- **M8 — session resume**: hub `start` accepts a saved `sessionFile`; the agent lists recent
  sessions for a machine and reopens the selected session in a new child. A restarted hub/agent
  still loses live rooms, but session files remain available for resumption.

## Post-MVP (remaining)

- **M6 — per-user auth & ACL**: user accounts (or OIDC), per-session grants
  (owner/editor/viewer), distribute view links by default, write actions via hub-proxied
  `session.prompt()` with per-user attribution instead of distributing write tokens.
- **M7 — durable hub state**: SQLite registry; reattach after hub restart (rooms still die —
  document or add host re-registration).
- **M9 — approvals via web**: route `ExtensionUIContext` dialogs to the browser through the
  agent channel (timeout + default-deny), replacing blanket yolo for sensitive tools.
- **M10 — hardening**: room caps (`4029`), per-IP rate limits, agent allow-lists, audit log,
  upstream collab-web sync procedure, i18n pass.
- **M11 —nice-to-haves**: hub-side guest presence (hub joins view-only to render previews),
  SSE push instead of 2 s polling, share-blob endpoints (`/s` upstream share viewer).
