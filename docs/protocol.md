# Protocols

All hub-own messages are JSON. `/*` = MVP freezes these shapes; changes need a version bump.

## 1. Relay contract (`/r/<roomId>`) — frozen, upstream-compatible

Byte-identical to `oh-my-pi/packages/collab-web/scripts/local-relay.ts`. Summary:

- Upgrade: `GET /r/<roomId>?role=host|guest`, roomId matches `^[A-Za-z0-9_-]{10,64}$`; anything
  else → 404. Missing/bad role → 404.
- Host first: creates room. Second host → close `4009`. Guest without live room → close `4004`.
  Room full (optional cap, MVP: none) → close `4029`.
- Guests get incrementing peerIds starting at 1; host is 0.
- Binary frame routing (`[4B uint32 BE peerId][sealed]`):
  - from host: peerId 0 → broadcast unchanged to all guests; peerId N → forward unchanged to
    guest N.
  - from guest: rewrite bytes 0-3 to the sender's peerId, forward to host. Never to other guests.
- TEXT frames from clients are ignored. Relay → host TEXT `{"t":"peer-joined","peer":N}` /
  `{"t":"peer-left","peer":N}`; relay → guests TEXT `{"t":"room-closed"}` then close `4001` when
  the host's socket closes.
- `GET /healthz` → 200 `ok` (liveness, unauthenticated).

## 2. Agent channel (`GET /agent?token=<HUB_TOKEN>`)

WS upgrade. Wrong token → HTTP 401 (no upgrade). One connection per wrapper daemon.

### agent → hub

```ts
{ t: "hello", name: string, machineId: string, version: string }   // first frame, required
{ t: "hb", ts: number, sessions: { id: string; status: SessionStatus }[] }  // every 15 s
{ t: "session-ready", id: string, sessionFile: string, pid: number,
  links: { full: string; view: string; web: string; webView: string } }
{ t: "session-error", id: string, error: string }                  // start failed before ready
{ t: "session-exit",  id: string, code: number | null, reason: string }
{ t: "pong", ts: number }
```

### hub → agent

```ts
{ t: "welcome", relayUrl: string, webUrl: string }                 // answer to hello
{ t: "start", id: string, cwd: string, name?: string, prompt?: string,
  relayUrl: string, webUrl: string }
{ t: "stop", id: string, reason?: string }
{ t: "ping", ts: number }                                          // hub watchdog, 30 s
```

Semantics:

- `hello` → hub registers `{machineId, name, connectedAt}` and replies `welcome`.
  Re-hello on the same socket after a drop is a protocol violation → close 4000.
- Two agents with the same `machineId`: the new connection **replaces** the old (old socket
  closed 4000, its sessions marked `exited` with reason `"agent replaced"`).
- `start.id` is hub-assigned (`s_<10 base36>`). The agent spawns one child per `start`.
  `relayUrl`/`webUrl` are passed verbatim to `CollabHost.start()`.
- `session-ready` flips the record to `live` and attaches links. `session-error` flips to
  `failed`. `session-exit` flips to `exited` (idempotent).
- Missing 2 consecutive heartbeats ⇒ hub marks the agent offline (sessions → `exited`,
  reason `"agent lost"`). `ping` must be answered with `pong`; it does not replace `hb`.
- Agent disconnect: sessions → `exited` reason `"agent disconnected"`; machine stays listed with
  `connected: false` until hub restart.

### Session commands (hub → agent → session-host)

Generic request/response control channel for web-driven host commands. hub→agent:

```ts
{ t: "cmd", id: string, reqId: string,                          // id = session id, reqId = "c_" + 10 base36
  cmd: "get-state" | "set-model" | "set-thinking",
  provider?: string, modelId?: string, level?: string }
```

agent→hub:

```ts
{ t: "cmd-result", reqId: string, ok: true,  data: unknown }
{ t: "cmd-result", reqId: string, ok: false, error: string }     // unknown session, invalid level/model, agent errors
```

Semantics:
- `get-state` → `data: AgentState`:
  ```ts
  interface AgentState {
    sessionName: string;
    cwd: string;
    model: { provider: string; id: string; name: string } | null;
    thinkingLevel: string | null;             // effective level, never "auto"
    thinkingLevels: string[];                 // levels valid for the current model
    models: { provider: string; id: string; name: string }[];  // auth-available
  }
  ```
- `set-model {provider, modelId}` → `data: { switched: boolean }` (session.setModel; errors when
  no auth for the provider).
- `set-thinking {level}` → `data: { thinkingLevel: string }` (effective level after set).
- Hub times out any pending cmd after 15 s (→ 504 to the caller). Unknown session →
  `ok:false, "unknown session"`.



## 3. HTTP API (`/api/*`)

All except `/api/health` require `Authorization: Bearer <HUB_TOKEN>` → 401 JSON
`{error: "unauthorized"}` otherwise. Content-Type JSON throughout.

```ts
type SessionStatus = "starting" | "live" | "exited" | "failed";

interface SessionRecord {
  id: string;                 // hub-assigned
  machineId: string;
  machineName: string;
  cwd: string;
  name: string;               // display name (default: basename(cwd))
  status: SessionStatus;
  startedAt: number;          // ms epoch
  exitedAt?: number;
  exitReason?: string;
  error?: string;             // status === "failed"
  links?: { full: string; view: string; web: string; webView: string };
  sessionFile?: string;
  pid?: number;
}
| `GET /api/sessions/:id/agent-state` | → `{ ok: true, state: AgentState }`; 404 unknown, 409 not live, 502 agent offline, 504 cmd timeout |
| `POST /api/sessions/:id/model` | `{provider, modelId}` → `{ ok: true, switched }`; same error set |
| `POST /api/sessions/:id/thinking` | `{level}` → `{ ok: true, thinkingLevel }`; same error set |

interface MachineRecord {
  machineId: string;
  name: string;
  connected: boolean;
  connectedAt: number;
  sessionCount: number;       // live+starting sessions on this machine
}
```

| Route | Body → Reply |
|---|---|
| `GET /api/health` | → `{ ok: true, version }` (no auth) |
| `GET /api/machines` | → `{ machines: MachineRecord[] }` |
| `GET /api/sessions` | → `{ sessions: SessionRecord[] }` (all states, newest first) |
| `GET /api/sessions/:id` | → `{ session: SessionRecord }`, 404 `{error}` |
| `POST /api/sessions` | `{ machineId, cwd, name?, prompt? }` → 202 `{ session }` (status `starting`); 404 unknown machine; 400 missing fields |
| `POST /api/sessions/:id/stop` | → `{ ok: true }`; 404 unknown id; 409 already exited |

- `POST /api/sessions` assigns the id, stores the record, forwards `start` to the agent. If the
  agent is offline → 404. If the agent socket write fails → record removed, 502.
- `stop` forwards `stop` to the owning agent (best effort; record flips on `session-exit`).
- Sessions are pruned: `exited`/`failed` records older than 24 h are dropped hourly (MVP: simple
  cap of 500 records, oldest-exited first).

## 4. Supervisor ↔ session-host IPC (JSONL over stdio, internal to the agent)

child → parent (stdout, one JSON object per line; non-JSON lines are logs):

```ts
{ t: "ready", sessionFile: string, pid: number,
  links: { full: string; view: string; web: string; webView: string } }
{ t: "error", message: string }        // fatal before ready; child exits non-zero after sending
{ t: "log", level: "debug"|"info"|"warn"|"error", message: string }
{ t: "cmd-result", reqId: string, ok: boolean, data?: unknown, error?: string }
```

parent → child (stdin):

```ts
{ t: "stop", reason?: string }         // child: host.stop → session.dispose → exit 0
{ t: "cmd", reqId: string, cmd: "get-state"|"set-model"|"set-thinking",
  provider?: string, modelId?: string, level?: string }
```

Spawn config is argv: `bun session-host.ts --config <json>` with
`{ id, cwd, name?, prompt?, relayUrl, webUrl, agentDir? }`.
SIGTERM from the supervisor is equivalent to `{t:"stop"}` with reason `"sigterm"`.
Child must exit within 10 s of stop; supervisor escalates to SIGKILL.

## 5. Web routes (SPA)

| Path | Page |
|---|---|
| `/` | token gate (once) → home: machines + start form + sessions |
| `/s/<id>` | live session (full collab guest powers via `GuestClient`) |
| `/join` | arbitrary collab link guest (vendored connect screen; also the `#<link>` deep-link target) |

localStorage keys: `omp-hub.token`, `omp-hub.name` (display name, default `"guest"`),
plus vendored `omp-collab-theme`, `omp.collab.name` (unused on hub pages).

## 6. Web slash commands (composer interception, §5 session page)

Text starting with `/` in the web composer is NEVER sent to the agent. Handling:

| Command | Effect |
|---|---|
| `/model` | model picker modal (drives `GET/POST …/agent-state`, `…/model`) |
| `/thinking` | thinking-level picker (drives `…/agent-state`, `…/thinking`) |
| `/settings` | settings modal: model + thinking + links + theme + display name |
| `/collab` | links modal (attach/view/web links, copy buttons) |
| `/theme` | toggle light/dark (vendored theme store) |
| `/dump` | download the current transcript snapshot as `.jsonl` |
| `/leave` | back to hub home |
| `/help` | command list modal |
| anything else | local notice "host-only or unknown command — not sent" |

The palette opens on leading `/`, filters as you type, Enter/Tab completes, Esc closes.
Guests attached via `omp join` keep their own TUI-local command behavior (unchanged).
