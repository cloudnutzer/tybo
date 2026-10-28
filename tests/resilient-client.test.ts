/**
 * Issue #382: Ausweichen von Anthropic auf OpenRouter (src/lib/resilient-client.ts),
 * festgehalten vor dem Neuschreiben. Der Ablauf läuft in einem eigenen
 * Prozess (tests/resilient-client-fixture.ts), weil das Anthropic-SDK fetch
 * beim ersten Laden festhält; die Attrappe dort beantwortet alle Anfragen.
 *
 * Beobachtet und so festgelegt:
 * - Anthropic zuerst, mit dem Modell und den Werkzeugen wie übergeben
 * - Guthaben-, Schlüssel- oder Lastfehler (Status 400, 401, 402, 429, 529
 *   oder eine passende Meldung) mit OPENROUTER_API_KEY: dieselbe Anfrage an
 *   OpenRouter, Modell mit Präfix anthropic/, ohne web_search, mit den
 *   App-Kopfzeilen von tybo
 * - danach gleich OpenRouter, auch nach mehr als 15 Minuten (der alte Code
 *   prüfte die Erholung nur in einem Weg, den niemand aufrief)
 * - ohne OPENROUTER_API_KEY bleibt es bei Anthropic, Fehler kommen durch
 * - andere Fehler kommen durch, ohne Ausweichen
 * - abgebrochene Ausführung: AbortError ohne Anfrage
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const FIXTURE = join(import.meta.dir, "resilient-client-fixture.ts");

interface Request {
  url: string;
  model: string;
  tools: string[];
  apiKey: string | null;
  referer: string | null;
  title: string | null;
}
interface Step {
  name: string;
  answer: string | null;
  error: string | null;
  requests: Request[];
}

function run(extra: Record<string, string>): Record<string, Step> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== "OPENROUTER_API_KEY" && key !== "ANTHROPIC_API_KEY") env[key] = value;
  }
  const result = Bun.spawnSync({
    cmd: [process.execPath, FIXTURE],
    env: { ...env, ANTHROPIC_API_KEY: "attrappe-anthropic", ...extra },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode).toBe(0);
  // Die letzte Zeile ist das Ergebnis, davor stehen Log-Zeilen
  const lines = result.stdout.toString().trim().split("\n");
  const steps: Step[] = JSON.parse(lines[lines.length - 1]);
  return Object.fromEntries(steps.map(s => [s.name, s]));
}

const ANTHROPIC: Request = {
  url: "https://api.anthropic.com/v1/messages",
  model: "claude-test-1",
  tools: ["web_search_20250305", "eigenes_werkzeug"],
  apiKey: "attrappe-anthropic",
  referer: null,
  title: null,
};
const OPENROUTER: Request = {
  url: "https://openrouter.ai/api/v1/messages",
  model: "anthropic/claude-test-1",
  tools: ["eigenes_werkzeug"],
  apiKey: "attrappe-openrouter",
  referer: "https://tybo.ai",
  title: "tybo",
};

/** Gemeinsamer Ablauf mit OpenRouter, egal welcher Fehler den Ausfall auslöst */
function expectFailover(steps: Record<string, Step>) {
  expect(steps.ok).toMatchObject({ answer: "von Anthropic", error: null, requests: [ANTHROPIC] });
  expect(steps["anderer-fehler"]).toMatchObject({ answer: null, error: "Error:404", requests: [ANTHROPIC] });
  expect(steps.ausfall).toMatchObject({ answer: "von OpenRouter", error: null, requests: [ANTHROPIC, OPENROUTER] });
  expect(steps.gestoert).toMatchObject({ answer: "von OpenRouter", requests: [OPENROUTER] });
  expect(steps["nach-16-minuten"]).toMatchObject({ answer: "von OpenRouter", requests: [OPENROUTER] });
  expect(steps["gestoert-ohne-openrouter"]).toMatchObject({ answer: "von Anthropic", requests: [ANTHROPIC] });
  expect(steps.abgebrochen).toMatchObject({ answer: null, error: "AbortError:", requests: [] });
}

describe("createResilientMessage", () => {
  test("Status 402 mit OpenRouter: Ausweichen und dabei bleiben", () => {
    expectFailover(run({ OPENROUTER_API_KEY: "attrappe-openrouter", TYBO_FIXTURE_OUTAGE_STATUS: "402" }));
  });

  test("Status 400 zählt ebenso als Ausfall", () => {
    expectFailover(run({ OPENROUTER_API_KEY: "attrappe-openrouter", TYBO_FIXTURE_OUTAGE_STATUS: "400" }));
  });

  test("Meldung insufficient_quota bei Status 404 zählt als Ausfall", () => {
    expectFailover(run({ OPENROUTER_API_KEY: "attrappe-openrouter", TYBO_FIXTURE_OUTAGE_MESSAGE: "insufficient_quota" }));
  });

  test("ohne OpenRouter: der Fehler kommt durch, nie eine Anfrage an OpenRouter", () => {
    const steps = run({ TYBO_FIXTURE_OUTAGE_STATUS: "402" });
    expect(steps.ok).toMatchObject({ answer: "von Anthropic", requests: [ANTHROPIC] });
    expect(steps["anderer-fehler"]).toMatchObject({ error: "Error:404", requests: [ANTHROPIC] });
    expect(steps.ausfall).toMatchObject({ answer: null, error: "Error:402", requests: [ANTHROPIC] });
    expect(steps.gestoert).toMatchObject({ answer: "von Anthropic", requests: [ANTHROPIC] });
    expect(steps.abgebrochen).toMatchObject({ error: "AbortError:", requests: [] });
  });
});
