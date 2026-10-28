/**
 * Kyutai Pocket TTS als lokale Stimme (Issue #252, Entscheidung 0023).
 *
 * - Ablage unter models/speech/pocket/: ein eigenes venv (venv/) mit
 *   pocket-tts in der geprüften Version und die Modelldateien im eigenen
 *   Hugging-Face-Ordner (hf/). Die Einrichtung (tybo setup sprache) lädt
 *   alles nach Zustimmung und schreibt erst nach bestandener Probe den
 *   Nachweis pocket.ok.json. available() prüft nur diese Dateien.
 * - Der Bot startet Pocket erst beim ersten Vorlesen als Kindprozess auf
 *   127.0.0.1 mit freiem Port, nicht mit `pocket-tts serve`, sondern über
 *   ./pocket_guard.py: lädt Modell und Stimme wie serve in Version 3.3.0 und
 *   stellt einen Wächter vor die unveränderte App (Host genau
 *   127.0.0.1:<port>, kein Origin, Token je Start im Kopf Authorization, nur
 *   GET /health und POST /tts mit genau dem Feld text). Der unveränderte
 *   Server nähme sonst jede Anfrage an, auch aus fremden Webseiten
 *   (DNS-Rebinding), und mit voice_url auch Adressen im Netz.
 *   HF_HUB_OFFLINE=1: beim Vorlesen lädt nichts nach, fehlt etwas, scheitert
 *   der Start.
 * - Gleichzeitige erste Aufrufe teilen sich einen Start. Nach
 *   POCKET_IDLE_MS ohne Aufruf endet der Prozess; eine laufende Synthese
 *   hält ihn am Leben. Ist er abgestürzt, startet der nächste Aufruf ihn neu.
 * - Stimmen nur aus der Positivliste POCKET_VOICES (Herkunft und Lizenz
 *   belegt). Nie Stimmen aus dem Ordner expresso (CC-BY-NC-4.0), nie URLs
 *   oder Uploads: die Stimme wird beim Start gewählt, der Wächter weist
 *   voice_url und voice_wav ab (Positivliste dort: ALLOWED_VOICES).
 * - Ausgaben des Prozesses gehen nirgends hin (nie ins Log).
 * - Eigene Stimmen (Issue #253): mit den Klon-Gewichten (kyutai/pocket-tts,
 *   gated, eingerichtet von tybo setup sprache mit Hugging-Face-Token) lädt
 *   der Wächter statt einer Katalogstimme die Referenz einer geprüften
 *   lokalen Kennung (Stimmenschlüssel clone:<id>, Datei
 *   <voicesDir>/<id>/reference.wav). Auch dann keine URLs, keine Uploads,
 *   keine weitere Stimme nach dem Start.
 */

import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { join } from "node:path";
import { BRAND } from "../../brand";
import { createWavStreamParser } from "./pcm";
import { SpeechError, type Availability } from "./types";

/** Geprüfte Version (PyPI, 24.09.2026), ein Wechsel ist eine Code-Änderung */
export const POCKET_VERSION = "3.3.0";
/** Sprachmodell von Pocket TTS: Deutsch mit 6 Schichten (german, nicht german_24l) */
export const POCKET_LANGUAGE = "german";
export const POCKET_LABEL = "Pocket TTS (Kyutai)";
export const POCKET_ATTRIBUTION = "Stimme: Kyutai Pocket TTS, Modell und Stimme juergen CC-BY-4.0 (huggingface.co/kyutai/pocket-tts-without-voice-cloning)";
/** Nach so langer Zeit ohne Aufruf endet der Prozess */
export const POCKET_IDLE_MS = 10 * 60 * 1000;
/** Bis der Server bereit ist (Modell laden, gemessen 1,5 s auf einem Mac mit M4; auf dem Pi deutlich länger) */
export const POCKET_START_TIMEOUT_MS = 90_000;
/** Abtastrate von Pocket TTS (mimi, 24 kHz); der gestreamte Kopf muss sie nennen (Issue #257) */
export const POCKET_SAMPLE_RATE = 24_000;
/** Höchstens so lange je Synthese (600 Zeichen im Sprechmodus, Telegram bis 4.500) */
export const POCKET_SYNTH_TIMEOUT_MS = 180_000;
const HEALTH_POLL_MS = 250;

export interface PocketVoice {
  name: string;
  /** Sprachmodell, zu dem die Stimme gehört */
  language: string;
  license: "CC0" | "CC-BY-4.0";
  /** Herkunft der Stimme (Repo und Datei) */
  source: string;
  /** Anzeigename (Issue #276, Hinweis beim Rückfall im Telefonhörer) */
  label: string;
}

/**
 * Freigegebene Stimmen. juergen: languages/german/embeddings/juergen.safetensors
 * im Repo kyutai/pocket-tts-without-voice-cloning, das als Ganzes unter
 * CC-BY-4.0 steht (Model Card), im README von Kyutai als Katalogstimme (de)
 * geführt (Planungs-Nachtrag zu Issue #252 vom 30.09.2026).
 */
export const POCKET_VOICES: Readonly<Record<string, PocketVoice>> = Object.freeze({
  juergen: {
    name: "juergen",
    language: POCKET_LANGUAGE,
    license: "CC-BY-4.0",
    source: "kyutai/pocket-tts-without-voice-cloning, languages/german/embeddings/juergen.safetensors",
    label: "Jürgen",
  },
});

export const POCKET_DEFAULT_VOICE = "juergen";

/**
 * Katalogstimmen aus dem Ordner expresso von kyutai/tts-voices (CC-BY-NC-4.0,
 * nicht kommerziell): nie wählbar, auch nicht je Anfrage. Stand pocket-tts
 * 3.3.0, pocket_tts/utils/utils.py.
 */
export const POCKET_NON_COMMERCIAL_VOICES: readonly string[] = ["cosette"];

/** Freigegebene Stimme zum Namen; null für alles andere (unbekannt, nicht kommerziell, URL) */
export function resolvePocketVoice(name: string): PocketVoice | null {
  if (POCKET_NON_COMMERCIAL_VOICES.includes(name)) return null;
  return Object.prototype.hasOwnProperty.call(POCKET_VOICES, name) ? POCKET_VOICES[name] : null;
}

export interface PocketPaths {
  dir: string;
  venv: string;
  python: string;
  program: string;
  /** HF_HOME des Prozesses: die Modelldateien liegen hier, nicht im Cache des Nutzers */
  hfHome: string;
  /** Ordner des Modells im Hub-Cache (ohne Stimmenklonen) */
  modelCache: string;
  /**
   * Nachweis, dass der Download von Modell, Tokenizer und Stimme vollständig
   * ist (geschrieben nach dem ersten erfolgreichen Erzeugen). Ein Ordner
   * modelCache allein kann von einem abgebrochenen Download stammen.
   */
  modelReady: string;
  proof: string;
  /** Hörbare Probe aus der Einrichtung */
  probeWav: string;
}

export function pocketPaths(speechDir: string): PocketPaths {
  const dir = join(speechDir, "pocket");
  const venv = join(dir, "venv");
  const hfHome = join(dir, "hf");
  return {
    dir,
    venv,
    python: join(venv, "bin", "python"),
    program: join(venv, "bin", "pocket-tts"),
    hfHome,
    modelCache: join(hfHome, "hub", "models--kyutai--pocket-tts-without-voice-cloning"),
    modelReady: join(dir, "model.ok"),
    proof: join(speechDir, "pocket.ok.json"),
    probeWav: join(speechDir, "pocket-probe.wav"),
  };
}

/** Nachweis der Einrichtung, geschrieben nach bestandener Probe */
export interface PocketProof {
  version: 1;
  pocket: string;
  language: string;
  voice: string;
  probe: { loadMs: number; synthMs: number; audioSeconds: number; rtf: number; at: string };
}

export const POCKET_PROOF_INVALID = `Probe fehlt oder Version geändert, ${BRAND.cli} setup sprache ausführen`;

/**
 * Verfügbar, wenn Programm, Modellordner und ein passender Nachweis da sind.
 * Nur Dateien, synchron: kein Prozessstart, kein Netzwerk.
 */
export function pocketAvailability(paths: PocketPaths, exists: (path: string) => boolean, readText: (path: string) => string | null, voice: string): Availability {
  if (!exists(paths.program)) return { ok: false, reason: `nicht eingerichtet, ${BRAND.cli} setup sprache ausführen` };
  if (!exists(paths.modelCache)) return { ok: false, reason: `Modell fehlt, ${BRAND.cli} setup sprache ausführen` };
  if (!resolvePocketVoice(voice)) return { ok: false, reason: "die eingestellte Stimme (POCKET_TTS_VOICE) ist nicht freigegeben" };
  const raw = readText(paths.proof);
  if (raw === null) return { ok: false, reason: POCKET_PROOF_INVALID };
  try {
    const proof = JSON.parse(raw) as PocketProof;
    if (!proof || proof.version !== 1 || proof.pocket !== POCKET_VERSION || proof.language !== POCKET_LANGUAGE) return { ok: false, reason: POCKET_PROOF_INVALID };
  } catch {
    return { ok: false, reason: POCKET_PROOF_INVALID };
  }
  return { ok: true };
}

/** Startpunkt mit Wächter (liegt im Repo neben dieser Datei) */
// ---------------------------------------------------------------------------
// Klon-Gewichte (Issue #253)
// ---------------------------------------------------------------------------

/** Repo, Datei und Revision der Klon-Gewichte, wie in pocket_tts/config/german.yaml (3.3.0) */
export const POCKET_CLONE_REPO = "kyutai/pocket-tts";
export const POCKET_CLONE_FILE = "languages/german/model.safetensors";
export const POCKET_CLONE_REVISION = "2dd944b099d06bb9edbd221fef138685711d9bf0";
/** Größe laut Hub-API (01.10.2026) */
export const POCKET_CLONE_BYTES = 219_029_196;
export const POCKET_CLONE_LABEL = "Pocket TTS mit Stimmenklonen (Kyutai)";
export const POCKET_CLONE_NOTE = "Kyutai Pocket TTS, Klon-Gewichte CC-BY-4.0 (huggingface.co/kyutai/pocket-tts, Zugang nach Zustimmung zu Kyutais Bedingungen)";

export interface PocketClonePaths {
  /** Ordner der Klon-Gewichte im Hub-Cache (HF_HOME von Pocket) */
  cloneCache: string;
  /** Nachweis: Download vollständig */
  cloneReady: string;
  /** Nachweis der Einrichtung: Probe mit Klon bestanden */
  cloneProof: string;
}

export function pocketClonePaths(speechDir: string): PocketClonePaths {
  const p = pocketPaths(speechDir);
  return {
    cloneCache: join(p.hfHome, "hub", "models--kyutai--pocket-tts"),
    cloneReady: join(p.dir, "clone-model.ok"),
    cloneProof: join(speechDir, "pocket-clone.ok.json"),
  };
}

export interface PocketCloneProof {
  version: 1;
  pocket: string;
  language: string;
  revision: string;
  probe: { loadMs: number; synthMs: number; audioSeconds: number; rtf: number; at: string };
}

export const POCKET_CLONE_PROOF_INVALID = `Stimmenklonen mit Pocket TTS nicht eingerichtet, ${BRAND.cli} setup sprache ausführen`;

/** Wie pocketAvailability, dazu Klon-Gewichte und Nachweis der Klon-Probe */
export function pocketCloneAvailability(paths: PocketPaths, clone: PocketClonePaths, exists: (path: string) => boolean, readText: (path: string) => string | null): Availability {
  if (!exists(paths.program)) return { ok: false, reason: `Pocket TTS nicht eingerichtet, ${BRAND.cli} setup sprache ausführen` };
  if (!exists(paths.modelCache) || !exists(clone.cloneCache) || !exists(clone.cloneReady)) return { ok: false, reason: POCKET_CLONE_PROOF_INVALID };
  const raw = readText(clone.cloneProof);
  if (raw === null) return { ok: false, reason: POCKET_CLONE_PROOF_INVALID };
  try {
    const proof = JSON.parse(raw) as PocketCloneProof;
    if (!proof || proof.version !== 1 || proof.pocket !== POCKET_VERSION || proof.language !== POCKET_LANGUAGE || proof.revision !== POCKET_CLONE_REVISION) return { ok: false, reason: POCKET_CLONE_PROOF_INVALID };
  } catch {
    return { ok: false, reason: POCKET_CLONE_PROOF_INVALID };
  }
  return { ok: true };
}

/** Stimmenschlüssel einer eigenen Stimme im Pocket-Prozess */
export const CLONE_VOICE_PREFIX = "clone:";
const CLONE_KEY = /^clone:([a-f0-9]{16})$/;

/** Kennung aus einem Stimmenschlüssel clone:<id>; null für alles andere */
export function cloneVoiceId(voice: string): string | null {
  const m = CLONE_KEY.exec(voice);
  return m ? m[1] : null;
}

export const POCKET_GUARD_SCRIPT = join(import.meta.dir, "pocket_guard.py");
/** Umgebungsvariable für das Token je Start (der Wächter entfernt sie sofort) */
export const POCKET_TOKEN_ENV = "TYBO_POCKET_TOKEN";

/**
 * Befehl für den Server: Python des venv, isoliert (-I), Wächter mit Port,
 * Sprache und Stimme. Eigene Stimme (clone:<id>): statt --voice der Ordner
 * der Stimmen und die geprüfte Kennung; den Pfad bildet der Wächter selbst.
 */
export function pocketServeCommand(paths: PocketPaths, port: number, voice: string, voicesDir?: string): string[] {
  const base = [paths.python, "-I", POCKET_GUARD_SCRIPT, "--port", String(port), "--language", POCKET_LANGUAGE];
  const id = cloneVoiceId(voice);
  if (id !== null) {
    if (!voicesDir) throw new SpeechError("unavailable");
    return [...base, "--clone-dir", voicesDir, "--clone-id", id];
  }
  return [...base, "--voice", voice];
}

/** Variablen, die Python-Prozesse für lokale Stimmen erben (Pfad, Sprache, Proxy, Zertifikate), nie Schlüssel */
export const BASE_ENV_NAMES = ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "USER", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy", "SSL_CERT_FILE", "REQUESTS_CA_BUNDLE"];

/**
 * Umgebung des Prozesses: nur das Nötige, keine Schlüssel des Bots.
 * HF_HUB_OFFLINE=1, damit beim Vorlesen nie ein Download beginnt.
 */
export function pocketEnv(paths: PocketPaths, base: Record<string, string | undefined>, offline = true): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of BASE_ENV_NAMES) {
    const v = base[name];
    if (v !== undefined) env[name] = v;
  }
  env.HF_HOME = paths.hfHome;
  env.HF_HUB_DISABLE_TELEMETRY = "1";
  if (offline) env.HF_HUB_OFFLINE = "1";
  return env;
}

// ---------------------------------------------------------------------------
// Kindprozess
// ---------------------------------------------------------------------------

export interface PocketChild {
  /** Löst auf, wenn der Prozess endet (auch nach Absturz) */
  exited: Promise<unknown>;
  kill(signal?: NodeJS.Signals): void;
}

export interface PocketServerDeps {
  spawn(cmd: string[], opts: { env: Record<string, string>; cwd: string }): PocketChild;
  fetch(url: string, init?: RequestInit): Promise<Response>;
  /** Freier Port auf 127.0.0.1 */
  freePort(): Promise<number>;
  now(): number;
  sleep(ms: number): Promise<void>;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

export interface PocketServerOptions {
  paths: PocketPaths;
  env: () => Record<string, string | undefined>;
  deps: PocketServerDeps;
  idleMs?: number;
  startTimeoutMs?: number;
  /**
   * Ordner der eigenen Stimmen (Issue #253): nur damit nimmt der Server
   * Stimmenschlüssel clone:<id> an. Fehlt er, gibt es nur Katalogstimmen.
   */
  voicesDir?: string;
}

interface Running {
  child: PocketChild;
  port: number;
  voice: string;
  /** Token je Start, nur im Speicher und in der Umgebung des Kindes */
  token: string;
  dead: boolean;
}

export type PocketServer = ReturnType<typeof createPocketServer>;

/**
 * Verwaltet den einen Prozess des Wächters (./pocket_guard.py). synthesize()
 * startet ihn bei Bedarf, stop() beendet ihn (auch beim Ende des Bots).
 * Jedes gestartete Kind ist sofort registriert, nicht erst nach der
 * Bereitschaft: stop() beendet auch startende Kinder, und ein Start, der vor
 * stop() begann, gilt danach nicht mehr (keine verspätete Bereitschaft).
 */
export function createPocketServer(o: PocketServerOptions) {
  const d = o.deps;
  const idleMs = o.idleMs ?? POCKET_IDLE_MS;
  const startTimeoutMs = o.startTimeoutMs ?? POCKET_START_TIMEOUT_MS;
  let current: Promise<Running> | null = null;
  let currentVoice: string | null = null;
  let running: Running | null = null;
  /** Alle gestarteten, noch nicht beendeten Kinder (auch vor der Bereitschaft) */
  const children = new Set<Running>();
  /** Zählt stop(); Starts und Anfragen aus einer früheren Runde enden ohne Neustart */
  let epoch = 0;
  let active = 0;
  let idleTimer: unknown = null;
  let starts = 0;

  /** Katalogstimme aus der Positivliste oder, mit voicesDir, eine eigene Stimme */
  function voiceOk(voice: string): boolean {
    if (resolvePocketVoice(voice)) return true;
    return !!o.voicesDir && cloneVoiceId(voice) !== null;
  }

  function clearIdle() {
    if (idleTimer !== null) d.clearTimer(idleTimer);
    idleTimer = null;
  }

  function armIdle() {
    clearIdle();
    idleTimer = d.setTimer(() => {
      idleTimer = null;
      if (active === 0) stop();
    }, idleMs);
  }

  function kill(r: Running) {
    // Schon beendet oder schon ein Signal geschickt: nicht noch einmal
    if (r.dead && !children.has(r)) return;
    r.dead = true;
    children.delete(r);
    try {
      r.child.kill("SIGTERM");
    } catch {
      // schon beendet
    }
  }

  /** Alle Kinder beenden, laufende Starts ungültig machen */
  function stop() {
    epoch++;
    clearIdle();
    for (const r of [...children]) kill(r);
    running = null;
    current = null;
    currentVoice = null;
  }

  function auth(r: Running): Record<string, string> {
    return { Authorization: `Bearer ${r.token}` };
  }

  async function healthy(r: Running): Promise<boolean> {
    try {
      const res = await d.fetch(`http://127.0.0.1:${r.port}/health`, { headers: auth(r), signal: AbortSignal.timeout(2_000) });
      await res.body?.cancel().catch(() => {});
      return res.ok;
    } catch {
      return false;
    }
  }

  /** Ein Start; endet der Prozess vorher (etwa weil der Port belegt war), ein zweiter Versuch mit neuem Port */
  async function start(voice: string): Promise<Running> {
    const mine = epoch;
    const stale = () => mine !== epoch;
    for (let attempt = 0; attempt < 2; attempt++) {
      const port = await d.freePort();
      if (stale()) throw new SpeechError("exit");
      starts++;
      const token = randomBytes(32).toString("hex");
      const env = { ...pocketEnv(o.paths, o.env()), [POCKET_TOKEN_ENV]: token };
      const child = d.spawn(pocketServeCommand(o.paths, port, voice, o.voicesDir), { env, cwd: o.paths.dir });
      const r: Running = { child, port, voice, token, dead: false };
      children.add(r);
      child.exited.then(
        () => {
          r.dead = true;
          children.delete(r);
          if (running === r) {
            running = null;
            current = null;
            currentVoice = null;
          }
        },
        () => {
          r.dead = true;
          children.delete(r);
        },
      );
      const deadline = d.now() + startTimeoutMs;
      while (!r.dead && !stale() && d.now() < deadline) {
        if (await healthy(r)) {
          if (r.dead || stale()) break;
          running = r;
          return r;
        }
        if (stale()) break;
        await d.sleep(HEALTH_POLL_MS);
      }
      if (stale()) {
        kill(r);
        throw new SpeechError("exit");
      }
      if (!r.dead) {
        kill(r);
        throw new SpeechError("timeout");
      }
    }
    throw new SpeechError("exit");
  }

  /** Laufender oder startender Prozess; gleichzeitige Aufrufe teilen sich einen Start */
  function ensure(voice: string): Promise<Running> {
    if (current && currentVoice === voice && !(running && running.dead)) return current;
    // Andere Stimme: der Prozess lädt die Stimme beim Start, also neu starten
    if (current && currentVoice !== voice) stop();
    const p = start(voice);
    current = p;
    currentVoice = voice;
    p.catch(() => {
      if (current === p) {
        current = null;
        currentVoice = null;
      }
    });
    return p;
  }

  /** Nur das Feld text; die Stimme steht beim Start fest, der Wächter nimmt keine andere an */
  async function request(r: Running, text: string, signal: AbortSignal): Promise<Response> {
    return d.fetch(`http://127.0.0.1:${r.port}/tts`, {
      method: "POST",
      headers: { ...auth(r), "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ text }).toString(),
      signal,
    });
  }

  /**
   * WAV für den Text mit einer freigegebenen Stimme. Wirft SpeechError:
   * unavailable (Stimme nicht freigegeben), timeout, exit (Start
   * gescheitert oder gestoppt), http (Antwort des Servers), empty.
   */
  async function synthesize(text: string, voice: string, signal?: AbortSignal): Promise<Buffer> {
    if (!voiceOk(voice)) throw new SpeechError("unavailable");
    const mine = epoch;
    active++;
    clearIdle();
    const timeout = AbortSignal.timeout(POCKET_SYNTH_TIMEOUT_MS);
    const sig = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      for (let attempt = 0; ; attempt++) {
        if (sig.aborted) throw new SpeechError("timeout");
        if (mine !== epoch && attempt > 0) throw new SpeechError("exit");
        const r = await ensure(voice);
        let res: Response;
        try {
          res = await request(r, text, sig);
        } catch {
          if (sig.aborted) throw new SpeechError("timeout");
          // Gestoppt (Ende des Bots): nicht neu starten
          if (mine !== epoch) throw new SpeechError("exit");
          // Verbindung weg: Prozess abgestürzt oder hängt; einmal neu starten
          if (running === r) {
            kill(r);
            running = null;
            current = null;
            currentVoice = null;
          }
          if (attempt >= 1) throw new SpeechError("exit");
          continue;
        }
        if (!res.ok) {
          await res.body?.cancel().catch(() => {});
          throw new SpeechError("http", res.status);
        }
        let audio: Buffer;
        try {
          audio = Buffer.from(await res.arrayBuffer());
        } catch {
          throw new SpeechError(sig.aborted ? "timeout" : "format");
        }
        if (audio.length <= 44) throw new SpeechError("empty");
        return audio;
      }
    } finally {
      active--;
      if (active === 0 && mine === epoch) armIdle();
    }
  }

  /**
   * Gestreamte Synthese für den Telefonhörer (Issue #257): dieselbe Anfrage
   * wie synthesize (nur das Feld text, Token, Host, Wächter unverändert),
   * aber die Antwort wird gelesen, wie sie kommt. pocket-tts 3.3.0 liefert
   * /tts als StreamingResponse (pocket_tts/main.py, generate_data_with_state):
   * erst ein WAV-Kopf mit unbekannter Länge, dann PCM16 mono in 24 kHz
   * Stück für Stück, wie das Modell es erzeugt (FIRST_CHUNK_LENGTH_SECONDS
   * Standard 0, also ohne Puffer vorab). Liefert PCM16 LE ohne Kopf.
   * Bricht der Verbraucher ab (signal oder return), endet die Anfrage; der
   * Server von pocket-tts hält dann auch die Erzeugung an.
   * Wirft SpeechError wie synthesize, dazu format (Kopf passt nicht).
   */
  async function* synthesizeStream(text: string, voice: string, signal?: AbortSignal): AsyncGenerator<Buffer> {
    if (!voiceOk(voice)) throw new SpeechError("unavailable");
    const mine = epoch;
    active++;
    clearIdle();
    const local = new AbortController();
    const timeout = AbortSignal.timeout(POCKET_SYNTH_TIMEOUT_MS);
    const sig = AbortSignal.any(signal ? [signal, timeout, local.signal] : [timeout, local.signal]);
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    try {
      let res: Response | null = null;
      for (let attempt = 0; !res; attempt++) {
        if (sig.aborted) throw new SpeechError("timeout");
        if (mine !== epoch && attempt > 0) throw new SpeechError("exit");
        const r = await ensure(voice);
        try {
          res = await request(r, text, sig);
        } catch {
          if (sig.aborted) throw new SpeechError("timeout");
          if (mine !== epoch) throw new SpeechError("exit");
          if (running === r) {
            kill(r);
            running = null;
            current = null;
            currentVoice = null;
          }
          if (attempt >= 1) throw new SpeechError("exit");
        }
      }
      if (!res.ok || !res.body) {
        await res.body?.cancel().catch(() => {});
        throw new SpeechError("http", res.status);
      }
      reader = res.body.getReader();
      // Abbruch beendet auch ein laufendes read(), selbst wenn der Body das Signal nicht beachtet
      const r = reader;
      sig.addEventListener("abort", () => void r.cancel().catch(() => {}), { once: true });
      const parser = createWavStreamParser();
      for (;;) {
        if (sig.aborted) throw new SpeechError("timeout");
        let step: Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>>;
        try {
          step = await reader.read();
        } catch {
          throw new SpeechError(sig.aborted ? "timeout" : "format");
        }
        if (sig.aborted) throw new SpeechError("timeout");
        if (step.done) break;
        for (const pcm of parser.push(step.value)) {
          if (parser.sampleRate !== POCKET_SAMPLE_RATE) throw new SpeechError("format");
          yield pcm;
        }
      }
      if (!parser.totalBytes) throw new SpeechError("empty");
    } finally {
      local.abort();
      await reader?.cancel().catch(() => {});
      active--;
      if (active === 0 && mine === epoch) armIdle();
    }
  }

  /**
   * Startet den Prozess, ohne vorzulesen (Probe der Einrichtung: Ladezeit
   * getrennt von der Synthese messen). Danach gilt das Leerlauf-Ende.
   * signal: Abbruch der Einrichtung beendet auch einen startenden Prozess.
   */
  async function warmUp(voice: string, signal?: AbortSignal): Promise<void> {
    if (!voiceOk(voice)) throw new SpeechError("unavailable");
    if (signal?.aborted) throw new SpeechError("timeout");
    const onAbort = () => stop();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      await ensure(voice);
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
    if (signal?.aborted) {
      stop();
      throw new SpeechError("timeout");
    }
    if (active === 0) armIdle();
  }

  /**
   * Beendet den Prozess, wenn er diese Stimme geladen hat oder gerade lädt
   * (Issue #253: eine gelöschte eigene Stimme darf nicht weiter vorlesen)
   */
  function stopVoice(voice: string) {
    if (currentVoice === voice || [...children].some(r => r.voice === voice)) stop();
  }

  return {
    synthesize,
    synthesizeStream,
    warmUp,
    stop,
    stopVoice,
    /** Läuft gerade ein Prozess? (für Tests und Status) */
    isRunning: () => !!running && !running.dead,
    /** Gestartete, noch nicht beendete Kinder, auch startende (für Tests) */
    children: () => children.size,
    /** Wie oft ein Prozess gestartet wurde (für Tests) */
    starts: () => starts,
  };
}

/** Freier Port auf 127.0.0.1 (das Betriebssystem vergibt ihn) */
export function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error("kein Port"))));
    });
  });
}

/** Echte Abhängigkeiten: Bun.spawn ohne Ausgabe, echte Uhr */
export const realPocketServerDeps: PocketServerDeps = {
  spawn(cmd, opts) {
    const proc = Bun.spawn({ cmd, cwd: opts.cwd, env: opts.env, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    return { exited: proc.exited, kill: signal => proc.kill(signal) };
  },
  fetch: (url, init) => fetch(url, init),
  freePort: findFreePort,
  now: () => Date.now(),
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
  setTimer: (fn, ms) => {
    const t = setTimeout(fn, ms);
    // Der Leerlauf-Zeitgeber hält den Prozess nicht am Leben
    (t as { unref?: () => void }).unref?.();
    return t;
  },
  clearTimer: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};
