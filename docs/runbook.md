# Operations runbook — hub/daemon restart & agent session recovery

Verified procedures for the `kfdesktop` production instance. Written 2026-09-29
after the registry-loss incident (§ Incident log). Every command below was
executed as-is during that recovery.

## Production layout

| Component | Runs from | Entry | Notes |
|---|---|---|---|
| Hub | `/home/skyrain/Projects/omp-hub-prod/packages/hub` (branch `prod`) | systemd **user unit** `omp-hub.service` → `omp-hub` binary | `Restart=on-failure` (auto-heals crashes, ~3 s), env from `hub.env` (0600, gitignored), log appended to `hub-restart.log` (cwd) |
| Agent daemon | `/home/skyrain/Projects/omp-hub-prod/packages/agent` | `bun src/main.ts --hub ws://localhost:8471 --name kfdesktop` | standalone (`nohup`), log `daemon.log` (cwd) |
| Session children | spawned by the daemon | `session-host.ts --config <json>` | one process per agent session |
| Public URL | `https://kfdesktop.tail02ef4.ts.net` | `tailscale serve` → `127.0.0.1:8471` | `HUB_PUBLIC_URL` must stay set on the hub |

The hub is a systemd **user unit** (`~/.config/systemd/user/omp-hub.service`,
`loginctl enable-linger` on): `systemctl --user start|stop|restart|status
omp-hub`. `Restart=on-failure` + `RestartSec=3` revives a crashed hub in
seconds — hub SIGTERM/`exit 0` stays stopped, so §A manual restarts still
work. Secrets live in `packages/hub/hub.env` (`HUB_TOKEN` among them; 0600,
gitignored) — the unit only references it. Why a compiled binary at all: its
cmdline no longer contains `bun src/server.ts`, so a test's
`pkill -f "bun src/server.ts"` cannot kill production again (the 03:30
incident). The binary is built by `bun --cwd=packages/hub run build:binary`
after each `packages/web` build; inside the compiled executable `import.meta`
paths do not exist on disk, so **`WEB_DIST` must be set explicitly** (it lives
in `hub.env`) and `--watch` (hot reload) is refused. The daemon stays
source-run: its session-host children are spawned from source paths and its
omp SDK loads native modules from `node_modules`.

State and identity:

- Hub registry snapshot: `hub-state.json` in the **hub process cwd** (default;
  `HUB_STATE_FILE` overrides). Restore happens only at boot. Written
  write-through every ≤2 s and flushed on SIGTERM. Contains live links/keys — treat as secret.
- Machine id: `~/.omp-hub-agent.json` (stable across daemon restarts).
- `HUB_TOKEN`: read it from the running hub instead of hardcoding:
  ```bash
  tr '\0' '\n' </proc/$(pgrep -f 'packages/hub/omp-hub|src/server.ts' | head -1)/environ | grep HUB_TOKEN
  ```

Discovery:

```bash
pgrep -af 'packages/hub/omp-hub|src/server\.ts|src/main\.ts --hub|session-host\.ts'   # what is running
ss -tlnp | grep 8471                                            # who owns the port
curl -s http://localhost:8471/healthz                           # hub alive
```

## A. Restart the hub only (agents keep running)

Safe: children and the daemon survive; the daemon and relay sockets reconnect
automatically (≤30 s backoff). Afterwards run the §A.1 room probe.

Preferred — systemd manages the process (crashes self-heal via
`Restart=on-failure`):

```bash
systemctl --user restart omp-hub      # or stop / start / status
systemctl --user status omp-hub       # + journal notes; stdout/stderr also append hub-restart.log
```

Manual fallback (same handover semantics; use when editing the unit or when
systemd itself is the problem):

```bash
HUBPID=$(pgrep -f 'packages/hub/omp-hub|src/server\.ts' | head -1)
kill -TERM "$HUBPID"                     # graceful: flushes state, releases port
for i in $(seq 1 50); do kill -0 "$HUBPID" 2>/dev/null || break; sleep 0.2; done

cd /home/skyrain/Projects/omp-hub-prod/packages/hub
env PORT=8471 \
    HUB_PUBLIC_URL=https://kfdesktop.tail02ef4.ts.net \
    HUB_TOKEN="$TOKEN" \
    WEB_DIST=/home/skyrain/Projects/omp-hub-prod/packages/web/dist \
    HUB_RESTART_BIND_WAIT=1 \
    setsid nohup /home/skyrain/Projects/omp-hub-prod/packages/hub/omp-hub >> hub-restart.log 2>&1 < /dev/null &
```

Remember to hand the process back afterwards (`systemctl --user start
omp-hub` after stopping the manual one) so crash self-healing stays armed.

The binary form needs `WEB_DIST` (the compiled executable cannot resolve the
web dist from `import.meta`) and does not support `--watch`. Fallback to the
source form (`bun src/server.ts`, same env minus `WEB_DIST`) only if the
binary is missing; rebuild it first:

```bash
bun --cwd=packages/web run build                 # dist must exist before the binary runs
bun --cwd=packages/hub run build:binary          # → packages/hub/omp-hub
```

**Loading a new binary build takes THIS §A restart (kill + start).** Rebuilding
`omp-hub` while it runs deletes the inode behind the running process, so
`POST /api/hub/restart` right after a build cannot exec the on-disk file — the
hub detects that and re-execs the RUNNING build via `/proc/self/exe` (service
stays up, log line `re-executed the RUNNING binary via /proc/self/exe`),
which is a recovery, not an upgrade. Order to remember: **build the web +
binary, then §A, then verify** — never rely on the API restart alone to pick
up a fresh build.

`POST /api/hub/restart` (the panel's hub restart) works from the binary too:
the fresh process re-execs the same binary with the same flags.

### A.2 Automatic hub deploy on prod merges (git hook)

`scripts/prod-deploy-hook.sh` is installed as the shared
`.git/hooks/reference-transaction` (covers every worktree). When
`refs/heads/prod` actually moves (any merge/`update-ref` — a no-op update is
ignored), it installs the web dependencies from the lockfile
(`bun install --frozen-lockfile` — a no-op when current), builds the web dist
+ hub binary in the prod worktree, and runs `systemctl --user restart
omp-hub`, which execs the fresh build; it then polls `/healthz` and logs the
outcome to `packages/hub/hub-deploy.log`. Install/build failures leave the
running hub untouched — fix and merge again. The **daemon is never
restarted** by the hook: when its code changed, use the panel's
restart-daemon (same-id resume). Deployment is serialized with `flock`;
overlapping merges just log one deploy. Re-install after cloning:

```bash
install -m 755 scripts/prod-deploy-hook.sh .git/hooks/reference-transaction
```

Removing that file disables the automation.

Expected log line: `restored state: N session record(s), M machine(s)`.

### A.1 Re-attach sessions stuck "reconnecting" after a hub restart

Relay rooms do not survive a hub restart, and a child's relay client can land
in a terminal state instead of retrying — its web view then loops
"reconnecting" (guest join → `4004 no such room`). **Agent tasks keep running**;
only the browser view is detached. After any hub restart, probe every live
session's room:

```bash
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:8471/api/sessions \
| python3 -c '
import json,sys
for s in json.load(sys.stdin)["sessions"]:
    if s["status"] != "live": continue
    full=(s.get("links") or {}).get("full","")
    if full: print(s["id"], full.split("/r/")[-1].split(".")[0])' > /tmp/rooms.txt

cat > /tmp/probe-rooms.ts <<'EOF'
for const line of (await Bun.file("/tmp/rooms.txt").text()).trim().split("\n") {
  const [id, room] = line.split(" ");
  const verdict = await new Promise<string>((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:8471/r/${room}?role=guest`);
    const timer = setTimeout(() => resolve("ROOM-OK"), 2500);
    ws.onopen = () => {};
    ws.onclose = (e) => { clearTimeout(timer); resolve(`DETACHED (code=${e.code} ${e.reason})`); };
  });
  console.log(id.padEnd(16), verdict);
}
EOF
/home/skyrain/.local/bin/bun /tmp/probe-rooms.ts
```

For every `DETACHED` session whose `activity.working` is false, restart it
(§B.2 broker steps are unnecessary — only the hub restarted): stop the session,
wait for `exited`, then `POST /api/sessions` with its `sessionFile` (§B.4).
A session that is actively `working` should be left alone until its turn
finishes — restarting aborts the in-flight turn.

Notes:

- `HUB_RESTART_BIND_WAIT=1` makes the new process wait up to 10 s for the port
  (same mechanism as the hub's own `POST /api/hub/restart`).
- Alternative in-place restart: `POST /api/hub/restart` (flush + respawn +
  port wait). Do **not** hand-edit `hub-state.json` first — the flush
  overwrites it before the fresh process reads it. To boot with a hand-crafted
  state file, follow the order in §C.
- The state file is **per-cwd**: starting the hub from a different checkout or
  worktree silently boots an empty registry. When moving the hub between
  checkouts, stop the old hub first, copy `hub-state.json` into the new cwd,
  then start.

## B. Restart the daemon (interrupts session children — follow every step)

**Preferred since protocol 0.9.0: the panel button or the API.** With the hub
and daemon both on ≥0.9.0 code, a daemon restart for a code update is one
click — the machine row's "Restart daemon" (or
`POST /api/machines/:id/restart-daemon`). The daemon stops its children
(graceful, transcripts flush), respawns itself from disk with the same argv,
and the hub resumes every session **under its old session id** with fresh
links — no manual §B.1–B.5 needed. Session ids stay stable, so open
`/s/<id>` pages recover on their own. Caveats: it updates **code only** — run
`bun install` in the worktree first when dependencies changed — and mid-turn
runs abort (the dialog warns). Manual §B below still applies when the daemon
predates the feature, when the daemon is down, or for a first bootstrap after
upgrading the hub past the daemon.

A manual daemon restart stops all session children (graceful `stopAll`, SDK
sessions flush their `.jsonl`). Running work is preserved by **resuming each
child's session file** afterwards; the in-flight turn is lost, the history is
not.

Trap: the daemon is normally hosted by `omp __omp_worker_daemon_broker`, which
**auto-respawns it within ~6 s from its original cwd** (possibly an old
checkout). To control which code runs, kill the broker first. Consequence: the
daemon becomes standalone — after a machine reboot nothing auto-starts it (§D).

### 1. Capture every child's session file (before stopping anything)

```bash
python3 - <<'EOF' > /tmp/omp-children.jsonl
import json, os, time
CLK = os.sysconf("SC_CLK_TCK")
btime = float(open('/proc/stat').read().split('btime ')[1].split('\n')[0])
for p in filter(str.isdigit, os.listdir('/proc')):
    try:
        args = open(f'/proc/{p}/cmdline', 'rb').read().decode().split('\0')
        cfg = json.loads(args[args.index('--config') + 1])  # only session-hosts carry --config
        st = open(f'/proc/{p}/stat').read()
        start_ticks = int(st[st.rindex(')') + 2:].split()[19])
    except (OSError, ValueError, IndexError, json.JSONDecodeError):
        continue
    print(json.dumps({
        'pid': int(p), 'id': cfg['id'], 'cwd': cfg.get('cwd'),
        'name': cfg.get('name'), 'profile': cfg.get('profile'),
        'sessionFile': cfg.get('sessionFile'), 'startedAt': int((btime + start_ticks / CLK) * 1000),
    }))
EOF
```

Then **overlay the authoritative file paths** from the open fds (children hold
their `.jsonl` open; `--config.sessionFile` is absent for sessions that minted
a new file at start):

```bash
python3 - <<'EOF'
import json, os
rows = [json.loads(l) for l in open('/tmp/omp-children.jsonl')]
for r in rows:
    try:
        for fd in os.listdir(f'/proc/{r["pid"]}/fd'):
            try:
                target = os.readlink(f'/proc/{r["pid"]}/fd/{fd}')
            except OSError:
                continue
            if target.endswith('.jsonl'):
                r['sessionFile'] = target
    except OSError:
        pass
with open('/tmp/omp-children.jsonl', 'w') as f:
    for r in rows:
        f.write(json.dumps(r) + '\n')
print(*rows, sep='\n')
EOF
```

Every row must end with a real `sessionFile` path. If one doesn't, do not stop
the daemon until it is resolved.

### 2. Stop broker + daemon

```bash
BROKER=$(pgrep -f '__omp_worker_daemon_broker' | head -1)
[ -n "$BROKER" ] && kill -9 "$BROKER"     # no auto-respawn afterwards (already dead post-2026-09-29)
DAEMON=$(pgrep -f 'src/main\.ts --hub' | head -1)
kill -TERM "$DAEMON"                     # stopAll: children dispose & flush
for i in $(seq 1 40); do pgrep -f 'src/main\.ts --hub' >/dev/null || break; sleep 0.3; done
pgrep -af 'src/main\.ts --hub|session-host\.ts' || echo "all stopped"
```

### 3. Start the daemon from the target checkout

```bash
cd /home/skyrain/Projects/omp-hub-prod/packages/agent
env HUB_TOKEN="$TOKEN" \
    setsid nohup /home/skyrain/.local/bin/bun src/main.ts \
      --hub ws://localhost:8471 --name kfdesktop >> daemon.log 2>&1 < /dev/null &
```

Expected log: `connected to hub` + `hub welcome: relay=… web=…`.
Verify `GET /api/machines` shows the machine `connected: true`.

### 4. Resume the captured sessions

Each start mints a **new** session id and **fresh collab links**; the omp
history inside `sessionFile` is reopened in full. No `prompt` field → the
session opens idle.

```bash
while IFS= read -r row; do
  BODY=$(python3 -c '
import json,sys
r=json.loads(sys.argv[1])
print(json.dumps({"machineId":sys.argv[2],"cwd":r["cwd"],
  "name":r.get("name") or "omp-hub","profile":r.get("profile"),
  "sessionFile":r["sessionFile"]}))' "$row" "$MACHINE_ID")
  curl -sS -m 20 -X POST -H "Authorization: Bearer $TOKEN" \
    -H 'Content-Type: application/json' -d "$BODY" \
    http://localhost:8471/api/sessions | python3 -c 'import json,sys
d=json.load(sys.stdin); s=d.get("session",{})
print(s.get("id"), s.get("status"), d.get("error",""))'
done < /tmp/omp-children.jsonl
```

`MACHINE_ID` comes from `GET /api/machines` (or `~/.omp-hub-agent.json`).

### 5. Verify and clean up

```bash
# after ~15 s (one heartbeat): all resumed ids must be `live` with links
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:8471/api/sessions \
  | python3 -c 'import json,sys
for s in json.load(sys.stdin)["sessions"]:
    print(s["id"], s["status"], "links" if s.get("links") else "NO-LINKS", s["name"][:40])'
```

- Command chain check (hub → daemon → child):
  `curl -H "Authorization: Bearer $TOKEN" http://localhost:8471/api/sessions/<id>/agent-state`.
- Rows of the pre-restart ids turn `exited` via heartbeat reconcile
  (`agent heartbeat: no such child`); delete them:
  `curl -X DELETE -H "Authorization: Bearer $TOKEN" http://localhost:8471/api/sessions/<old-id>`.
- Guard rails that reject a bad resume: `unknown session` (409), `session file
  already in use by session <id>` (duplicate file), `max sessions reached (8)`
  (cap; raise with `--max-sessions <n>` on daemon start).

## C. Hub lost its registry while children must not be interrupted

Symptoms: `GET /api/sessions` empty while `session-host` processes exist;
new starts fail with `max sessions reached (8)` (the live children hold every
slot). Cause: the hub was restarted from a cwd whose `hub-state.json` was
absent — restore found nothing, and the daemon never re-announces old sessions
(`session-ready` fires once, at spawn).

Two fixes; prefer B (cleaner, restores links) unless the children must keep
running untouched:

1. **Craft + boot** (children untouched): build a snapshot with one record per
   child (ids/metadata from §B.1 capture), then stop hub → install file →
   start hub (order matters: SIGTERM flush would overwrite an earlier edit).
   Record shape:

   ```json
   {
     "version": 1, "savedAt": 0,
     "machines": [{"machineId":"m_…","name":"kfdesktop","connected":false,
                   "connectedAt":0,"sessionCount":8,"tmpdir":"/tmp"}],
     "sessions": [{"id":"s_…","machineId":"m_…","machineName":"kfdesktop",
                   "cwd":"/…","name":"…","profile":"glm","status":"live",
                   "startedAt":0,"pid":0}]
   }
   ```

   `links` cannot be reconstructed (room keys are random, child-memory only) —
   recovered sessions are visible/controllable via the API but not attachable
   from the web until they are restarted through §B.

2. **§B restart + resume** (brief interruption, full recovery incl. links).

Reconcile semantics worth knowing: a restored record stays `live` while the
daemon's heartbeat reports the id; a reported-missing id is marked `exited`
(`startedAt` must predate the daemon's connection time for reconcile to apply).

## D. Cold start (nothing running, e.g. after reboot)

The hub self-starts on boot: `omp-hub.service` is enabled with linger on
(`loginctl enable-linger skyrain`) — check `systemctl --user status omp-hub`
first; it should already be `active` with the registry restored from
`hub-state.json`. What remains manual:

1. Daemon per §B.3 (nothing hosts it — start it, it reconnects on its own).
2. Find resumable omp session files under
   `~/.omp/profiles/<profile>/agent/sessions/<cwd-slug>/*.jsonl`
   (or `GET /api/machines/<id>/sessions` once the daemon is up), then §B.4
   for the ones that should continue running.

## Verification checklist (any restart)

```bash
curl -sf http://localhost:8471/healthz && curl -sf https://kfdesktop.tail02ef4.ts.net/healthz
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:8471/api/machines   # connected:true, sessionCount
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:8471/api/sessions   # live rows carry links
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:8471/api/sessions/<id>/agent-state   # cmd chain
```

State file check: `python3 -c "import json;d=json.load(open('<hub cwd>/hub-state.json'));print(len(d['sessions']), sum(s['status']=='live' for s in d['sessions']))"`.

## Incident log

- **2026-09-29 ~02:18** — hub restarted from the main checkout while its state
  lived in the `omp-hub-upgrade` worktree (per-cwd `hub-state.json` miss).
  Registry lost; 8 live children orphaned from the registry; new starts hit
  `max sessions reached (8)`. Recovered via §C.1 crafted snapshot.
- **2026-09-29 ~03:35** — after the pkill restart, 4 of 8 children's relay
  rooms never re-established (guest probe → `4004 no such room`; web views
  stuck "reconnecting"). SDK `relay-client.ts` treats several close codes as
  terminal for hosts, so the affected children stop retrying. Fixed per §A.1:
  3 idle sessions stopped + resumed (fresh rooms); 1 left until its turn
  finished. Every hub restart needs the §A.1 room probe.
- **2026-09-29 03:30** — the "Omphhh" agent session's E2E cleanup ran
  `pkill -f "bun src/server.ts"` (intended for its own hub on :8097) and killed
  the production hub too → public 502. Daemon/children unaffected; hub
  restarted per §A, registry restored from the flushed snapshot (8 live).
  **Rule: never stop the hub by cmdline pattern** — every worktree's hub shares
  `bun src/server.ts`. Stop the PID that owns the port:
  `fuser -k 8471/tcp` or `kill -TERM $(ss -tlnp | awk '/:8471 /{…}')`. E2E
  stacks should record their own hub PID and kill exactly that.
- **2026-09-29 ~03:10** — services moved to the `prod` worktree
  (npm-pinned SDK 18.4.2 + typed-settings migration, commits `4e1cc7b`/`d8527bc`);
  daemon restarted per §B with all 8 sessions resumed (§B.4) — registry fully
  rebuilt including links. Broker killed → daemon now standalone (§D applies
  after reboots).
