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
                                      collab UI bridge (ask/select/editor → guests)
```

**Why process-per-session (not N sessions in one process):** omp's SDK has documented
process-global singletons that break multi-session daemons — `Settings.init()` (first cwd wins),
`AsyncJobManager.instance()` (second top-level session gets none → async bash/task break),
`AgentRegistry` id `"Main"` collision, module-global skills/rules/provider prefs (last session
wins), and `dispose()` of any session kills shared tiny-title/mnemopi subprocesses. Process
isolation sidesteps all of it and adds crash containment. Evidence:
`oh-my-pi/packages/coding-agent/test/sdk-async-job-manager-singleton.test.ts`,
`src/async/job-manager.ts:96-112`, `src/config/settings.ts:288`.

Machine subscription limits come from omp's auth-store `/usage` reports, not the
transcript-backed `/stats` dashboard. The daemon answers the machine-level
request without starting a session. It fetches each selected profile in a
separate short-lived SDK process because profile directories and provider
registries are resolved at module load; only a bounded, allowlisted projection
of the reports crosses the hub channel. Historical request statistics remain
on the existing stats-dashboard relay.

**session-host construction** (per child):

1. `createAgentSession({ cwd, agentDir?, settings: await Settings.loadIsolated({cwd, agentDir}),
   sessionManager: SessionManager.create(cwd), agentId: "hub-<sessionId>", hasUI: false,
   autoApprove: true, eventBus })`.
   - `Settings.loadIsolated`, never `Settings.init` (global singleton).
   - `autoApprove: true` ⇒ forced `tools.approvalMode: "yolo"` (headless precedent:
     `src/task/executor.ts:786-796` "Subagents run headless"). Policy knobs:
     `tools.approval.<tool>: allow|deny` honored in every mode.
2. Install the **collab UI bridge** (`ui-bridge.ts`, docs/protocol.md §7): `createAgentSession`
   runs with `interactivePrompts: true` (registers the `ask` tool) and `setToolUIContext(ui, true)`
   hands extensions a bridging `ExtensionUIContext` — `askDialog`/`select`/`editor` mirror to
   **writable** collab guests as `ui-request`/`ui-response` frames, and `CollabHost` retains a
   request until the first writer joins. The default-deny discipline stays as the bridge's
   fallback (all required `ExtensionUIContext` methods; awaitables settle immediately:
   select→`undefined` (mapped to Deny upstream), confirm→`false`, input/editor/custom→`undefined`;
   everything else no-op; `theme` after `initTheme()`): no room, gated traffic, pending cap,
   caller abort, guest cancel, or relay teardown all settle as a cancellation instead of a
   dialog. `await initializeExtensions(session, { uiContext: ui, … })` from
   `@oh-my-pi/pi-coding-agent/modes/runtime-init` is still the only supported way to make
   `ExtensionRunner.hasUI()` true. **Never leave a dialog promise unsettled** — that is
   the only way to hang a session.
3. Build the collab stub context (shape proven by
   `oh-my-pi/packages/coding-agent/test/collab/read-only.test.ts` `makeHostContext()`):
   `{ settings: session.settings, sessionManager: session.sessionManager, session, eventBus,
   statusLine: { setCollabStatus(){}, invalidate(){}, getCachedContextBreakdown: () => collabContextUsage(session) },
   ui: { requestRender(){} }, showStatus(){}, updatePendingMessagesDisplay(){}, collabHost: undefined }`
   cast `as unknown as InteractiveModeContext`.
4. `const host = new CollabHost(ctx);` — bind the module-level `collabHost` the bridge reads
   **before** `await host.start(relayUrl, webUrl)` (a `session_start` hook dialog raised during
   startup must reach the bridge while the relay connection is still opening), then
   `ctx.collabHost = host;` and report `{ link, webLink, viewLink, webViewLink }` upstream.
5. Optional initial prompt: `void session.prompt(text)` (fire-and-forget, errors logged).
6. Shutdown: on SIGTERM or supervisor `stop` → `host.stop("hub stop")` →
   `session.beginDispose()` → `await session.dispose()` (never `process.exit` paths from RPC mode).

Guest prompts arrive through collab (`prompt` frames) and land via
`session.promptCustomMessage({customType:"collab-prompt", …})` — handled entirely by
`CollabHost`; the child does not proxy prompts itself in the MVP.

The encrypted-relay history integration test supplies an isolated SDK model backed
by a local OpenAI-compatible responder. This keeps its live guest-prompt and
pagination assertions independent of the developer's credentials or CI secrets.

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
  PWA manifest. The shared frame keeps the rail visible beside the scrollable New tab;
  its columns follow the remaining pane width, and the cwd field wraps below 400px
  so widening the rail cannot crush the mobile form.
- Secure context requirement: WebCrypto (`crypto.subtle`) needs https or localhost. Plain-LAN
  http deployments need TLS for the web client to decrypt rooms (see Security/TLS).

Hub additions:

- `main.tsx` boots a tiny path router (no dependency): `/` selects the pinned New tab,
  `/s/<id>` selects a session in the same `HubFrame`, `/join` is an arbitrary-link
  guest (vendored connect screen), and `/usage/<machineId>` remains separate.
- Token gate: token in `localStorage["omp-hub.token"]`, sent as `Authorization: Bearer`.
- New tab: live machine list (`/api/machines`), namespace create/list and
  selection for a full start form (machine, profile, cwd, name, prompt,
  tools/superagent), plus per-machine history with resume and message search.
  The persistent rail owns the hub session list (`/api/sessions` every 2s),
  status/selection, stop vs delete, copyable attach/view links, and live-session
  namespace moves through its Manage dialog. Deleting the current row selects
  the next visible session, falling back to New with no survivors.
- Session registry polling is shared by the rail and an authenticated
  `WarmSessions` coordinator. It keeps at most six writable `GuestClient`
  replicas connected across route changes, choosing the visible session first,
  then input-required/working sessions and recently visited rooms. Hidden
  sessions are not preconnected; a cold room joins when selected. Only the
  visible `SessionView`/transcript mounts, so off-screen rooms do not render
  React trees or poll `agent-state`.
- The session surface only accepts a link belonging to the current route id.
  A matching pooled client retains its transcript and receives background
  frames without another hello/snapshot; changed links re-mint it. Transient
  socket drops retry in `CollabSocket`, and ended background clients retry
  with bounded backoff only while the registry still says live. Eviction,
  deletion, leaving the authenticated hub, logout, and a rejected hub token
  close peers; logout/401 also clear cached bearer-protected registry records.
- Browser guests request only the newest 80 transcript entries on join. The
  patched agent host returns a bounded tail snapshot first, leaving the
  composer usable while older pages load on upward scroll or via the button
  at the top. Live entries continue arriving independently. The `/join` and
  hub session pages share this behavior; `omp join` still receives the full
  snapshot. Older agents send their usual full snapshot until upgraded.
- Display name: profile name input on the token gate, stored
  `localStorage["omp-hub.name"]`, default `"guest"`.
- Authenticated hub pages share one settings center (`SettingsModal`): the New
  tab header and shared rail/switcher open browser preferences; `/settings`
  opens the live session controls in the same dialog. Browser options reuse their
  existing localStorage stores, while model/thinking and the SDK's allowlisted
  settings stay tied to the current live session. The dialog becomes a
  scrollable bottom sheet on phones; the unauthenticated `/join` page has no
  hub-settings entry.
- The transcript's browser-local `omp.transcript-mode` defaults to `full`;
  the settings center's "Only show model answers" checkbox is the only
  control — transcript surfaces render no in-chat switch. `body` narrows to
  agent messages: agent turns collapse to model text plus a footnote, hiding
  reasoning, tool details and transcript metadata, while user prompts, the
  session stats strip and subagent stats stay visible, all without changing
  collab data. One footnote per agent turn counts distinct tool-call ids and
  sums host-reported **whole model request** durations (approximate, not
  exclusive thinking time and excluding tool execution). Missing timing
  remains unknown; incomplete history is marked until older entries load.
  Errors retain a short status.

- `HubAlerts` stays mounted across authenticated routes and consumes the shared
  sessions-store poll; the persistent frame also tracks completed sessions while
  New is selected. Rail and settings notification toggles share a browser-local
  preference. New/usage and session status cards render local alert toasts when
  no collab surface exists.
- Hub startup variables and daemon CLI flags are deployment configuration, not
  writable browser preferences. Logging out only removes the browser's saved
  bearer token; changing the server token still requires operator deployment.

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
- **Fleet namespaces are a hub control-plane boundary.** A superagent child exposes
  only the SDK-supplied `fleet_*` tools (`restrictToolNames` and
  `allowRestrictedCustomTools`); the daemon permits only `/api/fleet/*`, supplies
  its real child id as the owner, and the hub checks current membership on
  each operation. Workers outside that namespace return 404 to its tools.
  Admin users still hold the global `HUB_TOKEN`; namespaces are not per-user
  ACLs or process/filesystem isolation. A manually shared collab write link
  remains a capability even after namespace reassignment — rotating existing
  links or isolating OS accounts is required for strict revocation.
- **Fleet state is durable separately from the registry snapshot.** A sibling
  `${HUB_STATE_FILE}.fleet.sqlite` stores namespace membership, control and
  unread subscribed events. Persist the state directory as a unit; restore
  without a membership row is fail-closed. Old daemon builds retain their
  pre-namespace fleet proxy allowlist. Upgrade every daemon, stop old
  superagents, and rotate `HUB_TOKEN` if an old daemon may still possess it;
  otherwise do not treat namespaces as an isolation guarantee.
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
