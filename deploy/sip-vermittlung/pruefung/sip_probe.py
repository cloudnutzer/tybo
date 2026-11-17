"""SIP-Gegenstellen und Proben für die Laufzeitprüfung der Vermittlung (Issue #511).

Läuft in einem Python-Container ohne Zugang nach außen (pruefen.ts) und spielt
beide Seiten nach, mit denen die Vermittlung spricht:

- easybell: Registrar mit Digest-Anmeldung auf voip.easybell.de:5061 (TLS),
  ruft über die Registrierung an und nimmt Anrufe der Vermittlung an.
- ElevenLabs: SIP-Trunk auf sip.rtc.elevenlabs.io:5061 (TLS, Digest), nimmt
  Anrufe der Vermittlung an und ruft für /anruf bei ihr an.

Dazu Proben ohne Anmeldung, mit falschen Zugangsdaten, mit unterdrückter
Nummer, Folgeverbindungen zu ElevenLabs (Contact <ip>.hosts.rtc.elevenlabs.io,
siehe folgeverbindung), gleichzeitige Anrufe, Weiterleitungen, REFER und die
Höchstdauer. Je
Probe eine Zeile JSON auf der Standardausgabe: {"probe": name, ...}.

Aufruf: python -I -u sip_probe.py <modus> <konfiguration als JSON>
Modi:   phase-a (Standard), phase-b (UNTERDRUECKTE_NUMMER=annehmen),
        angriff (fehlgeschlagene Anmeldungen, dann Sperre abwarten), ports
"""
import base64
import hashlib
import json
import os
import queue
import re
import socket
import ssl
import sys
import threading
import time
import uuid

CRLF = "\r\n"
KURZ = {"f": "from", "t": "to", "i": "call-id", "m": "contact", "v": "via", "l": "content-length", "c": "content-type", "k": "supported", "r": "refer-to"}
EASYBELL = "voip.easybell.de"
ELEVENLABS = "sip.rtc.elevenlabs.io"
PKI = "/pki"
# Ports der ElevenLabs-Attrappe für Folgeverbindungen, je mit einem anderen
# Zertifikat: *.hosts.rtc.elevenlabs.io (wie bei ElevenLabs beschrieben),
# *.hosts.andere.invalid (falscher Name), sip.rtc.elevenlabs.io (Name der
# ersten Verbindung, passt nicht zum Contact <ip>.hosts.rtc.elevenlabs.io)
WILDCARD_PORT, FALSCH_PORT, ERSTER_NAME_PORT = 5062, 5063, 5064
FOLGE_PORTS = ((WILDCARD_PORT, "folge"), (FALSCH_PORT, "falsch"), (ERSTER_NAME_PORT, "gegenstelle"))


def md5(text):
    return hashlib.md5(text.encode()).hexdigest()


def zufall(n=10):
    return uuid.uuid4().hex[:n]


def ausgabe(ergebnis):
    print(json.dumps(ergebnis), flush=True)


# ---------------------------------------------------------------------------
# Nachrichten
# ---------------------------------------------------------------------------

class Nachricht:
    def __init__(self, text):
        self.text = text
        kopf, _, self.body = text.partition(CRLF + CRLF)
        zeilen = kopf.split(CRLF)
        self.start = zeilen[0]
        self.kopfzeilen = []
        for zeile in zeilen[1:]:
            if ":" in zeile:
                name, wert = zeile.split(":", 1)
                name = name.strip().lower()
                self.kopfzeilen.append((KURZ.get(name, name), wert.strip()))
        self.anfrage = not self.start.startswith("SIP/2.0")
        teile = self.start.split(" ", 2)
        if self.anfrage:
            self.methode, self.uri = teile[0], teile[1]
            self.code = None
        else:
            self.methode, self.uri = None, None
            self.code = int(teile[1])

    def alle(self, name):
        return [w for n, w in self.kopfzeilen if n == name]

    def kopf(self, name):
        werte = self.alle(name)
        return werte[0] if werte else None

    def cseq(self):
        nummer, methode = (self.kopf("cseq") or "0 X").split()
        return int(nummer), methode

    def call_id(self):
        return self.kopf("call-id")


def uri_aus(kopf):
    """URI aus einem Kopf wie '"Name" <sip:x@y>;tag=1' oder 'sip:x@y'."""
    if kopf is None:
        return None
    m = re.search(r"<([^>]*)>", kopf)
    return m.group(1) if m else kopf.split(";")[0].strip()


def benutzer(uri):
    if not uri:
        return None
    m = re.match(r"sips?:([^@;>]+)@", uri)
    return m.group(1) if m else None


def tag(kopf):
    m = re.search(r";tag=([^;>\s]+)", kopf or "")
    return m.group(1) if m else None


def digest_parameter(kopf):
    return {k.lower(): (v1 if v1 != "" or v2 == "" else v2) for k, v1, v2 in re.findall(r'(\w+)=(?:"([^"]*)"|([^,\s]+))', kopf)}


def digest_antwort(challenge, methode, uri, user, passwort):
    p = digest_parameter(challenge)
    ha1 = md5(f"{user}:{p['realm']}:{passwort}")
    ha2 = md5(f"{methode}:{uri}")
    felder = [f'username="{user}"', f'realm="{p["realm"]}"', f'nonce="{p["nonce"]}"', f'uri="{uri}"', "algorithm=MD5"]
    if "qop" in p:
        cnonce = zufall(16)
        antwort = md5(f"{ha1}:{p['nonce']}:00000001:{cnonce}:auth:{ha2}")
        felder += ["qop=auth", "nc=00000001", f'cnonce="{cnonce}"']
    else:
        antwort = md5(f"{ha1}:{p['nonce']}:{ha2}")
    felder.append(f'response="{antwort}"')
    if "opaque" in p:
        felder.append(f'opaque="{p["opaque"]}"')
    return "Digest " + ", ".join(felder)


def digest_pruefen(kopf, methode, user, passwort):
    p = digest_parameter(kopf[len("Digest "):] if kopf.startswith("Digest ") else kopf)
    if p.get("username") != user or "nonce" not in p:
        return False
    ha1 = md5(f"{user}:{p.get('realm', '')}:{passwort}")
    ha2 = md5(f"{methode}:{p.get('uri', '')}")
    if "qop" in p:
        erwartet = md5(f"{ha1}:{p['nonce']}:{p.get('nc', '')}:{p.get('cnonce', '')}:{p['qop']}:{ha2}")
    else:
        erwartet = md5(f"{ha1}:{p['nonce']}:{ha2}")
    return p.get("response") == erwartet


def md5_challenge(nachricht):
    for wert in nachricht.alle("www-authenticate") + nachricht.alle("proxy-authenticate"):
        if "MD5" in wert.upper() or "algorithm" not in wert.lower():
            return wert
    return None


def sdp(ip, angebot=None):
    """SDP mit G.711 A-law und SRTP (SDES). Als Antwort mit Tag und Suite des Angebots."""
    tag_, suite = "1", "AES_CM_128_HMAC_SHA1_80"
    if angebot:
        m = re.search(r"a=crypto:(\d+) (AES_CM_128_HMAC_SHA1_(?:80|32))", angebot)
        if m:
            tag_, suite = m.group(1), m.group(2)
    schluessel = base64.b64encode(os.urandom(30)).decode()
    return CRLF.join([
        "v=0", f"o=- 1 1 IN IP4 {ip}", "s=-", f"c=IN IP4 {ip}", "t=0 0",
        "m=audio 40000 RTP/SAVP 8 101", "a=rtpmap:8 PCMA/8000", "a=rtpmap:101 telephone-event/8000",
        f"a=crypto:{tag_} {suite} inline:{schluessel}", "a=sendrecv",
    ]) + CRLF


# ---------------------------------------------------------------------------
# Verbindungen
# ---------------------------------------------------------------------------

class Verbindung:
    def __init__(self, sock, gegenstellen):
        self.sock = sock
        self.g = gegenstellen
        self.sperre = threading.Lock()
        self.ip, self.port = sock.getsockname()[:2]
        self.zu = False
        with gegenstellen.sperre:
            gegenstellen.verbindungen.append(self)
        threading.Thread(target=self._lesen, daemon=True).start()

    def schliessen(self):
        self.zu = True
        try:
            self.sock.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        self.sock.close()

    def senden(self, text):
        if self.g.cfg.get("protokoll"):
            print(f"# >> {text.split(CRLF, 1)[0]} | {re.search(r'(?im)^cseq:.*$', text).group(0)}", file=sys.stderr, flush=True)
        with self.sperre:
            self.sock.sendall(text.encode())

    def _lesen(self):
        puffer = b""
        try:
            while True:
                daten = self.sock.recv(65535)
                if not daten:
                    self.zu = True
                    return
                puffer += daten
                while True:
                    puffer = puffer.lstrip(b"\r\n")
                    ende = puffer.find(b"\r\n\r\n")
                    if ende < 0:
                        break
                    kopf = puffer[:ende].decode(errors="replace")
                    m = re.search(r"(?im)^(?:content-length|l)\s*:\s*(\d+)", kopf)
                    laenge = int(m.group(1)) if m else 0
                    if len(puffer) < ende + 4 + laenge:
                        break
                    roh, puffer = puffer[:ende + 4 + laenge], puffer[ende + 4 + laenge:]
                    try:
                        n = Nachricht(roh.decode(errors="replace"))
                        if self.g.cfg.get("protokoll"):
                            print(f"# << {n.start} | CSeq: {n.kopf('cseq')}", file=sys.stderr, flush=True)
                        self.g.empfangen(self, n)
                    except Exception as fehler:  # noqa: BLE001
                        print(f"# Fehler beim Verarbeiten: {type(fehler).__name__}: {fehler}", file=sys.stderr, flush=True)
        except (OSError, ssl.SSLError):
            self.zu = True
            return


class Dialog:
    def __init__(self, rolle, seite, call_id, verbindung, lokal, fern, ziel, via_host):
        self.rolle, self.seite, self.call_id, self.verbindung = rolle, seite, call_id, verbindung
        self.lokal, self.fern, self.ziel, self.via_host = lokal, fern, ziel, via_host
        self.cseq = 100
        self.aufgebaut = None
        self.ende = None
        self.ende_durch = None
        self.bye_verbindung = None
        self.ack_verbindung = None
        self.erstellt = time.time()


class Gegenstellen:
    def __init__(self, cfg):
        self.cfg = cfg
        self.sperre = threading.Lock()
        self.ereignisse = []
        self.warter = {}
        self.dialoge = {}
        # Namen aus SNI je Port, in der Reihenfolge der Verbindungen
        self.sni = {}
        self.registrierung = None
        self.registriert = threading.Event()
        self.verhalten = {"easybell": "annehmen", "elevenlabs": "annehmen"}
        self.verbindungen = []
        # angenommene TCP-Verbindungen (auch ohne fertigen TLS-Aufbau) und Anfragen je Port
        self.versuche = {port: 0 for port in (5061, *(p for p, _ in FOLGE_PORTS))}
        self.anfragen_je_port = dict(self.versuche)
        # gesetzt: ElevenLabs nennt im 200 OK den Contact <host>:<port> statt sip.rtc.elevenlabs.io:5061
        self.folge_ziel = None

    # --- Server ------------------------------------------------------------

    def lauschen(self):
        for port, name in ((5061, "gegenstelle"), *FOLGE_PORTS):
            self._lauschen(port, name)

    def _lauschen(self, port, zertifikat):
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(f"{PKI}/{zertifikat}.pem", f"{PKI}/{zertifikat}.key")

        def sni(_sock, name, _ctx):
            with self.sperre:
                self.sni.setdefault(port, []).append(name or "")

        ctx.sni_callback = sni
        srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        srv.bind(("0.0.0.0", port))
        srv.listen(64)

        def annehmen(roh):
            try:
                Verbindung(ctx.wrap_socket(roh, server_side=True), self)
            except (OSError, ssl.SSLError):
                roh.close()

        def schleife():
            while True:
                roh, _ = srv.accept()
                with self.sperre:
                    self.versuche[port] += 1
                threading.Thread(target=annehmen, args=(roh,), daemon=True).start()

        threading.Thread(target=schleife, daemon=True).start()

    def verbinde_asterisk(self):
        ctx = ssl.create_default_context(cafile=f"{PKI}/ca.pem")
        roh = socket.create_connection((self.cfg["asterisk_host"], self.cfg["port"]), timeout=10)
        tls = ctx.wrap_socket(roh, server_hostname=self.cfg["asterisk_host"])
        tls.settimeout(None)
        return Verbindung(tls, self)

    def notiere(self, **ereignis):
        ereignis["zeit"] = time.time()
        with self.sperre:
            self.ereignisse.append(ereignis)

    def invites(self, rolle, seit, angenommen=True):
        with self.sperre:
            return [e for e in self.ereignisse if e["art"] == ("invite_angenommen" if angenommen else "invite") and e["rolle"] == rolle and e["zeit"] >= seit]

    def antworten(self, verbindung, anfrage, code, grund, extra=(), body="", to_tag=None):
        zeilen = [f"SIP/2.0 {code} {grund}"]
        zeilen += [f"Via: {v}" for v in anfrage.alle("via")]
        zeilen.append(f"From: {anfrage.kopf('from')}")
        to = anfrage.kopf("to")
        if to_tag and ";tag=" not in to:
            to += f";tag={to_tag}"
        zeilen += [f"To: {to}", f"Call-ID: {anfrage.call_id()}", f"CSeq: {anfrage.kopf('cseq')}"]
        zeilen += list(extra)
        if body:
            zeilen.append("Content-Type: application/sdp")
        zeilen.append(f"Content-Length: {len(body.encode())}")
        verbindung.senden(CRLF.join(zeilen) + CRLF + CRLF + body)

    def empfangen(self, verbindung, n):
        if not n.anfrage:
            nummer, methode = n.cseq()
            q = self.warter.get((n.call_id(), nummer, methode))
            if q:
                q.put(n)
            return
        rolle = "easybell" if EASYBELL in n.uri else "elevenlabs" if ELEVENLABS in n.uri else "unbekannt"
        dialog = self.dialoge.get(n.call_id())
        self.notiere(art="anfrage", rolle=rolle, methode=n.methode, call_id=n.call_id())
        with self.sperre:
            if verbindung.port in self.anfragen_je_port:
                self.anfragen_je_port[verbindung.port] += 1
        if n.methode == "REGISTER":
            self.register(verbindung, n)
        elif n.methode == "INVITE" and dialog and dialog.aufgebaut:
            self.antworten(verbindung, n, 200, "OK", [f"Contact: <sip:{dialog.rolle}@{dialog.via_host}:5061;transport=tls>"], sdp(verbindung.ip, n.body))
        elif n.methode == "INVITE":
            self.invite_annehmen(verbindung, n, rolle)
        elif n.methode == "ACK":
            if dialog and dialog.ack_verbindung is None:
                dialog.ack_verbindung = verbindung
        elif n.methode in ("BYE", "CANCEL"):
            self.antworten(verbindung, n, 200, "OK")
            if dialog and dialog.ende is None:
                dialog.ende, dialog.ende_durch = time.time(), "vermittlung"
                dialog.bye_verbindung = verbindung
        elif n.methode in ("OPTIONS", "UPDATE", "INFO", "NOTIFY"):
            self.antworten(verbindung, n, 200, "OK")
        else:
            self.antworten(verbindung, n, 405, "Method Not Allowed")

    def register(self, verbindung, n):
        anmeldung = n.kopf("authorization")
        if not anmeldung:
            self.antworten(verbindung, n, 401, "Unauthorized", [f'WWW-Authenticate: Digest realm="easybell", nonce="{zufall(24)}", algorithm=MD5'], to_tag=zufall())
            return
        if not digest_pruefen(anmeldung, "REGISTER", self.cfg["easybell_user"], self.cfg["easybell_pass"]):
            self.notiere(art="register_falsch", rolle="easybell")
            self.antworten(verbindung, n, 403, "Forbidden", to_tag=zufall())
            return
        kontakt = n.kopf("contact")
        self.antworten(verbindung, n, 200, "OK", [f"Contact: {kontakt};expires=600" if "expires" not in kontakt else f"Contact: {kontakt}", "Expires: 600"], to_tag=zufall())
        self.registrierung = {"kontakt": kontakt, "uri": uri_aus(kontakt), "verbindung": verbindung, "via": n.kopf("via"), "an": n.uri}
        self.registriert.set()

    def invite_annehmen(self, verbindung, n, rolle):
        if rolle == "easybell":
            user, passwort = self.cfg["easybell_user"], self.cfg["easybell_pass"]
        else:
            user, passwort = self.cfg["el_in_user"], self.cfg["el_in_pass"]
        self.notiere(art="invite", rolle=rolle, call_id=n.call_id())
        anmeldung = n.kopf("authorization") or n.kopf("proxy-authorization")
        if not anmeldung:
            self.antworten(verbindung, n, 401, "Unauthorized", [f'WWW-Authenticate: Digest realm="{rolle}", nonce="{zufall(24)}", algorithm=MD5'], to_tag=zufall())
            return
        if not digest_pruefen(anmeldung, "INVITE", user, passwort):
            self.notiere(art="invite_falsche_anmeldung", rolle=rolle, call_id=n.call_id())
            self.antworten(verbindung, n, 403, "Forbidden", to_tag=zufall())
            return
        self.notiere(
            art="invite_angenommen", rolle=rolle, call_id=n.call_id(), text=n.text,
            ruri_user=benutzer(n.uri), from_user=benutzer(uri_aus(n.kopf("from"))), pai=n.kopf("p-asserted-identity"),
            x_caller_id=n.kopf("x-caller-id"), privacy=n.kopf("privacy"),
        )
        verhalten = self.verhalten[rolle]
        if verhalten == "umleiten":
            self.antworten(verbindung, n, 302, "Moved Temporarily", [f"Contact: <sip:{self.cfg['verboten']}@{EASYBELL}>"], to_tag=zufall())
            return
        eigen = zufall()
        self.antworten(verbindung, n, 100, "Trying")
        d = Dialog(rolle, "uas", n.call_id(), verbindung, f"{n.kopf('to')};tag={eigen}", n.kopf("from"), uri_aus(n.kopf("contact")), EASYBELL if rolle == "easybell" else ELEVENLABS)
        d.angebot = n.body
        self.dialoge[n.call_id()] = d
        kontakt = f"{d.via_host}:5061"
        if rolle == "elevenlabs" and self.folge_ziel:
            kontakt = "%s:%d" % self.folge_ziel
        self.antworten(verbindung, n, 200, "OK", [f"Contact: <sip:{rolle}@{kontakt};transport=tls>"], sdp(verbindung.ip, n.body), to_tag=eigen)
        d.aufgebaut = time.time()

    # --- Client ------------------------------------------------------------

    def anfrage(self, d, methode, extra=(), body="", cseq=None, branch=None, uri=None):
        if cseq is None:
            d.cseq += 1
            cseq = d.cseq
        zeilen = [
            f"{methode} {uri or d.ziel} SIP/2.0",
            f"Via: SIP/2.0/TLS {d.via_host}:5061;branch={branch or 'z9hG4bK' + zufall(16)};rport",
            "Max-Forwards: 70", f"From: {d.lokal}", f"To: {d.fern}", f"Call-ID: {d.call_id}", f"CSeq: {cseq} {methode}",
        ]
        zeilen += list(extra)
        if body:
            zeilen.append("Content-Type: application/sdp")
        zeilen.append(f"Content-Length: {len(body.encode())}")
        q = queue.Queue()
        if methode != "ACK":
            self.warter[(d.call_id, cseq, methode)] = q
        d.verbindung.senden(CRLF.join(zeilen) + CRLF + CRLF + body)
        return q

    def endgueltig(self, q, frist=40):
        ende = time.time() + frist
        while time.time() < ende:
            try:
                n = q.get(timeout=max(0.1, ende - time.time()))
            except queue.Empty:
                return None
            if n.code >= 200:
                return n
        return None

    def anrufen(self, verbindung, rolle, ruri, von, an, extra=(), anmeldung=None):
        """INVITE mit Digest bei Bedarf. Ergebnis: Dialog (aufgebaut oder nicht), erste und letzte Antwort."""
        via_host = EASYBELL if rolle == "easybell" else ELEVENLABS
        d = Dialog(rolle, "uac", zufall(24) + "@pruefung", verbindung, f"{von};tag={zufall()}", an, ruri, via_host)
        self.dialoge[d.call_id] = d
        kontakt = f"Contact: <sip:{rolle}@{via_host}:5061;transport=tls>"
        body = sdp(verbindung.ip)
        branch = "z9hG4bK" + zufall(16)
        antwort = self.endgueltig(self.anfrage(d, "INVITE", [kontakt, *extra], body, branch=branch))
        erste = antwort.code if antwort else None
        if antwort and antwort.code in (401, 407) and anmeldung:
            fern = d.fern
            d.fern = antwort.kopf("to")
            self.anfrage(d, "ACK", cseq=d.cseq, branch=branch)
            d.fern = fern
            challenge = md5_challenge(antwort)
            kopf = "Authorization" if antwort.code == 401 else "Proxy-Authorization"
            branch = "z9hG4bK" + zufall(16)
            antwort = self.endgueltig(self.anfrage(d, "INVITE", [kontakt, f"{kopf}: {digest_antwort(challenge, 'INVITE', ruri, *anmeldung)}", *extra], body, branch=branch))
        letzte = antwort.code if antwort else None
        if antwort and 200 <= antwort.code < 300:
            d.fern = antwort.kopf("to")
            d.ziel = uri_aus(antwort.kopf("contact")) or d.ziel
            self.anfrage(d, "ACK", cseq=d.cseq)
            d.aufgebaut = time.time()
        elif antwort:
            fern = d.fern
            d.fern = antwort.kopf("to")
            self.anfrage(d, "ACK", cseq=d.cseq, branch=branch)
            d.fern = fern
        return d, erste, letzte

    def auflegen(self, d):
        if d.aufgebaut is None or d.ende is not None:
            return None
        antwort = self.endgueltig(self.anfrage(d, "BYE"), 10)
        d.ende, d.ende_durch = time.time(), "pruefung"
        return antwort.code if antwort else None

    def dialog_seit(self, rolle, seit):
        """Der zuletzt angenommene Dialog einer Gegenstelle seit einem Zeitpunkt (Gegenseite eines Anrufs)."""
        passend = [d for d in list(self.dialoge.values()) if d.rolle == rolle and d.seite == "uas" and d.erstellt >= seit]
        return passend[-1] if passend else None

    def warte_ende(self, dialoge, frist):
        ende = time.time() + frist
        while time.time() < ende and any(d is not None and d.ende is None for d in dialoge):
            time.sleep(0.2)


# ---------------------------------------------------------------------------
# Anrufe aus Sicht der Gegenstellen
# ---------------------------------------------------------------------------

def eingehend(g, anrufer=None, pai=None, privacy=None, ruri=None, verbindung=None):
    """easybell ruft über die Registrierung bei der Vermittlung an."""
    cfg = g.cfg
    reg = g.registrierung
    von = f"<sip:{anrufer}@{EASYBELL}>" if anrufer else "<sip:anonymous@anonymous.invalid>"
    extra = []
    if pai:
        extra.append(f"P-Asserted-Identity: <sip:{pai}@{EASYBELL}>")
    if privacy:
        extra.append(f"Privacy: {privacy}")
    return g.anrufen(verbindung or reg["verbindung"], "easybell", ruri or reg["uri"], von, f"<sip:{cfg['easybell_nummer']}@{EASYBELL}>", extra)


def ausgehend(g, ziel, anmeldung="richtig", von=None, verbindung=None):
    """ElevenLabs ruft für /anruf bei der Vermittlung an."""
    cfg = g.cfg
    host = cfg["asterisk_host"]
    if anmeldung == "richtig":
        anmeldung = (cfg["el_out_user"], cfg["el_out_pass"])
    return g.anrufen(verbindung or g.verbinde_asterisk(), "elevenlabs", f"sip:{ziel}@{host}:5061;transport=tls",
                     f"<sip:{von or cfg['easybell_nummer']}@{ELEVENLABS}>", f"<sip:{ziel}@{host}>", anmeldung=anmeldung)


def leg_daten(e):
    if not e:
        return {}
    return {"ruri_user": e["ruri_user"], "from_user": e["from_user"], "pai": e["pai"], "x_caller_id": e["x_caller_id"], "privacy": e["privacy"]}


def probe_eingehend(g, name, anrufer, pai=None, privacy=None, auflegen=True):
    t0 = time.time()
    d, _, status = eingehend(g, anrufer, pai, privacy)
    time.sleep(0.3)
    el = g.invites("elevenlabs", t0)
    gegen = g.dialog_seit("elevenlabs", t0)
    ziffern = re.sub(r"\D", "", pai or anrufer or "")
    ergebnis = {"probe": name, "status": status, "elevenlabs_invites": len(el), **leg_daten(el[-1] if el else None)}
    ergebnis["nummer_bei_elevenlabs"] = bool(ziffern) and any(ziffern[-9:] in e["text"] for e in el)
    if auflegen and d.aufgebaut:
        ergebnis["bye"] = g.auflegen(d)
        g.warte_ende([gegen], 5)
        ergebnis["gegenseite_beendet"] = gegen is not None and gegen.ende is not None
    return ergebnis, d, gegen


def probe_ausgehend(g, name, ziel, auflegen=True, anmeldung="richtig", von=None):
    t0 = time.time()
    d, erste, status = ausgehend(g, ziel, anmeldung, von)
    time.sleep(0.3)
    eb = g.invites("easybell", t0)
    gegen = g.dialog_seit("easybell", t0)
    ergebnis = {"probe": name, "erste": erste, "nach_anmeldung": status, "status": status, "easybell_invites": len(eb), **leg_daten(eb[-1] if eb else None)}
    if auflegen and d.aufgebaut:
        ergebnis["bye"] = g.auflegen(d)
        g.warte_ende([gegen], 5)
        ergebnis["gegenseite_beendet"] = gegen is not None and gegen.ende is not None
    return ergebnis, d, gegen


def refer(g, d, ziel):
    """REFER im laufenden Gespräch; Antwortcode oder None, wenn innerhalb von 5 s keine Antwort kommt."""
    antwort = g.endgueltig(g.anfrage(d, "REFER", [f"Refer-To: <sip:{ziel}@{EASYBELL}>", f"Referred-By: <{uri_aus(d.lokal)}>", f"Contact: <sip:{d.rolle}@{d.via_host}:5061;transport=tls>"]), 5)
    return antwort.code if antwort else None


def parallel(aufgaben):
    """Startet alle Anrufe zugleich (Schranke) und liefert die Dialoge mit Status."""
    schranke = threading.Barrier(len(aufgaben))
    ergebnisse = [None] * len(aufgaben)

    def lauf(i, aufgabe):
        schranke.wait()
        ergebnisse[i] = aufgabe()

    faeden = [threading.Thread(target=lauf, args=(i, a)) for i, a in enumerate(aufgaben)]
    for f in faeden:
        f.start()
    for f in faeden:
        f.join(60)
    return ergebnisse


# ---------------------------------------------------------------------------
# Phasen
# ---------------------------------------------------------------------------

def warte_registrierung(g):
    ok = g.registriert.wait(90)
    reg = g.registrierung or {}
    kontakt = reg.get("kontakt") or ""
    return {
        "probe": "registrierung", "registriert": ok, "kontakt": kontakt,
        "kontakt_tls": "transport=tls" in kontakt.lower(), "kontakt_line": ";line=" in kontakt,
        "via_tls": "SIP/2.0/TLS" in (reg.get("via") or ""), "register_an": reg.get("an"),
    }


def anmeldeproben(g):
    cfg = g.cfg
    erlaubt, verboten = cfg["erlaubt"], cfg["verboten"]
    user, pw = cfg["el_out_user"], cfg["el_out_pass"]
    proben = []
    t0 = time.time()
    _, erste, letzte = ausgehend(g, erlaubt, anmeldung=None, von="easybell")
    proben.append({"probe": "ohne_anmeldung_als_easybell", "erste": erste, "status": letzte})
    _, erste, letzte = ausgehend(g, erlaubt, anmeldung=None, von="elevenlabs")
    proben.append({"probe": "ohne_anmeldung_als_elevenlabs", "erste": erste, "status": letzte})
    for name, anmeldung, ziel in (
        ("falsches_passwort", (user, pw + "x"), erlaubt),
        ("unbekannter_benutzer", ("fremd", pw), erlaubt),
        ("verbotenes_ziel", (user, pw), verboten),
        ("buchstaben_als_ziel", (user, pw), "abc"),
    ):
        _, erste, letzte = ausgehend(g, ziel, anmeldung=anmeldung)
        proben.append({"probe": name, "erste": erste, "nach_anmeldung": letzte, "status": letzte})
    proben[-2]["easybell_invites"] = len(g.invites("easybell", t0, angenommen=False))
    # Eingehend ohne die Kennung line= der Registrierung: kein easybell-Weg
    reg_uri = g.registrierung["uri"]
    ohne_line = re.sub(r";line=[^;>]*", "", reg_uri)
    t1 = time.time()
    _, erste, letzte = eingehend(g, cfg["anrufer"], ruri=ohne_line, verbindung=g.verbinde_asterisk())
    proben.append({"probe": "eingehend_ohne_line", "erste": erste, "status": letzte, "elevenlabs_invites": len(g.invites("elevenlabs", t1, angenommen=False))})
    _, erste, letzte = eingehend(g, cfg["anrufer"], ruri=re.sub(r";line=[^;>]*", ";line=falsch", reg_uri), verbindung=g.verbinde_asterisk())
    proben.append({"probe": "eingehend_falsche_line", "erste": erste, "status": letzte, "elevenlabs_invites": len(g.invites("elevenlabs", t1, angenommen=False))})
    return proben


def phase_a(g):
    cfg = g.cfg
    erlaubt, verboten, anrufer = cfg["erlaubt"], cfg["verboten"], cfg["anrufer"]
    nur = cfg.get("nur") or ["anmeldung", "gespraeche", "folgeverbindung", "unterdrueckt", "gleichzeitig", "weiterleitung", "refer", "hoechstdauer"]
    ausgabe(warte_registrierung(g))
    if not g.registriert.is_set():
        return
    if "anmeldung" in nur:
        for probe in anmeldeproben(g):
            ausgabe(probe)
    if "gespraeche" in nur:
        gespraeche(g, erlaubt, anrufer)
    if "folgeverbindung" in nur:
        folgeverbindung(g, anrufer)
    if "unterdrueckt" in nur:
        ausgabe(probe_eingehend(g, "unterdrueckt_privacy_id", None, pai=anrufer, privacy="id")[0])
        ausgabe(probe_eingehend(g, "unterdrueckt_anonym", None)[0])
    if "gleichzeitig" in nur:
        gleichzeitig(g, erlaubt, anrufer)
    if "weiterleitung" in nur:
        weiterleitung(g, erlaubt, anrufer)
    if "refer" in nur:
        refer_proben(g, erlaubt, verboten, anrufer)
    if "hoechstdauer" in nur:
        hoechstdauer(g, erlaubt, anrufer)


def gespraeche(g, erlaubt, anrufer):
    """Erfolgreiche Gespräche in beiden Richtungen."""
    ausgabe(probe_eingehend(g, "eingehend", anrufer, pai=anrufer)[0])
    ausgabe(probe_eingehend(g, "eingehend_national", "0" + anrufer[3:])[0])
    ausgabe(probe_ausgehend(g, "ausgehend", erlaubt)[0])
    ausgabe(probe_ausgehend(g, "ausgehend_national", "0" + erlaubt[3:])[0])


def folgeverbindung(g, anrufer):
    """ACK und BYE an ElevenLabs über neue TLS-Verbindungen (Follow-up connections).

    ElevenLabs nennt im 200 OK den Contact <ip>.hosts.rtc.elevenlabs.io. Das
    ACK geht schon über eine neue Verbindung an diesen Contact. Danach schließt
    die Attrappe alle Verbindungen dieses Gesprächs, dann legt easybell auf:
    Asterisk muss das BYE über eine weitere neue Verbindung an den Contact
    schicken. Bei jeder Verbindung hält die Attrappe den Namen aus SNI fest.

    Zertifikate am Contact: *.hosts.rtc.elevenlabs.io (wie bei ElevenLabs
    beschrieben, muss klappen), ein anderer Wildcard-Name und
    sip.rtc.elevenlabs.io, der Name der ersten Verbindung (beide müssen
    scheitern, ohne dass eine Anfrage über die Verbindung geht). Gegenprobe:
    ein Contact als IP-Adresse; dann gilt weiter der Name der ersten
    Verbindung, das Zertifikat für sip.rtc.elevenlabs.io passt.
    """
    host, ip = g.cfg["folge_host"], g.cfg["folge_ip"]
    for name, ziel_host, port in (
        ("folgeverbindung_wildcard", host, WILDCARD_PORT),
        ("folgeverbindung_falscher_name", host, FALSCH_PORT),
        ("folgeverbindung_erster_name", host, ERSTER_NAME_PORT),
        ("folgeverbindung_ip_adresse", ip, ERSTER_NAME_PORT),
    ):
        versuche0, anfragen0 = g.versuche[port], g.anfragen_je_port[port]
        with g.sperre:
            sni0 = len(g.sni.get(port, []))
        g.folge_ziel = (ziel_host, port)
        _, d, gegen = probe_eingehend(g, "x", anrufer, auflegen=False)
        g.folge_ziel = None
        time.sleep(1)  # ACK geht an den Contact
        ack = gegen.ack_verbindung if gegen else None
        with g.sperre:
            alte = [v for v in g.verbindungen if v.port == port or (gegen is not None and v is gegen.verbindung)]
        for v in alte:
            v.schliessen()
        time.sleep(0.5)
        bye = g.auflegen(d)
        g.warte_ende([gegen], 8)
        neu = gegen.bye_verbindung if gegen else None
        with g.sperre:
            sni = g.sni.get(port, [])[sni0:]
        ausgabe({
            "probe": name, "aufgebaut": d.aufgebaut is not None and gegen is not None,
            "ack_ueber_folgeverbindung": ack is not None and ack.port == port and ack is not gegen.verbindung,
            "alte_verbindungen_zu": gegen is not None and gegen.verbindung in alte and all(v.zu for v in alte),
            "bye": bye, "bye_angekommen": gegen is not None and gegen.ende is not None,
            "bye_ueber_neue_verbindung": neu is not None and neu not in alte and neu.port == port,
            "verbindungsversuche": g.versuche[port] - versuche0, "anfragen": g.anfragen_je_port[port] - anfragen0,
            "sni": sorted(set(sni)),
        })
        time.sleep(0.5)


def gleichzeitig(g, erlaubt, anrufer):
    """Dritter gleichzeitiger Anruf, auch bei Starts im selben Augenblick."""
    _, a1, _ = probe_eingehend(g, "x", anrufer, auflegen=False)
    _, a2, _ = probe_ausgehend(g, "x", erlaubt, auflegen=False)
    t1 = time.time()
    _, _, dritter_ein = eingehend(g, anrufer)
    _, _, dritter_aus = ausgehend(g, erlaubt)
    time.sleep(0.5)
    ausgabe({
        "probe": "dritter_anruf", "erste_beiden": [a1.aufgebaut is not None, a2.aufgebaut is not None],
        "dritter_eingehend": dritter_ein, "dritter_ausgehend": dritter_aus,
        "neue_invites": len(g.invites("elevenlabs", t1)) + len(g.invites("easybell", t1)),
    })
    for d in (a1, a2):
        g.auflegen(d)
    time.sleep(1)

    # Parallelstarts: drei Anrufe im selben Augenblick
    for name, aufgaben in (
        ("parallelstart_gemischt", [lambda: eingehend(g, anrufer), lambda: eingehend(g, anrufer), lambda: ausgehend(g, erlaubt)]),
        ("parallelstart_ausgehend", [lambda: ausgehend(g, erlaubt)] * 3),
        ("parallelstart_eingehend", [lambda: eingehend(g, anrufer)] * 3),
    ):
        laeufe = parallel(aufgaben)
        aufgebaut = [r[0] for r in laeufe if r and r[0].aufgebaut is not None]
        ausgabe({"probe": name, "aufgebaut": len(aufgebaut), "codes": [r[2] if r else None for r in laeufe]})
        for d in aufgebaut:
            g.auflegen(d)
        time.sleep(1)
    ergebnis, _, _ = probe_ausgehend(g, "frei_nach_parallelstart", erlaubt)
    ausgabe(ergebnis)


def weiterleitung(g, erlaubt, anrufer):
    """Umleitung per 302 von einer Gegenstelle an ein Ziel außerhalb der Positivliste."""
    t0 = time.time()
    g.verhalten["elevenlabs"] = "umleiten"
    ergebnis, _, _ = probe_eingehend(g, "weiterleitung_eingehend", anrufer)
    ergebnis["easybell_ziele"] = [e["ruri_user"] for e in g.invites("easybell", t0)]
    ausgabe(ergebnis)
    g.verhalten["elevenlabs"] = "annehmen"
    t0 = time.time()
    g.verhalten["easybell"] = "umleiten"
    ergebnis, _, _ = probe_ausgehend(g, "weiterleitung_ausgehend", erlaubt)
    ergebnis["easybell_ziele"] = [e["ruri_user"] for e in g.invites("easybell", t0)]
    ergebnis["elevenlabs_invites"] = len(g.invites("elevenlabs", t0, angenommen=False))
    ausgabe(ergebnis)
    g.verhalten["easybell"] = "annehmen"


def refer_proben(g, erlaubt, verboten, anrufer):
    """REFER aus beiden Richtungen, im laufenden Gespräch."""
    for name, start, seite in (
        ("refer_von_elevenlabs_eingehend", lambda: probe_eingehend(g, "x", anrufer, auflegen=False), "gegen"),
        ("refer_von_easybell_eingehend", lambda: probe_eingehend(g, "x", anrufer, auflegen=False), "eigen"),
        ("refer_von_elevenlabs_ausgehend", lambda: probe_ausgehend(g, "x", erlaubt, auflegen=False), "eigen"),
        ("refer_von_easybell_ausgehend", lambda: probe_ausgehend(g, "x", erlaubt, auflegen=False), "gegen"),
    ):
        _, d, gegen = start()
        t0 = time.time()
        sender = gegen if seite == "gegen" else d
        code = refer(g, sender, verboten) if sender and sender.aufgebaut else None
        time.sleep(1)
        neue = len(g.invites("easybell", t0, angenommen=False)) + len(g.invites("elevenlabs", t0, angenommen=False))
        ausgabe({"probe": name, "aufgebaut": d.aufgebaut is not None, "refer": code, "neue_invites": neue, "bye": g.auflegen(d)})
        time.sleep(0.5)


def hoechstdauer(g, erlaubt, anrufer):
    """Höchstdauer in beiden Richtungen: niemand legt auf."""
    cfg = g.cfg
    _, ein, ein_gegen = probe_eingehend(g, "x", anrufer, auflegen=False)
    _, aus, aus_gegen = probe_ausgehend(g, "x", erlaubt, auflegen=False)
    legs = {"eingehend_easybell": ein, "eingehend_elevenlabs": ein_gegen, "ausgehend_elevenlabs": aus, "ausgehend_easybell": aus_gegen}
    g.warte_ende(list(legs.values()), cfg["max_sekunden"] + 40)
    ausgabe({
        "probe": "hoechstdauer", "grenze": cfg["max_sekunden"],
        **{k: (round(d.ende - d.aufgebaut, 1) if d and d.aufgebaut and d.ende else None) for k, d in legs.items()},
        "beendet_durch": sorted({d.ende_durch for d in legs.values() if d and d.ende_durch}),
    })


def phase_b(g):
    anrufer = g.cfg["anrufer"]
    ausgabe(warte_registrierung(g))
    if not g.registriert.is_set():
        return
    ausgabe(probe_eingehend(g, "annehmen_unterdrueckt_privacy_id", None, pai=anrufer, privacy="id")[0])
    ausgabe(probe_eingehend(g, "annehmen_unterdrueckt_anonym", None)[0])
    ausgabe(probe_eingehend(g, "annehmen_sichtbar", anrufer, pai=anrufer)[0])


def angriff(g):
    """Fehlgeschlagene Anmeldungen mit Rufnummern als From und Benutzername, dann warten, bis die Adresse gesperrt ist."""
    cfg = g.cfg
    nummer = cfg["angreifer_nummer"]
    eigene_ip = None
    codes = []
    for _ in range(cfg.get("versuche", 6)):
        try:
            v = g.verbinde_asterisk()
        except OSError:
            break  # schon gesperrt
        eigene_ip = v.ip
        _, erste, letzte = ausgehend(g, nummer, anmeldung=(nummer, "falsches-passwort-123"), von=nummer, verbindung=v)
        codes.append(letzte)
    start = time.time()
    gesperrt = False
    while time.time() - start < 90:
        try:
            roh = socket.create_connection((cfg["asterisk_host"], cfg["port"]), timeout=3)
            roh.close()
        except OSError:
            gesperrt = True
            break
        time.sleep(2)
    ausgabe({"probe": "angriff", "ip": eigene_ip, "codes": codes, "gesperrt": gesperrt, "sekunden": round(time.time() - start, 1)})


def ports():
    """Offene Ports im Namensraum (aus /proc/net), ohne Werkzeuge im Image."""
    gefunden = {"tcp": [], "udp": []}
    for proto, dateien in (("tcp", ["/proc/net/tcp", "/proc/net/tcp6"]), ("udp", ["/proc/net/udp", "/proc/net/udp6"])):
        for pfad in dateien:
            if not os.path.exists(pfad):
                continue
            with open(pfad) as fh:
                next(fh)
                for zeile in fh:
                    spalten = zeile.split()
                    adresse, port = spalten[1].split(":")
                    port = int(port, 16)
                    if adresse == "0B00007F":  # 127.0.0.11: DNS von Docker in eigenen Netzen
                        continue
                    if proto == "tcp" and spalten[3] != "0A":  # nur LISTEN
                        continue
                    if port not in gefunden[proto]:
                        gefunden[proto].append(port)
    ausgabe({"probe": "ports", "status": None, **{k: sorted(v) for k, v in gefunden.items()}})


def main():
    modus = sys.argv[1]
    if modus == "ports":
        ports()
        return
    g = Gegenstellen(json.loads(sys.argv[2]))
    if modus in ("phase-a", "phase-b"):
        g.lauschen()
        (phase_a if modus == "phase-a" else phase_b)(g)
    elif modus == "angriff":
        angriff(g)
    ausgabe({"probe": "fertig"})


if __name__ == "__main__":
    main()
