#!/bin/sh
# Start von Asterisk im Container der SIP-Vermittlung (Issue #511).
#
# 1. Startet nur, wenn die Firewall seit dem letzten Systemstart geladen ist:
#    firewall.sh legt dann /run/sip-vermittlung/geladen auf dem Server an
#    (im Container /firewall/geladen). /run ist nach jedem Neustart leer. Fehlt
#    die Marke, endet der Container mit Fehler und Docker versucht es mit
#    wachsendem Abstand erneut, bis die Firewall geladen ist.
# 2. Asterisk schreibt nur auf die Konsole. Die läuft durch logfilter.pl, der
#    Rufnummern kürzt, bevor etwas nach logs/messages oder ins Docker-Log geht.
set -eu
MARKE=${FIREWALL_MARKE:-/firewall/geladen}
LOGDATEI=${LOGDATEI:-/var/log/asterisk/messages}

if [ ! -f "$MARKE" ]; then
  echo "Firewall der Vermittlung seit dem Systemstart nicht geladen ($MARKE fehlt): Asterisk startet nicht" >&2
  exit 1
fi

mkdir -p "$(dirname "$LOGDATEI")"
ROHR=/tmp/asterisk-konsole
rm -f "$ROHR"
mkfifo -m 600 "$ROHR"
perl /vermittlung/logfilter.pl "$LOGDATEI" < "$ROHR" &
# exec: Asterisk bekommt die Signale von docker stop direkt
exec /usr/sbin/asterisk -f -n -U asterisk > "$ROHR" 2>&1
