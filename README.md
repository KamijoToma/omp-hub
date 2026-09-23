# omp-hub

Headless remote-control suite for [omp](https://github.com/can1357/oh-my-pi) agent sessions.

Three components:

| Package | Runs where | Purpose |
|---|---|---|
| `packages/hub` | a server (or Docker) | collab relay + machine/session registry + web UI host + wrapper control channel |
| `packages/agent` | every machine you want to drive | headless daemon: receives hub commands, spawns SDK agent sessions, hosts them via collab |
| `packages/web` | built into hub's static dist | browser UI (desktop + mobile): machine list, start/stop sessions, full live session control |

No local TUI/GUI is opened anywhere on the agent machines. All interaction happens in the browser
or by attaching a real omp client (`omp join "<link>"`) to a live session.

## MVP feature set

- Hub issues **start new agent** commands to connected wrappers (machine + cwd + optional initial prompt).
- **Full web operation** of a live session: streaming transcript, tool cards, prompt, interrupt,
  subagent panel (chat/kill/revive/transcript), host UI dialogs (select/editor) — the complete
  collab guest feature set, plus stop.
- **omp client attach**: copy the session's full or view-only collab link and `omp join` it from
  any terminal for the native TUI experience.
- **Responsive layout**: phone and desktop layouts share the upstream collab-web breakpoints.
- **Hub as one Docker container**: single port serves relay + API + web UI.

## How it works (30 seconds)

```
┌────────────┐   WSS /agent (token)   ┌──────────────────────────────┐
│ omp-hub-   │ ───────────────────▶  │             HUB              │
│ agent (per │                        │  relay /r/:room  (WS)        │
│ machine)   │ ◀── start {cwd} ────  │  API   /api/*    (Bearer)    │
└────────────┘                       │  web   /*        (static UI) │
      │ spawns per session           └──────────────────────────────┘
      ▼                                          ▲            ▲
┌────────────┐  collab E2E frames  ┌─────────────┴───┐   ┌────┴─────────┐
│ session-   │ ──────────────────▶ │ browser (web UI)│   │ omp join     │
│ host (SDK) │ ◀── prompt/abort ── │ guest (full     │   │ (TUI attach) │
└────────────┘                     │ write link)     │   └──────────────┘
                                   └─────────────────┘
```

- All session payloads stay **AES-256-GCM end-to-end encrypted** between the session-host and the
  guest (browser or `omp join`); the hub relay is content-blind. The hub *registry* does hold the
  links (keys) for the sessions it manages — on this MVP the hub is a trusted party; deploy it
  accordingly.
- The wrapper never binds a port: it dials out to the hub. NAT-friendly.

## Quick start (local dev, single machine)

Prereqs: Bun ≥ 1.3.14. An omp auth store (`~/.omp`) with at least one working provider
(the wrapper's sessions share it), or provider API keys in the environment.

```bash
# 1. hub (relay + API + web on :8080)
cd packages/hub
HUB_TOKEN=dev-token bun run dev            # http://localhost:8080

# 2. wrapper agent (another shell)
cd packages/agent
bun run dev -- --hub ws://localhost:8080 --token dev-token --name dev-machine

# 3. browser
open http://localhost:8080                 # enter token "dev-token", pick dev-machine,
                                           # cwd=/tmp/demo, Start → click the session → drive it

# 4. omp TUI attach (optional)
omp join "$(cat /tmp/last-link.txt)"       # or copy the link from the session page
```

## Docker (hub only)

```bash
docker build -f docker/Dockerfile -t omp-hub .
docker run --rm -p 8080:8080 -e HUB_TOKEN=dev-token omp-hub
```

Wrappers run directly on the machines being controlled (they need the local filesystem, shell,
and omp auth store); they are not containerized in this MVP.

## Docs

- [docs/architecture.md](docs/architecture.md) — components, topology, security model, design decisions
- [docs/protocol.md](docs/protocol.md) — wrapper↔hub control protocol, HTTP API, relay contract
- [docs/milestones.md](docs/milestones.md) — MVP phases and post-MVP roadmap

## License

MIT. Vendored code from `oh-my-pi` (`packages/web` derives from `@oh-my-pi/collab-web`) is MIT by Can Boluk.
