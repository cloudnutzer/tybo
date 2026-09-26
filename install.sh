#!/bin/sh
# Installer für tybo (Issue #144, Entscheidung 0009):
#
#   curl -fsSL https://tybo.ai/install | sh
#   curl -fsSL https://tybo.ai/install | sh -s -- [--dir <pfad>] [--yes] [--no-setup] [--help]
#
# Prüft, was fehlt, bietet die offizielle Bun-Installation an, holt tybo nach
# ~/tybo, installiert die Pakete, legt den Befehl tybo an und startet
# tybo setup. Ein zweiter Lauf aktualisiert eine vorhandene Installation.
# Ruft nie sudo auf und ändert selbst keine Shell-Startdateien.
#
# Oberhalb von main stehen nur Zuweisungen und Funktionen; der Aufruf steht in
# der letzten Zeile. Bricht der Download vorher ab, führt sh nichts aus.

set -eu

# Gleichlauf mit src/brand.ts (BRAND.repo), MIN_BUN_VERSION und engines.bun:
# tests/install-sh.test.ts
TYBO_DEFAULT_REPO_URL="https://github.com/cloudnutzer/tybo.git"
TYBO_MIN_BUN_VERSION="1.3.10"
BUN_INSTALLER_URL="https://bun.sh/install"
CLAUDE_INSTALL_CMD="npm install -g @anthropic-ai/claude-code"

say() {
  printf 'tybo: %s\n' "$*"
}

die() {
  printf 'tybo: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<EOF
tybo installieren oder aktualisieren

Aufruf:
  curl -fsSL https://tybo.ai/install | sh
  curl -fsSL https://tybo.ai/install | sh -s -- [Optionen]
  sh install.sh [Optionen]

Optionen:
  --dir <pfad>   Zielordner (sonst \$TYBO_DIR, sonst ~/tybo)
  --yes          Bun ohne Rückfrage installieren bzw. aktualisieren
  --no-setup     tybo setup am Ende nicht starten
  --help         diese Hilfe

Umgebungsvariablen (für Tests und eigene Kopien):
  TYBO_DIR       Zielordner, wenn --dir fehlt
  TYBO_REPO_URL  Repo zum Klonen (Standard $TYBO_DEFAULT_REPO_URL)
  TYBO_BRANCH    Branch (Standard master)
  TYBO_TTY       Terminal für Rückfragen und Einrichtung (Standard /dev/tty)
  BUN_INSTALL    Bun-Ordner (Standard ~/.bun)

Ein zweiter Lauf im selben Ordner holt den neuesten Stand (git pull --ff-only)
und startet die Einrichtung nicht noch einmal. Node.js und die Claude CLI
installiert dieses Skript nicht.
EOF
}

manual_guide() {
  printf '%s/blob/master/docs/einrichtung.md' "${TYBO_DEFAULT_REPO_URL%.git}"
}

# Terminal für Rückfragen: lässt es sich öffnen? (Kein test -t, damit TYBO_TTY
# in Tests auch eine Datei mit Antworten sein kann.)
have_tty() {
  (: <"$tty") 2>/dev/null
}

# Rückfrage mit Standard Ja; nur aufrufen, wenn have_tty zutrifft
ask_yes() {
  printf 'tybo: %s [J/n] ' "$1"
  answer=""
  IFS= read -r answer <"$tty" || true
  case $answer in
    "" | j | J | ja | Ja | JA | y | Y | yes) return 0 ;;
    *) return 1 ;;
  esac
}

# true, wenn Version $1 mindestens $2 ist (x.y.z; Zusätze wie -canary zählen nicht)
version_at_least() {
  have=${1%%[-+ ]*}
  want=$2
  case $have in "" | *[!0-9.]*) return 1 ;; esac
  old_ifs=$IFS
  IFS=.
  # shellcheck disable=SC2086 # Zerlegen an Punkten ist hier gewollt
  set -- $have
  h1=${1:-0} h2=${2:-0} h3=${3:-0}
  # shellcheck disable=SC2086
  set -- $want
  IFS=$old_ifs
  w1=${1:-0} w2=${2:-0} w3=${3:-0}
  [ "$h1" -ne "$w1" ] && { [ "$h1" -gt "$w1" ]; return; }
  [ "$h2" -ne "$w2" ] && { [ "$h2" -gt "$w2" ]; return; }
  [ "$h3" -ge "$w3" ]
}

# Repo-Adresse vergleichbar machen: HTTPS, ssh:// und git@host:pfad, mit und
# ohne .git, ohne Benutzer, klein geschrieben
normalize_repo_url() {
  printf '%s\n' "$1" | sed \
    -e 's#/*$##' \
    -e 's#\.git$##' \
    -e 's#^[A-Za-z][A-Za-z0-9+.-]*://##' \
    -e 's#^[^@/]*@##' \
    -e 's#^\([^/:]*\):#\1/#' | tr '[:upper:]' '[:lower:]'
}

# Wert für ausgegebene Befehle zum Kopieren: unverändert, wenn nur harmlose
# Zeichen drin sind, sonst in einfachen Anführungszeichen ('\'' für ')
shell_quote() {
  case $1 in
    "" | *[!A-Za-z0-9_./:@%+=,-]*)
      printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
      ;;
    *) printf '%s' "$1" ;;
  esac
}

parse_args() {
  while [ $# -gt 0 ]; do
    case $1 in
      --dir)
        if [ $# -lt 2 ] || [ -z "$2" ]; then
          die "--dir braucht einen Ordner, etwa --dir ~/tybo."
        fi
        target_dir=$2
        shift 2
        ;;
      --dir=*)
        target_dir=${1#--dir=}
        [ -n "$target_dir" ] || die "--dir braucht einen Ordner, etwa --dir ~/tybo."
        shift
        ;;
      --yes | -y) assume_yes=1; shift ;;
      --no-setup) run_setup=0; shift ;;
      --help | -h) show_help=1; shift ;;
      *) die "unbekannte Option: $1. Alle Optionen zeigt: sh install.sh --help" ;;
    esac
  done
}

# Schritt 1: kein Root
check_not_root() {
  if [ "$(id -u)" = "0" ]; then
    die "bitte ohne sudo ausführen (nicht als root). tybo gehört in dein eigenes Benutzerkonto."
  fi
}

# Schritt 2: macOS oder Linux (auch WSL)
check_system() {
  system=$(uname -s)
  case $system in
    Darwin | Linux) ;;
    *) die "dieses System ($system) unterstützt der Installer nicht. Anleitung von Hand: $(manual_guide)" ;;
  esac
}

# Schritt 3: Git muss da sein, der Installer installiert es nicht
check_git() {
  command -v git >/dev/null 2>&1 && return 0
  if [ "$system" = "Darwin" ]; then
    die "Git fehlt. Installieren mit: xcode-select --install, danach diesen Befehl erneut ausführen."
  fi
  die "Git fehlt. Installieren mit: sudo apt install git (Debian, Ubuntu) bzw. sudo dnf install git (Fedora), danach diesen Befehl erneut ausführen."
}

# Zielordner einordnen, bevor irgendetwas geändert wird (auch vor Bun):
# mode=fresh (fehlt oder leer) oder mode=update (passender Klon, sauber,
# richtiger Branch, lässt sich vorspulen). Sonst Abbruch.
inspect_target() {
  case $target_dir in
    /*) ;;
    *) target_dir="$(pwd)/$target_dir" ;;
  esac
  target_q=$(shell_quote "$target_dir")
  if [ ! -e "$target_dir" ]; then
    mode=fresh
    return 0
  fi
  not_ours="$target_dir gehört nicht zu tybo, nichts geändert. Einen anderen Ordner wählen: --dir <pfad>"
  [ -d "$target_dir" ] || die "$not_ours"
  if [ -z "$(ls -A "$target_dir")" ]; then
    mode=fresh
    return 0
  fi

  # Wurzel eines Git-Klons, kein Unterordner
  real_dir=$(cd "$target_dir" && pwd -P) || die "$not_ours"
  if ! top=$(git -C "$target_dir" rev-parse --show-toplevel 2>/dev/null); then
    die "$not_ours"
  fi
  [ "$top" = "$real_dir" ] || die "$not_ours"

  if ! origin=$(git -C "$target_dir" remote get-url origin 2>/dev/null); then
    die "$not_ours"
  fi
  if [ "$(normalize_repo_url "$origin")" != "$(normalize_repo_url "$repo_url")" ]; then
    die "$not_ours"
  fi

  branch_now=$(git -C "$target_dir" symbolic-ref --short -q HEAD 2>/dev/null || true)
  if [ "$branch_now" != "$branch" ]; then
    die "$target_dir steht auf Branch ${branch_now:-(keiner)}, nicht auf $branch, nichts geändert. Zurück mit: cd $target_q && git checkout $branch"
  fi

  if [ -n "$(git -C "$target_dir" status --porcelain --untracked-files=no)" ]; then
    die "lokale Änderungen in $target_dir, nichts geändert. Anzeigen mit: cd $target_q && git status"
  fi

  if ! git -C "$target_dir" fetch origin "$branch"; then
    die "neuen Stand nicht erreichbar (git fetch fehlgeschlagen), nichts geändert. Internetverbindung prüfen und erneut versuchen."
  fi
  if ! git -C "$target_dir" merge-base --is-ancestor HEAD FETCH_HEAD; then
    die "$target_dir weicht vom Stand auf origin/$branch ab (eigene Commits), nichts geändert. Anzeigen mit: cd $target_q && git log origin/$branch..HEAD"
  fi
  mode=update
}

find_bun() {
  if command -v bun >/dev/null 2>&1; then
    command -v bun
  elif [ -x "$bun_home/bin/bun" ]; then
    printf '%s\n' "$bun_home/bin/bun"
  else
    return 1
  fi
}

bun_version() {
  "$1" --version 2>/dev/null || true
}

need_for_installer() {
  for tool in bash curl unzip; do
    command -v "$tool" >/dev/null 2>&1 && continue
    if [ "$system" = "Darwin" ]; then
      die "$tool fehlt, der Bun-Installer braucht es. Unter macOS gehört es zum System; Xcode-Werkzeuge nachholen: xcode-select --install"
    fi
    die "$tool fehlt, der Bun-Installer braucht bash, curl und unzip. Installieren mit: sudo apt install $tool (Debian, Ubuntu) bzw. sudo dnf install $tool (Fedora)"
  done
}

# Rückfrage für Bun-Installation oder -Upgrade; ohne Ja Abbruch mit dem Befehl
confirm_bun() {
  question=$1
  manual=$2
  [ "$assume_yes" = 1 ] && return 0
  if ! have_tty; then
    die "Bun fehlt oder ist zu alt, und ohne Terminal kann ich nicht fragen. Selbst ausführen: $manual, danach diesen Befehl erneut; oder mit --yes starten."
  fi
  ask_yes "$question" || die "abgebrochen, nichts installiert. Selbst ausführen: $manual, danach diesen Befehl erneut."
}

run_bun_installer() {
  need_for_installer
  installer=$(mktemp "${TMPDIR:-/tmp}/tybo-bun-install.XXXXXX") || die "kein Platz für eine temporäre Datei. TMPDIR prüfen und erneut versuchen."
  # Erst ganz laden, dann ausführen: bei curl | bash sähe set -e einen
  # Downloadfehler links der Pipe nicht.
  if ! curl -fsSL "$BUN_INSTALLER_URL" -o "$installer" || [ ! -s "$installer" ]; then
    rm -f "$installer"
    die "Bun-Installer ließ sich nicht laden ($BUN_INSTALLER_URL). Internetverbindung prüfen und erneut versuchen."
  fi
  say "starte den offiziellen Bun-Installer (er trägt Bun selbst in deine Shell-Startdatei ein)"
  if ! BUN_INSTALL="$bun_home" bash "$installer" </dev/null; then
    rm -f "$installer"
    die "der Bun-Installer ist fehlgeschlagen. Meldung oben lesen, dann selbst ausführen: curl -fsSL $BUN_INSTALLER_URL | bash"
  fi
  rm -f "$installer"
  [ -x "$bun_home/bin/bun" ] || die "Bun ist nach der Installation nicht unter $bun_home/bin/bun. Neues Terminal öffnen und diesen Befehl erneut ausführen."
  bun_cmd="$bun_home/bin/bun"
}

# Schritt 4: Bun vorhanden und aktuell genug
ensure_bun() {
  manual_install="curl -fsSL $BUN_INSTALLER_URL | bash"
  if ! bun_cmd=$(find_bun); then
    say "Bun fehlt (gesucht im PATH und unter $bun_home/bin)."
    confirm_bun "Bun jetzt mit dem offiziellen Installer von bun.sh installieren?" "$manual_install"
    run_bun_installer
  fi
  version=$(bun_version "$bun_cmd")
  if ! version_at_least "$version" "$TYBO_MIN_BUN_VERSION"; then
    say "Bun ${version:-(unbekannte Version)} ist zu alt, tybo braucht $TYBO_MIN_BUN_VERSION oder neuer."
    confirm_bun "Bun jetzt mit bun upgrade aktualisieren?" "bun upgrade"
    if ! "$bun_cmd" upgrade </dev/null; then
      die "bun upgrade ist fehlgeschlagen. Selbst ausführen: bun upgrade, danach diesen Befehl erneut."
    fi
    version=$(bun_version "$bun_cmd")
    version_at_least "$version" "$TYBO_MIN_BUN_VERSION" ||
      die "Bun ist nach dem Upgrade noch ${version:-(unbekannte Version)}, gebraucht wird $TYBO_MIN_BUN_VERSION. Selbst ausführen: $manual_install"
  fi
  say "Bun $version gefunden: $bun_cmd"
  # Folgeprozesse (tybo setup, launchd-Einrichtung) suchen Bun über den PATH
  PATH="${bun_cmd%/*}:$PATH"
  export PATH
}

# Schritt 5: tybo holen oder aktualisieren
fetch_tybo() {
  if [ "$mode" = fresh ]; then
    say "hole tybo nach $target_dir"
    git clone --branch "$branch" "$repo_url" "$target_dir" ||
      die "git clone ist fehlgeschlagen. Internetverbindung prüfen und erneut versuchen."
  else
    say "aktualisiere $target_dir"
    git -C "$target_dir" pull --ff-only origin "$branch" ||
      die "git pull ist fehlgeschlagen. Meldung oben lesen; Stand anzeigen mit: cd $target_q && git status"
  fi
}

# Schritt 6: Pakete und Befehl tybo
install_packages() {
  say "installiere Pakete"
  (cd "$target_dir" && "$bun_cmd" install --frozen-lockfile </dev/null) ||
    die "bun install ist fehlgeschlagen. Meldung oben lesen, dann erneut: cd $target_q && bun install --frozen-lockfile"
  (cd "$target_dir" && "$bun_cmd" link </dev/null) ||
    die "bun link ist fehlgeschlagen. Meldung oben lesen, dann erneut: cd $target_q && bun link"
}

# Schritt 7: Einrichtung bei neuer Installation, Hinweis bei Aktualisierung
finish() {
  if [ "$mode" = update ]; then
    commit=$(git -C "$target_dir" rev-parse --short HEAD 2>/dev/null || printf '?')
    say "Aktualisiert auf $commit. Läuft tybo schon, einmal neu starten: cd $target_q && bun run restart:request \"Update\""
  elif [ "$run_setup" = 1 ] && have_tty; then
    say "tybo ist installiert. Jetzt startet die Einrichtung (tybo setup)."
    # Direkt mit bun: das Shebang-Flag --no-env-file greift hier nicht von selbst.
    # TYBO_ROOT fest auf den Zielordner, sonst bearbeitete ein geerbter Wert
    # die .env einer anderen Installation.
    # Kein die: die Hinweise aus final_hints (PATH, Node.js, Claude CLI) braucht
    # der Fortsetzungsbefehl erst recht; main endet danach mit Exit 1.
    if ! TYBO_ROOT="$target_dir" "$bun_cmd" --no-env-file "$target_dir/scripts/tybo.ts" setup <"$tty"; then
      printf 'tybo: %s\n' "Einrichtung nicht abgeschlossen. Später weiter mit: cd $target_q && tybo setup" >&2
      setup_failed=1
    fi
  else
    say "tybo ist installiert. Weiter mit: cd $target_q && tybo setup"
  fi
}

# Schritt 8: was noch fehlt; Startdateien ändert dieses Skript nicht.
# Maßgeblich ist der PATH vor dem Lauf, nicht der um Bun ergänzte.
final_hints() {
  case ":$original_path:" in
    *":$bun_home/bin:"*) ;;
    *)
      say "$bun_home/bin ist nicht im PATH, der Befehl tybo wird sonst nicht gefunden."
      say "Diese zwei Zeilen in ~/.zshrc (zsh, macOS) bzw. ~/.bashrc (bash, Linux) eintragen und ein neues Terminal öffnen:"
      printf '  export BUN_INSTALL=%s\n' "$(shell_quote "$bun_home")"
      # shellcheck disable=SC2016 # die Zeile soll wörtlich so in der Startdatei stehen
      printf '  export PATH="$BUN_INSTALL/bin:$PATH"\n'
      ;;
  esac
  if ! command -v node >/dev/null 2>&1; then
    say "Als Nächstes Node.js installieren (mit npm), Anleitung: $(manual_guide). tybo setup prüft Node.js nicht."
  fi
  if ! command -v claude >/dev/null 2>&1; then
    say "Dann die Claude CLI: $CLAUDE_INSTALL_CMD und einmal claude starten zum Anmelden. tybo setup prüft sie."
  fi
}

main() {
  original_path=$PATH
  target_dir=${TYBO_DIR:-}
  assume_yes=0
  run_setup=1
  setup_failed=0
  show_help=0
  parse_args "$@"
  if [ "$show_help" = 1 ]; then
    usage
    return 0
  fi
  [ -n "$target_dir" ] || target_dir="$HOME/tybo"
  repo_url=${TYBO_REPO_URL:-$TYBO_DEFAULT_REPO_URL}
  branch=${TYBO_BRANCH:-master}
  tty=${TYBO_TTY:-/dev/tty}
  bun_home=${BUN_INSTALL:-$HOME/.bun}

  check_not_root
  check_system
  check_git
  inspect_target
  ensure_bun
  fetch_tybo
  install_packages
  finish
  final_hints
  [ "$setup_failed" = 0 ] || exit 1
}

main "$@"
