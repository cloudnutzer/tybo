#!/bin/sh
# Übernimmt das TLS-Zertifikat für die SIP-Vermittlung (Issue #511).
#   ./zertifikat-erneuern.sh <ordner mit fullchain.pem und privkey.pem>
# Einmal bei der Einrichtung, danach täglich per Cron (als root).
#
# - Kopiert Zertifikat und Schlüssel, wenn eines von beiden fehlt oder sich
#   geändert hat, und stellt bei jedem Lauf Besitzer und Rechte des Schlüssels
#   sicher (nur der Asterisk-Nutzer im Container, uid 1000, darf ihn lesen).
# - Startet Asterisk nur neu, wenn der Container läuft und das Zertifikat neu
#   ist. Läuft ein Gespräch, bleibt der Neustart offen (zertifikat/.neustart-offen)
#   und der nächste Lauf holt ihn nach. Läuft der Container nicht (etwa bei der
#   Einrichtung vor dem ersten Start), liest Asterisk das Zertifikat beim Start.
# - Entschieden wird nur nach einer erfolgreichen Abfrage mit gültiger Antwort.
#   Scheitert docker oder ist die Antwort unlesbar, bleibt die Marke stehen,
#   es gibt keinen Neustart, das Skript meldet den Fehler und endet mit Exit 1.
set -eu
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
QUELLE=${1:?Ordner mit fullchain.pem und privkey.pem angeben}
ZIEL="$DIR/zertifikat"
CONTAINER=${SIP_VERMITTLUNG_CONTAINER:-sip-vermittlung}
BESITZER=${ZERTIFIKAT_BESITZER:-1000:1000}
OFFEN="$ZIEL/.neustart-offen"

[ -s "$QUELLE/fullchain.pem" ] && [ -s "$QUELLE/privkey.pem" ] || { echo "Zertifikat fehlt in $QUELLE" >&2; exit 1; }
mkdir -p "$ZIEL"

neu=0
cmp -s "$QUELLE/fullchain.pem" "$ZIEL/fullchain.pem" || neu=1
cmp -s "$QUELLE/privkey.pem" "$ZIEL/privkey.pem" || neu=1
if [ "$neu" = 1 ]; then
  install -m 0640 -o "${BESITZER%:*}" -g "${BESITZER#*:}" "$QUELLE/privkey.pem" "$ZIEL/privkey.pem"
  install -m 0644 "$QUELLE/fullchain.pem" "$ZIEL/fullchain.pem"
  touch "$OFFEN"
  echo "Zertifikat übernommen"
fi
# Bei jedem Lauf: Besitzer und Rechte des Schlüssels
chown "$BESITZER" "$ZIEL/privkey.pem"
chmod 0640 "$ZIEL/privkey.pem"

[ -f "$OFFEN" ] || exit 0

unbekannt() {
  echo "Neustart bleibt offen, Zustand von Asterisk unbekannt: $1" >&2
  exit 1
}

# Gibt es den Container? Eine leere Liste ist eine gültige Antwort, ein Fehler nicht.
namen=$(docker ps -a --format '{{.Names}}') || unbekannt "docker ps fehlgeschlagen"
if ! printf '%s\n' "$namen" | grep -qxF -- "$CONTAINER"; then
  rm -f "$OFFEN"
  echo "Asterisk läuft nicht und liest das Zertifikat beim Start"
  exit 0
fi
laeuft=$(docker inspect -f '{{.State.Running}}' "$CONTAINER") || unbekannt "docker inspect fehlgeschlagen"
case "$laeuft" in
  true) ;;
  false)
    rm -f "$OFFEN"
    echo "Asterisk läuft nicht und liest das Zertifikat beim Start"
    exit 0
    ;;
  *) unbekannt "docker inspect lieferte keinen Zustand" ;;
esac

# Laufende Gespräche: Asterisk schließt die Ausgabe mit "<n> active channel(s)" ab.
kanaele=$(docker exec "$CONTAINER" asterisk -rx "group show channels") || unbekannt "Abfrage der Gespräche fehlgeschlagen"
laufend=$(printf '%s\n' "$kanaele" | awk '/^[0-9]+ active channels?[[:space:]]*$/ { print $1; exit }')
[ -n "$laufend" ] || unbekannt "Antwort auf group show channels nicht lesbar"
if [ "$laufend" != "0" ]; then
  echo "Neustart verschoben: $laufend Gespräch(e) laufen"
  exit 0
fi
docker restart "$CONTAINER" >/dev/null
rm -f "$OFFEN"
echo "Asterisk mit neuem Zertifikat neu gestartet"
