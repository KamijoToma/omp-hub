# omp-hub

English | [简体中文](README.zh-CN.md)

Run [omp](https://github.com/can1357/oh-my-pi) sessions on your own machines and manage them from a browser. A small outbound-only agent on each machine connects to the hub; the hub serves the dashboard, encrypted-session relay, and web client.

## Preview

**See your machines and sessions together.** The dashboard lists connected machines and sessions, with restart controls and a configurable new-session form.

![Dashboard with demo-machine, two live sessions and the session setup form](docs/screenshots/dashboard.png)

**Switch between live sessions without losing your place.** The expanded rail shows both demo sessions beside the session header and slash-command picker.

![Live browser session with an expanded two-session rail, status header and command picker](docs/screenshots/live-session.png)

<details>
<summary>Mobile session view</summary>

<img src="docs/screenshots/mobile-session.png" alt="Mobile browser session with collapsed rail, status header and command picker" width="390">

</details>

These captures use an isolated demo machine and idle synthetic sessions; no provider request, personal session history or credentials were used.

## Components

| Package | Runs where | Purpose |
|---|---|---|
| `packages/hub` | server or Docker | Relay, machine/session API, web UI and agent control channel |
| `packages/agent` | each machine you control | Outbound-only daemon that hosts isolated omp sessions |
| `packages/web` | served by the hub | Desktop and mobile browser UI |

No TUI opens on an agent machine. Use the browser or attach a terminal with `omp join "<full or view link>"`.

## Features

- **Manage multiple sessions:** Start on a connected machine with a directory, optional profile,
  name and initial prompt. Switch live sessions with the rail or switcher, activity indicators and
  optional browser notifications. Rename, hide (this browser only), stop or remove sessions from
  the hub list (saved omp files remain); resume saved conversations. Search session lists/history
  by metadata and, in current source builds, prompt/assistant message text.
- **Work in the browser:** Stream transcripts and tool results, send or interrupt prompts, handle
  interactive dialogs and manage subagents. Use full-control or view-only links to attach an omp client.
- **Control the agent:** Choose models, thinking level and role assignments; use session-scoped
  advanced settings, modes (plan, advisor, goal and loop), and MCP servers (config edits apply to
  new sessions). At start, optionally whitelist tools or enable **superagent** fleet controls to
  start, stop and message other sessions. No whitelist means the default, unrestricted tool set.
- **Operate the fleet:** See machine usage and restart an agent daemon from the dashboard to load
  new code: its session children stop and resume from saved transcripts under their existing IDs.
  The authenticated hub restart API hands over machine/session records from `hub-state.json` (the
  real hub's default state file). Agents reconnect and live hosts recreate relay rooms; rooms and
  ephemeral notices are not persisted, so allow for an interruption.

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

- Session frames are **AES-256-GCM end-to-end encrypted** between host and browser or `omp join`; the relay forwards ciphertext. The hub registry nevertheless holds full/view links and their keys, and its state snapshot stores those links on disk. Treat both hub and snapshot as sensitive.
- The agent dials out to the hub and requires no inbound port on the controlled machine.

## Install from a GitHub release

Requires Bun ≥ 1.3.14 and working omp provider credentials (`~/.omp/agent` or provider API keys) on each agent machine. The [published releases](https://github.com/KamijoToma/omp-hub/releases) provide a source archive with the hub, **already-built** web UI, agent source and third-party licenses; it contains neither `node_modules` nor Docker build files. This example uses the published `v0.9.0` assets. To run newer features documented here (such as message-text session search), use the source checkout below until a newer release includes them.

```bash
# On the hub machine, from any working directory:
mkdir -p "$HOME/omp-hub-release" && cd "$HOME/omp-hub-release"
umask 077  # keep hub-state.json and its session links private
curl -fL -O https://github.com/KamijoToma/omp-hub/releases/download/v0.9.0/omp-hub-v0.9.0.tar.gz
curl -fL -O https://github.com/KamijoToma/omp-hub/releases/download/v0.9.0/SHA256SUMS.txt
sha256sum -c SHA256SUMS.txt
tar -xzf omp-hub-v0.9.0.tar.gz
cd omp-hub
HUB_TOKEN=dev-token HOST=127.0.0.1 bun packages/hub/src/main.ts
```

In another terminal, repeat the download, checksum and extraction steps on each agent machine (or reuse the extracted directory for a local trial), then run:

```bash
cd "$HOME/omp-hub-release/omp-hub"
bun --cwd=packages/agent install --frozen-lockfile
mkdir -p /tmp/omp-hub-demo
HUB_TOKEN=dev-token bun packages/agent/src/main.ts --hub ws://127.0.0.1:8080 --name dev-machine
```

Open `http://127.0.0.1:8080`, enter `dev-token`, choose `dev-machine` and start a session in `/tmp/omp-hub-demo`. `dev-token` and plain HTTP/WS are **only for a local, loopback-only trial**. For a remote deployment, choose a strong shared token and expose the hub over HTTPS/WSS:

```bash
# Hub machine, from the extracted omp-hub/ directory; cert paths must be readable.
cd "$HOME/omp-hub-release/omp-hub"
HUB_TOKEN='<strong-shared-secret>' HOST=0.0.0.0 \
  HUB_TLS_CERT=/path/to/cert.pem HUB_TLS_KEY=/path/to/key.pem \
  bun packages/hub/src/main.ts
# Agent machine, from its extracted omp-hub/ directory, after the locked install:
cd "$HOME/omp-hub-release/omp-hub"
HUB_TOKEN='<same-strong-shared-secret>' \
  bun packages/agent/src/main.ts --hub wss://hub.example.com:8080 --name my-machine
```

Replace the example secret, certificate paths and DNS name; restrict hub ingress to trusted networks. Alternatively terminate TLS at a reverse proxy and set `HUB_PUBLIC_URL=https://hub.example.com` on the hub so generated session links use WSS. A remote browser needs HTTPS for WebCrypto; remote insecure `ws://` links are rejected. Keep full links private: they grant write access. The agent's frozen lockfile installs platform-specific prebuilt SDK binaries; **no sibling SDK checkout or Rust build** is needed. See [agent setup](packages/agent/README.md).

For **Linux x64 (glibc)** without Bun, extract the native agent archive into its own directory.
Keep all three executables and `pi_natives.linux-x64-baseline.node` together; the daemon spawns
the isolated session host and named-profile statistics program from that directory:

```bash
mkdir -p /path/to/agent
tar -xzf omp-hub-agent-linux-x64-vX.Y.Z.tar.gz -C /path/to/agent
HUB_TOKEN=\"<same secret as the hub>\" /path/to/agent/omp-hub-agent --hub wss://hub.example.com
```

The native agent needs the machine's omp auth store (`~/.omp/agent`) or provider credentials,
but no Bun, npm installation or source checkout. Use `ws://` only on a local loopback hub.

### Source checkout (latest source features)

From a terminal with Git and Bun installed, clone the repository and run from its root (the release archive has no web source/build scripts):

```bash
git clone https://github.com/KamijoToma/omp-hub.git
cd omp-hub
bun --cwd=packages/agent install --frozen-lockfile
mkdir -p /tmp/omp-hub-demo
umask 077  # keep hub-state.json and its session links private
HUB_TOKEN=dev-token HOST=127.0.0.1 bun --cwd=packages/hub run demo
# In another terminal, also from the repository root:
HUB_TOKEN=dev-token bun --cwd=packages/agent run start -- --hub ws://127.0.0.1:8080 --name dev-machine
```

`demo` installs the web's locked dependencies, builds its static UI and launches the hub. Normal `bun --cwd=packages/hub run start` serves an existing web build. To attach a terminal client, copy a session's link and run `omp join "<paste link here>"`.

## Docker (hub only, source checkout)

From the **repository root**, build the hub/web image and expose its port on loopback:

```bash
docker build -f docker/Dockerfile -t omp-hub .
export HUB_TOKEN="$(openssl rand -hex 32)"
docker run --rm -p 127.0.0.1:8080:8080 -e HUB_TOKEN="$HUB_TOKEN" omp-hub
```

`docker compose -f docker/docker-compose.yml up --build` also uses the exported token. The agent is not in this image; install and run it on each controlled machine. The image build needs repository web source and `docker/`, which are **not** in the release archive. For remote access use HTTPS/WSS as above; the image listens inside the container on all interfaces but this example only publishes on the host's loopback. Mounted TLS keys must be readable by the non-root container user. The container filesystem is not a durable writable state location: mount a private writable directory and set `HUB_STATE_FILE` there for restart recovery across containers. See [TLS / LAN notes](docs/architecture.md#tls--lan-notes-hard-constraints-from-upstream).

## Security and limits

`HUB_TOKEN` is required for the agent connection and HTTP API; an empty token prevents hub startup. The browser stores it locally. Any token holder can obtain full session write links, browse recent omp session history across projects (including paths, titles and first-message excerpts), and resume saved sessions. Headless session hosts auto-approve omp tool use and can access the agent machine's files and provider credentials; a tools whitelist limits one session's available tools, **not** what a trusted token holder can start next. A superagent has fleet-wide session controls. Use a dedicated OS account for each agent when local history or credentials need isolation.

The relay `/r/` does not authenticate peers or enforce room quotas/host identity: even a view-link holder could claim a room's host role after a disconnect. The hub's live registry and `hub-state.json` snapshot contain session keys; protect the state file, token and links. The real hub entry persists machine/session registry snapshots for restart recovery, but live relay sockets and ephemeral notifications do not survive a process restart. Agent and guest reconnects can restore live rooms; do not treat this as a zero-interruption guarantee. This is **not** a public-internet or multi-tenant service: restrict access to trusted users and networks. See [the security model](docs/architecture.md#security-model-mvp).

## Docs

- [docs/architecture.md](docs/architecture.md) — components, topology, security model, design decisions
- [docs/protocol.md](docs/protocol.md) — wrapper↔hub control protocol, HTTP API, relay contract
- [docs/milestones.md](docs/milestones.md) — MVP phases and post-MVP roadmap
- [docs/e2e.md](docs/e2e.md) — manual end-to-end verification and known limitations

GitHub Actions runs frozen installs, typechecks and Bun tests for all three packages, then builds the web UI and hub-only container. A qualifying version tag on `main` assembles the release archive and `SHA256SUMS.txt`, tests the unpacked archive and publishes the assets. Releases contain the tagged version, not unreleased source changes; no npm package or Docker image is published by this workflow.

## License

[MIT](LICENSE). The vendored web client derives from
[`@oh-my-pi/collab-web`](https://github.com/can1357/oh-my-pi) (MIT); the original copyright
holders and permission notice are preserved in `LICENSE`.
Bundled third-party libraries keep their own licenses (including Lucide's ISC/Feather notices
and Marked's Markdown notice); the hub Docker image carries their full texts in `/app/licenses/`,
and the GitHub release archive in `licenses/`.
