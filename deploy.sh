#!/usr/bin/env bash
# tybo auf einem Server neu ausrollen (Issue #352).
#
# Ablauf: neuen Stand als eigenes Release-Verzeichnis auspacken, dort
# installieren und mit "bun run check" prüfen. Erst danach wird der laufende
# PM2-Prozess angefasst: alten Prozess anhalten, geteilte Pfade verlinken
# (Liste: scripts/deploy-shared.txt), Bot im Server-Profil starten
# (src/bot.ts --profile server), auf /health mit der neuen Revision warten.
# Bleibt die aus, kommt der alte Prozess mit seiner alten Einstellung zurück.
#
# Aufruf: der Weg POST /deploy (src/app/server-routes.ts) oder von Hand.
# Einstellungen (alle optional):
#   DEPLOY_DIR           Projektordner mit .git, .env und Daten (Standard: Ordner dieses Skripts)
#   DEPLOY_BRANCH        Branch, der ausgerollt wird (Standard master, auch refs/heads/...)
#   DEPLOY_REMOTE        Remote für git fetch (Standard origin)
#   DEPLOY_APP           PM2-Name des Bots (Standard tybo)
#   DEPLOY_PREVIOUS_APP  PM2-Name des laufenden Prozesses, wenn er anders heißt
#                        (Wechsel etwa vom früheren Gateway-Namen auf tybo)
#   RELEASE_ROOT         Ablage der Releases (Standard DEPLOY_DIR/.releases)
#   DEPLOY_HEALTH_URL    Prüfadresse (Standard: Webhook-Listener,
#                        http://127.0.0.1:TELEGRAM_WEBHOOK_PORT/health, Port 3080)
set -Eeuo pipefail
umask 077

project="${DEPLOY_DIR:-$(cd "$(dirname "$0")" && pwd)}"
branch="${DEPLOY_BRANCH:-master}"
branch="${branch#refs/heads/}"
remote="${DEPLOY_REMOTE:-origin}"
app="${DEPLOY_APP:-tybo}"
previous_app="${DEPLOY_PREVIOUS_APP:-$app}"
releases="${RELEASE_ROOT:-$project/.releases}"
health_url="${DEPLOY_HEALTH_URL:-http://127.0.0.1:${TELEGRAM_WEBHOOK_PORT:-3080}/health}"
shared_list="scripts/deploy-shared.txt"

mkdir -p "$releases"
exec >"$releases/deploy-$(date +%Y%m%d-%H%M%S).log" 2>&1

# Höchstens ein Deploy zur Zeit; die Sperre ist ein Verzeichnis (mkdir ist atomar)
lock="$releases/deploy.lock"
mkdir "$lock" 2>/dev/null || { echo "Abbruch: ein anderer Deploy läuft (Sperre $lock)."; exit 1; }
trap 'rmdir "$lock"' EXIT

for tool in git bun pm2 curl tar; do
  command -v "$tool" >/dev/null || { echo "Abbruch: $tool fehlt."; exit 1; }
done
if ! pm2 describe "$previous_app" >/dev/null; then
  echo "Abbruch: kein PM2-Prozess $previous_app. Läuft der Bot unter einem anderen Namen, DEPLOY_PREVIOUS_APP setzen."
  exit 1
fi

# --- Neuer Stand, noch ohne Wirkung auf den laufenden Bot ---
git -C "$project" check-ref-format "refs/heads/$branch"
git -C "$project" fetch "$remote" "$branch"
revision="$(git -C "$project" rev-parse FETCH_HEAD)"
release="$releases/$revision-$(date +%s)"
mkdir "$release"
git -C "$project" archive "$revision" | tar -x -C "$release"
cd "$release"
for required in bun.lock src/bot.ts tests "$shared_list"; do
  [ -e "$required" ] || { echo "Abbruch: $required fehlt im Release."; exit 1; }
done

# Liste der geteilten Pfade lesen und prüfen, bevor etwas verlinkt wird
shared_dirs=()
shared_files=()
while IFS= read -r line || [ -n "$line" ]; do
  entry="${line%%$'\r'}"
  case "$entry" in "" | "#"*) continue ;; esac
  case "$entry" in
    /* | *..* | *" "* | ./*) echo "Abbruch: ungültiger Eintrag in $shared_list: $entry"; exit 1 ;;
  esac
  if [ "${entry%/}" != "$entry" ]; then shared_dirs+=("${entry%/}"); else shared_files+=("$entry"); fi
done <"$shared_list"

bun install --frozen-lockfile
bun run check

# --- Prozess-Einstellungen: Rückweg und neues Release ---
pm2 jlist >"$releases/previous.json"
DEPLOY_PROJECT="$project" DEPLOY_RELEASE="$release" DEPLOY_RELEASES="$releases" DEPLOY_REVISION="$revision" \
DEPLOY_NEW_APP="$app" DEPLOY_OLD_APP="$previous_app" bun --no-env-file -e '
const fs = require("node:fs");
const e = process.env;
const list = JSON.parse(fs.readFileSync(e.DEPLOY_RELEASES + "/previous.json", "utf8"));
const running = list.find(p => p.name === e.DEPLOY_OLD_APP)?.pm2_env;
if (!running?.pm_exec_path || !running?.pm_cwd) throw new Error("Einstellung des laufenden PM2-Prozesses nicht lesbar");
// Frist zum Beenden (Issue #564, BOT_PM2_KILL_TIMEOUT_MS in src/setup/services/pm2.ts):
// sonst SIGKILL nach 1,6 Sekunden und bot.lock bleibt liegen. Eine längere
// Frist des laufenden Prozesses bleibt erhalten, auch auf dem Rückweg.
const kept = Number(running.kill_timeout);
const killTimeout = Math.max(10000, Number.isFinite(kept) ? kept : 0);
const back = { name: e.DEPLOY_OLD_APP, script: running.pm_exec_path, cwd: running.pm_cwd,
  interpreter: running.exec_interpreter, args: running.args, env: running.env || {}, exec_mode: "fork", instances: 1,
  kill_timeout: killTimeout };
// PM2 legt env über die Umgebung dieses Aufrufs; ein DEPLOY_PREVIOUS_APP mit
// dem alten Namen bliebe sonst im Bot und ginge an den nächsten Deploy über /deploy
const next = { name: e.DEPLOY_NEW_APP, script: e.DEPLOY_RELEASE + "/src/bot.ts", cwd: e.DEPLOY_RELEASE,
  interpreter: process.execPath, args: ["--profile", "server"], exec_mode: "fork", instances: 1,
  kill_timeout: killTimeout, env: { ...back.env, DEPLOY_DIR: e.DEPLOY_PROJECT, RELEASE_REVISION: e.DEPLOY_REVISION, DEPLOY_PREVIOUS_APP: e.DEPLOY_NEW_APP } };
fs.writeFileSync(e.DEPLOY_RELEASES + "/rollback.json", JSON.stringify({ apps: [back] }), { mode: 0o600 });
fs.writeFileSync(e.DEPLOY_RELEASE + "/release.json", JSON.stringify({ apps: [next] }), { mode: 0o600 });
fs.writeFileSync(e.DEPLOY_RELEASES + "/previous-cwd", running.pm_cwd, { mode: 0o600 });
'
previous_cwd="$(cat "$releases/previous-cwd")"

# Dateien aus $1, die es in $2 noch nicht gibt, dorthin kopieren; vorhandene bleiben
copy_missing() {
  (cd "$1" && find . -type f) | while IFS= read -r file; do
    [ -e "$2/$file" ] && continue
    mkdir -p "$(dirname "$2/$file")"
    cp -p "$1/$file" "$2/$file"
  done
}

# Geteilte Ordner: mitgelieferte Dateien nur ergänzen, dann den ganzen Ordner verlinken
for dir in ${shared_dirs[@]+"${shared_dirs[@]}"}; do
  shipped="$release/$dir"
  kept="$project/$dir"
  mkdir -p "$kept"
  if [ -d "$shipped" ] && [ ! -L "$shipped" ]; then copy_missing "$shipped" "$kept"; rm -rf "${shipped:?}"; fi
  mkdir -p "$(dirname "$shipped")"
  ln -sfn "$kept" "$shipped"
done

restore_previous() {
  echo "Release $revision nicht gesund, der vorige Prozess kommt zurück."
  pm2 delete "$app" || true
  pm2 start "$releases/rollback.json"
}
trap restore_previous ERR

# --- Wechsel ---
pm2 delete "$previous_app"

from_release=false
case "$previous_cwd" in "$releases"/?*) from_release=true ;; esac
previous_revision="${previous_cwd##*/}"
previous_revision="${previous_revision%-*}"

# true: $1 (relativ) liegt im vorigen Release genau so, wie dessen Revision ihn mitbrachte
shipped_unchanged() {
  local blob
  blob="$(git -C "$project" rev-parse --verify --quiet "$previous_revision:$1")" || return 1
  [ "$blob" = "$(git -C "$project" hash-object --path="$1" "$previous_cwd/$1")" ]
}

# Datei $1 nach $2 kopieren; ersetzt auch einen Link an $2, statt durch ihn zu schreiben
replace_with() {
  mkdir -p "$(dirname "$2")"
  cp -p "$1" "$2.deploy-tmp"
  mv -f "$2.deploy-tmp" "$2"
}

# Bisheriges Layout (vor #352): im vorigen Release war ein geteilter Ordner
# wie config/ ein echter Ordner, darin nur einzelne Dateien als Link. Echte
# Dateien dort (settings.json, agents.json, topics.json, ersetzte frühere
# Links) sind der neueste Stand und gehen jetzt, nach dem Anhalten, in den
# Projektordner. Unverändert mitgelieferte Dateien und Links bleiben liegen.
if [ "$from_release" = true ]; then
  for dir in ${shared_dirs[@]+"${shared_dirs[@]}"}; do
    [ -d "$previous_cwd/$dir" ] && [ ! -L "$previous_cwd/$dir" ] || continue
    while IFS= read -r file; do
      shipped_unchanged "$file" && continue
      echo "Übernommen aus dem vorigen Release: $file"
      replace_with "$previous_cwd/$file" "$project/$file"
    done < <(cd "$previous_cwd" && find "$dir" -type f)
  done
fi

# Einzelne Dateien: hat ein voriges Release (nur unter RELEASE_ROOT) einen
# Link durch eine echte Datei ersetzt, ist diese der neueste Stand; sie geht
# vor dem Verlinken in den Projektordner
for file in ${shared_files[@]+"${shared_files[@]}"}; do
  if [ "$from_release" = true ] && [ -f "$previous_cwd/$file" ] && [ ! -L "$previous_cwd/$file" ]; then
    replace_with "$previous_cwd/$file" "$project/$file"
  fi
  if [ -e "$project/$file" ]; then
    mkdir -p "$(dirname "$release/$file")"
    ln -sfn "$project/$file" "$release/$file"
  fi
done

pm2 start "$release/release.json"
healthy=false
for _ in $(seq 1 30); do
  if curl --fail --silent --max-time 2 "$health_url" | DEPLOY_REVISION="$revision" bun --no-env-file -e '
    const answer = JSON.parse(await Bun.stdin.text());
    process.exit(answer.status === "ok" && answer.revision === process.env.DEPLOY_REVISION ? 0 : 1);'; then
    healthy=true
    break
  fi
  sleep 1
done
[ "$healthy" = true ]
trap - ERR
echo "Release $revision läuft als $app."
