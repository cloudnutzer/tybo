#!/usr/bin/env bash
# Validate a separate release before touching the running PM2 gateway.
set -Eeuo pipefail
umask 077
DEPLOY_DIR="${DEPLOY_DIR:-$(cd "$(dirname "$0")" && pwd)}"
DEPLOY_BRANCH="${DEPLOY_BRANCH:-master}"
DEPLOY_BRANCH="${DEPLOY_BRANCH#refs/heads/}"
DEPLOY_APP="${DEPLOY_APP:-go-bot}"
RELEASE_ROOT="${RELEASE_ROOT:-$DEPLOY_DIR/.releases}"
HEALTH_URL="${DEPLOY_HEALTH_URL:-http://127.0.0.1:${PORT:-3000}/health}"
mkdir -p "$RELEASE_ROOT"
exec > "$RELEASE_ROOT/deploy-$(date +%Y%m%d-%H%M%S).log" 2>&1
if ! mkdir "$RELEASE_ROOT/deploy.lock"; then
  echo "Another deployment is active; refusing concurrent deployment."
  exit 1
fi
trap 'rmdir "$RELEASE_ROOT/deploy.lock"' EXIT
command -v pm2 >/dev/null
command -v bun >/dev/null
command -v curl >/dev/null
pm2 describe "$DEPLOY_APP" >/dev/null
git -C "$DEPLOY_DIR" check-ref-format "refs/heads/$DEPLOY_BRANCH"
git -C "$DEPLOY_DIR" fetch origin "$DEPLOY_BRANCH"
REVISION="$(git -C "$DEPLOY_DIR" rev-parse FETCH_HEAD)"
RELEASE="$RELEASE_ROOT/$REVISION-$(date +%s)"
mkdir "$RELEASE"
git -C "$DEPLOY_DIR" archive "$REVISION" | tar -x -C "$RELEASE"
cd "$RELEASE"
test -f bun.lock
test -f src/whatsapp-gateway.ts
test -f src/voice-bridge.ts
test -d tests
bun install --frozen-lockfile
bun run check

# Capture exact process configuration for rollback, in private files.
pm2 jlist > "$RELEASE_ROOT/previous.json"
DEPLOY_DIR="$DEPLOY_DIR" DEPLOY_APP="$DEPLOY_APP" RELEASE="$RELEASE" RELEASE_ROOT="$RELEASE_ROOT" bun -e '
const fs = require("node:fs");
const all = JSON.parse(fs.readFileSync(process.env.RELEASE_ROOT + "/previous.json", "utf8"));
const old = all.find(p => p.name === process.env.DEPLOY_APP)?.pm2_env;
if (!old?.pm_exec_path || !old?.pm_cwd) throw new Error("Cannot identify existing PM2 process");
const base = {name: process.env.DEPLOY_APP, script: old.pm_exec_path, cwd: old.pm_cwd,
  interpreter: old.exec_interpreter, args: old.args, env: old.env || {}, exec_mode: "fork", instances: 1};
fs.writeFileSync(process.env.RELEASE_ROOT + "/rollback.json", JSON.stringify({apps:[base]}), {mode:0o600});
fs.writeFileSync(process.env.RELEASE + "/release.json", JSON.stringify({apps:[{...base,
  script: process.env.RELEASE + "/src/vps-gateway.ts", cwd: process.env.RELEASE, interpreter: process.execPath, args: [],
  env:{...base.env, DEPLOY_DIR: process.env.DEPLOY_DIR, RELEASE_REVISION: process.env.RELEASE.split("/").pop().split("-")[0]}}]}), {mode:0o600});
'
for rel in .env data uploads logs memory.json session-state.json credit-tally.json config/profile.md config/schedule.json config/agent-overrides.json config/.google-tokens.json config/whatsapp-groups.json; do
  if [ -e "$DEPLOY_DIR/$rel" ]; then
    mkdir -p "$(dirname "$RELEASE/$rel")"
    ln -sfn "$DEPLOY_DIR/$rel" "$RELEASE/$rel"
  fi
done
rollback() {
  echo "Release failed; restoring previous process configuration."
  pm2 delete "$DEPLOY_APP" || true
  pm2 start "$RELEASE_ROOT/rollback.json"
}
trap 'rollback' ERR
pm2 delete "$DEPLOY_APP"
pm2 start "$RELEASE/release.json"
healthy=false
for attempt in $(seq 1 30); do
  if curl --fail --silent --max-time 2 "$HEALTH_URL" | REVISION="$REVISION" bun -e '
    const value = JSON.parse(await Bun.stdin.text());
    process.exit(value.status === "ok" && value.revision === process.env.REVISION ? 0 : 1);'; then
    healthy=true
    break
  fi
  sleep 1
done
if [ "$healthy" != true ]; then false; fi
trap - ERR
echo "Healthy release: $REVISION"
