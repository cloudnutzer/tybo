#!/usr/bin/env bun
/**
 * Integrationsprüflauf für den Pocket-Wächter src/lib/speech/pocket_guard.py
 * (Issue #252). Kein Teil von `bun run check` (startet Python), wird von Hand
 * gestartet:
 *
 *   bun run scripts/pocket-guard-check.ts
 *
 * Braucht nur python3 (3.10 oder neuer) aus dem PATH, kein pocket-tts, kein
 * Modell, kein Netz: scripts/pocket-guard-harness.py ersetzt pocket-tts und
 * uvicorn durch Attrappen und schickt die Anfragen aus GUARD_REQUESTS an die
 * ASGI-App, die uvicorn bekäme, also an den tatsächlich erreichbaren
 * Endpunkt. Geprüft werden fremder, fehlender und doppelter Host, Origin und
 * Sec-Fetch, fehlendes und falsches Token, Stimmen je Anfrage (https, hf,
 * Katalog), Upload, Textgrenze, Wege, Startparameter und die Positivliste,
 * dazu der Start mit einer eigenen Stimme (Issue #253): nur geprüfte lokale
 * Kennungen, keine Symlinks, nur mit Klon-Gewichten.
 *
 * Die Auswertung (guardFindings) prüft tests/speech-pocket-guard.test.ts
 * mit einer Prozessattrappe; dort startet kein Python.
 */

import { join } from "node:path";
import { POCKET_GUARD_SCRIPT, POCKET_VOICES } from "../src/lib/speech/pocket";

export const GUARD_HARNESS = join(import.meta.dir, "pocket-guard-harness.py");

const TOKEN = "t".repeat(64);
const HOST = "127.0.0.1:41000";
const FORM = "application/x-www-form-urlencoded";
const ok = (extra: [string, string][] = []): [string, string][] => [["Host", HOST], ["Authorization", `Bearer ${TOKEN}`], ...extra];

export interface GuardRequest {
  name: string;
  method: string;
  path: string;
  headers?: [string, string][];
  body?: string;
}

export const GUARD_REQUESTS: GuardRequest[] = [
  { name: "health", method: "GET", path: "/health", headers: ok() },
  { name: "tts", method: "POST", path: "/tts", headers: ok([["Content-Type", FORM]]), body: "text=Hallo+Welt" },
  // Fremder Host (DNS-Rebinding: die Webseite spricht unter eigenem Namen mit 127.0.0.1)
  { name: "host-fremd", method: "POST", path: "/tts", headers: [["Host", "evil.example:41000"], ["Authorization", `Bearer ${TOKEN}`], ["Content-Type", FORM]], body: "text=x" },
  { name: "host-localhost", method: "GET", path: "/health", headers: [["Host", "localhost:41000"], ["Authorization", `Bearer ${TOKEN}`]] },
  { name: "host-fehlt", method: "GET", path: "/health", headers: [["Authorization", `Bearer ${TOKEN}`]] },
  { name: "host-doppelt", method: "GET", path: "/health", headers: [["Host", HOST], ["Host", "evil.example"], ["Authorization", `Bearer ${TOKEN}`]] },
  // Origin bzw. Sec-Fetch: Anfrage aus einem Browser, auch mit richtigem Host und Token
  { name: "origin-fremd", method: "POST", path: "/tts", headers: ok([["Origin", "https://evil.example"], ["Content-Type", FORM]]), body: "text=x" },
  { name: "origin-null", method: "POST", path: "/tts", headers: ok([["Origin", "null"], ["Content-Type", FORM]]), body: "text=x" },
  { name: "sec-fetch", method: "GET", path: "/health", headers: ok([["Sec-Fetch-Site", "cross-site"]]) },
  // Interne Berechtigung
  { name: "token-fehlt", method: "POST", path: "/tts", headers: [["Host", HOST], ["Content-Type", FORM]], body: "text=x" },
  { name: "token-falsch", method: "POST", path: "/tts", headers: [["Host", HOST], ["Authorization", `Bearer ${"u".repeat(64)}`], ["Content-Type", FORM]], body: "text=x" },
  { name: "health-ohne-token", method: "GET", path: "/health", headers: [["Host", HOST]] },
  // Stimmen und Adressen je Anfrage
  { name: "voice-https", method: "POST", path: "/tts", headers: ok([["Content-Type", FORM]]), body: "text=x&voice_url=https%3A%2F%2Fevil.example%2Fv.safetensors" },
  { name: "voice-hf", method: "POST", path: "/tts", headers: ok([["Content-Type", FORM]]), body: "text=x&voice_url=hf%3A%2F%2Fkyutai%2Ftts-voices%2Fexpresso%2Fx.wav" },
  { name: "voice-katalog", method: "POST", path: "/tts", headers: ok([["Content-Type", FORM]]), body: "text=x&voice_url=cosette" },
  { name: "voice-freigegeben", method: "POST", path: "/tts", headers: ok([["Content-Type", FORM]]), body: "text=x&voice_url=juergen" },
  { name: "upload", method: "POST", path: "/tts", headers: ok([["Content-Type", "multipart/form-data; boundary=b"]]), body: '--b\r\nContent-Disposition: form-data; name="text"\r\n\r\nx\r\n--b\r\nContent-Disposition: form-data; name="voice_wav"; filename="v.wav"\r\n\r\nRIFF\r\n--b--\r\n' },
  { name: "text-doppelt", method: "POST", path: "/tts", headers: ok([["Content-Type", FORM]]), body: "text=a&text=b" },
  // Textgrenze und Wege
  { name: "text-leer", method: "POST", path: "/tts", headers: ok([["Content-Type", FORM]]), body: "text=+" },
  { name: "text-zu-lang", method: "POST", path: "/tts", headers: ok([["Content-Type", FORM]]), body: `text=${"a".repeat(6001)}` },
  { name: "body-zu-gross", method: "POST", path: "/tts", headers: ok([["Content-Type", FORM]]), body: `text=${"a".repeat(70_000)}` },
  { name: "startseite", method: "GET", path: "/", headers: ok() },
  { name: "tts-get", method: "GET", path: "/tts", headers: ok() },
  { name: "query", method: "POST", path: "/tts?voice_url=https://evil.example/v", headers: ok([["Content-Type", FORM]]), body: "text=x" },
];

/** Erwartete Antwort je Anfrage; reachedApp: kam sie bis zur App von pocket-tts */
export const GUARD_EXPECTED: Record<string, { status: number; reachedApp: boolean }> = {
  health: { status: 200, reachedApp: true },
  tts: { status: 200, reachedApp: true },
  ...Object.fromEntries(["host-fremd", "host-localhost", "host-fehlt", "host-doppelt"].map(n => [n, { status: 421, reachedApp: false }])),
  ...Object.fromEntries(["origin-fremd", "origin-null", "sec-fetch"].map(n => [n, { status: 403, reachedApp: false }])),
  ...Object.fromEntries(["token-fehlt", "token-falsch", "health-ohne-token"].map(n => [n, { status: 401, reachedApp: false }])),
  ...Object.fromEntries(["voice-https", "voice-hf", "voice-katalog", "voice-freigegeben", "text-doppelt", "text-leer", "text-zu-lang"].map(n => [n, { status: 400, reachedApp: false }])),
  upload: { status: 415, reachedApp: false },
  "body-zu-gross": { status: 413, reachedApp: false },
  ...Object.fromEntries(["startseite", "tts-get", "query"].map(n => [n, { status: 404, reachedApp: false }])),
};

export interface HarnessOut {
  main: {
    noToken: number;
    badVoice: number;
    urlVoice: number;
    ok: number;
    tokenLeftInEnv: boolean;
    runs: { host: string; port: number; proxy_headers: boolean; guarded: boolean }[];
    resolvedAtStart: string[];
    language: string;
    laterVoiceRefused: boolean;
  };
  allowedVoices: string[];
  maxText: number;
  guardTooShortToken: boolean;
  responses: { name: string; status: number | null; reachedApp: boolean }[];
  innerCalls: { method: string; path: string; body: string }[];
  resolvedTotal: string[];
  /** Eigene Stimme (Issue #253): Exit-Codes der Starts mit --clone-dir/--clone-id */
  clone: {
    badId: number;
    upperId: number;
    relativeDir: number;
    missing: number;
    symlink: number;
    tooBig: number;
    withVoice: number;
    noWeights: number;
    noWeightsResolved: string[];
    ok: number;
    /** Je beim Start aufgelöster Stimme: war es genau die Referenz der Kennung? */
    resolvedReference: boolean[];
    laterVoiceRefused: boolean;
  };
}

export interface GuardFinding {
  ok: boolean;
  label: string;
  detail?: string;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Wertet die Ausgabe des Prüfstands aus: eine Zeile je Prüfung */
export function guardFindings(r: HarnessOut): GuardFinding[] {
  const out: GuardFinding[] = [];
  const check = (label: string, cond: boolean, detail?: string) => out.push({ ok: cond, label, ...(cond ? {} : { detail }) });

  for (const [name, want] of Object.entries(GUARD_EXPECTED)) {
    const got = r.responses.find(x => x.name === name);
    check(`Anfrage ${name}: ${want.status}${want.reachedApp ? ", bis zur App" : ", App sieht nichts"}`, !!got && got.status === want.status && got.reachedApp === want.reachedApp, JSON.stringify(got ?? null));
  }
  const tts = r.innerCalls.find(c => c.path === "/tts");
  check("Synthese erreicht die App nur mit text", tts?.body === "text=Hallo+Welt", JSON.stringify(tts ?? null));
  check("aufgelöst wurde nur die Stimme beim Start", same(r.resolvedTotal, ["juergen"]), JSON.stringify(r.resolvedTotal));
  check("Textgrenze 6000 Zeichen", r.maxText === 6000, String(r.maxText));
  check("Start ohne Token abgelehnt", r.main.noToken === 2, String(r.main.noToken));
  check("Start mit Katalogstimme abgelehnt", r.main.badVoice === 2, String(r.main.badVoice));
  check("Start mit Stimmenadresse abgelehnt", r.main.urlVoice === 2, String(r.main.urlVoice));
  check("Start mit freigegebener Stimme und Token", r.main.ok === 0, String(r.main.ok));
  check("Token aus der Umgebung entfernt", r.main.tokenLeftInEnv === false);
  check("uvicorn nur auf 127.0.0.1, ohne Proxy-Köpfe, mit Wächter", same(r.main.runs, [{ host: "127.0.0.1", port: 41000, proxy_headers: false, guarded: true }]), JSON.stringify(r.main.runs));
  check("Sprache german", r.main.language === "german", r.main.language);
  check("beim Start nur juergen aufgelöst", same(r.main.resolvedAtStart, ["juergen"]), JSON.stringify(r.main.resolvedAtStart));
  check("zu kurzes Token abgelehnt", r.guardTooShortToken === true);
  check("nach dem Start keine weitere Stimme (keine Downloads)", r.main.laterVoiceRefused === true);
  check("Positivliste gleich POCKET_VOICES", same(r.allowedVoices, Object.keys(POCKET_VOICES).sort()), JSON.stringify(r.allowedVoices));
  const c = r.clone;
  const refused = (label: string, code: number | undefined) => check(`Eigene Stimme: ${label} abgelehnt`, code === 2, String(code));
  refused("Kennung mit Pfad", c?.badId);
  refused("Kennung in Großbuchstaben", c?.upperId);
  refused("relativer Ordner", c?.relativeDir);
  refused("fehlende Referenz", c?.missing);
  refused("Referenz als Symlink", c?.symlink);
  refused("zu große Referenz", c?.tooBig);
  refused("Katalogstimme und eigene Stimme zugleich", c?.withVoice);
  check("Eigene Stimme: ohne Klon-Gewichte Exit 3, nichts aufgelöst", c?.noWeights === 3 && same(c.noWeightsResolved, []), JSON.stringify(c ?? null));
  check("Eigene Stimme: Start mit geprüfter Kennung, genau die Referenz aufgelöst", c?.ok === 0 && same(c.resolvedReference, [true]), JSON.stringify(c ?? null));
  check("Eigene Stimme: danach keine weitere Stimme", c?.laterVoiceRefused === true);
  return out;
}

/** Prozessstart, in den Tests eine Attrappe */
export type GuardSpawn = (cmd: string[], stdin: string) => Promise<{ code: number; stdout: string; stderr: string }>;

export const realGuardSpawn: GuardSpawn = async (cmd, stdin) => {
  const proc = Bun.spawn({ cmd, stdin: new Blob([stdin]), stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, stdout, stderr };
};

/** Startet den Prüfstand (python3 -I -B, isoliert, ohne .pyc) und wertet aus */
export async function runGuardCheck(spawn: GuardSpawn = realGuardSpawn): Promise<GuardFinding[]> {
  const res = await spawn(["python3", "-I", "-B", GUARD_HARNESS], JSON.stringify({ guard: POCKET_GUARD_SCRIPT, requests: GUARD_REQUESTS }));
  if (res.code !== 0) return [{ ok: false, label: "Prüfstand gestartet", detail: `Exit ${res.code}: ${res.stderr.trim()}` }];
  let parsed: HarnessOut;
  try {
    parsed = JSON.parse(res.stdout) as HarnessOut;
  } catch {
    return [{ ok: false, label: "Ausgabe des Prüfstands lesbar", detail: res.stdout.slice(0, 200) }];
  }
  return guardFindings(parsed);
}

if (import.meta.main) {
  const findings = await runGuardCheck();
  for (const f of findings) console.log(`${f.ok ? "OK  " : "FEHLER"} ${f.label}${f.detail ? `  (${f.detail})` : ""}`);
  const failed = findings.filter(f => !f.ok).length;
  console.log(failed ? `\n${failed} von ${findings.length} Prüfungen fehlgeschlagen` : `\nAlle ${findings.length} Prüfungen bestanden`);
  process.exit(failed ? 1 : 0);
}
