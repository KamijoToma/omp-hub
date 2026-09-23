# RFC: Decoupling slash-command UIs from the TUI (upstream oh-my-pi)

Status: proposal. Motivation: let any frontend (TUI, collab web, hub web) render and drive
configuration commands (`/settings`, `/model`, `/login`, …) with full fidelity.

## Current state (measured)

### Command inventory (81 builtin specs, `builtin-registry.ts` + 7 family files)

| Class | Count | Examples | UI needs |
|---|---|---|---|
| text-mode `handle` | 41 (7 handle-only) | `/export`, `/dump`, `/compact`, `/stats` | none — already headless-drivable (RPC/ACP dispatcher) |
| `handleTui`, simple primitives | 25 | `/theme` list, `/logout` confirm, `/new` confirm | select / confirm / input / editor |
| `handleTui`, bespoke widget trees | 15 | `/settings`, `/model`, `/resume`, `/branch`, `/tree`, `/login`, `/copy`, `/agents`, `/git`, `/mcp add`, usage dashboard | tabs, search, mouse, live previews, wizards, provider sidebars, OAuth progress |

### Existing tunnels (all narrow, none a superset)

| Tunnel | Grammar | Covers |
|---|---|---|
| collab `ui-request` | 2 kinds: `select`, `editor`; response = single `string\|undefined` | ask dialogs only; commands never use it |
| RPC `extension_ui_request` | 11 methods, fire-and-forget heavy | select/confirm/input/editor/notify/status |
| ACP elicitation | JSON-schema object form | select/confirm/input/askDialog mapped to form properties |
| `ExtensionUIContext` | 25 methods in-process | everything, TUI-only at the rich end |

Hard evidence:
- `CollabUiRequestDraft` = exactly select|editor (`packages/wire/src/index.ts:305-320`).
- Guests answer in `collab-web/src/components/shell/Composer.tsx:142-190` and
  `coding-agent/src/collab/guest.ts:713-745`. **Both fall back to a text editor for unknown
  kinds** — any new kind needs a `COLLAB_PROTO` bump (wire/src/index.ts:390-397 documents the
  hang-forever failure mode).
- Guest prompts enter the host via `promptCustomMessage` and **bypass the slash dispatcher
  entirely** (`collab/host.ts:875-908`) — so "send /model as a prompt" can never work; commands
  must be executed host-side by an explicit control path.

### Why `custom()` can never be serialized

`custom<T>(factory)` receives a live `(TUI, Theme, KeybindingsManager, done)` and returns a
`Component` whose `render(width)` emits pre-styled ANSI rows, with `handleInput` on raw escape
sequences and SGR mouse routing (`extension-ui-controller.ts:1157`, `pi-tui` Component
contract). There is no component registry and no props serialization anywhere in the repo. Also
fundamentally TUI-bound: alt-screen overlays, editor-slot ownership, raw terminal input, mouse,
incremental paint.

## Design: command view-model protocol

Split every command's UI into a **declarative view model** (serializable) + **actions**
(RPC back to the host). The host owns all behavior; frontends render schemas and return actions.

```
┌────────────┐  ui-view {viewId, kind, schema, state}   ┌──────────────┐
│ host       │ ───────────────────────────────────────▶ │ TUI renderer │
│ command    │                                          │ web renderer │
│ logic      │ ◀──────── ui-action {viewId, op, value} ─ │ (same code)  │
└────────────┘                                          └──────────────┘
```

### New wire kinds (collab `ui-request` extension, proto bump)

| Kind | Payload | Unlocks |
|---|---|---|
| `confirm` | title, message, labels, timeout | `/logout`, `/new`, deletes |
| `input` | title, placeholder, secret, pattern | renames, tokens |
| `form` | JSON-schema object (reuse the ACP mapping, `acp-agent.ts:470-500`) | `/login` manual code, wizard steps, multi-field settings |
| `list` | sections, searchable, multi/ordered, disabledIndices, structured result | `/resume`, `/branch`, `/copy`, model picker body |
| `progress` / `progress-end` | id, label, detail, percent (non-request frames) | OAuth login, catalog refresh, connection tests |
| `presentation` | notify/status/widget-lines keyed by id | host chrome mirroring |
| `view` (the big one) | a **`SettingDef[]`-style schema** + values | `/settings` in full |

`custom` stays a TUI-only escape hatch: guests without the capability simply see
"this dialog is TUI-only" — no worse than today.

### Why `/settings` is 80% done already

The settings panel's *view* is already declarative:
`settings-schema.ts` (single source of truth, ~6.4k lines of `SettingDef` metadata) →
`createSettingsHost` → `SettingDef` closed union (boolean|enum|submenu|text|providerLimits|
multiselect + tabs/groups) → TUI selector. Conditions are *named* and looked up in a
`CONDITIONS` map (`settings-ui.ts:16-84`) — serializable by construction.

Missing for remote rendering (each becomes an explicit schema field or action):
1. runtime option injection (`options: "runtime"` → host fills themes/thinking levels at view
   build time),
2. async previews (`onPreview` → host action `preview {path,value}` returning preview text),
3. validation (host action `validate`, or ship regex/range in schema),
4. reorder semantics (ordered multiselect → `list` kind with `ordered:true`),
5. mouse/search (frontend-native — free on web).

### Model picker

`ModelBrowserItem[]` (items/roles/current/search text) is a describable list model; host keeps
the decisions (auth state, catalog `refresh()`, over-context compaction, `/login` round-trip)
behind actions: `pick {provider,id}`, `refresh`, `login {provider}` (progress via `progress`
kind). The provider sidebar becomes a `list` section.

### Capability negotiation

Extend `hello`: `uiCaps: string[]` (e.g. `["select","editor","form","list","progress","view"]`).
Host downgrades per guest: no `form` → serialize wizard as sequential select/input; no
`progress` → spinner only; nothing → "TUI-only" notice. Bump `COLLAB_PROTO`; remove the
unknown-kind→editor ternaries on both guest answerers (they convert unknown kinds into silent
mis-render).

### Security gate

The bespoke 15 are exactly the config-mutating commands (settings.json, credential store,
plugin dirs). The command-control path needs an explicit per-guest capability:
`uiControl: "none"|"view"|"config"` carried alongside the existing write-token check, enforced
host-side per action. A view-link guest must never be able to flip `settings.json`.

## Migration path (upstream)

1. **Phase 0 (no wire change)**: introduce `CommandUI` abstraction internally — command
   handlers emit view-model + actions; TUI renderer consumes. Refactor `/settings` first
   (schema already exists), prove with existing TUI tests.
2. **Phase 1**: add `confirm`/`input`/`form`/`list` + proto bump + capability negotiation; port
   the simple 25; guests gain ask-parity.
3. **Phase 2**: `view` kind + settings remote rendering (TUI and web both consume the schema);
   model picker view-model; OAuth via `progress`+`form`.
4. **Phase 3**: deprecate direct `ctx.ui.custom` use in builtins (keep for extensions).

## Relation to omp-hub

omp-hub's `cmd` channel (get-state/set-model/set-thinking) is the *action* half of this design,
hand-rolled per command. The upstream view-model protocol subsumes it: hub's web UI would become
a renderer of `ui-view` schemas and stop hardcoding pickers. Until then, keep the cmd channel —
it is the correct interim shape (host-owned logic, schema-typed results).

## Risks

- **Two renderers to maintain** (TUI + web) for every schema construct — mitigated by keeping
  the union small and closed (like `SettingDef`).
- **Behavior leakage**: previews/validation must stay host-side or they drift; the action
  round-trip latency (~LAN) is fine for settings, borderline for per-keystroke search —
  therefore `list.searchable` does client-side filtering over a shipped item set.
- **Proto fragmentation**: older guests must be rejected at hello (existing mechanism) rather
  than silently degraded.
