#!/bin/sh
# Wegwerf-Zertifikate für die Laufzeitprüfung der Vermittlung (Issue #511).
# Läuft im Asterisk-Image (OpenSSL 3), nie auf dem Server.
#   sh pki.sh <rechnername der vermittlung>
# Ergebnis in /pki: ca.pem (Prüf-CA), asterisk/fullchain.pem und
# asterisk/privkey.pem (Vermittlung), gegenstelle.pem und gegenstelle.key
# (easybell und ElevenLabs als Attrappen), folge.pem und folge.key
# (Wildcard *.hosts.rtc.elevenlabs.io für Folgeverbindungen zu ElevenLabs),
# falsch.pem und falsch.key (Wildcard für einen anderen Namen, muss scheitern).
set -eu
cd /pki
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=Pruef-CA" -keyout ca.key -out ca.pem \
  -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign" \
  -addext "subjectKeyIdentifier=hash" 2>/dev/null
blatt() {
  openssl req -newkey rsa:2048 -nodes -subj "/CN=$2" -keyout "$1.key" -out "$1.csr" 2>/dev/null
  printf 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth,clientAuth\nsubjectAltName=%s\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid\n' "$3" > "$1.ext"
  openssl x509 -req -in "$1.csr" -CA ca.pem -CAkey ca.key -CAcreateserial -days 2 -out "$1.pem" -extfile "$1.ext" 2>/dev/null
}
blatt asterisk "$1" "DNS:$1"
blatt gegenstelle voip.easybell.de "DNS:voip.easybell.de,DNS:sip.rtc.elevenlabs.io"
blatt folge "*.hosts.rtc.elevenlabs.io" "DNS:*.hosts.rtc.elevenlabs.io"
blatt falsch "*.hosts.andere.invalid" "DNS:*.hosts.andere.invalid"
mkdir -p asterisk
cp asterisk.pem asterisk/fullchain.pem
cp asterisk.key asterisk/privkey.pem
chmod 644 ./*.key asterisk/privkey.pem
