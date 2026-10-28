"""
Startpunkt für Pocket TTS im Bot (Issue #252, Nachbesserung aus dem Review).

`pocket-tts serve` nähme auf seinem Port jede Anfrage an: ohne Anmeldung,
ohne Prüfung von Host und Origin (fremde Webseiten, DNS-Rebinding), mit
beliebigem voice_url (https://, hf://, Uploads). Dieses Skript lädt Modell und
Stimme wie `serve` in Version 3.3.0 (pocket_tts/main.py), stellt aber einen
Wächter vor die App:

- Host muss genau 127.0.0.1:<port> sein, ein Origin- oder Sec-Fetch-Kopf
  (Browser) wird abgewiesen.
- Jede Anfrage braucht `Authorization: Bearer <Token>`; das Token kommt je
  Start aus der Umgebung (TYBO_POCKET_TOKEN) und wird dort sofort entfernt.
- Nur GET /health und POST /tts. /tts nur als
  application/x-www-form-urlencoded mit genau einem Feld text (nicht leer,
  höchstens MAX_TEXT_CHARS Zeichen); voice_url, voice_wav und alles andere
  wird abgewiesen. Die Stimme ist die beim Start gewählte aus ALLOWED_VOICES.
- Zusätzlich lehnt das Modell nach dem Laden der Stimme jede weitere
  Stimmenauflösung ab (keine Downloads über requests.get, auch wenn der
  Wächter umgangen würde).

Eigene Stimme (Issue #253): statt --voice gibt es --clone-dir und
--clone-id. Die Kennung muss genau 16 Hex-Zeichen sein; der Pfad
<clone-dir>/<id>/reference.wav entsteht hier, muss eine echte Datei (kein
Symlink) innerhalb des Ordners sein und höchstens MAX_REFERENCE_BYTES groß.
Ohne geladene Klon-Gewichte (has_voice_cloning) endet der Start mit Exit-Code
3, statt still die Variante ohne Klonen zu nehmen. Danach gilt dieselbe Sperre:
keine weitere Stimme.

Nur Standardbibliothek bis main(): der Wächter ist ohne pocket-tts prüfbar
(scripts/pocket-guard-check.ts, von Hand gestartet).
"""

import argparse
import hmac
import os
import re
import stat
import sys
from urllib.parse import parse_qsl

# Positivliste wie POCKET_VOICES in pocket.ts (Test prüft den Gleichstand)
ALLOWED_VOICES = frozenset({"juergen"})
# Telegram bis 4.500 Zeichen, mit Luft
MAX_TEXT_CHARS = 6000
MAX_BODY_BYTES = 64 * 1024
TOKEN_ENV = "TYBO_POCKET_TOKEN"
MIN_TOKEN_CHARS = 32
ROUTES = {("GET", "/health"), ("POST", "/tts")}
# Eigene Stimmen (Issue #253): Kennung wie VOICE_ID_PATTERN in voices.ts
CLONE_ID = re.compile(r"^[a-f0-9]{16}$")
MAX_REFERENCE_BYTES = 3 * 1024 * 1024
EXIT_NO_CLONING = 3


def clone_reference(clone_dir, clone_id):
    """Pfad der Referenz einer geprüften Kennung; None, wenn etwas nicht passt"""
    if not CLONE_ID.match(clone_id or "") or not clone_dir or not os.path.isabs(clone_dir):
        return None
    base = os.path.realpath(clone_dir)
    path = os.path.join(base, clone_id, "reference.wav")
    try:
        info = os.lstat(path)
    except OSError:
        return None
    if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_REFERENCE_BYTES:
        return None
    if os.path.dirname(os.path.dirname(os.path.realpath(path))) != base:
        return None
    return path


async def _reply(send, status, text):
    body = text.encode("utf-8")
    await send(
        {
            "type": "http.response.start",
            "status": status,
            "headers": [(b"content-type", b"text/plain; charset=utf-8"), (b"content-length", str(len(body)).encode())],
        }
    )
    await send({"type": "http.response.body", "body": body})


class Guard:
    """ASGI-Wächter vor der App von pocket-tts"""

    def __init__(self, app, token, port):
        if len(token) < MIN_TOKEN_CHARS:
            raise ValueError("Token zu kurz")
        self.app = app
        self.expected_auth = ("Bearer " + token).encode("latin-1")
        self.expected_host = ("127.0.0.1:%d" % port).encode("latin-1")

    async def __call__(self, scope, receive, send):
        kind = scope.get("type")
        if kind == "lifespan":
            return await self.app(scope, receive, send)
        if kind != "http":
            if kind == "websocket":
                await send({"type": "websocket.close", "code": 1008})
            return

        headers = {}
        for name, value in scope.get("headers", []):
            headers.setdefault(name.lower(), []).append(value)

        def one(name):
            values = headers.get(name, [])
            return values[0] if len(values) == 1 else None

        if one(b"host") != self.expected_host:
            return await _reply(send, 421, "falscher Host")
        if b"origin" in headers or any(n.startswith(b"sec-fetch-") for n in headers):
            return await _reply(send, 403, "keine Anfragen aus dem Browser")
        auth = one(b"authorization")
        if auth is None or not hmac.compare_digest(auth, self.expected_auth):
            return await _reply(send, 401, "nicht berechtigt")
        if (scope.get("method"), scope.get("path")) not in ROUTES or scope.get("query_string"):
            return await _reply(send, 404, "nicht gefunden")
        if scope["method"] == "GET":
            return await self.app(scope, receive, send)

        ctype = (one(b"content-type") or b"").split(b";")[0].strip().lower()
        if ctype != b"application/x-www-form-urlencoded":
            return await _reply(send, 415, "nur Formular ohne Dateien")
        body = b""
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                return
            body += message.get("body", b"")
            if len(body) > MAX_BODY_BYTES:
                return await _reply(send, 413, "zu groß")
            if not message.get("more_body"):
                break
        try:
            fields = parse_qsl(body.decode("utf-8"), keep_blank_values=True, strict_parsing=True)
        except (UnicodeDecodeError, ValueError):
            return await _reply(send, 400, "Formular unlesbar")
        if len(fields) != 1 or fields[0][0] != "text":
            return await _reply(send, 400, "nur das Feld text, keine Stimme je Anfrage")
        text = fields[0][1]
        if not text.strip() or len(text) > MAX_TEXT_CHARS:
            return await _reply(send, 400, "Text leer oder zu lang")

        sent = False

        async def replay():
            nonlocal sent
            if sent:
                return await receive()
            sent = True
            return {"type": "http.request", "body": body, "more_body": False}

        return await self.app(scope, replay, send)


def _refuse_voice(*_args, **_kwargs):
    raise RuntimeError("Stimmen nur aus der Positivliste, beim Start geladen")


def main(argv):
    parser = argparse.ArgumentParser(prog="pocket_guard")
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--language", required=True)
    parser.add_argument("--voice")
    parser.add_argument("--clone-dir")
    parser.add_argument("--clone-id")
    args = parser.parse_args(argv)
    reference = None
    if args.clone_id is not None or args.clone_dir is not None:
        if args.voice is not None:
            print("Entweder Katalogstimme oder eigene Stimme", file=sys.stderr)
            return 2
        reference = clone_reference(args.clone_dir, args.clone_id)
        if reference is None:
            print("Eigene Stimme nicht gefunden oder nicht erlaubt", file=sys.stderr)
            return 2
    elif args.voice not in ALLOWED_VOICES:
        print("Stimme nicht freigegeben", file=sys.stderr)
        return 2
    token = os.environ.pop(TOKEN_ENV, "")
    if len(token) < MIN_TOKEN_CHARS:
        print("Token fehlt", file=sys.stderr)
        return 2

    import uvicorn
    from pocket_tts import main as pocket_main
    from pocket_tts.models.tts_model import TTSModel

    model = TTSModel.load_model(language=args.language)
    if reference is not None and not getattr(model, "has_voice_cloning", False):
        # Klon-Gewichte fehlen: nicht still die Variante ohne Klonen nehmen
        print("Klon-Gewichte nicht geladen", file=sys.stderr)
        return EXIT_NO_CLONING
    pocket_main.tts_model = model
    if reference is not None:
        from pathlib import Path

        pocket_main.default_voice_state = model.get_state_for_audio_prompt(Path(reference))
    else:
        pocket_main.default_voice_state = model.get_state_for_audio_prompt(args.voice)
    # Ab hier keine weitere Stimme: kein Download, keine Datei, kein Upload
    model.get_state_for_audio_prompt = _refuse_voice
    model._cached_get_state_for_audio_prompt = _refuse_voice

    uvicorn.run(
        Guard(pocket_main.web_app, token, args.port),
        host="127.0.0.1",
        port=args.port,
        proxy_headers=False,
        server_header=False,
        access_log=False,
        log_level="warning",
    )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
