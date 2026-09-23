# omp-hub agent (wrapper daemon)

Headless per-machine daemon: dials out to the hub, spawns one child process per session
(SDK `createAgentSession` + `CollabHost`), never opens a local TUI.

## Resolving oh-my-pi SDK imports

This package resolves the omp SDK from a sibling `../oh-my-pi` checkout; it is not a
standalone published daemon. From the omp-hub repository root, clone the tested public
SDK revision and install its workspace dependencies:

```bash
git clone https://github.com/KamijoToma/oh-my-pi.git ../oh-my-pi
git -C ../oh-my-pi checkout 7ae76f8e4daca0c8f409f61bcd514260cd522365
bun --cwd=../oh-my-pi install --frozen-lockfile
bun --cwd=packages/agent install --frozen-lockfile
```

If a sibling checkout already exists, verify its revision and install its dependencies instead
of cloning over it. `tsconfig.json` contains the source import mappings and asset type roots;
the SDK and web guest must use compatible `COLLAB_PROTO` versions. Do not deploy against an
unverified SDK revision. `bun run typecheck` resolves real upstream sources, not a mock.

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
