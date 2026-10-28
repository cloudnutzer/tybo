"""
Prüfstand für src/lib/speech/pocket_guard.py (Issue #252), aufgerufen aus
scripts/pocket-guard-check.ts (von Hand, nicht in bun run check). Nur
Standardbibliothek: pocket-tts und uvicorn sind Attrappen in sys.modules, die
innere App zeichnet auf, was durchkommt, und löst wie pocket-tts 3.3.0
voice_url über das Modell auf.

Eingabe (stdin): {"guard": Pfad, "requests": [...]}. Ausgabe (stdout): JSON.
"""

import asyncio
import importlib.util
import json
import os
import sys
import types

spec_in = json.load(sys.stdin)
spec = importlib.util.spec_from_file_location("pocket_guard", spec_in["guard"])
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)

TOKEN = "t" * 64
PORT = 41000

# ---------------------------------------------------------------------------
# Attrappen für pocket-tts und uvicorn
# ---------------------------------------------------------------------------

resolved = []  # Stimmen, die das Modell auflösen sollte (Downloads im echten Paket)


class FakeModel:
    # Issue #253: wie pocket-tts 3.3.0 nach dem Laden (False ohne Klon-Gewichte)
    cloning = True

    @classmethod
    def load_model(cls, language=None, **_kwargs):
        m = cls()
        m.language = language
        m.has_voice_cloning = cls.cloning
        return m

    def get_state_for_audio_prompt(self, voice, truncate=False):
        resolved.append(voice)
        return {"voice": voice}

    def _cached_get_state_for_audio_prompt(self, voice, truncate=False):
        return self.get_state_for_audio_prompt(voice, truncate)


inner_calls = []


async def inner_app(scope, receive, send):
    """Wie pocket_tts.main.web_app: liest das Formular, löst voice_url über das Modell auf"""
    if scope["type"] == "lifespan":
        return
    body = b""
    while True:
        m = await receive()
        body += m.get("body", b"")
        if not m.get("more_body"):
            break
    inner_calls.append({"method": scope["method"], "path": scope["path"], "body": body.decode()})
    from urllib.parse import parse_qs

    voice_url = parse_qs(body.decode()).get("voice_url", [None])[0]
    status = 200
    if voice_url is not None:
        try:
            pocket_main.tts_model._cached_get_state_for_audio_prompt(voice_url)
        except RuntimeError:
            status = 500
    await send({"type": "http.response.start", "status": status, "headers": []})
    await send({"type": "http.response.body", "body": b"RIFF"})


pocket_pkg = types.ModuleType("pocket_tts")
pocket_main = types.ModuleType("pocket_tts.main")
pocket_main.web_app = inner_app
pocket_main.tts_model = None
pocket_main.default_voice_state = None
models_pkg = types.ModuleType("pocket_tts.models")
tts_model_mod = types.ModuleType("pocket_tts.models.tts_model")
tts_model_mod.TTSModel = FakeModel
pocket_pkg.main = pocket_main
sys.modules.update(
    {
        "pocket_tts": pocket_pkg,
        "pocket_tts.main": pocket_main,
        "pocket_tts.models": models_pkg,
        "pocket_tts.models.tts_model": tts_model_mod,
    }
)
uvicorn_runs = []
uvicorn_mod = types.ModuleType("uvicorn")
uvicorn_mod.run = lambda app, **kw: uvicorn_runs.append((app, kw))
sys.modules["uvicorn"] = uvicorn_mod

# ---------------------------------------------------------------------------
# Start über main(): Stimme, Token, Bindung
# ---------------------------------------------------------------------------

out = {"main": {}}
os.environ.pop(guard.TOKEN_ENV, None)
out["main"]["noToken"] = guard.main(["--port", str(PORT), "--language", "german", "--voice", "juergen"])
os.environ[guard.TOKEN_ENV] = TOKEN
out["main"]["badVoice"] = guard.main(["--port", str(PORT), "--language", "german", "--voice", "cosette"])
out["main"]["urlVoice"] = guard.main(["--port", str(PORT), "--language", "german", "--voice", "https://example.invalid/x.safetensors"])
os.environ[guard.TOKEN_ENV] = TOKEN
out["main"]["ok"] = guard.main(["--port", str(PORT), "--language", "german", "--voice", "juergen"])
out["main"]["tokenLeftInEnv"] = guard.TOKEN_ENV in os.environ
out["main"]["runs"] = [{"host": kw.get("host"), "port": kw.get("port"), "proxy_headers": kw.get("proxy_headers"), "guarded": isinstance(app, guard.Guard)} for app, kw in uvicorn_runs]
out["main"]["resolvedAtStart"] = list(resolved)
out["main"]["language"] = pocket_main.tts_model.language
try:
    pocket_main.tts_model.get_state_for_audio_prompt("https://example.invalid/x.safetensors")
    out["main"]["laterVoiceRefused"] = False
except RuntimeError:
    out["main"]["laterVoiceRefused"] = True
out["allowedVoices"] = sorted(guard.ALLOWED_VOICES)
out["maxText"] = guard.MAX_TEXT_CHARS
out["guardTooShortToken"] = False
try:
    guard.Guard(inner_app, "kurz", PORT)
except ValueError:
    out["guardTooShortToken"] = True

# ---------------------------------------------------------------------------
# Anfragen durch den Wächter (die App aus dem Start über main())
# ---------------------------------------------------------------------------

app = uvicorn_runs[-1][0]


async def call(req):
    headers = [(k.lower().encode(), v.encode()) for k, v in req.get("headers", [])]
    path, _, query = req["path"].partition("?")
    scope = {"type": "http", "method": req["method"], "path": path, "query_string": query.encode(), "headers": headers}
    body = req.get("body", "").encode()
    chunks = [body[i : i + 1000] for i in range(0, len(body), 1000)] or [b""]
    queue = list(chunks)

    async def receive():
        if queue:
            c = queue.pop(0)
            return {"type": "http.request", "body": c, "more_body": bool(queue)}
        return {"type": "http.disconnect"}

    sent = []

    async def send(m):
        sent.append(m)

    before = len(inner_calls)
    await app(scope, receive, send)
    start = next((m for m in sent if m["type"] == "http.response.start"), None)
    return {"name": req["name"], "status": start["status"] if start else None, "reachedApp": len(inner_calls) > before}


async def all_requests():
    return [await call(r) for r in spec_in["requests"]]


out["responses"] = asyncio.run(all_requests())
out["innerCalls"] = inner_calls
out["resolvedTotal"] = list(resolved)

# ---------------------------------------------------------------------------
# Eigene Stimme (Issue #253): nur geprüfte lokale Kennungen, nur mit Klon-Gewichten
# ---------------------------------------------------------------------------

import tempfile

clone = {}
with tempfile.TemporaryDirectory() as tmp:
    voices = os.path.join(tmp, "voices")
    good = "0123456789abcdef"
    os.makedirs(os.path.join(voices, good))
    with open(os.path.join(voices, good, "reference.wav"), "wb") as f:
        f.write(b"RIFF")
    # Symlink auf eine Datei außerhalb des Ordners
    outside = os.path.join(tmp, "fremd.wav")
    with open(outside, "wb") as f:
        f.write(b"RIFF")
    link = "fedcba9876543210"
    os.makedirs(os.path.join(voices, link))
    os.symlink(outside, os.path.join(voices, link, "reference.wav"))
    big = "aaaaaaaaaaaaaaaa"
    os.makedirs(os.path.join(voices, big))
    with open(os.path.join(voices, big, "reference.wav"), "wb") as f:
        f.write(b"\0" * (guard.MAX_REFERENCE_BYTES + 1))

    def start(args):
        os.environ[guard.TOKEN_ENV] = TOKEN
        before = len(resolved)
        code = guard.main(["--port", str(PORT), "--language", "german"] + args)
        return code, resolved[before:]

    clone["badId"] = start(["--clone-dir", voices, "--clone-id", "../" + good])[0]
    clone["upperId"] = start(["--clone-dir", voices, "--clone-id", good.upper()])[0]
    clone["relativeDir"] = start(["--clone-dir", "voices", "--clone-id", good])[0]
    clone["missing"] = start(["--clone-dir", voices, "--clone-id", "1111111111111111"])[0]
    clone["symlink"] = start(["--clone-dir", voices, "--clone-id", link])[0]
    clone["tooBig"] = start(["--clone-dir", voices, "--clone-id", big])[0]
    clone["withVoice"] = start(["--voice", "juergen", "--clone-dir", voices, "--clone-id", good])[0]
    FakeModel.cloning = False
    code, got = start(["--clone-dir", voices, "--clone-id", good])
    clone["noWeights"] = code
    clone["noWeightsResolved"] = [str(x) for x in got]
    FakeModel.cloning = True
    code, got = start(["--clone-dir", voices, "--clone-id", good])
    clone["ok"] = code
    want = os.path.join(os.path.realpath(voices), good, "reference.wav")
    clone["resolvedReference"] = [str(x) == want for x in got]
    try:
        pocket_main.tts_model.get_state_for_audio_prompt("https://example.invalid/x.wav")
        clone["laterVoiceRefused"] = False
    except RuntimeError:
        clone["laterVoiceRefused"] = True
out["clone"] = clone
json.dump(out, sys.stdout)
