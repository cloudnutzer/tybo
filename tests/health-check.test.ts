/**
 * Nachtcheck (src/health-check.ts): reine Teile ohne Netz und ohne launchctl.
 * Report-Format, Zeitlimit je Prüfung, Auswertung von launchctl, Edge
 * Functions, Embedding-Quote, Log-Fenster über gespeicherte Dateigrößen,
 * hängende Jobs, Schwärzen von Geheimnissen.
 */
import { describe, expect, test } from "bun:test";
import {
  countLogIssues,
  evaluateEdgeStatuses,
  evaluateEmbeddingRatio,
  evaluateOtherServices,
  findStuckJobs,
  formatReport,
  nextSnapshots,
  parseDfAvailableBytes,
  parseLaunchctlList,
  pickBaseline,
  redact,
  runCheck,
  type CheckResult,
} from "../src/health-check";
import type { JobStatus } from "../src/lib/jobs/store";

const H = 60 * 60 * 1000;
const NOW = Date.parse("2026-10-01T01:30:00Z");

describe("formatReport", () => {
  test("alles grün: Kopfzeile mit Datum, eine Zeile pro Prüfung", () => {
    const report = formatReport(
      [
        { name: "Bot-Prozess", status: "ok", detail: "läuft (PID 1)" },
        { name: "WebUI", status: "na", detail: "aus" },
      ],
      new Date(NOW),
      "Europe/Berlin"
    );
    expect(report.split("\n")).toEqual(["tybo Nachtcheck 1.10.: alles grün", "✅ Bot-Prozess: läuft (PID 1)", "– WebUI: aus"]);
  });

  test("Probleme zuerst, mit Grund und nächstem Schritt; Hinweis nur bei warn/fail", () => {
    const results: CheckResult[] = [
      { name: "A", status: "ok", detail: "gut", hint: "nie zu sehen" },
      { name: "B", status: "warn", detail: "3x timeout", hint: "Log ansehen" },
      { name: "C", status: "fail", detail: "HTTP 401", hint: "Schlüssel prüfen" },
      { name: "D", status: "fail", detail: "kein Treffer" },
    ];
    const lines = formatReport(results, new Date(NOW), "Europe/Berlin").split("\n");
    expect(lines[0]).toBe("tybo Nachtcheck 1.10.: 2 Probleme, 1 Warnung");
    expect(lines.slice(1)).toEqual(["❌ C: HTTP 401. Schlüssel prüfen", "❌ D: kein Treffer", "⚠️ B: 3x timeout. Log ansehen", "✅ A: gut"]);
  });
});

describe("runCheck", () => {
  test("Zeitlimit: ❌ mit Grund, andere Prüfungen laufen weiter", async () => {
    const [slow, fine] = await Promise.all([
      runCheck("langsam", () => new Promise(() => {}), 20),
      runCheck("schnell", async () => ({ name: "schnell", status: "ok" })),
    ]);
    expect(slow).toEqual([{ name: "langsam", status: "fail", detail: "keine Antwort nach 0 s" }]);
    expect(fine[0].status).toBe("ok");
  });

  test("Ausnahme wird ❌, mehrere Ergebnisse bleiben einzeln", async () => {
    const [failed] = await runCheck("kaputt", async () => {
      throw new Error("REST HTTP 500");
    });
    expect(failed).toEqual({ name: "kaputt", status: "fail", detail: "Error: REST HTTP 500" });
    const many = await runCheck("x", async () => [
      { name: "a", status: "ok" },
      { name: "b", status: "ok" },
    ]);
    expect(many.map(r => r.name)).toEqual(["a", "b"]);
  });
});

describe("launchctl", () => {
  const list = [
    "PID\tStatus\tLabel",
    "3649\t0\tai.tybo.telegram-relay",
    "-\t0\tai.tybo.morning-briefing",
    "-\t1\tai.tybo.whatsapp-gateway",
    "-\t0\tai.tybo.health-check",
    "78009\t0\tai.tybo.cloudflare-tunnel",
    "123\t0\tcom.apple.fremd",
  ].join("\n");

  test("nur ai.tybo.*, PID und letzter Exit", () => {
    expect(parseLaunchctlList(list)).toEqual([
      { service: "telegram-relay", pid: 3649, lastExit: 0 },
      { service: "morning-briefing", pid: null, lastExit: 0 },
      { service: "whatsapp-gateway", pid: null, lastExit: 1 },
      { service: "health-check", pid: null, lastExit: 0 },
      { service: "cloudflare-tunnel", pid: 78009, lastExit: 0 },
    ]);
  });

  test("weitere Dienste: Exit ungleich 0 ohne Prozess ist ⚠️; Bot, Tunnel und Nachtcheck zählen nicht", () => {
    const r = evaluateOtherServices(parseLaunchctlList(list));
    expect(r.status).toBe("warn");
    expect(r.detail).toBe("whatsapp-gateway Exit 1");
    // laufender Dienst mit altem Fehler-Exit ist in Ordnung
    expect(evaluateOtherServices([{ service: "watchdog", pid: 5, lastExit: -15 }]).status).toBe("ok");
    expect(evaluateOtherServices([]).status).toBe("na");
  });
});

describe("Edge Functions", () => {
  test("400 auf {} heißt erreichbar", () => {
    expect(evaluateEdgeStatuses({ a: 400, b: 400, c: 400 }).status).toBe("ok");
  });

  test("401 wie am 9.9.: ❌ mit Hinweis auf die Schlüssel", () => {
    const r = evaluateEdgeStatuses({ "store-telegram-message": 401, "search-memory": 400 });
    expect(r.status).toBe("fail");
    expect(r.detail).toBe("store-telegram-message HTTP 401");
    expect(r.hint).toContain("Schlüssel");
  });

  test("404 und Netzfehler", () => {
    expect(evaluateEdgeStatuses({ a: 404 }).hint).toContain("tybo setup suche");
    expect(evaluateEdgeStatuses({ a: "Zeitlimit überschritten" }).detail).toBe("a Zeitlimit überschritten");
    expect(evaluateEdgeStatuses({ a: 503 }).status).toBe("fail");
  });
});

describe("Embedding-Quote", () => {
  test("unter 90% ❌ (der Fall vom 9. bis 30.9.)", () => {
    expect(evaluateEmbeddingRatio("N", 0, 40, "").status).toBe("fail");
    expect(evaluateEmbeddingRatio("N", 89, 100, "").status).toBe("fail");
    expect(evaluateEmbeddingRatio("N", 90, 100, "").status).toBe("ok");
    expect(evaluateEmbeddingRatio("N", 59, 60, "").detail).toBe("59/60 mit Vektor (98%)");
  });

  test("keine Einträge: ✅ mit Hinweistext", () => {
    expect(evaluateEmbeddingRatio("N", 0, 0, "keine neuen Nachrichten")).toEqual({ name: "N", status: "ok", detail: "keine neuen Nachrichten" });
  });
});

describe("Log-Fenster ohne Zeitstempel pro Zeile", () => {
  test("erster Lauf: ganzes Log", () => {
    expect(pickBaseline([], 500, NOW)).toEqual({ offset: 0, since: null });
  });

  test("Stand von vor mindestens 24h geht vor jüngeren", () => {
    const snaps = [
      { at: NOW - 30 * H, size: 100 },
      { at: NOW - 25 * H, size: 200 },
      { at: NOW - 2 * H, size: 400 },
    ];
    expect(pickBaseline(snaps, 500, NOW)).toEqual({ offset: 200, since: NOW - 25 * H });
  });

  test("nur jüngere Stände: ab dem ältesten", () => {
    expect(pickBaseline([{ at: NOW - 3 * H, size: 300 }, { at: NOW - H, size: 450 }], 500, NOW)).toEqual({ offset: 300, since: NOW - 3 * H });
  });

  test("Datei kleiner geworden: ab Anfang, alte Stände fallen weg", () => {
    const snaps = [{ at: NOW - 25 * H, size: 900 }];
    expect(pickBaseline(snaps, 100, NOW)).toEqual({ offset: 0, since: null });
    expect(nextSnapshots(snaps, 100, NOW)).toEqual([{ at: NOW, size: 100 }]);
  });

  test("behält 3 Tage und den jüngsten älteren Stand", () => {
    const snaps = [
      { at: NOW - 100 * H, size: 1 },
      { at: NOW - 80 * H, size: 2 },
      { at: NOW - 50 * H, size: 3 },
    ];
    expect(nextSnapshots(snaps, 4, NOW)).toEqual([
      { at: NOW - 80 * H, size: 2 },
      { at: NOW - 50 * H, size: 3 },
      { at: NOW, size: 4 },
    ]);
  });

  test("zählt die Muster aus Bot- und Fehler-Log", () => {
    const text = [
      "[Claude streaming] timeout (idle) after 1020s, last activity 910s ago",
      "Claude streaming timeout/idle, kein Fallback (steps=8, sessionId=ja)",
      "🔄 Fallback: trying OpenRouter (anthropic/claude-opus-5.5) with 32 tools...",
      "[saveMessage] Edge Function store-telegram-message: HTTP 401, Direkt-Insert ohne Embedding",
      "[web] Modellliste: Ollama ist nicht erreichbar",
    ].join("\n");
    expect(Object.fromEntries(countLogIssues(text))).toEqual({
      "timeout (idle)": 1,
      "kein Fallback": 1,
      "Fallback OpenRouter": 1,
      "saveMessage ohne Embedding": 1,
    });
  });
});

describe("Hintergrund-Jobs", () => {
  const job = (over: Partial<JobStatus>): JobStatus => ({
    version: 1,
    id: "20261001-000000-abcdef",
    title: "Test",
    createdAt: new Date(NOW - H).toISOString(),
    startedAt: new Date(NOW - H).toISOString(),
    phase: "running",
    maxHours: 3,
    model: "m",
    fullAccess: false,
    target: {},
    watcher: { pid: 42, identity: null },
    ...over,
  });

  test("über der Frist oder ohne Wächter hängt, beendete zählen nicht", () => {
    const alive = (pid: number | undefined) => pid === 42;
    const r = findStuckJobs(
      [
        job({}),
        job({ title: "Alt", startedAt: new Date(NOW - 4 * H).toISOString() }),
        job({ title: "Waise", watcher: { pid: 7, identity: null } }),
        job({ title: "Fertig", phase: "ended", startedAt: new Date(NOW - 99 * H).toISOString() }),
      ],
      NOW,
      alive
    );
    expect(r.running).toBe(3);
    expect(r.stuck).toEqual(["Alt (über der Frist)", "Waise (Wächter tot)"]);
  });
});

test("df: freier Platz in Bytes", () => {
  const out = "Filesystem 1024-blocks Used Available Capacity iused ifree %iused Mounted on\n/dev/disk3s5 971350180 800000000 134217728 86% 1 2 0% /System/Volumes/Data";
  expect(parseDfAvailableBytes(out)).toBe(134217728 * 1024);
  expect(parseDfAvailableBytes("kaputt")).toBeNull();
});

test("redact: Werte geheimer Variablen verschwinden, andere bleiben", () => {
  const env = { TELEGRAM_BOT_TOKEN: "123456:ABCDEFGHIJ", USER_NAME: "Erika Muster", OPENAI_API_KEY: "sk-geheim-123" };
  expect(redact("url bot123456:ABCDEFGHIJ/getMe, key sk-geheim-123, Erika Muster", env)).toBe("url bot***/getMe, key ***, Erika Muster");
});
