# Architecture

## Components

### 1. Hub (`packages/hub`)

Single Bun process, single port. Four logical surfaces:

| Surface | Route | Auth | Purpose |
|---|---|---|---|
| collab relay | `GET /r/<roomId>?role=host\|guest` (WS upgrade) | none (roomId+key is the capability, upstream model) | content-blind frame routing between session-hosts and guests |
| agent channel | `GET /agent` (WS upgrade) | shared `Authorization: Bearer` token | wrapper registration, heartbeat, command dispatch, session reports |
| HTTP API | `/api/*` | `Authorization: Bearer <token>` | machine/session registry for the web UI |
| static | `/*` | none (UI itself prompts for token) | serves `packages/web` dist with SPA fallback |

State is in-memory (MVP): `rooms`, `agents`, `sessions` maps. Hub restart loses registry state;
agents reconnect and re-register, live collab rooms are dropped (guests see `room-closed`).

The relay part implements the exact upstream contract (byte-compatible with
`oh-my-pi/packages/collab-web/scripts/local-relay.ts`):

- roomId path regex `^/r/([A-Za-z0-9_-]{10,64})$`, `role=host|guest` required.
- First host claims the room; second host → close `4009`; guest without room → close `4004`.
- Binary frames `[4B uint32 BE peerId][AES-GCM sealed payload]`: host→peerId 0 broadcasts to all
  guests, peerId N targets guest N, forwarded unchanged. Guest frames get the first 4 bytes
  rewritten to the sender's peerId and go to the host only.
- TEXT control (relay-generated only): `{"t":"peer-joined","peer":N}` / `{"t":"peer-left","peer":N}`
  to the host; `{"t":"room-closed"}` + close `4001` to guests when the host disconnects.
- Clients treat 4001/4004/4009/4029 as fatal (no reconnect); anything else retries with backoff.

### 2. Agent / wrapper (`packages/agent`)

Headless daemon per machine. **No TUI is ever constructed.** Two process layers:

```
main.ts (supervisor)                session-host.ts (one child process per session)
  hub-client.ts  ◀── JSONL stdio ──   createAgentSession({cwd, …})
  supervisor.ts                       CollabHost over a stub InteractiveModeContext
                                      default-deny ExtensionUIContext
```

**Why process-per-session (not N sessions in one process):** omp's SDK has documented
process-global singletons that break multi-session daemons — `Settings.init()` (first cwd wins),
`AsyncJobManager.instance()` (second top-level session gets none → async bash/task break),
`AgentRegistry` id `"Main"` collision, module-global skills/rules/provider prefs (last session
wins), and `dispose()` of any session kills shared tiny-title/mnemopi subprocesses. Process
isolation sidesteps all of it and adds crash containment. Evidence:
`oh-my-pi/packages/coding-agent/test/sdk-async-job-manager-singleton.test.ts`,
`src/async/job-manager.ts:96-112`, `src/config/settings.ts:288`.

**session-host construction** (per child):

1. `createAgentSession({ cwd, agentDir?, settings: await Settings.loadIsolated({cwd, agentDir}),
   sessionManager: SessionManager.create(cwd), agentId: "hub-<sessionId>", hasUI: false,
   autoApprove: true, eventBus })`.
   - `Settings.loadIsolated`, never `Settings.init` (global singleton).
   - `autoApprove: true` ⇒ forced `tools.approvalMode: "yolo"` (headless precedent:
     `src/task/executor.ts:786-796` "Subagents run headless"). Policy knobs:
     `tools.approval.<tool>: allow|deny` honored in every mode.
2. Install the **default-deny UI context** (all required `ExtensionUIContext` methods; awaitables
   resolve immediately: select→`undefined` (mapped to Deny upstream), confirm→`false`,
   input/editor/custom→`undefined`; everything else no-op; `theme` after `initTheme()`):
   - `setToolUIContext(ui, false)` (tools stay non-interactive; ask tool stays off),
   - `await initializeExtensions(session, { uiContext: ui, … })` from
     `@oh-my-pi/pi-coding-agent/modes/runtime-init` — the only supported way to make
     `ExtensionRunner.hasUI()` true; with the runner's no-op sentinel, approval-required tool
     calls throw instead of hanging (wrapper.ts:152-161). With yolo nothing should reach that
     path; the deny-ctx is the safety net. **Never leave a dialog promise unsettled** — that is
     the only way to hang a session.
3. Build the collab stub context (shape proven by
   `oh-my-pi/packages/coding-agent/test/collab/read-only.test.ts` `makeHostContext()`):
   `{ settings: session.settings, sessionManager: session.sessionManager, session, eventBus,
   statusLine: { setCollabStatus(){}, invalidate(){}, getCachedContextBreakdown: () => ({usedTokens: 0, contextWindow: 0}) },
   ui: { requestRender(){} }, showStatus(){}, updatePendingMessagesDisplay(){}, collabHost: undefined }`
   cast `as unknown as InteractiveModeContext`.
4. `const host = new CollabHost(ctx); await host.start(relayUrl, webUrl); ctx.collabHost = host;`
   then report `{ link, webLink, viewLink, webViewLink }` upstream.
5. Optional initial prompt: `void session.prompt(text)` (fire-and-forget, errors logged).
6. Shutdown: on SIGTERM or supervisor `stop` → `host.stop("hub stop")` →
   `session.beginDispose()` → `await session.dispose()` (never `process.exit` paths from RPC mode).

Guest prompts arrive through collab (`prompt` frames) and land via
`session.promptCustomMessage({customType:"collab-prompt", …})` — handled entirely by
`CollabHost`; the child does not proxy prompts itself in the MVP.

### 3. Web (`packages/web`)

Vendored copy of `@oh-my-pi/collab-web` (MIT) plus a hub layer. Rationale: the guest client
(`GuestClient` + `CollabSocket` + transcript/tool-card renderers + subagent drawer) is
production-grade and exactly the "full operation" surface; rebuilding it would be the largest
single cost. Vendoring keeps this repo self-contained and Docker-buildable. Upstream sync is a
maintenance task (see milestones).

Upstream facts the design relies on:

- No router, no state library: `GuestClient` is an external store bound with
  `useSyncExternalStore`; one client ⇄ one socket; multi-room is just N instances.
- Display names ride the `hello` frame (`new GuestClient(link, name)`); fixed for the
  connection's lifetime (rename = reconnect).
- URL `#fragment` is the room-link channel, read once at mount; hash routing collides with the
  link grammar ⇒ **path routing** (`/`, `/s/<id>`, `/join`).
- Responsive already: breakpoints 768px/640px, visualViewport height var, safe-area insets,
  PWA manifest. The hub home page reuses the same tokens.
- Secure context requirement: WebCrypto (`crypto.subtle`) needs https or localhost. Plain-LAN
  http deployments need TLS for the web client to decrypt rooms (see Security/TLS).

Hub additions:

- `main.tsx` boots a tiny path router (no dependency): `/` home, `/s/<id>` session, `/join`
  arbitrary-link guest (vendored connect screen).
- Token gate: token in `localStorage["omp-hub.token"]`, sent as `Authorization: Bearer`.
- Home: machine list (live, from `/api/machines`), start form (machine, cwd, name, optional
  initial prompt), session list (poll `/api/sessions` every 2s) with status + open/stop actions
  + copyable attach links.
- Session page `/s/<id>`: fetch `/api/sessions/:id` (contains the full collab link), construct
  `GuestClient(link, displayName)`, render the vendored session leaves
  (HeaderBar/Transcript/AgentsPanel/Composer/AgentDrawer/Banners/Toasts) through a thin
  `SessionView` glue (~40 lines, mirroring upstream `Session` in `app.tsx`).
- Display name: profile name input on the token gate, stored
  `localStorage["omp-hub.name"]`, default `"guest"`.

## Security model (MVP)

- **Single shared token** (`HUB_TOKEN` env) gates the agent channel and the API. Startup
  refuses an empty token, even on loopback.
- The hub defaults to loopback (`HOST=127.0.0.1`); direct remote access requires an explicit
  `HOST` override, TLS, and a trusted ingress.
- **The hub holds room keys.** Sessions mint their links on the wrapper and upload them; the web
  UI distributes the *full* (write) link to any authenticated user. E2E confidentiality ends at
  the hub: it is a trusted party. Per-user ACL, view-only distribution, and hub-proxied prompts
  (no write-token distribution) are post-MVP (milestones M6).
- The authenticated machine history endpoint lists recent sessions from the daemon's omp store
  across projects, including paths, titles and first-message excerpts; all token holders can
  browse and resume them. Use a dedicated OS account to isolate private history.
- Relay endpoints stay unauthenticated for upstream wire compatibility; room IDs are random and
  payloads are AES-GCM sealed. There is no host-identity proof or global room quota: a viewer
  with a room link can claim the host slot after a disconnect, and an unauthenticated client can
  create rooms until resources are exhausted. Restrict relay ingress to trusted networks.
- The token travels in an `Authorization: Bearer` header on both the API and agent channel,
  never in a URL. Restrict access to reverse-proxy logs and stored browser tokens.

## TLS / LAN notes (hard constraints from upstream)

- `parseCollabLink`/`CollabHost` reject plain `ws://` for non-localhost hosts
  (`oh-my-pi/packages/coding-agent/src/collab/protocol.ts:172-174`). ⇒ **`omp join` attach on a
  LAN requires `wss://`**, i.e. the hub needs TLS.
- The browser client needs a secure context for WebCrypto ⇒ **https (or localhost) for web use**.
- Hub supports `HUB_TLS_CERT`/`HUB_TLS_KEY` (Bun.serve tls) directly; or terminate TLS in front
  (Caddy/nginx) and set `HUB_PUBLIC_URL=https://hub.lan` so minted links use `wss://`.
- Single-machine development on `localhost` needs none of this (`ws://localhost` and
  `http://localhost` are both secure-context/loopback exceptions).

## Link flow (what travels where)

1. Hub → agent `start {id, cwd, relayUrl, webUrl}` (relayUrl/webUrl derived from
   `HUB_PUBLIC_URL` or the agent connection's Host/TLS).
2. Agent child `CollabHost.start(relayUrl, webUrl)` mints roomId/key/writeToken locally and
   renders four links (`link`, `webLink`, `viewLink`, `webViewLink`).
3. Child → supervisor → hub `session-ready {id, links}` — hub stores them on the SessionRecord.
4. Web session page pulls the record (auth) and connects with the **full** link.
5. `omp join "<full-or-view link>"` attaches a terminal guest (write or read-only by link type).
