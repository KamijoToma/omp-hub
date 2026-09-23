# omp-hub agent (wrapper daemon)

Headless per-machine daemon: dials out to the hub, spawns one child process per session
(SDK `createAgentSession` + `CollabHost`), never opens a local TUI.

## Resolving oh-my-pi SDK imports

The daemon has no runtime dependencies in this package. Run `bun install --frozen-lockfile`
for the dev-only TypeScript/Bun types used by `bun run typecheck`; the sibling `oh-my-pi`
checkout must have its own dependencies installed. `tsconfig.json` maps SDK imports onto
that sibling checkout and uses its asset type declarations:

```jsonc
"paths": {
  "@oh-my-pi/pi-coding-agent":  ["../../../oh-my-pi/packages/coding-agent/src/index.ts"],
  "@oh-my-pi/pi-coding-agent/*": ["../../../oh-my-pi/packages/coding-agent/src/*.ts"],
  "@oh-my-pi/pi-tui/thinking": ["../../../oh-my-pi/packages/tui/src/thinking.ts"]
}
```

Bun resolves these at runtime; the checkout's own dependencies resolve from its workspace
`node_modules`. A plain `file:` dependency does NOT work (oh-my-pi's packages use the
workspace-only `catalog:` protocol). If your checkout lives elsewhere, adjust the mapping paths.

Production deployments should replace these mappings with published `@oh-my-pi/pi-coding-agent`
and `@oh-my-pi/pi-tui` packages, pinned so hosts and guests share the same `COLLAB_PROTO`.

## Run

```bash
bun run dev -- --hub ws://127.0.0.1:8080 --token <HUB_TOKEN> --name my-machine
# flags: --hub (required) --token (or HUB_TOKEN env) --name (default: hostname)
#        --machine-id <id> --max-sessions <n=8> --help
```

Auth for the agent sessions comes from the default omp store (`~/.omp/agent`) — the daemon
shares it with any local omp install. Provider env keys work too.

Type-check from this package with `bun run typecheck`; it does not emit files or type-check
against a mock SDK.

## Layout

| file | role |
|---|---|
| `src/main.ts` | entry: flags, wiring, shutdown |
| `src/hub-client.ts` | hub WSS client (hello/hb/ping-pong/backoff) |
| `src/supervisor.ts` | child process registry, JSONL IPC, SIGKILL escalation |
| `src/session-host.ts` | per-session child: SDK session + collab host |
| `src/collab-ctx.ts` | stub `InteractiveModeContext` over the real session |
| `src/ui-stub.ts` | default-deny `ExtensionUIContext` |
| `src/machine-id.ts` | stable machine id (`~/.omp-hub-agent.json`) |
