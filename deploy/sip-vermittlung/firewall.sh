#!/bin/sh
# Lädt erzeugt/firewall.nft und füllt das Set easybell (Issue #511).
# easybell veröffentlicht keine Adressbereiche und empfiehlt Rechnernamen
# statt Adressen; das Set entsteht deshalb aus dem DNS und sollte stündlich
# erneuert werden (README.md). Nur mit EASYBELL_TRANSPORT=udp nötig, schadet
# mit TLS aber nicht.
#
# Nach dem Laden legt das Skript die Marke /run/sip-vermittlung/geladen an.
# Ohne sie startet Asterisk nicht (container/start.sh); /run ist nach jedem
# Neustart des Servers leer. Bei jedem Systemstart lädt die systemd-Unit
# systemd/sip-vermittlung-firewall.service dieses Skript, bevor Docker startet.
#   sudo ./firewall.sh            Regeln laden
#   sudo ./firewall.sh --anzeigen nur zeigen, was geladen würde
set -eu
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REGELN="$DIR/erzeugt/firewall.nft"
MARKE=${FIREWALL_MARKE:-/run/sip-vermittlung/geladen}
HOSTS="${EASYBELL_HOSTS:-voip.easybell.de sip.easybell.de secure.sip.easybell.de}"
[ -f "$REGELN" ] || { echo "Fehlt: $REGELN (erst docker compose run --rm vorlagen)" >&2; exit 1; }

ips=""
for h in $HOSTS; do
  for ip in $(getent ahostsv4 "$h" | awk '{ print $1 }' | sort -u); do
    case " $ips " in *" $ip "*) ;; *) ips="$ips $ip" ;; esac
  done
done
elemente=$(echo $ips | tr ' ' ',')

if [ "${1:-}" = "--anzeigen" ]; then
  cat "$REGELN"
  echo "# Set easybell: ${elemente:-leer}"
  exit 0
fi
nft -f "$REGELN"
if [ -n "$elemente" ]; then
  nft add element inet sip_vermittlung easybell "{ $elemente }"
fi
# Erst nach erfolgreichem Laden: Asterisk darf starten
nft list table inet sip_vermittlung >/dev/null
mkdir -p "$(dirname "$MARKE")"
date -u +%Y-%m-%dT%H:%M:%SZ > "$MARKE"
echo "Firewall geladen, easybell: ${elemente:-keine Adresse gefunden}"
