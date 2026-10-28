/**
 * Issue #252, Nachbesserung aus dem Review: Pocket TTS läuft hinter dem
 * Wächter src/lib/speech/pocket_guard.py. Der unveränderte Server nähme auf
 * seinem Loopback-Port jede Anfrage an (fremde Webseiten, DNS-Rebinding) und
 * mit voice_url auch Adressen im Netz.
 *
 * Kein Python im Test: Den Wächter selbst prüft der von Hand gestartete
 * Integrationsprüflauf scripts/pocket-guard-check.ts (echtes Python,
 * pocket-tts und uvicorn als Attrappen). Hier laufen dessen Auswertung mit
 * einer Prozessattrappe sowie die Sicherheitsgrenzen, die sich im Quelltext
 * des Wächters ablesen lassen.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { GUARD_EXPECTED, GUARD_HARNESS, GUARD_REQUESTS, guardFindings, runGuardCheck, type GuardSpawn, type HarnessOut } from "../scripts/pocket-guard-check";
import { POCKET_GUARD_SCRIPT, POCKET_LANGUAGE, POCKET_TOKEN_ENV, POCKET_VOICES } from "../src/lib/speech/pocket";

/** Ausgabe, wie sie der Prüfstand bei einem korrekten Wächter liefert */
function goodOut(): HarnessOut {
  return {
    main: {
      noToken: 2,
      badVoice: 2,
      urlVoice: 2,
      ok: 0,
      tokenLeftInEnv: false,
      runs: [{ host: "127.0.0.1", port: 41000, proxy_headers: false, guarded: true }],
      resolvedAtStart: ["juergen"],
      language: "german",
      laterVoiceRefused: true,
    },
    allowedVoices: ["juergen"],
    maxText: 6000,
    guardTooShortToken: true,
    responses: GUARD_REQUESTS.map(r => ({ name: r.name, ...GUARD_EXPECTED[r.name]! })),
    innerCalls: [{ method: "GET", path: "/health", body: "" }, { method: "POST", path: "/tts", body: "text=Hallo+Welt" }],
    resolvedTotal: ["juergen"],
    clone: {
      badId: 2,
      upperId: 2,
      relativeDir: 2,
      missing: 2,
      symlink: 2,
      tooBig: 2,
      withVoice: 2,
      noWeights: 3,
      noWeightsResolved: [],
      ok: 0,
      resolvedReference: [true],
      laterVoiceRefused: true,
    },
  };
}

function fakeSpawn(out: HarnessOut | string, code = 0) {
  const calls: { cmd: string[]; stdin: string }[] = [];
  const spawn: GuardSpawn = async (cmd, stdin) => {
    calls.push({ cmd, stdin });
    return { code, stdout: typeof out === "string" ? out : JSON.stringify(out), stderr: code ? "Traceback" : "" };
  };
  return { spawn, calls };
}

const failed = (out: HarnessOut) => guardFindings(out).filter(f => !f.ok).map(f => f.label);

describe("Integrationsprüflauf des Pocket-Wächters (Prozessattrappe)", () => {
  test("startet python3 isoliert mit dem Prüfstand, übergibt Wächter und alle Anfragen", async () => {
    const { spawn, calls } = fakeSpawn(goodOut());
    const findings = await runGuardCheck(spawn);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cmd).toEqual(["python3", "-I", "-B", GUARD_HARNESS]);
    const input = JSON.parse(calls[0]!.stdin);
    expect(input.guard).toBe(POCKET_GUARD_SCRIPT);
    expect(input.requests.map((r: { name: string }) => r.name)).toEqual(GUARD_REQUESTS.map(r => r.name));
    expect(findings.every(f => f.ok)).toBe(true);
  });

  test("jede Anfrage hat eine Erwartung; durch kommen nur Bereitschaft und Synthese", () => {
    expect(Object.keys(GUARD_EXPECTED).sort()).toEqual(GUARD_REQUESTS.map(r => r.name).sort());
    expect(Object.entries(GUARD_EXPECTED).filter(([, e]) => e.reachedApp).map(([n]) => n)).toEqual(["health", "tts"]);
  });

  test("Sicherheitsfälle: fremder, fehlender, doppelter Host 421; Origin, Sec-Fetch 403; Token 401; Stimmen 400; Upload 415", () => {
    for (const n of ["host-fremd", "host-localhost", "host-fehlt", "host-doppelt"]) expect(GUARD_EXPECTED[n]).toEqual({ status: 421, reachedApp: false });
    for (const n of ["origin-fremd", "origin-null", "sec-fetch"]) expect(GUARD_EXPECTED[n]).toEqual({ status: 403, reachedApp: false });
    for (const n of ["token-fehlt", "token-falsch", "health-ohne-token"]) expect(GUARD_EXPECTED[n]).toEqual({ status: 401, reachedApp: false });
    for (const n of ["voice-https", "voice-hf", "voice-katalog", "voice-freigegeben", "text-doppelt", "text-leer", "text-zu-lang"]) expect(GUARD_EXPECTED[n]).toEqual({ status: 400, reachedApp: false });
    expect(GUARD_EXPECTED.upload).toEqual({ status: 415, reachedApp: false });
    expect(GUARD_EXPECTED["body-zu-gross"]).toEqual({ status: 413, reachedApp: false });
    for (const n of ["startseite", "tts-get", "query"]) expect(GUARD_EXPECTED[n]).toEqual({ status: 404, reachedApp: false });
  });

  test("Anfrage, die am Wächter vorbei die App erreicht, ist ein Fehler", () => {
    const out = goodOut();
    out.responses = out.responses.map(r => (r.name === "host-fremd" ? { name: r.name, status: 200, reachedApp: true } : r));
    expect(failed(out)).toEqual(["Anfrage host-fremd: 421, App sieht nichts"]);
    const out2 = goodOut();
    out2.responses = out2.responses.map(r => (r.name === "voice-https" ? { ...r, reachedApp: true } : r));
    expect(failed(out2)).toEqual(["Anfrage voice-https: 400, App sieht nichts"]);
  });

  test("fehlende Antwort, falscher Status, Stimme je Anfrage aufgelöst: Fehler", () => {
    const out = goodOut();
    out.responses = out.responses.filter(r => r.name !== "token-falsch").map(r => (r.name === "origin-null" ? { ...r, status: 200 } : r));
    out.resolvedTotal = ["juergen", "https://evil.example/v.safetensors"];
    expect(failed(out)).toEqual(["Anfrage origin-null: 403, App sieht nichts", "Anfrage token-falsch: 401, App sieht nichts", "aufgelöst wurde nur die Stimme beim Start"]);
  });

  test("Startfehler werden gemeldet: Token bleibt, falsche Bindung, Stimme danach noch auflösbar, Positivliste abweichend", () => {
    const out = goodOut();
    out.main.tokenLeftInEnv = true;
    out.main.runs = [{ host: "0.0.0.0", port: 41000, proxy_headers: true, guarded: false }];
    out.main.laterVoiceRefused = false;
    out.main.badVoice = 0;
    out.allowedVoices = ["cosette", "juergen"];
    expect(failed(out)).toEqual([
      "Start mit Katalogstimme abgelehnt",
      "Token aus der Umgebung entfernt",
      "uvicorn nur auf 127.0.0.1, ohne Proxy-Köpfe, mit Wächter",
      "nach dem Start keine weitere Stimme (keine Downloads)",
      "Positivliste gleich POCKET_VOICES",
    ]);
  });

  test("Absturz oder unlesbare Ausgabe des Prüfstands: ein Fehler, nie bestanden", async () => {
    const crash = await runGuardCheck(fakeSpawn("", 1).spawn);
    expect(crash).toEqual([{ ok: false, label: "Prüfstand gestartet", detail: "Exit 1: Traceback" }]);
    const garbage = await runGuardCheck(fakeSpawn("kein json").spawn);
    expect(garbage.map(f => f.ok)).toEqual([false]);
  });
});

describe("Sicherheitsgrenzen im Quelltext des Wächters", () => {
  const src = readFileSync(POCKET_GUARD_SCRIPT, "utf8");

  test("Positivliste gleich POCKET_VOICES, keine expresso-Stimme", () => {
    const m = src.match(/^ALLOWED_VOICES = frozenset\(\{([^}]*)\}\)$/m);
    expect(m).not.toBeNull();
    const voices = [...m![1]!.matchAll(/"([^"]+)"/g)].map(x => x[1]).sort();
    expect(voices).toEqual(Object.keys(POCKET_VOICES).sort());
    expect(voices).not.toContain("cosette");
  });

  test("Token aus der Umgebung entfernt, Mindestlänge, Vergleich in konstanter Zeit", () => {
    expect(src).toContain(`TOKEN_ENV = "${POCKET_TOKEN_ENV}"`);
    expect(src).toContain("os.environ.pop(TOKEN_ENV");
    expect(src).toMatch(/^MIN_TOKEN_CHARS = 32$/m);
    expect(src).toContain("hmac.compare_digest(auth, self.expected_auth)");
  });

  test("nur GET /health und POST /tts, Textgrenze und Body-Grenze", () => {
    expect(src).toMatch(/^ROUTES = \{\("GET", "\/health"\), \("POST", "\/tts"\)\}$/m);
    expect(src).toMatch(/^MAX_TEXT_CHARS = 6000$/m);
    expect(src).toMatch(/^MAX_BODY_BYTES = 64 \* 1024$/m);
  });

  test("uvicorn nur auf 127.0.0.1 ohne Proxy-Köpfe, App nur hinter Guard; Stimmenauflösung danach gesperrt", () => {
    const run = src.slice(src.indexOf("uvicorn.run("));
    expect(run).toContain("Guard(pocket_main.web_app, token, args.port)");
    expect(run).toContain('host="127.0.0.1"');
    expect(run).toContain("proxy_headers=False");
    expect(src).toContain("model.get_state_for_audio_prompt = _refuse_voice");
    expect(src).toContain("model._cached_get_state_for_audio_prompt = _refuse_voice");
    expect(POCKET_LANGUAGE).toBe("german");
  });
});
