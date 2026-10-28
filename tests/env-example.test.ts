/**
 * Issue #380 (U3-6): Aufbau von .env.example.
 *
 * - Jeder Zugang, den src/lib/credentials.ts mit declareCredential anmeldet,
 *   steht als Zeile NAME= (auch auskommentiert) in der Vorlage. Die Namen
 *   kommen aus dem Quelltext, nicht aus credentialStatus(): das liest echte
 *   Zugangsdaten.
 * - Die Abschnitte zu den Schritten von `tybo setup` tragen „(tybo setup
 *   <schritt>)“ in der Überschrift und stehen in der Reihenfolge von
 *   SETUP_STEPS, vor allen übrigen Abschnitten. Die Variablen, die ein
 *   Schritt schreibt oder prüft, stehen in dessen Abschnitt.
 * - Convex und USE_AGENT_SDK kommen nicht mehr vor, und der Abo-Zähler
 *   verspricht keinen Modellwechsel.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { SETUP_STEPS } from "../src/setup/steps";

const ROOT = resolve(import.meta.dir, "..");
const EXAMPLE = readFileSync(join(ROOT, ".env.example"), "utf8");
const LINES = EXAMPLE.split("\n");

const HEADING = /^# --- (.+) ---$/;
const STEP_IN_HEADING = /\(tybo setup ([a-z]+)\)/;

/** Zeilennummer der ersten Zeile NAME=, auch auskommentiert; -1, wenn es sie nicht gibt */
function firstAssignment(name: string): number {
  const re = new RegExp(`^#?\\s*${name}=`);
  return LINES.findIndex(l => re.test(l));
}

interface Section {
  title: string;
  step: string | null;
  start: number;
  end: number;
}

function sections(): Section[] {
  const starts = LINES.flatMap((l, i) => (HEADING.test(l) ? [i] : []));
  return starts.map((start, n) => {
    const title = HEADING.exec(LINES[start])![1];
    return { title, step: STEP_IN_HEADING.exec(title)?.[1] ?? null, start, end: starts[n + 1] ?? LINES.length };
  });
}

/** Variablen, die der jeweilige Schritt schreibt oder prüft (src/setup/steps/) */
const STEP_VARIABLES: Record<string, string[]> = {
  voraussetzungen: ["CLAUDE_PATH", "CLAUDE_AUTH", "ANTHROPIC_API_KEY", "CODEX_PATH", "OPENCODE_PATH"],
  telegram: ["TELEGRAM_BOT_TOKEN", "TELEGRAM_USER_ID"],
  gruppe: ["TELEGRAM_GROUP_ID"],
  datenbank: ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_ANON_KEY"],
  suche: ["EMBEDDING_PROVIDER", "EMBEDDING_MODEL", "OPENAI_API_KEY", "GEMINI_API_KEY", "OLLAMA_URL"],
  profil: ["USER_NAME", "USER_TIMEZONE"],
  modelle: ["OPENROUTER_API_KEY", "OPENROUTER_MODEL", "OLLAMA_MODEL", "FALLBACK_OFFLINE_ONLY"],
  sprache: ["SPEECH_STT", "SPEECH_TTS", "SPEECH_CALL_MODEL", "ELEVENLABS_API_KEY"],
  webui: ["WEB_ENABLED", "WEB_PASSWORD", "WEB_HOST", "WEB_PORT"],
  zugang: ["WEB_PUBLIC_ORIGIN", "WEB_ACCESS_TEAM", "WEB_ACCESS_AUD"],
  google: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN"],
  autostart: ["TYBO_LAUNCHD_LABEL"],
};

describe(".env.example und src/lib/credentials.ts", () => {
  const source = readFileSync(join(ROOT, "src/lib/credentials.ts"), "utf8");
  const declared = [...source.matchAll(/declareCredential\(\{\s*name:\s*"([A-Z][A-Z0-9_]*)"/g)].map(m => m[1]);

  test("die Registry meldet Zugänge an (sonst prüft der nächste Test nichts)", () => {
    expect(declared.length).toBeGreaterThanOrEqual(5);
    expect(declared).toContain("FIRECRAWL_API_KEY");
  });

  test("jeder angemeldete Zugang steht als NAME= in der Vorlage", () => {
    expect(declared.filter(n => firstAssignment(n) < 0)).toEqual([]);
  });
});

describe("Gliederung nach tybo setup", () => {
  const all = sections();
  const stepIds = SETUP_STEPS.map(s => s.id).filter(id => id !== "pruefung");

  test("jeder Schritt hat genau einen Abschnitt, in der Reihenfolge von SETUP_STEPS", () => {
    expect(all.filter(s => s.step).map(s => s.step)).toEqual(stepIds);
  });

  test("die Abschnitte der Schritte stehen vor allen übrigen", () => {
    const firstOther = all.findIndex(s => !s.step);
    const lastStep = all.map(s => !!s.step).lastIndexOf(true);
    expect(firstOther).toBeGreaterThan(lastStep);
  });

  test("die Tabelle oben deckt alle Schritte ab", () => {
    expect(Object.keys(STEP_VARIABLES)).toEqual(stepIds);
  });

  for (const [step, names] of Object.entries(STEP_VARIABLES)) {
    test(`Variablen von ${step} stehen in dessen Abschnitt`, () => {
      const section = all.find(s => s.step === step)!;
      expect(section).toBeDefined();
      const misplaced = names.filter(n => {
        const at = firstAssignment(n);
        return at < section.start || at >= section.end;
      });
      expect(misplaced).toEqual([]);
    });
  }

  test("kein Name wird zweimal als NAME= eingeführt", () => {
    const seen = new Map<string, number>();
    for (const l of LINES) {
      const m = /^#?\s*([A-Z][A-Z0-9_]*)=/.exec(l);
      if (m) seen.set(m[1], (seen.get(m[1]) ?? 0) + 1);
    }
    expect([...seen].filter(([, n]) => n > 1).map(([name]) => name)).toEqual([]);
  });
});

describe("entfallene Inhalte", () => {
  test("Convex und USE_AGENT_SDK kommen nicht mehr vor", () => {
    expect(EXAMPLE).not.toMatch(/convex/i);
    expect(EXAMPLE).not.toContain("USE_AGENT_SDK");
    expect(EXAMPLE).not.toMatch(/agent sdk/i);
  });

  test("der Abo-Zähler verspricht keinen Modellwechsel, CREDIT_GUARD=off lässt die Buchung", () => {
    expect(EXAMPLE).not.toMatch(/günstigste|billigste|cheapest|routet/i);
    const at = firstAssignment("CREDIT_GUARD");
    expect(at).toBeGreaterThan(0);
    const block = LINES.slice(Math.max(0, at - 20), at + 3).join("\n");
    expect(block).toMatch(/keinen? Modellwechsel/);
    expect(block).toMatch(/CLAUDE_AUTH=subscription/);
    expect(LINES[at]).toContain("gebucht");
  });
});
