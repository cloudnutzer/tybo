#!/bin/sh
# Zustand der SIP-Vermittlung (Issue #511), für tybo per SSH abfragbar.
# Gedacht als erzwungener Befehl in authorized_keys (siehe README.md):
#   command="/docker/sip-vermittlung/zustand.sh",restrict ssh-ed25519 …
#
# Ausgabe, eine Angabe je Zeile:
#   version=1
#   zeit=<jetzt, UTC, ISO 8601>
#   status=<Registered | Unregistered | Rejected | … | unbekannt | gestoppt>
#   letzte_registrierung=<UTC-Zeitpunkt der letzten Abfrage mit Registered, leer wenn nie>
#   gespraeche=<laufende Gespräche oder leer>
# Keine Rufnummern, keine Zugangsdaten.
set -u
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
CONTAINER=${SIP_VERMITTLUNG_CONTAINER:-sip-vermittlung}
STAND="$DIR/zustand"
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)

if ! out=$(docker exec "$CONTAINER" asterisk -rx "pjsip show registrations" 2>/dev/null); then
  status=gestoppt
else
  # Zeile der Registrierung: Name/Server, Anmeldung, Zustand
  status=$(printf '%s\n' "$out" | awk '$1 ~ /^easybell-reg\// { print $3; exit }')
  [ -n "$status" ] || status=unbekannt
fi

mkdir -p "$STAND"
if [ "$status" = "Registered" ]; then
  printf '%s\n' "$NOW" > "$STAND/letzte-registrierung.tmp" && mv "$STAND/letzte-registrierung.tmp" "$STAND/letzte-registrierung"
fi
letzte=$(cat "$STAND/letzte-registrierung" 2>/dev/null || true)

gespraeche=""
if [ "$status" != "gestoppt" ]; then
  gespraeche=$(docker exec "$CONTAINER" asterisk -rx "group show channels" 2>/dev/null | awk '/active channel/ { print $1; exit }')
fi

printf 'version=1\nzeit=%s\nstatus=%s\nletzte_registrierung=%s\ngespraeche=%s\n' "$NOW" "$status" "$letzte" "$gespraeche"
