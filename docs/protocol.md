# Protocols

All hub-own messages are JSON. `/*` = MVP freezes these shapes; changes need a version bump.

Revision **0.3.0** — reported by `hello.version` and `GET /api/health` — is additive: the
machine-level usage relay (§2 `usage-req`/`usage-res`, §3 `GET|HEAD|POST /api/machines/:id/usage/*`,
§5 `/usage/<machineId>`) and the optional `hello.tmpdir` (§2), surfaced as `MachineRecord.tmpdir`
(§3). Revision 0.2.0 added the `get-context` session command (§2) and `GET /api/sessions/:id/context`
(§3).

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
{ t: "hello", name: string, machineId: string, version: string, tmpdir?: string }   // first frame, required; tmpdir = the daemon's os.tmpdir() (0.3.0+)
{ t: "hb", ts: number, sessions: { id: string; status: SessionStatus }[] }  // every 15 s
{ t: "session-ready", id: string, sessionFile: string, pid: number,
  links: { full: string; view: string; web: string; webView: string } }
{ t: "session-error", id: string, error: string }                  // start failed before ready
{ t: "session-exit",  id: string, code: number | null, reason: string }
{ t: "pong", ts: number }
{ t: "usage-res", reqId: string, ok: true, status: number,
  contentType?: string, bodyB64?: string }                         // answer to usage-req
{ t: "usage-res", reqId: string, ok: false, error: string }
```

### hub → agent

```ts
{ t: "welcome", relayUrl: string, webUrl: string }                 // answer to hello
{ t: "start", id: string, cwd: string, name?: string, prompt?: string, profile?: string,
  sessionFile?: string, relayUrl: string, webUrl: string }
{ t: "stop", id: string, reason?: string }
{ t: "ping", ts: number }                                          // hub watchdog, 30 s
{ t: "usage-req", reqId: string, method: "GET" | "HEAD" | "POST",
  path: string, bodyB64?: string }                                 // machine-level stats relay
```

Semantics:

- `hello` → hub registers `{machineId, name, connectedAt, tmpdir?}` and replies `welcome`.
  Re-hello on the same socket after a drop is a protocol violation → close 4000.
- Two agents with the same `machineId`: the new connection **replaces** the old (old socket
  closed 4000, its sessions marked `exited` with reason `"agent replaced"`).
- `start.id` is hub-assigned (`s_<10 base36>`). The agent spawns one child per `start`.
  `relayUrl`/`webUrl` are passed verbatim to `CollabHost.start()`.
- `start.profile` names an omp profile (omp `--profile`): the daemon validates the name and
  that the profile exists on the machine, exports `OMP_PROFILE`/`PI_PROFILE` on the session
  child, and reports any failure as `session-error` before spawning. Omitted (or `"default"`)
  means the default profile.
- `start.sessionFile` resumes an existing omp session file instead of minting a new one
  (CLI `--resume` semantics: history, model, and thinking level come back from the file).
  The agent refuses a `start` whose `sessionFile` already belongs to a starting/live child
  on that machine — session files carry no cross-process lock, so two live writers would
  corrupt the transcript — and reports `session-error` `"session file already in use by
  session <id>"`. A session that has exited releases the file for further resumes.
>>>>>>> feat/resume-history-sessions
- `session-ready` flips the record to `live` and attaches links. `session-error` flips to
  `failed`. `session-exit` flips to `exited` (idempotent).
- Missing 2 consecutive heartbeats ⇒ hub marks the agent offline (sessions → `exited`,
  reason `"agent lost"`). `ping` must be answered with `pong`; it does not replace `hb`.
- `usage-req` → `usage-res` relays one HTTP request to the machine's local omp stats dashboard
  (`127.0.0.1:3847`; the agent starts it on demand and reuses a live one). `path` must be an
  absolute path on that dashboard origin; `bodyB64` is POST-only. Machine-level: no session
  required, answered even with zero sessions. The hub abandons the request after the same
  15 s timeout as `cmd` (`usage timeout` → 504 to the caller).
- Agent disconnect: sessions → `exited` reason `"agent disconnected"`; machine stays listed with
  `connected: false` until hub restart.

### Session commands (hub → agent → session-host)

Generic request/response control channel for web-driven host commands. hub→agent:

```ts
{ t: "cmd", id: string, reqId: string,                          // id = session id, reqId = "c_" + 10 base36
  cmd: "get-state" | "get-context" | "set-model" | "set-thinking" | "navigate-tree"
     | "compact" | "retry" | "get-todos" | "loop" | "goal" | "set-extended-context",
  provider?: string, modelId?: string, level?: string,
  role?: string, persist?: boolean }                            // set-model only
                                                                // entryId, summarize → navigate-tree
                                                                // instructions, mode → compact
                                                                // action, objective, tokenBudget → goal
                                                                // prompt, limit, condition → loop
                                                                // enabled → set-extended-context
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
  models: {                                 // auth-available
    provider: string; id: string; name: string;
    thinkingEfforts: string[];              // model-declared efforts; [] = non-reasoning
    defaultThinkingLevel: string | null;    // effort applied on selection; null = SDK default
  }[];
  roles: {                                  // chat-section model roles
    role: string; name: string;             // e.g. "smol", "Fast"
    model: { provider: string; id: string; name: string } | null;  // resolved assignment
  }[];
  extendedContext: boolean;                 // session `extendedContext` setting
  goal: SessionGoalState | null;            // active/paused goal; null when off
  loop: LoopStatus | null;                  // host-side loop mode; null when off
}
```

```ts
interface SessionGoalState {                  // SDK GoalModeState projection
  enabled: boolean;
  mode: "active" | "exiting";
  reason?: "completed";
  goal: { status: string; objective: string; tokenBudget?: number; updatedAt: number } & Record<string, unknown>;
}

interface LoopStatus {
  state: "waiting" | "running" | "paused";  // paused flag; else prompt set → running
  prompt?: string;
  limit?: { kind: "iterations"; iterations: number; iterationsLeft: number }
        | { kind: "duration"; durationMs: number; deadlineMs: number };
  condition?: { command: string; until: boolean };   // until=true → `--until` polarity
}
```

- `set-model {provider, modelId, role?, persist?, level?}` → `data: { switched: boolean, role: string,
  thinkingLevel: string | null }` (session.setModel; `role` defaults to `"default"`. A non-default role
  also persists the assignment to settings unless `persist: false`. `level` optionally presets the
  thinking level, applied after the switch so it wins over the target model's default; the agent
  validates it before switching and returns the effective level. Errors when no auth for the provider,
  `role` is blank/over 64 chars, or `level` is not a valid thinking selector.)
- `set-thinking {level}` → `data: { thinkingLevel: string }` (effective level after set).
- `get-context` (no parameters) → `data: SessionContext`: SDK token estimates for the session's
  current context. The model object never leaves the host — only numbers do:
  ```ts
  interface SessionContext {
    contextWindow: number;              // 0 when no model is selected
    usedTokens: number;
    categories: { id: "systemPrompt" | "systemTools" | "systemContext" | "skills" | "messages";
                  label: string; tokens: number }[];
    autoCompactBufferTokens: number;    // contextWindow - auto-compaction threshold; 0 when off
    freeTokens: number;
  }
  ```
  All values are estimates: `categories` need not sum to `usedTokens`, and messages stay one
  bucket — the SDK cannot honestly split them into user/tool/assistant.
- `navigate-tree {entryId, summarize?}` → `data: { cancelled, aborted, editorText, leafId }`
  (session.navigateTree; moves the tree leaf — the target entry and everything after it leave
  the active branch; a user-message target rewinds PAST itself and returns its text as
  `editorText`. `aborted: true` means an in-flight turn was aborted — retry once settled.
  `summarize: true` records a branch summary; requires a model. The host broadcasts no
  tree-change frame: callers rebuild their transcript locally, and guests resync on reconnect.)
- `compact {instructions?, mode?}` → `data: { started: true }`. Validates `mode` against the SDK's
  compact modes (empty = default), then background-dispatches `session.compact` and replies
  immediately — compaction is a model call and outlives the 15 s hub timeout. Progress and the
  outcome arrive through the normal transcript/notice stream, not this channel. Errors after the
  reply are logged host-side only.
- `retry` → `data: { started: boolean }`. Refuses while streaming (`"Wait for the current response
  to finish or abort it before retrying."`); `started: false` means nothing to retry (hub → 409).
  The retried turn itself streams through the normal session channel.
- `get-todos` → `data: { phases }`: todo phases rehydrated from the current transcript branch
  (`TodoPhase[]` — plain JSON `{phase, tasks:[…]}` with per-task `status`), [] when none.
- `loop {action, prompt?, limit?, condition?}` → `data: { loop: LoopStatus | null }`. Host-side
  loop engine (session-host re-submits `prompt` after every terminal turn end): `enable` sets or
  replaces prompt/limit/condition; `disable` clears; `pause` keeps config and drops the pending
  resubmit; `resume` re-arms; `status` just reports. `limit` is `{iterations: N>0}` or
  `{durationMs: N>0}`; exhaustion/expiry disables the loop. `condition` gates each subsequent
  iteration on a shell command's exit status (`--while`: continue while it succeeds;
  `--until`: continue while it fails).
- `goal {action, objective?, tokenBudget?}` → `data: { goal: SessionGoalState | null }`.
  `set` (requires non-empty `objective`) → `goalRuntime.createGoal`; `replace` → `replaceGoal`;
  `pause` / `resume` / `drop` map to the runtime methods; `budget` → `onBudgetMutated(tokenBudget)`
  (number or absent = clear). SDK precondition errors surface as `cmd-result` errors.
- `set-extended-context {enabled?}` → `data: { extendedContext: boolean }`; omitted `enabled`
  toggles. Affects model resolution for subsequent turns.
- Hub times out any pending cmd after 15 s (→ 504 to the caller). Unknown session →
  `ok:false, "unknown session"`.

### Machine commands (hub → agent, no session child)

A `cmd` **without `id`** targets the machine itself; the daemon answers with the same
`cmd-result` framing, `reqId` correlation, and 15 s hub timeout as session commands.

```ts
{ t: "cmd", reqId: string, cmd: "list-dir", path?: string }      // path omitted ⇒ agent user's home
{ t: "cmd", reqId: string, cmd: "list-profiles" }
{ t: "cmd", reqId: string, cmd: "list-sessions", cwd?: string }  // cwd omitted ⇒ every project
```

- `list-dir` → `data: DirListing`:
  ```ts
interface DirListing {
  path: string;              // absolute, symlink-resolved directory listed
  parent: string | null;     // null at the filesystem root
  entries: { name: string; path: string }[];  // child directories only, sorted
  truncated: boolean;        // entries hit the 500 cap
}
```
  Directories only (symlinked directories included, broken links skipped). The target must exist
  and be a directory. Agent-reported failures use stable strings the hub maps to client errors:
  `no such directory` / `not a directory` / `permission denied` → 400; anything else → 500.
  Unknown machine command → `ok:false, "unknown machine command: <cmd>"`.
- `list-profiles` → `data: { profiles: string[] }`: named omp profiles that exist on the
  machine (`~/.omp/profiles/<name>/agent` exists; `PI_CONFIG_DIR` honored), sorted; the
  implicit `"default"` profile is never listed.

- `list-sessions` → `data: SessionListing`: resumable omp sessions known to the machine, most
  recently modified first. Reads the machine's omp session store (SDK picker listing), so empty
  0-turn stubs are excluded. `cwd` scopes the listing to the project that directory belongs to.
  ```ts
interface SessionListing {
  sessions: {
    path: string;              // absolute session file; the value for start.sessionFile
    id: string;
    cwd: string;               // working directory recorded in the session header
    title?: string;
    created: string;           // ISO timestamp
    modified: string;
    messageCount: number;
    assistantTurns?: number;   // persisted assistant turns; 0 = agent never replied
    status?: string;           // complete | interrupted | aborted | error | pending | unknown
    firstMessage: string;      // single-line preview
  }[];
  truncated: boolean;          // sessions hit the 200 cap
}
```



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
  profile?: string;           // named omp profile; absent ⇒ default profile
  status: SessionStatus;
  startedAt: number;          // ms epoch
  exitedAt?: number;
  exitReason?: string;
  error?: string;             // status === "failed"
  links?: { full: string; view: string; web: string; webView: string };
  sessionFile?: string;
  pid?: number;
}

interface MachineRecord {
  machineId: string;
  name: string;
  connected: boolean;
  connectedAt: number;
  sessionCount: number;       // live+starting sessions on this machine
  tmpdir?: string;            // agent os.tmpdir(); absent until a ≥0.3.0 hello
}
```

| Route | Body → Reply |
|---|---|
| `GET /api/health` | → `{ ok: true, version }` (no auth) |
| `GET /api/machines` | → `{ machines: MachineRecord[] }` |
| `GET /api/machines/:machineId/fs?path=` | → `{ ok: true, listing: DirListing }` (§2 "Machine commands", `path` omitted ⇒ home); 404 unknown machine, 502 agent offline, 504 cmd timeout, 400 agent-reported path errors |
| `GET/HEAD/POST /api/machines/:id/usage/<path>` | Relay `<path>` (+query, POST body) to the machine's local omp stats dashboard; status/content-type/body replayed verbatim. 404 unknown machine, 405 other methods, 413 oversized POST body, 502 machine offline or malformed reply, 504 usage timeout |
| `GET /api/machines/:machineId/profiles` | → `{ ok: true, profiles: string[] }` (§2 "Machine commands"); 404 unknown machine, 502 agent offline, 504 cmd timeout, mapped status for agent-reported errors |
| `GET /api/machines/:machineId/sessions?cwd=` | → `{ ok: true, listing: SessionListing }` (§2 "Machine commands", `cwd` omitted ⇒ every project); error set as for `/fs` |
| `GET /api/sessions` | → `{ sessions: SessionRecord[] }` (all states, newest first) |
| `GET /api/sessions/:id` | → `{ session: SessionRecord }`, 404 `{error}` |
| `GET /api/sessions/:id/agent-state` | → `{ ok: true, state: AgentState }`; 404 unknown, 409 not live, 502 agent offline, 504 cmd timeout |
| `GET /api/sessions/:id/context` | → `{ ok: true, context: SessionContext }`; same error set |
| `POST /api/sessions/:id/model` | `{provider, modelId, role?, persist?, level?}` → `{ ok: true, switched, role, thinkingLevel }`; same error set; 400 blank/oversize `role`, non-boolean `persist`, or blank `level` |
| `POST /api/sessions/:id/thinking` | `{level}` → `{ ok: true, thinkingLevel }`; same error set |
| `POST /api/sessions/:id/tree` | `{entryId, summarize?}` → `{ ok: true, cancelled, aborted, editorText, leafId }`; same error set; 400 missing `entryId` or non-boolean `summarize` |
| `POST /api/sessions/:id/compact` | `{instructions?, mode?}` → `{ ok: true }` (§2 `compact`); 400 non-string `instructions`/`mode` |
| `POST /api/sessions/:id/retry` | → `{ ok: true, started }`; 409 on "nothing to retry" / streaming guard |
| `GET /api/sessions/:id/todos` | → `{ ok: true, phases }` (§2 `get-todos`); same error set as `…/context` |
| `POST /api/sessions/:id/loop` | `{action, prompt?, limit?, condition?}` → `{ ok: true, loop }` (§2 `loop`); 400 bad action/limit/condition |
| `POST /api/sessions/:id/goal` | `{action, objective?, tokenBudget?}` → `{ ok: true, goal }` (§2 `goal`); 400 bad action/objective/budget; SDK precondition errors via cmd-result mapping |
| `POST /api/sessions/:id/extended-context` | `{enabled?}` → `{ ok: true, extendedContext }` (§2 `set-extended-context`); 400 non-boolean `enabled` |
| `POST /api/sessions` | `{ machineId, cwd, name?, prompt?, profile?, sessionFile? }` → 202 `{ session }` (status `starting`); 404 unknown machine; 400 missing fields, invalid profile name, or blank `sessionFile`. `profile` starts under that omp profile (§2 `start.profile`); `sessionFile` resumes that omp session file (`start.sessionFile`, §2) |
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
{ t: "cmd", reqId: string, cmd: "get-state"|"get-context"|"set-model"|"set-thinking"|"navigate-tree"
     |"compact"|"retry"|"get-todos"|"loop"|"goal"|"set-extended-context",
  provider?: string, modelId?: string, level?: string, role?: string, persist?: boolean,
  entryId?: string, summarize?: boolean,
  instructions?: string, mode?: string,
  action?: string, objective?: string, tokenBudget?: number,
  prompt?: string, limit?: object, condition?: object, enabled?: boolean }
                                            // parameters pass through unvalidated;
                                            // executeCommand owns per-command validation
```

`cmd` semantics are §2's; `get-context` is answered with the same `SessionContext` object
(numbers only), computed by the child from the SDK's context breakdown.

Spawn config is argv: `bun session-host.ts --config <json>` with
`{ id, cwd, name?, prompt?, profile?, sessionFile?, relayUrl, webUrl, agentDir? }`. A validated `profile`
rides the config verbatim; the supervisor exports `OMP_PROFILE`/`PI_PROFILE` on the child
(and clears any ambient daemon-level profile variables for default sessions), so the SDK
resolves the profile's agent directory from the first module load. `sessionFile` resumes
that omp session file (`SessionManager.open` with `throwIfMissing`) instead of minting a new
session; the recorded header cwd is adopted when the directory is still enterable.
SIGTERM from the supervisor is equivalent to `{t:"stop"}` with reason `"sigterm"`.
Child must exit within 10 s of stop; supervisor escalates to SIGKILL.

## 5. Web routes (SPA)

| Path | Page |
|---|---|
| `/` | token gate (once) → home: machines + start form + sessions |
| `/s/<id>` | live session (full collab guest powers via `GuestClient`) |
| `/usage/<machineId>` | machine usage: hub-native view over the machine's omp stats dashboard (§3 usage relay) |
| `/join` | arbitrary collab link guest (vendored connect screen; also the `#<link>` deep-link target) |

localStorage keys: `omp-hub.token`, `omp-hub.name` (display name, default `"guest"`),
plus vendored `omp-collab-theme`, `omp.collab.name` (unused on hub pages).

## 6. Web slash commands (composer interception, §5 session page)

Text starting with `/` in the web composer is NEVER sent to the agent. Handling:

| Command | Effect |
|---|---|
| `/model` | model picker modal (drives `GET/POST …/agent-state`, `…/model`) |
| `/thinking` | thinking-level picker (drives `…/agent-state`, `…/thinking`) |
| `/rewind` | rewind picker: move the tree leaf to an earlier user message (drives `POST …/tree`) |
| `/compact` | background compaction; optional `[mode] [instructions…]` args (drives `POST …/compact`; progress arrives via transcript) |
| `/retry` | retry the last failed agent turn (drives `POST …/retry`) |
| `/todo` | todo list modal: phases/tasks with status chips (drives `GET …/todos`) |
| `/goal` | goal mode modal: status card, set/replace objective + token budget, pause/resume/drop (drives `…/agent-state`, `POST …/goal`) |
| `/loop` | loop mode modal: status card, prompt + iteration/duration limit + `--while`/`--until` gate, enable/disable/pause/resume (drives `…/agent-state`, `POST …/loop`) |
| `/extended-context` | toggle extended context windows; bare = toggle, `on`/`off` forces (drives `POST …/extended-context`) |
| `/settings` | settings modal: model + thinking + links + theme + display name |
| `/collab` | links modal (attach/view/web links, copy buttons) |
| `/theme` | toggle light/dark (vendored theme store) |
| `/dump` | download the current transcript snapshot as `.jsonl` |
| `/leave` | back to hub home |
| `/help` | command list modal |
| anything else | local notice "host-only or unknown command — not sent" |

The palette opens on leading `/`, filters as you type, Enter/Tab completes, Esc closes.
Guests attached via `omp join` keep their own TUI-local command behavior (unchanged).
