# Prüfbild für den Neustart-Nachweis der Firewall (Issue #511, pruefen.ts):
# Debian mit systemd als PID 1 und nftables. Nur für die Prüfung, nie auf dem Server.
FROM debian:trixie-slim@sha256:a72b4433de1cf7d6bae0c4cee74d0547f58601a643b3375f070c51600d63b6b2
RUN apt-get update \
 && apt-get install -y --no-install-recommends systemd systemd-sysv nftables \
 && rm -rf /var/lib/apt/lists/*
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
