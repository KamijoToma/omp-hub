# omp-hub agent (wrapper daemon)

Headless per-machine daemon: dials out to the hub, spawns one child process per session
(SDK `createAgentSession` + `CollabHost`), never opens a local TUI.

## Resolving oh-my-pi SDK imports

This package consumes the omp SDK as pinned npm dependencies (`@oh-my-pi/pi-coding-agent`,
`pi-ai`, `pi-tui`, `pi-wire`, `omp-stats`). The SDK packages publish TypeScript sources with
wildcard subpath exports, so deep imports (`pi-coding-agent/collab/host`, …) resolve the same
files whether type-checked or run. Setup is plain dependency installation:

```bash
bun --cwd=packages/agent install --frozen-lockfile
```

No sibling checkout or native build is required: `@oh-my-pi/pi-natives` ships prebuilt
platform binaries via npm optional dependencies. The pinned versions equal the SDK's git
release tags (e.g. `18.4.2` = tag `v18.4.2`), so a pin is an exact upstream revision — do
not bump without rerunning `bun run typecheck` and `bun test`. `types/sdk-assets.d.ts`
vendors the ambient declarations for the SDK's `with { type: "file" }` asset imports
(they are not part of the published tarballs); extend it if a new SDK version imports new
asset patterns. The SDK and web guest must use compatible `COLLAB_PROTO` versions.

## Run

```bash
HUB_TOKEN="<same token as the hub>" bun run dev -- --hub ws://127.0.0.1:8080 --name my-machine
# flags: --hub (required) --token (or HUB_TOKEN env, required) --name (default: hostname)
#        --machine-id <id> --max-sessions <n=8> --help
```

Use `wss://` for a non-local hub. An environment variable keeps the token out of the daemon's
command-line arguments; configure reverse proxies to forward `Authorization` on WebSocket
upgrades without logging it.

Auth for the agent sessions comes from the default omp store (`~/.omp/agent`) — the daemon
shares it with any local omp install. Provider env keys work too.

Type-check from this package with `bun run typecheck`; it does not emit files or type-check
against a mock SDK.

## Native Linux x64 distribution

The release archive `omp-hub-agent-linux-x64-vX.Y.Z.tar.gz` includes a compiled daemon,
`omp-hub-agent-session`, `omp-hub-agent-stats` and a pinned
`pi_natives.linux-x64-baseline.node`. Extract them into the **same directory** and run
`HUB_TOKEN=\"<secret>\" ./omp-hub-agent --hub wss://hub.example.com`. No Bun or npm install is
needed on that machine. The native addon is versioned with the pinned SDK and must not be
replaced by an addon from another release. Keep the included notices with the archive.

To build and verify a Linux x64 archive locally from a locked SDK install:

```bash
bun --cwd=packages/agent install --frozen-lockfile
bun packages/agent/scripts/build-native.ts --out-dir /tmp/omp-hub-agent-native
bun packages/agent/test/fixtures/native-smoke.ts /tmp/omp-hub-agent-native
```

The smoke creates its own temporary home and exercises a live session, named-profile stats and
the compiled daemon's upgrade restart. It does not use provider credentials.

## Layout

| file | role |
|---|---|
| `src/main.ts` | entry: flags, wiring, shutdown |
| `src/hub-client.ts` | hub WSS client (hello/hb/ping-pong/backoff) |
| `src/supervisor.ts` | child process registry, JSONL IPC, SIGKILL escalation |
| `src/session-host.ts` | per-session child: SDK session + collab host |
| `src/collab-ctx.ts` | stub `InteractiveModeContext` over the real session |
| `src/ui-bridge.ts` | collab UI bridge: `ask`/`select`/`editor` dialogs ↔ writable guests (protocol §7) |
| `src/ui-stub.ts` | default-deny `ExtensionUIContext` the bridge falls back to |
| `src/machine-id.ts` | stable machine id (`~/.omp-hub-agent.json`) |
