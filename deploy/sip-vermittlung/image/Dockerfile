# Asterisk für die SIP-Vermittlung (Issue #511).
#
# Grundlage ist das Standard-Image andrius/asterisk:22.11.0_debian-trixie-1b724ca.
# Ausgetauscht wird nur /usr/lib/libasteriskpj.so.2: pjproject 2.17, so wie
# Asterisk 22.11.0 es mitbringt und baut (--with-pjproject-bundled), dazu
# 0100-tls-folgeverbindung-zielname.patch. Ohne den Patch prüft Asterisk das
# Zertifikat einer Folgeverbindung zu ElevenLabs gegen sip.rtc.elevenlabs.io
# statt gegen den Contact <ip>.hosts.rtc.elevenlabs.io und lehnt das
# Zertifikat *.hosts.rtc.elevenlabs.io ab (README.md, „Folgeverbindungen“).
#
# Abweichung vom Issue-Kriterium „Standard-Image“: Ein unverändertes Image,
# das diese Folgeverbindungen mit Zertifikatsprüfung schafft, gibt es nicht
# (README.md, „Folgeverbindungen“). Der Maintainer hat dieses Image am
# 6.11.2026 freigegeben, nur mit diesem Patch; jedes Update braucht die
# Folgeverbindungsproben aus pruefen.ts --container erneut
# (docs/webui/decisions/0026-sprachagenten-rezepte.md, Nachtrag E1).
#
# Der Build braucht einmal Internet: Debian-Pakete, die Asterisk-Quellen
# (Prüfsumme wie beim Standard-Image) und pjproject (Asterisk prüft es selbst).
# Gebaut wird mit compose.yaml (docker compose build) und von pruefen.ts.

FROM debian:trixie@sha256:9c6e381421d0f48d1b8133e573f33c185ee16cbf505eda9c4a8a4791b25ea8a6 AS bau
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl bzip2 build-essential pkg-config patch python3 \
      libedit-dev libjansson-dev libxml2-dev libxslt1-dev libsqlite3-dev uuid-dev libssl-dev binutils-dev \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /usr/src/asterisk
RUN curl -fsSL -o /tmp/asterisk.tar.gz https://downloads.asterisk.org/pub/telephony/asterisk/releases/asterisk-22.11.0.tar.gz \
 && echo "3bd5ee040509a3d3cd9b1ba9520c18e6ec0a7e7981ca68c457dcd36ba3c54d94  /tmp/asterisk.tar.gz" | sha256sum -c - \
 && tar --strip-components=1 -xzf /tmp/asterisk.tar.gz \
 && rm /tmp/asterisk.tar.gz
COPY 0100-tls-folgeverbindung-zielname.patch third-party/pjproject/patches/
COPY pjlib.mak ./
# Dieselben Optionen wie beim Standard-Image; BUILD_NATIVE aus, damit die
# Bibliothek nicht nur auf dem Prozessor des Build-Rechners läuft
RUN ./configure --with-pjproject-bundled --with-ssl=ssl --with-crypto > /dev/null \
 && make menuselect.makeopts > /dev/null \
 && menuselect/menuselect --disable BUILD_NATIVE menuselect.makeopts \
 && make -f pjlib.mak pjlib \
 && grep -q "Using next hop name" main/libasteriskpj.so.2

FROM andrius/asterisk:22.11.0_debian-trixie-1b724ca
COPY --from=bau /usr/src/asterisk/main/libasteriskpj.so.2 /tmp/libasteriskpj.so.2
# Die neue Bibliothek muss dieselben Symbole anbieten wie die ersetzte,
# sonst bricht der Build ab
RUN set -e; \
    nm -D --defined-only /usr/lib/libasteriskpj.so.2 | awk '{print $NF}' | sort > /tmp/symbole.alt; \
    nm -D --defined-only /tmp/libasteriskpj.so.2 | awk '{print $NF}' | sort > /tmp/symbole.neu; \
    cmp /tmp/symbole.alt /tmp/symbole.neu; \
    install -m 755 /tmp/libasteriskpj.so.2 /usr/lib/libasteriskpj.so.2; \
    install -m 755 /tmp/libasteriskpj.so.2 /usr/lib/libasteriskpj.so; \
    rm /tmp/libasteriskpj.so.2 /tmp/symbole.alt /tmp/symbole.neu
LABEL org.opencontainers.image.title="Asterisk für die SIP-Vermittlung" \
      org.opencontainers.image.description="andrius/asterisk:22.11.0_debian-trixie-1b724ca mit pjproject-Patch für TLS-Folgeverbindungen"
