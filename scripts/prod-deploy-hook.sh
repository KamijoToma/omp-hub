#!/usr/bin/env bash
# Hub deploy hook for the prod branch (docs/runbook.md §A.2).
#
# Runs as the shared .git/hooks/reference-transaction (every worktree, every
# ref update); it deploys ONLY when refs/heads/prod actually moves. The deploy
# builds the web dist + hub binary in the prod worktree and restarts the
# systemd unit — which re-execs the fresh binary from disk. The daemon is NOT
# touched: restart it via the panel (restart-daemon) when its code changed.
#
# Install once (shared by all worktrees):
#   install -m 755 scripts/prod-deploy-hook.sh .git/hooks/reference-transaction
set -u

state="${1:-}"
[ "$state" = "committed" ] || exit 0

touched=0
while read -r old new ref; do
	[ "$ref" = "refs/heads/prod" ] || continue
	[ "$old" != "$new" ] || continue
	touched=1
done
[ "$touched" = 1 ] || exit 0

PROD=/home/skyrain/Projects/omp-hub-prod
LOG="$PROD/packages/hub/hub-deploy.log"
exec 9>"$PROD/packages/hub/.hub-deploy.lock"
flock -n 9 || exit 0 # a newer deploy is already in flight; it wins

{
	echo "[$(date -Is)] prod branch moved — building and restarting the hub (daemon untouched)"
	cd "$PROD" || exit 0
	if ! /home/skyrain/.local/bin/bun --cwd=packages/web run build >>"$LOG" 2>&1; then
		echo "[$(date -Is)] web build FAILED — running hub left alone; fix and merge again" >>"$LOG"
		exit 0
	fi
	if ! /home/skyrain/.local/bin/bun --cwd=packages/hub run build:binary >>"$LOG" 2>&1; then
		echo "[$(date -Is)] binary build FAILED — running hub left alone; fix and merge again" >>"$LOG"
		exit 0
	fi
	systemctl --user restart omp-hub >>"$LOG" 2>&1
	for _ in $(seq 1 20); do
		curl -sf -m 2 http://localhost:8471/healthz >/dev/null 2>&1 && break
		sleep 0.5
	done
	if curl -sf -m 2 http://localhost:8471/healthz >/dev/null 2>&1; then
		echo "[$(date -Is)] hub restarted and healthy on the new build"
	else
		echo "[$(date -Is)] hub not answering healthz within 10 s — check hub-restart.log / systemctl --user status omp-hub"
	fi
	echo "[$(date -Is)] deploy done"
} >>"$LOG" 2>&1
exit 0
