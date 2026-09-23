# Repository Guidelines

## Project Overview

`omp-hub` remotely controls headless [omp](https://github.com/can1357/oh-my-pi) agent sessions. The Bun hub serves a collab relay, machine/session API, and browser UI; an outbound-only daemon on each controlled machine starts isolated session hosts. Browser guests or `omp join` attach to those sessions without opening a TUI on the agent machine.

## Architecture & Data Flow

- **Control:** `packages/web/src/hub/api.ts` calls bearer-authenticated `/api/*`; `packages/hub/src/api.ts` updates the in-memory session registry and sends `start`/`stop`/`cmd` over the token-authenticated `/agent` WebSocket. `packages/agent/src/main.ts` delegates to `Supervisor`, which runs one `session-host.ts` child per session and exchanges JSONL frames over stdio. Correlate command replies by `reqId`; a session child must not share omp's process-global SDK singletons with another session.
- **Session content:** The child's `CollabHost` creates full/view links; browser `GuestClient` (or `omp join`) exchanges AES-256-GCM frames through `/r/<roomId>`. The relay forwards ciphertext and rewrites only peer IDs. The hub registry nevertheless stores the links/keys and gives authenticated web users the full write link: treat the hub and links as sensitive.
- **Web state:** `/`, `/s/<id>`, `/join` use a small path router. Hub pages poll the HTTP API; live session state is a `GuestClient` external store consumed with `useSyncExternalStore`. Slash commands are intercepted locally in `hub/commands.ts`, not sent as prompts. Hub registry/rooms are in memory; restart drops live rooms, while agents reconnect.

## Key Directories

| Path | Work here for |
|---|---|
| `packages/hub/src/` | Bun HTTP/WS server, auth/API, relay, registry, static SPA serving |
| `packages/agent/src/` | daemon connection, child supervision, SDK/CollabHost session, default-deny headless UI |
| `packages/web/src/hub/` | hub pages, API client, session glue, local slash commands |
| `packages/web/src/lib/`, `components/`, `guest/`, `tool-render/` | vendored collab client/wire/crypto, transcript and tool UI; keep hub additions in `hub/` when possible |
| `packages/{hub,agent,web}/test/` | Bun tests; agent child fixture is in `packages/agent/test/fixtures/` |
| `docs/`, `docker/` | protocol/design and dated E2E notes; hub-only image/Compose |

## Development Commands

Run commands from the repository root with `bun --cwd`; there is no root package manifest or workspace runner.

```bash
# Install and check each package (hub/agent dependencies are dev-only)
bun --cwd=packages/web install --frozen-lockfile
bun --cwd=packages/web run build
bun --cwd=packages/web run typecheck
bun --cwd=packages/hub install --frozen-lockfile
bun --cwd=packages/hub run typecheck
bun --cwd=packages/agent install --frozen-lockfile
bun --cwd=packages/agent run typecheck

# Local demo: run these in separate terminals
HUB_TOKEN=dev-token bun --cwd=packages/hub run demo  # installs locked web deps, builds UI, serves :8080
bun --cwd=packages/agent run dev -- --hub ws://localhost:8080 --token dev-token --name dev-machine
bun --cwd=packages/web run dev                       # optional separate Bun HTML dev server

bun --cwd=packages/hub test
bun --cwd=packages/agent test
bun --cwd=packages/web test
docker build -f docker/Dockerfile -t omp-hub .       # hub + web only
```

The hub and agent also expose `bun run start` (same entry points as `dev`). Hub `demo` installs the web's frozen lockfile dependencies and builds `dist/` before serving; hub `dev`/`start` serve an existing dist without building it. `WEB_DIST` overrides the static directory. The Docker image builds the web with `bun install --frozen-lockfile` and packages the hub only, not the machine agent.

## Code Conventions & Common Patterns

- **Feature worktrees:** Implement all feature additions and behavior changes in a dedicated Git worktree (one per concurrent change). Reserve the main working tree solely for merging completed worktree changes; never implement feature work there.
- TypeScript ESM, strict `tsconfig.json`, tabs in source; `PascalCase.tsx` React components, kebab-case modules such as `hub-client.ts`. Prefer existing `t`-discriminated frames (`session-ready`, `cmd-result`) and `machineId`/`reqId` fields. `docs/protocol.md` freezes the hub wire shapes: coordinate protocol changes with the doc, both endpoints, and relevant tests; keep the vendored web `COLLAB_PROTO` compatible with omp's host.
- Keep the hub on Bun built-ins (zero runtime dependencies). Use explicit config/constructor options and small protocol-facing interfaces rather than a DI container; examples: `startHub({ port: 0, token: "t" })` in tests and `Supervisor`'s child entry option.
- Reserve session-host **stdout for JSONL IPC**. Log diagnostics to stderr; do not leave headless UI dialog promises pending. Use `Settings.loadIsolated`, not global `Settings.init`, when creating SDK sessions.
- Normalize errors at boundaries: HTTP JSON `{error}` with an intentional status, `HubApiError` in the browser, and `cmd-result` for agent commands. Pair async `reqId` responses, clear timeout timers, and settle pending requests on disconnect/child exit. Do not edit vendored guest components for hub-only behavior when `hub/` glue can own it.

## Important Files

- `packages/hub/src/server.ts` routes `/healthz`, `/agent`, `/r/*`, `/api/*`, then static; `config.ts` reads `PORT`, `HOST`, `HUB_TOKEN`, `HUB_PUBLIC_URL`, TLS and dist settings; `agents.ts`, `sessions.ts`, and `relay.ts` own live state.
- `packages/agent/src/main.ts`, `hub-client.ts`, `supervisor.ts`, `session-host.ts`, and `ui-stub.ts` trace daemon-to-session behavior.
- `packages/web/src/main.tsx`, `hub/SessionView.tsx`, `hub/commands.ts`, `lib/client.ts`, `lib/socket.ts`, `lib/wire.ts`, and `lib/codec.ts` trace browser routing, control, wire, and crypto.
- `docs/protocol.md` is the wire contract; `docs/architecture.md` explains isolation/security; `docs/e2e.md` records manual verification, not an automated suite.

## Runtime/Tooling Preferences

Use **Bun ≥ 1.3.14**, not Node/npm commands. Each package owns a `bun.lock`: web has third-party runtime dependencies; hub and agent have only dev dependencies for TypeScript and Bun types, keeping their runtimes dependency-free. Run `bun run typecheck` in each package. Agent type checking emits nothing and resolves SDK source imports and asset declarations through a sibling `../oh-my-pi` checkout with its own dependencies installed; its real-host test also needs matching SDK subpaths. Hub/agent run TypeScript directly without a build step. There is no configured lint, formatter, CI workflow, or coverage gate. Keep `HUB_TOKEN` set outside disposable local development; remote browser/`omp join` access needs HTTPS/WSS (`HUB_TLS_CERT`/`HUB_TLS_KEY` or a proxy plus `HUB_PUBLIC_URL`).

## Testing & QA

Use `bun:test` in `<package>/test/*.test.ts`; scope a run with e.g. `cd packages/hub && bun test test/relay.test.ts`. Hub tests start a real hub on port 0 and exercise HTTP/WebSocket against a fake agent; agent tests spawn a child (fixture for commands, real host for framing); web tests exercise pure commands/API with a fetch stub. For async assertions, prefer condition/deadline polling or frame-order sentinels over fixed sleeps. There is no automated browser E2E: for UI or session-flow changes, exercise the hub + agent + browser (and `omp join` when relevant) using `docs/e2e.md` as a scenario list, not as a runnable test. A green unit suite does not verify React rendering, static assets, or the session-host success path.
