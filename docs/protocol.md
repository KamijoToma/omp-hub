# Protocols

All hub-own messages are JSON. `/*` = MVP freezes these shapes; changes need a version bump.

Revision **0.9.0** — three additions. Advanced session modes from the TUI: `prewalk` / `plan` /
`advisor` / `tier` / `pause` / `cycle-model` / `get-settings` / `set-setting` session commands
(§2) with matching HTTP endpoints (§3) and web slash commands (§6); `AgentState` grows
`prewalk` / `plan` / `advisor` / `paused` / `tiers` / `tools`; `start.prewalk` / `start.planYolo`
(§2) arm the one-shot model hand-offs at session start; and the settings gateway exposes a
hub-curated allowlist of the SDK's typed setting descriptors with session-scoped runtime
overrides — writes never persist to `settings.json`. Per-session tool whitelists: `POST
/api/sessions` accepts `tools` (§3) and `SessionRecord` echoes it, and the hub forwards
`start.tools` (§2); the session child restricts the SDK session to exactly those tools —
optional and additive: older agents ignore the unknown `start` field, and an absent `tools`
keeps the full default tool set. And the panel-triggered daemon upgrade restart: the
`restart-daemon` machine command (§2) stops all children and self-respawns the daemon from
disk, `POST /api/machines/:id/restart-daemon` (§3) drives it from the web panel, and the hub
re-issues same-id `start`s for sessions the fresh daemon no longer reports (first-heartbeat
reconcile against the disconnect-time snapshot). `MachineRecord` gains `restarting` (§3).
Upgrade the hub and agent together to *use* any addition; unknown cmds answer `ok:false` and
unknown `start` fields pass through, so mixed fleets degrade gracefully.

Revision **0.8.0** — adds the superagent surface: `start.superagent` (§2) marks a session as a
fleet operator (the child registers the fleet tools, §4 fleet-req), `POST /api/sessions` accepts
`superagent` and `SessionRecord` echoes it (§3), the `prompt` session command + `POST
/api/sessions/:id/prompt` deliver a text message to a live session (§2/§3), and `GET|POST
/api/notices` (§3) give agents a human-facing notification channel. Child↔parent IPC gains
`fleet-req`/`fleet-res` (§4): the daemon proxies a whitelisted `/api/*` subset for superagent
children so the fleet tools never hold `HUB_TOKEN`. Upgrade the hub and agent together only to
*use* the fleet tools; the frame additions are ignored by older peers (unknown `start` fields
pass through, unknown cmds answer `ok:false`).

Revision **0.6.0** — adds the registry state snapshot and the upgrade-restart
flow: the hub persists machines + session records to `HUB_STATE_FILE` (§3;
default `hub-state.json` next to the entry, off in library use) and restores
them on boot, `POST /api/hub/restart` (§3) re-execs the hub in place, and `hb`
reconciles restored records against the daemon's child list (§2). Collab rooms
are not persisted — session hosts retry the relay on their own and re-create
their rooms (same roomId/key), guests rejoin — so a live session survives the
restart with no wire change. Revision 0.5.0 adds the per-profile
usage relay (§2 `usage-req.profile`, §3 `?profile=`, §5 `/usage/<machineId>` profile selector);
upgrade the hub and agent together: hubs may send `profile` to any agent, but only ≥0.5.0
agents honor it (older ones answer from the default profile's dashboard, so the hub gates the
parameter on `hello.version`). Revision 0.4.0 requires a `Bearer` authorization header on the
agent WebSocket handshake; the legacy query-string token is rejected. Revision 0.3.0 added the
machine-level usage relay (§2 `usage-req`/`usage-res`, §3 `GET|HEAD|POST /api/machines/:id/usage/*`, §5
`/usage/<machineId>`) and optional `hello.tmpdir` (§2). Revision 0.2.0 added the
`get-context` session command (§2) and `GET /api/sessions/:id/context` (§3).

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

## 2. Agent channel (`GET /agent`)

WS upgrade with `Authorization: Bearer <HUB_TOKEN>`. Missing/wrong bearer token or a
query-string token without the header → HTTP 401 (no upgrade). One connection per wrapper
daemon; use TLS/WSS outside loopback.

### agent → hub

```ts
{ t: "hello", name: string, machineId: string, version: string, tmpdir?: string }   // first frame, required; tmpdir = the daemon's os.tmpdir() (0.3.0+)
{ t: "hb", ts: number, sessions: { id: string; status: SessionStatus }[] }  // every 15 s
{ t: "session-ready", id: string, sessionFile: string, pid: number,
  links: { full: string; view: string; web: string; webView: string } }
{ t: "session-error", id: string, error: string }                  // start failed before ready
{ t: "session-exit",  id: string, code: number | null, reason: string }
{ t: "session-activity", id: string, working: boolean,
  inputRequired: boolean, name?: string, handoff?: boolean }       // on every change (0.5.0+; optional for consumers);
                                                                   // `name` mirrors the SDK session name when set
                                                                   // (auto-titles included) — the registry label follows it;
                                                                   // `handoff` is true while the child generates a handoff
                                                                   // document (0.7.0+; absent clears it)
{ t: "pong", ts: number }
{ t: "usage-res", reqId: string, ok: true, status: number,
  contentType?: string, bodyB64?: string }                         // answer to usage-req
{ t: "usage-res", reqId: string, ok: false, error: string }
```

### hub → agent

```ts
{ t: "welcome", relayUrl: string, webUrl: string }                 // answer to hello
{ t: "start", id: string, cwd: string, name?: string, prompt?: string, profile?: string,
  sessionFile?: string, superagent?: boolean, tools?: string[], relayUrl: string, webUrl: string }
{ t: "stop", id: string, reason?: string }
{ t: "ping", ts: number }                                          // hub watchdog, 30 s
{ t: "usage-req", reqId: string, method: "GET" | "HEAD" | "POST",
  path: string, bodyB64?: string, profile?: string }              // machine-level stats relay;
                                                                  // `profile` (0.5.0+) names the omp
                                                                  // profile whose dashboard serves it
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
  session <id>"`. A session that has exited releases the file for further resumes. A file
  that lives under a named profile's session store should be resumed with the same
  `start.profile`, so config and credentials resolve from the profile that owns it.
- `start.superagent` (0.8.0+) marks the session as a fleet operator: the child spawns with
  `config.superagent` and registers the fleet tools (§4 fleet-req), which reach the hub through
  the daemon's whitelisted proxy — the child never holds `HUB_TOKEN`. Fleet-initiated starts
  are daemon-rewritten to `superagent: false`, so a superagent cannot mint another superagent.
- `start.tools` (0.9.0+) whitelists the session's callable tools: the child creates its SDK
  session with `toolNames` + `restrictToolNames`, so exactly those tools are exposed and
  discovered extras (extensions, MCP, ambient custom tools) stay out of the schema. Omitted
  means the default tool set. The whitelist replaces the whole built-in set — a `superagent`
  session that also names `tools` gets only that list; the fleet tools are custom tools and
  are not part of it, so the two options should not be combined.
- `start.prewalk` / `start.planYolo` (0.9.0+) arm the SDK's one-shot model hand-offs at
  startup (CLI `--prewalk` / `--plan-yolo` parity). `true` targets the SDK default prewalk
  target (the `@smol` role); a string is an explicit model/role pattern. The child resolves
  the pattern against its model registry the way the CLI does; resolution failures log a
  host-side warning and the session starts without the hand-off (never a failed start).
- `session-ready` flips the record to `live` and attaches links. `session-error` flips to
  `failed`. `session-exit` flips to `exited` (idempotent).
- `session-activity` mirrors the child's guest-visible state into the record's `activity`
  (`working` = the agent turn streams, `inputRequired` = a host dialog waits on a writable
  guest, `handoff` = a handoff document is generating — a model call with `working` false).
  Sent only on change; malformed samples are dropped; unknown ids and terminal records ignore
  it; `session-exit`/`-error` clears the field. Older agents never send it, so `activity` stays
  absent — consumers must treat it as optional (and `handoff` too: absent clears the bit).
- Missing 2 consecutive heartbeats ⇒ hub marks the agent offline (sessions → `exited`,
  reason `"agent lost"`). `ping` must be answered with `pong`; it does not replace `hb`.
- `hb.sessions` doubles as the upgrade-restart reconcile (0.6.0+): records restored from the
  state snapshot (§3) that this connection's heartbeat no longer reports — or reports
  `exited`/`failed` — flip to that terminal state (`"agent heartbeat: no such child"` /
  `"agent heartbeat"`). Only records created before the agent connected take part; newer ones
  follow the normal `session-exit` flow.
- `usage-req` → `usage-res` relays one HTTP request to a machine-local omp stats dashboard
  (`127.0.0.1:3847` for the default profile; the agent starts it on demand and reuses a live
  one). `path` must be an absolute path on that dashboard origin; `bodyB64` is POST-only.
  `profile` (0.5.0+) selects the named omp profile's own stats database: the agent spawns a
  loopback dashboard for that profile (`OMP_PROFILE`/`PI_PROFILE`, same env contract as
  session hosts), caches it per profile, and validates the name with omp's profile rules —
  invalid names answer `ok:false` `"invalid usage profile: …"`. Omitted, `""`, or `"default"`
  means the default profile. Machine-level: no session required, answered even with zero
  sessions. The hub abandons the request after the same
  15 s timeout as `cmd` (`usage timeout` → 504 to the caller).
- Agent disconnect: sessions → `exited` reason `"agent disconnected"`; machine stays listed with
  `connected: false` until hub restart.

### Session commands (hub → agent → session-host)

Generic request/response control channel for web-driven host commands. hub→agent:

```ts
{ t: "cmd", id: string, reqId: string,                          // id = session id, reqId = "c_" + 10 base36
  cmd: "get-state" | "get-context" | "set-model" | "set-thinking" | "get-tree" | "navigate-tree"
     | "compact" | "shake" | "handoff" | "retry" | "loop" | "goal" | "set-extended-context" | "clear-context" | "upload-file"
     | "rename" | "generate-title" | "prompt"
     | "mcp-list" | "mcp-add" | "mcp-remove" | "mcp-set-enabled" | "mcp-test"
     | "prewalk" | "plan" | "advisor" | "tier" | "pause" | "cycle-model"
     | "get-settings" | "set-setting",
  provider?: string, modelId?: string, level?: string,
  role?: string, persist?: boolean }                            // set-model only
                                                                // entryId, summarize → navigate-tree
                                                                // instructions, mode → compact
                                                                // action, objective, tokenBudget → goal
                                                                // prompt, limit, condition → loop
                                                                // enabled → set-extended-context, pause
                                                                // name, dataB64 → upload-file
                                                                // text → prompt
                                                                // name → rename; no params → generate-title
                                                                // name, scope, url, transport, token, command, args → mcp-*
                                                                // action, target, level → prewalk
                                                                // action, planFilePath → plan
                                                                // action → advisor
                                                                // action, family, tier → tier
                                                                // direction → cycle-model
                                                                // settingId, value → set-setting
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
  tools: string[];                          // top-level callable tools, sorted (0.9.0+; what start.tools produced)
  prewalk: {                                // armed one-shot model hand-off (0.9.0+); null when disarmed
    provider: string; id: string; name: string;
    thinkingLevel: string | null;
  } | null;
  plan: {                                   // plan-mode state (0.9.0+); null when the SDK reports none
    enabled: boolean;
    planFilePath: string;
    workflow: string | null;                // "parallel" | "iterative" | null
  } | null;
  advisor: { enabled: boolean };            // second-model advisor toggle (0.9.0+)
  paused: boolean;                          // process-wide pause gate, this child (0.9.0+)
  tiers: Record<string, string>;            // applied service tiers, family → tier (0.9.0+)
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
- `get-tree` → `data: { leafId, truncated, nodes: SessionTreeNode[] }` (protocol §2 SessionTree;
  `sessionManager.getTree()` reduced to previews for the web `/tree` picker). Non-wire entry
  kinds (`custom` HUD notes, `model_usage`, …) are pruned and their children re-homed onto the
  nearest kept ancestor, so `parentId` in the payload is the nearest KEPT parent. Nodes carry
  `{ id, parentId, type, role?, synthetic?, toolName?, customType?, preview, timestamp, label?,
  branch?, leaf?, children }` — `branch` marks the active leaf path (root → leaf), `leaf` the
  current leaf, `preview` a ≤120-char one-line summary; message bodies never cross the wire.
  `truncated: true` means the host's 4000-node cap dropped the oldest subtrees.
- `navigate-tree {entryId, summarize?}` → `data: { cancelled, aborted, editorText, leafId }`
  (session.navigateTree; moves the tree leaf — the target entry and everything after it leave
  the active branch; a user-message target rewinds PAST itself and returns its text as
  `editorText`. `aborted: true` means an in-flight turn was aborted — retry once settled.
  `summarize: true` records a branch summary; requires a model. The host broadcasts no
  tree-change frame: callers rebuild their transcript locally, and guests resync on reconnect.)
- `compact {instructions?, mode?}` → `data: { started: true }`. Validates `mode` against the SDK's
  compact modes (empty = default), then background-dispatches `session.compact` and replies
  immediately — compaction is a model call and outlives the 15 s hub timeout. Progress and the
  outcome arrive through the normal transcript/notice stream, not this channel: the committed
  compaction entry carries `method` and `tokensAfter`, which the transcript divider renders
  (`context compacted (snapcompact) · 171.6k → 52.3k tokens`). Errors after the reply are logged
  host-side only and surface as an error notice.
- `shake {mode?}` → `data: ShakeResult` (`{ mode, toolResultsDropped, blocksDropped, imagesDropped?,
  thinkingBlocksDropped?, tokensFreed, artifactId? }`). TUI `/shake` parity: a local, model-free
  context diet — `elide` (default) strips tool results and large blocks, `images` drops image
  blocks (including old snapcompact archive frames), `thinking` drops thinking blocks. The run
  settles inside the cmd budget, so the counts reply verbatim and the caller formats the summary.
  Unknown mode → `ok:false`.
- `handoff {instructions?}` → `data: { started: true }`. TUI `/handoff` parity: summarizes the
  session into a handoff document and compacts in place. Refuses while a turn streams (409 via the
  "Wait for the current response…" mapping) or a handoff is already generating ("Handoff
  generation is already in progress." → 409); otherwise background-dispatches `session.handoff`
  like `compact` — the document arrives through the transcript, a cancellation through an info
  notice, and a failure (handoff and compact alike) through an error notice entry, not this
  channel. While generating, the session's `activity.handoff` bit (§2/§3) is set.
- `retry` → `data: { started: boolean }`. Refuses while streaming (`"Wait for the current response
  to finish or abort it before retrying."`); `started: false` means nothing to retry (hub → 409).
  The retried turn itself streams through the normal session channel.
- `prompt {text}` (0.8.0+) → `data: { accepted: boolean }`. Delivers `text` to the session via
  `session.prompt()`: a new turn when idle, queued as steering/follow-up while one streams
  (SDK semantics — the reply never blocks on the turn). `accepted: false` means the SDK
  dispatched locally without a model turn. Invalid/blank `text` → `ok:false` (hub → 400).
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
- `clear-context` → `data: { droppedCount: number }`; drops the conversation in place (TUI
  `/clear` parity): messages, queued steers, checkpoint state, provider sessions rotate.
  Session id, title, and transcript file survive. Refused while a turn streams, a user
  bash/eval runs, or the session is mid-transition → `ok:false` (409 via the
  "Wait for the current response…" mapping). Older omp builds without the SDK method answer
  `ok:false, "clear-context is not supported by this omp build"` (500).
- `rename` → `data: { name: string }`: sets the session display name via the SDK session
  manager (`source: "user"`, so the auto-title generator can no longer replace it), persists a
  title-change entry, and updates the collab header guests snapshot. The hub mirrors the
  applied name into the registry record so `/api/sessions` reflects the rename. Refused for a
  blank name (`rename requires a non-empty name`, 400 is enforced hub-side before dispatch).
- `generate-title` → `data: { name: string }`: the TUI's bare `/rename` — summarizes the
  first user turn with the title model and pins the result as a `source: "user"` rename (a
  later auto-title cannot replace it). A model call; failures surface as `ok:false`
  ("no user input to generate a session title from", "Could not generate a session title.").
  The hub mirrors the applied name into the registry record like `rename`.
- `upload-file` → `data: { path: string, bytes: number }`: writes the base64-decoded payload to a
  fresh owner-only file under the machine's temp directory
  (`omp-hub-upload-<rand>-<sanitized name>`) and returns its absolute path, which callers
  reference as plain text (`@path`) in prompts for the model to `read` on demand (PDFs convert
  through the agent's own markit tooling). The child sanitizes `name` to a bare filename
  (basename, control chars stripped, 128-char cap), re-validates size against the same 15 MiB
  cap the hub enforces on the HTTP body, and maps caller-input failures to stable strings:
  `file too large` → 413, `invalid upload encoding` → 400. Each upload opportunistically prunes
  `omp-hub-upload-*` files older than 7 days; OS tmp cleaners are the backstop.
- `mcp-list` (no parameters) → `data: { servers: McpServerRow[] }`: MCP management (web `/mcp`,
  TUI `/mcp` ACP parity). Rows merge the session cwd's user and project `mcp.json` (user rows
  first; a project entry shadows the same-name user entry and the shadow row carries
  `shadowed: true` without claiming the live section), each folded with the user-level
  `disabledServers` list into `enabled`:
  ```ts
interface McpServerRow {
  name: string;
  scope: "user" | "project";
  type: string;                       // "stdio" | "http" | "sse"
  enabled: boolean;
  location: string | null;            // stdio command, or URL stripped of query + userinfo
  envCount: number;                   // env var count — values never cross the wire
  shadowed?: true;
  args?: string[];                    // stdio args
  health?: "connected" | "connecting" | "disconnected";   // live join, see below
  implementationName?: string;        // serverInfo name/version
  implementationVersion?: string;
  instructions?: string;              // server instructions, when connected
  toolsCount?: number;                // connected rows only
  tools?: { name: string; description?: string }[];       // ≤ 50 rows, descriptions ≤ 200 chars
  resourcesCount?: number;
  promptsCount?: number;
}
  ```
  Config rows are file truth; the live section joins the session's own MCPManager (the SDK pins
  each top-level session's manager into a process-global the child reads back — one child hosts
  exactly one session) and appears only for enabled, non-shadowed rows: `health`, server
  identity, instructions, and bounded tool/resource/prompt counts. Config edits apply to NEW
  sessions; the live section shows what this session mounted at start. Extension/provider
  -discovered servers (Claude Code plugins etc.) are not listed — only user/project `mcp.json`
  rows are. Secrets (env values, headers, tokens, URL queries) never cross the wire.
- `mcp-add {name, scope?, url?, transport?, token?, command?, args?}` → `data: { name, scope }`:
  adds to the scope's config file (`scope` omitted ⇒ `"project"`). Exactly one of `url`
  (normalized to `https://` when scheme-less) or `command` is required — the hub enforces this
  plus `transport ∈ {http, sse}` (default `http`), `token` only with `url` (folded into the
  config's `Authorization: Bearer …` header), and `args` as a string array; `token` and env
  values are never echoed in the reply. Duplicate names and the writer's name/config validation
  fail the command (`Server "…" already exists in …` → 409, `Server name …` /
  `Invalid server config: …` → 400).
- `mcp-remove {name, scope?}` → `data: { name, scope }`: removes the entry from that scope's
  config file; missing entries fail (`Server "…" not found in …` → 404).
- `mcp-set-enabled {name, enabled}` → `data: { name, enabled, where: "project" | "user" |
  "disabled-list" }`: TUI `/mcp enable|disable` semantics — the project entry wins, else the
  user entry, else the user-level `disabledServers` list (covers discovered servers with no
  writable config entry: disable adds, enable removes). A name in no config and not in the list
  fails (`server "…" not found in user or project config` → 404).
- `mcp-test {name}` → `data: { name, count, tools: { name, description? }[] }`: one temporary
  connection to a configured, enabled server (project shadow wins) — the live session's manager
  is untouched. OAuth-backed servers get the session's auth storage, so saved credentials
  refresh exactly as at session start; the connection (and any stdio subprocess) is always torn
  down before the reply. Unknown/disabled targets fail before any connection attempt
  (`server "…" not found or disabled (see mcp-list)` → 404); connect failures bubble as
  `ok:false` (500) and count against the same 15 s cmd budget.
- `prewalk {action?, target?, level?}` (0.9.0+): `arm` resolves `target` (a role alias such as
  `@smol` — the default — or a provider/model pattern) like the SDK's own prewalk settings
  watcher (`resolveCliModel` over the session model registry, scoped to the session's model
  list) and arms the one-shot hand-off (`data: { armed, prewalk }`; `armed: false` = no-op,
  target equals the active model and level). `restart` is TUI `/prewalk restart`: restore the
  pre-prewalk model and re-arm (`data: { result: "armed" | "reset" | "rejected", prewalk }`).
  Bare/`state` returns `data: { prewalk }`. Unresolvable targets fail (`ok:false`). The
  hand-off itself fires at the SDK's turn boundary (after the plan nudge's todo list exists
  and the first edit/write lands) and is visible through `model_change` transcript entries.
- `plan {action?, planFilePath?}` (0.9.0+): `enable` activates read-only plan mode from the
  next prompt (`data: { plan }`; `planFilePath` optional — SDK default reference path when
  omitted), `disable` clears it, bare/`status` reports `data: { plan }`. TUI `/plan` parity.
- `advisor {action?}` (0.9.0+): `enable` discovers the SDK's advisor configs and turns the
  second-model advisor on (`data: { enabled, advisors }` — advisor names); no discovered
  configs → `ok:false`. `disable` turns it off; bare/`status` reports. The advisor model
  resolves through the `advisor` model role, so it follows role reassignment live.
- `tier {action?, family?, tier?}` (0.9.0+): `set` applies a service tier (`data: { tiers }`).
  `family` ∈ `openai | anthropic | google`, omitted = the current model's family (error when
  no model is selected). `tier` validates against the family's values — openai
  `none | auto | default | flex | scale | priority`, anthropic `none | priority`, google
  `none | flex | priority` (`"none"` clears). Bare/`status` reports `data: { tiers }`.
  TUI `/fast` (priority) / `/slow` (flex / low-priority) parity.
- `pause {enabled?}` (0.9.0+): freezes / resumes the session's agent loop through the SDK's
  process-wide pause gate (`data: { paused }`; omitted `enabled` toggles, mirroring
  `set-extended-context`). One child hosts exactly one session, so the process-wide gate is
  session-scoped in practice.
- `cycle-model {direction?}` (0.9.0+): `session.cycleModel` (`direction` `"forward"` default |
  `"backward"`) over the session's model list — `data: { switched, model, thinkingLevel }`;
  `switched: false` when there is nothing to cycle to. TUI model-cycling keybinding parity.
- `get-settings` (0.9.0+, no parameters) → `data: { settings: SettingWire[] }`: the
  hub-curated allowlist of the SDK's typed setting descriptors, current values included. The
  model registry, provider credentials, and other never-expose surfaces are not allowlisted.
  ```ts
interface SettingWire {
  id: string;                 // descriptor id, e.g. "compaction.thresholdPercent"
  value: unknown;             // JSON-safe current value (override wins over config)
  defaultValue: unknown;      // descriptor default; null when none
  type: string;               // "boolean" | "enum" | "number" | "string" | "array" | "record"
  values?: string[];          // enum settings only, allowed values in order
  tab?: string;               // TUI /settings tab hint, e.g. "context"
  group?: string;             // TUI /settings group hint, e.g. "Compaction"
  description: string;        // descriptor documentation
  configured: boolean;        // present in user/project config
  overridden: boolean;        // session runtime override active
}
  ```
- `set-setting {settingId, value}` (0.9.0+) → `data: { setting: SettingWire }`: applies a
  session-scoped runtime override (`Setting.override`) to an allowlisted descriptor; `value:
  null` clears the override. Type mismatches and non-allowlisted ids fail (`ok:false`).
  Overrides never persist to `settings.json` and die with the session.
- Hub times out any pending cmd after 15 s (→ 504 to the caller). Unknown session →
  `ok:false, "unknown session"`.

### Machine commands (hub → agent, no session child)

A `cmd` **without `id`** targets the machine itself; the daemon answers with the same
`cmd-result` framing, `reqId` correlation, and 15 s hub timeout as session commands.

```ts
{ t: "cmd", reqId: string, cmd: "list-dir", path?: string }      // path omitted ⇒ agent user's home
{ t: "cmd", reqId: string, cmd: "list-profiles" }
{ t: "cmd", reqId: string, cmd: "list-sessions", cwd?: string, allProfiles?: boolean }
{ t: "cmd", reqId: string, cmd: "restart-daemon" }               // 0.9.0+
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
  `allProfiles: true` merges the default profile with every named omp profile
  (`~/.omp/profiles/<name>/agent/sessions`, the root `start.profile` validates against) into one
  recency-sorted listing capped once; `cwd` is ignored in that mode, and named-profile entries
  carry `profile` (absent ⇒ default profile). The hub always requests `allProfiles` so the resume
  picker sees — and can restart under — the profile that owns each session.
  ```ts
interface SessionListing {
  sessions: {
    path: string;              // absolute session file; the value for start.sessionFile
    id: string;
    cwd: string;               // working directory recorded in the session header
    title?: string;
    created: string;           // ISO timestamp
    modified: string;
    messageCount: number;      // exact stored message entries (full-file line scan; the SDK
                               // picker scan only reads the first 4 KB and saturates at 2-3)
    assistantTurns?: number;   // persisted assistant turns; 0 = agent never replied
    status?: string;           // complete | interrupted | aborted | error | pending | unknown
    firstMessage: string;      // single-line preview
    profile?: string;          // owning omp profile in allProfiles mode; absent ⇒ default
  }[];
  truncated: boolean;          // sessions hit the 200 cap
}
```

- `restart-daemon` (0.9.0+) → `data: { restarting: true }`. Panel-triggered daemon upgrade: the
  daemon acks immediately, then stops every session child gracefully (transcripts flush), stops
  its usage dashboards, spawns a fresh daemon from disk with the same entry point and argv, and
  exits. The hub arms a same-id resume plan when the restarting daemon's socket drops; the fresh
  daemon's first heartbeat reconciles against the plan and re-issues `start` frames with the SAME
  session ids, recorded `cwd`/`name`/`profile`/`sessionFile`, and fresh links — sessions recover
  with full history without any shell access. Children the daemon still reports (a restart frame
  lost in transit) are never resumed against their session-file lock; sessions that die during
  the handover keep their own terminal state. Starts the daemon receives while restarting are
  refused with `session-error` `"daemon is restarting"`. Older daemons answer
  `ok:false, "unknown machine command: restart-daemon"` (the hub surfaces 400). Code updates only:
  dependency changes still need a manual install on the machine before restarting.

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
  superagent?: true;          // 0.8.0: fleet-operator session (§4 fleet-req); set at start, daemon strips it from fleet-initiated starts
  tools?: string[];           // 0.9.0: callable-tool whitelist (§2 start.tools); absent ⇒ default tool set
  status: SessionStatus;
  startedAt: number;          // ms epoch
  exitedAt?: number;
  exitReason?: string;
  error?: string;             // status === "failed"
  links?: { full: string; view: string; web: string; webView: string };
  sessionFile?: string;
  pid?: number;
  activity?: { working: boolean; inputRequired: boolean; handoff?: boolean; updatedAt: number };
  // ↑ last child `activity` sample (§2 session-activity); absent until the first
  //   one arrives, cleared on exit; consumers must treat it as optional (≥0.5.0 agents only,
  //   `handoff` ≥0.7.0 and absent on older agents)
}

interface MachineRecord {
  machineId: string;
  name: string;
  connected: boolean;
  connectedAt: number;
  sessionCount: number;       // live+starting sessions on this machine
  tmpdir?: string;            // agent os.tmpdir(); absent until a ≥0.3.0 hello
  restarting?: true;          // 0.9.0+: daemon upgrade restart in flight (§2 `restart-daemon`)
}

interface Notice {              // 0.8.0+, in-memory only
  id: string;                   // hub-assigned (`n_` + 10 base36)
  message: string;
  urgency: "info" | "warn" | "urgent";
  sessionId?: string;           // attributing session record, when given
  createdAt: number;            // ms epoch
}
```

| Route | Body → Reply |
|---|---|
| `GET /api/health` | → `{ ok: true, version }` (no auth) |
| `GET /api/machines` | → `{ machines: MachineRecord[] }` |
| `GET /api/machines/:machineId/fs?path=` | → `{ ok: true, listing: DirListing }` (§2 "Machine commands", `path` omitted ⇒ home); 404 unknown machine, 502 agent offline, 504 cmd timeout, 400 agent-reported path errors |
| `GET/HEAD/POST /api/machines/:id/usage/<path>` | Relay `<path>` (+query, POST body) to a machine-local omp stats dashboard; status/content-type/body replayed verbatim. `?profile=<name>` (0.5.0+) selects the named omp profile's dashboard — consumed by the hub, never forwarded in `<path>`; `default`/empty mean the default profile. 404 unknown machine, 400 invalid profile name or agent <0.5.0, 405 other methods, 413 oversized POST body, 502 machine offline or malformed reply, 504 usage timeout |
| `GET /api/machines/:machineId/profiles` | → `{ ok: true, profiles: string[] }` (§2 "Machine commands"); 404 unknown machine, 502 agent offline, 504 cmd timeout, mapped status for agent-reported errors |
| `GET /api/machines/:machineId/sessions` | → `{ ok: true, listing: SessionListing }` (§2 "Machine commands", `allProfiles`: merged across the default profile and every named omp profile, entries stamped with `profile`); error set as for `/fs` |
| `POST /api/machines/:machineId/restart-daemon` | → `{ ok: true, machine: MachineRecord }` (0.9.0+; panel-triggered daemon upgrade, §2 `restart-daemon`). 404 unknown machine, 409 `daemon restart already in progress`, 502 agent offline, 504 cmd timeout, 400 agent-reported refusal (e.g. an older daemon). The machine record carries `restarting: true` until the fresh daemon's reconciling heartbeat has replayed the same-id resumes (or the 90 s watchdog TTL expires) |
| `GET /api/sessions` | → `{ sessions: SessionRecord[] }` (all states, newest first) |
| `GET /api/sessions/:id` | → `{ session: SessionRecord }`, 404 `{error}` |
| `DELETE /api/sessions/:id` | → `{ ok: true }`; drops the registry record (0.7.0+). A live/starting session is stopped first (§2 `stop`, reason `"user delete"`); the machine-side omp session file is untouched — `/resume` can re-attach. 404 unknown id |
| `GET /api/sessions/:id/agent-state` | → `{ ok: true, state: AgentState }`; 404 unknown, 409 not live, 502 agent offline, 504 cmd timeout |
| `GET /api/sessions/:id/context` | → `{ ok: true, context: SessionContext }`; same error set |
| `POST /api/sessions/:id/model` | `{provider, modelId, role?, persist?, level?}` → `{ ok: true, switched, role, thinkingLevel }`; same error set; 400 blank/oversize `role`, non-boolean `persist`, or blank `level` |
| `POST /api/sessions/:id/thinking` | `{level}` → `{ ok: true, thinkingLevel }`; same error set |
| `GET /api/sessions/:id/tree` | → `{ ok: true, leafId, truncated, nodes }` (§2 `get-tree`: preview-only session tree for the web `/tree` picker); same error set |
| `POST /api/sessions/:id/tree` | `{entryId, summarize?}` → `{ ok: true, cancelled, aborted, editorText, leafId }`; same error set; 400 missing `entryId` or non-boolean `summarize` |
| `POST /api/sessions/:id/compact` | `{instructions?, mode?}` → `{ ok: true }` (§2 `compact`); 400 non-string `instructions`/`mode` |
| `POST /api/sessions/:id/shake` | `{mode?}` → `{ ok: true, result: ShakeResult }` (§2 `shake`); 400 non-string `mode`, 500 agent-reported unknown mode |
| `POST /api/sessions/:id/handoff` | `{instructions?}` → `{ ok: true }` (§2 `handoff`); 400 non-string `instructions`, 409 streaming/handoff-in-progress guard |
| `POST /api/sessions/:id/retry` | → `{ ok: true, started }`; 409 on "nothing to retry" / streaming guard |
| `POST /api/sessions/:id/prompt` | `{text}` → `{ ok: true, accepted }` (§2 `prompt`, 0.8.0+): deliver a message to the live session — new turn when idle, steering/follow-up queue while streaming; 400 missing/blank `text`, same error set otherwise |
| `POST /api/sessions/:id/loop` | `{action, prompt?, limit?, condition?}` → `{ ok: true, loop }` (§2 `loop`); 400 bad action/limit/condition |
| `POST /api/sessions/:id/goal` | `{action, objective?, tokenBudget?}` → `{ ok: true, goal }` (§2 `goal`); 400 bad action/objective/budget; SDK precondition errors via cmd-result mapping |
| `POST /api/sessions/:id/extended-context` | `{enabled?}` → `{ ok: true, extendedContext }` (§2 `set-extended-context`); 400 non-boolean `enabled` |
| `POST /api/sessions/:id/clear-context` | → `{ ok: true, droppedCount }` (§2 `clear-context`); 409 streaming guard |
| `POST /api/sessions/:id/rename` | `{name}` → `{ ok: true, name, session }` (§2 `rename`; the registry record's label follows); 400 missing/blank/oversize (>200) `name`, 404 unknown/offline, 409 not live, 502/504 cmd plumbing |
| `POST /api/sessions/:id/title` | → `{ ok: true, name, session }` (§2 `generate-title` — bare `/rename`; the registry record's label follows); 404 unknown/offline, 409 not live, 500 agent refusal (e.g. no user input), 502 no title in reply, 502/504 cmd plumbing |
| `POST /api/sessions/:id/files` | raw body + `X-Filename` header (percent-encoded) → `{ ok: true, path, bytes }` (§2 `upload-file`); 400 missing/blank/oversize name or empty body, 404 unknown/offline, 409 not live, 413 body > 15 MiB, 502/504 cmd plumbing |
| `GET /api/sessions/:id/mcp` | → `{ ok: true, servers: McpServerRow[] }` (§2 `mcp-list`); 404 unknown, 409 not live, 502 agent offline, 504 cmd timeout |
| `POST /api/sessions/:id/mcp/add` | `{name, scope?, url?, transport?, token?, command?, args?}` → `{ ok: true, name, scope }` (§2 `mcp-add`); 400 missing `name`, neither/both of `url`+`command`, bad `scope`/`transport`, blank `token`, `token` without `url`, or non-string `args`; 409 duplicate name; 404 unknown/offline, 409 not live, 500 writer validation, 502/504 cmd plumbing |
| `POST /api/sessions/:id/mcp/remove` | `{name, scope?}` → `{ ok: true, name, scope }` (§2 `mcp-remove`); 400 missing/blank `name` or bad `scope`; 404 missing entry, unknown/offline; 409 not live; 502/504 cmd plumbing |
| `POST /api/sessions/:id/mcp/enabled` | `{name, enabled}` → `{ ok: true, name, enabled, where }` (§2 `mcp-set-enabled`); 400 missing/blank `name` or non-boolean `enabled`; 404 name in no config and not listed, unknown/offline; 409 not live; 502/504 cmd plumbing |
| `POST /api/sessions/:id/mcp/test` | `{name}` → `{ ok: true, name, count, tools }` (§2 `mcp-test`); 400 missing/blank `name`; 404 unknown/disabled target, unknown/offline; 409 not live; 500 connect failure; 502/504 cmd plumbing |
| `POST /api/sessions/:id/prewalk` | `{action?, target?, level?}` → `{ ok: true, prewalk }` (+ `armed` on `arm`, `result` on `restart`) (§2 `prewalk`, 0.9.0+); 400 bad `action`, non-string `target`/`level`; same error set otherwise |
| `POST /api/sessions/:id/plan` | `{action?, planFilePath?}` → `{ ok: true, plan }` (§2 `plan`, 0.9.0+); 400 bad `action`, non-string `planFilePath`; same error set |
| `POST /api/sessions/:id/advisor` | `{action?}` → `{ ok: true, enabled, advisors }` (§2 `advisor`, 0.9.0+); 400 bad `action`; 500 enabling with no discovered advisor configs; same error set |
| `POST /api/sessions/:id/tier` | `{action?, family?, tier?}` → `{ ok: true, tiers }` (§2 `tier`, 0.9.0+); 400 bad `action`, unknown `family`, `tier` invalid for the family, or `family` omitted with no current model; same error set |
| `POST /api/sessions/:id/pause` | `{enabled?}` → `{ ok: true, paused }` (§2 `pause`, 0.9.0+); 400 non-boolean `enabled`; same error set |
| `POST /api/sessions/:id/cycle` | `{direction?}` → `{ ok: true, switched, model, thinkingLevel }` (§2 `cycle-model`, 0.9.0+); 400 bad `direction`; same error set |
| `GET /api/sessions/:id/settings` | → `{ ok: true, settings: SettingWire[] }` (§2 `get-settings`, 0.9.0+); same error set |
| `POST /api/sessions/:id/settings` | `{settingId, value}` → `{ ok: true, setting: SettingWire }` (§2 `set-setting`, 0.9.0+; `value: null` clears the override); 400 missing `settingId` or absent `value` key, 400 unknown/disallowed id or type-invalid value (agent-reported); same error set |
| `POST /api/sessions` | `{ machineId, cwd, name?, prompt?, profile?, sessionFile?, superagent?, tools?, prewalk?, planYolo? }` → 202 `{ session }` (status `starting`); 404 unknown machine; 400 missing fields, invalid profile name, blank `sessionFile`, malformed `tools`, or a bad `prewalk`/`planYolo` selector (must be boolean or non-empty string). `profile` starts under that omp profile (§2 `start.profile`); `sessionFile` resumes that omp session file (`start.sessionFile`, §2); `superagent: true` (0.8.0+) starts a fleet-operator session (§2 `start.superagent`, `SessionRecord.superagent`); `tools` (0.9.0+) whitelists the session's callable tools — non-empty array of non-empty strings (§2 `start.tools`, `SessionRecord.tools`); `prewalk` / `planYolo` (0.9.0+, boolean or model/role pattern string) arm the startup hand-offs (§2 `start.prewalk`) |
| `POST /api/sessions/:id/stop` | → `{ ok: true }`; 404 unknown id; 409 already exited |
| `POST /api/notices` | `{message, urgency?, sessionId?}` → `{ ok: true, notice }` (0.8.0+): record a human-facing notification; urgency ∈ `"info"|"warn"|"urgent"` (default `"info"`); `sessionId` optionally attributes it to a session record. 400 blank/oversize (>2000 chars) `message` or bad urgency |
| `GET /api/notices` | → `{ notices: Notice[] }` — newest first, capped at the 50 most recent (0.8.0+). Notices are in-memory only (like the registry beyond the state file: restart drops them); web clients poll this listing for toasts |
| `POST /api/hub/restart` | → `{ ok: true }` (0.6.0+): flushes the state snapshot (below), spawns the same interpreter/script/env detached — the fresh process waits for the port — answers, then releases. 501 when the entry did not wire a restart (library use) |

- `POST /api/sessions` assigns the id, stores the record, forwards `start` to the agent. If the
  agent is offline → 404. If the agent socket write fails → record removed, 502.
- `stop` forwards `stop` to the owning agent (best effort; record flips on `session-exit`).
- Sessions are pruned: `exited`/`failed` records older than 24 h are dropped hourly (MVP: simple
  cap of 500 records, oldest-exited first).

### Hub state & upgrade restart (0.6.0+)

- `HUB_STATE_FILE` — the registry snapshot. Default: `hub-state.json` in the entry's working
  directory; an explicit value (even relative) is resolved against the cwd; the library default
  (tests) keeps persistence off. Content: machines + session records, written atomically
  (tmp + rename) when the registry changes (coalesced, ≤2 s after a mutation) and flushed on
  graceful stop/restart. The file carries live links/keys — treat it like the registry itself:
  sensitive.
- Boot restores records as-is (`live` stays `live` optimistically; machines start
  `connected: false`) and the first `hb` of each reconnected agent reconciles children it no
  longer has (§2). Collab rooms are **not** persisted: a host socket treats a hub restart as a
  transient loss (the shutdown close codes are non-fatal for hosts), retries with backoff, and
  re-creates the room with the same roomId + key; guests keep retrying (`4001`/`4004`) and
  rejoin with a fresh full snapshot. Live sessions therefore survive a restart without any wire
  change — only hub-side records need the snapshot.
- `POST /api/hub/restart` is the upgrade flow: flush → spawn (same interpreter, script, env;
  the child sets `HUB_RESTART_BIND_WAIT` and waits up to 10 s for the port) → answer → the old
  process releases. Deployments that replace the whole process/image instead rely on the same
  snapshot: state dir must be a volume, port/token unchanged.

## 4. Supervisor ↔ session-host IPC (JSONL over stdio, internal to the agent)

child → parent (stdout, one JSON object per line; non-JSON lines are logs):

```ts
{ t: "ready", sessionFile: string, pid: number,
  links: { full: string; view: string; web: string; webView: string } }
{ t: "error", message: string }        // fatal before ready; child exits non-zero after sending
{ t: "log", level: "debug"|"info"|"warn"|"error", message: string }
{ t: "activity", working: boolean, inputRequired: boolean, name?: string, handoff?: boolean }
                                       // sampled 1/s after ready, emitted only on change;
                                       // malformed samples are dropped by the supervisor;
                                       // `name` mirrors the SDK session name (absent until set);
                                       // `handoff` is true while the handoff document generates
{ t: "cmd-result", reqId: string, ok: boolean, data?: unknown, error?: string }
{ t: "fleet-req", reqId: string, method: "GET" | "POST", path: string,
  body?: unknown }                   // 0.8.0+, superagent children only: one whitelisted
                                     // /api/* call, proxied by the daemon (§4 fleet proxy)
```

parent → child (stdin):

```ts
{ t: "stop", reason?: string }         // child: host.stop → session.dispose → exit 0
{ t: "fleet-res", reqId: string, ok: true, status: number, body?: unknown }
                                     // 0.8.0+ answer to fleet-req; ok:false carries `error`
{ t: "cmd", reqId: string, cmd: "get-state"|"get-context"|"set-model"|"set-thinking"|"get-tree"|"navigate-tree"
     |"compact"|"shake"|"handoff"|"retry"|"loop"|"goal"|"set-extended-context"|"clear-context"|"upload-file"|"rename"|"generate-title"|"prompt",
  provider?: string, modelId?: string, level?: string, role?: string, persist?: boolean,
  entryId?: string, summarize?: boolean,
  instructions?: string, mode?: string,
  action?: string, objective?: string, tokenBudget?: number,
  prompt?: string, limit?: object, condition?: object, enabled?: boolean,
  name?: string, dataB64?: string, text?: string }
                                            // parameters pass through unvalidated;
                                            // executeCommand owns per-command validation
```

`cmd` semantics are §2's; `get-context` is answered with the same `SessionContext` object
(numbers only), computed by the child from the SDK's context breakdown.

### Fleet proxy (0.8.0+, superagent children)

`fleet-req`/`fleet-res` let a superagent session's custom tools reach the hub API without
holding `HUB_TOKEN`. The daemon (parent) answers every `fleet-req` exactly once:

- **Whitelist** — allowed: `GET /api/machines`, `GET /api/sessions`, `GET /api/sessions/:id`,
  `POST /api/sessions`, `POST /api/sessions/:id/stop`, `POST /api/sessions/:id/prompt`,
  `POST /api/notices`. Everything else — `DELETE`, `/api/hub/restart`, usage relay, file
  upload, unknown paths — answers `{ok:false, error:"fleet: path not allowed"}` without any
  network traffic. The whitelist is the security boundary; the child is untrusted input.
- **Superagent recursion guard** — a `POST /api/sessions` body with `superagent: true` is
  rewritten to `false` before the fetch: fleet sessions spawn only plain sessions.
- **Proxying** — the daemon fetches `http(s)://<hub>/<path>` with its own `Authorization:
  Bearer <HUB_TOKEN>` (hub URL = the `--hub` value with `ws:`→`http:` / `wss:`→`https:`) and
  replays `{ok:true, status, body}` (parsed JSON; absent body on empty) or
  `{ok:false, error}` on transport failure. Each request is logged one structured line:
  `fleet <method> <path> -> <status|error>`.
- **Timeout** — the child abandons an unanswered `fleet-req` after 30 s (`ok:false` to the
  tool); a late `fleet-res` is dropped by reqId. Unknown `reqId` answers are ignored.
- Non-superagent children have no fleet tools registered; a hostile `fleet-req` from them
  (hand-crafted stdin is not a threat model, but defense in depth) is answered
  `{ok:false, error:"fleet: not a superagent session"}` by the supervisor.

Spawn config is argv: `bun session-host.ts --config <json>` with
`{ id, cwd, name?, prompt?, profile?, sessionFile?, superagent?, relayUrl, webUrl, agentDir? }`. A validated `profile`
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
`omp-hub.usage.profile` (usage page profile selection), plus vendored `omp-collab-theme`,
`omp.collab.name` (unused on hub pages).

## 6. Web slash commands (composer interception, §5 session page)

Text starting with `/` in the web composer is NEVER sent to the agent. Handling:

| Command | Effect |
|---|---|
| `/model` | model picker modal (drives `GET/POST …/agent-state`, `…/model`) |
| `/thinking` | thinking-level picker (drives `…/agent-state`, `…/thinking`) |
| `/rewind` | rewind picker: move the tree leaf to an earlier user message (drives `POST …/tree`) |
| `/branch` | same picker as `/rewind` (TUI parity: `/branch` is the omp `/rewind` alias — the old path stays as an abandoned branch) |
| `/tree` | session-tree picker: browse the host's full entry tree (previews only, `GET …/tree`) and move the leaf to any node (`POST …/tree`); success resyncs the transcript via reconnect. Every message row also carries a hover/tap "rewind here" button targeting its turn prompt |
| `/compact` | background compaction; optional `[mode] [instructions…]` args (drives `POST …/compact`; progress arrives via transcript) |
| `/shake` | shake heavy content out of the context — bare or `elide` strips tool results + large blocks, `images` drops image blocks, `thinking` drops thinking blocks (drives `POST …/shake`; local notice reports the counts) |
| `/handoff` | summarize the session into a handoff document and compact in place — `[instructions]` focuses the summary (drives `POST …/handoff`; the document lands via transcript, a failure toasts via an error notice, and the header shows a running chip while it generates) |
| `/clear` | clear the conversation context in place, keep the session (drives `POST …/clear-context`; local notice reports the dropped-message count) |
| `/new` | start a fresh session on this machine (machineId/cwd/profile from the current record) and navigate to it — hub-level orchestration, no host cmd; needs a hub session record |
| `/rename` | rename this session: `[name]` drives `POST …/rename` (§2 `rename` — the agent-side name is authoritative, the registry label and collab header follow); bare drives `POST …/title` (§2 `generate-title` — TUI bare `/rename`, regenerates from the conversation). The sidebar rows rename the same way (pencil / right-click), and the header title is click-to-rename on hub pages |
| `/resume` | resume another omp session on this machine and navigate to it: `[session id]` arg resolves against the machine's resumable sessions (§2 machine sessions; TUI `/resume` prefix match on session id/file name) and starts it via `POST /api/sessions` with `sessionFile` (plus the entry's cwd/title/profile); bare opens the machine session picker modal |
| `/retry` | retry the last failed agent turn (drives `POST …/retry`) |
| `/todo` | expand the docked todo panel (board derived client-side from the live transcript — no host traffic) |
| `/goal` | goal mode modal: status card, set/replace objective + token budget, pause/resume/drop (drives `…/agent-state`, `POST …/goal`) |
| `/loop` | loop mode modal: status card, prompt + iteration/duration limit + `--while`/`--until` gate, enable/disable/pause/resume (drives `…/agent-state`, `POST …/loop`) |
| `/extended-context` | toggle extended context windows; bare = toggle, `on`/`off` forces (drives `POST …/extended-context`) |
| `/prewalk` | arm the one-shot prewalk hand-off — bare or `[target]` arms (default the `@smol` role), `restart` restores the pre-prewalk model and re-arms (drives `POST …/prewalk`; the header chip shows the armed target while active) |
| `/plan` | toggle plan mode — read-only until disabled; optional `[path]` sets the plan file (drives `POST …/plan`; header chip while enabled) |
| `/advisor` | toggle the second-model advisor (drives `POST …/advisor`; header chip while enabled) |
| `/fast` | priority service tier on the current model's provider family (drives `POST …/tier` `set tier=priority`) |
| `/slow` | low-priority tier on the current model's provider family — flex where offered (drives `POST …/tier` `set tier=flex`) |
| `/pause` | freeze/resume the session's agent loop; bare toggles (drives `POST …/pause`; header chip while paused) |
| `/cycle` | cycle to the next model in the session's list (drives `POST …/cycle`) |
| `/settings` | settings modal: model + thinking + links + theme + display name + Advanced (session settings from `GET/POST …/settings` — runtime overrides, not persisted) |
| `/collab` | links modal (attach/view/web links, copy buttons) |
| `/mcp` | MCP servers modal (list/add/test/enable/remove; drives `GET/POST …/mcp…`) |
| `/theme` | toggle light/dark (vendored theme store) |
| `/dump` | download the current transcript snapshot as `.jsonl` |
| `/leave` | back to hub home |
| `/help` | command list modal |
| anything else | local notice "host-only or unknown command — not sent" |

The palette opens on leading `/`, filters as you type, Enter/Tab completes, Esc closes.
Guests attached via `omp join` keep their own TUI-local command behavior (unchanged).

## 7. Interactive ask bridging (session-host tool UI ↔ collab guests)

The headless session host registers the SDK `ask` tool (`createAgentSession` with
`interactivePrompts: true` → `canPromptUser`) and installs a collab-bridging
`ExtensionUIContext` (`agent/src/ui-bridge.ts`) via `setToolUIContext(ui, true)`.
No new hub or relay frames: dialogs ride the frozen collab wire (§1) as
`ui-request`/`ui-request-end` host frames answered by guest `ui-response` frames —
the same grammar omp TUI uses to mirror its dialogs (collab wire proto ≥ 3; the
vendored web `lib/wire.ts` matches).

- `askDialog` (the `ask` tool), `select`, and `editor` surface to **writable**
  guests; the web composer renders them (options, checkbox multi-select with
  `Next →` submit gating, `Other (type your own)` editor detour, `Chat about
  this`, Cancel). Read-only (view link) guests never see them.
- With a live room but zero connected guests the request is **retained** by
  `CollabHost` until the first writer joins (its documented behavior); the
  session's `activity.inputRequired` bit (§2/§4) reports the wait to the hub.
  `ask.timeout` (SDK setting, default 0 = wait) bounds it with the tool's
  auto-select-recommended semantics.
- Deny discipline keeps the host's default-deny contract: no room, gated
  traffic, pending cap, caller abort, guest cancel, or relay teardown all settle
  the awaitable immediately as a cancellation — AskTool then aborts the turn
  instead of stranding a promise. One dialog at a time is inherent (`ask` is
  `concurrency: "exclusive"`; extra requests queue in the web composer).
- Guest answers are display-label keyed; the bridge disambiguates labels that
  collide with reserved runtime labels on the wire and maps answers back to the
  original labels before persisting results.
