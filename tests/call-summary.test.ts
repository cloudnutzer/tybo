import { test, expect, describe, beforeEach, afterEach, spyOn } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import * as claudeModule from "../src/lib/claude";
import * as auxModule from "../src/lib/aux-model";
import { abortError } from "../src/lib/execution-context";
import { setSettingsPath } from "../src/lib/settings";
import { summarizeTranscript, summarizeTranscriptStrict, extractTaskFromTranscript } from "../src/lib/call-summary";
import * as phoneService from "../src/lib/phone/service";
import { createPhone } from "../src/lib/phone";

// Anruf-Zusammenfassung (Issue #306) über den Aux-Zweck call-summary. Die CLI
// bzw. Ollama sind Attrappen unterhalb von callAux; es läuft kein echtes
// Modell, kein Netz, und config/settings.json des Checkouts bleibt ungelesen.

const ENV_KEYS = ["ANTHROPIC_API_KEY", "OPENROUTER_API_KEY", "AUX_MODEL_CALL_SUMMARY"] as const;
const HAIKU = "claude-haiku-5-5";
const savedEnv: Record<string, string | undefined> = {};
const realFetch = globalThis.fetch;
let spies: { mockRestore(): void }[] = [];
let dir: string;

beforeEach(() => {
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  dir = mkdtempSync(join(tmpdir(), "tybo-call-summary-"));
  setSettingsPath(join(dir, "settings.json"));
  spies = [spyOn(console, "error").mockImplementation(() => {})];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  for (const s of spies) s.mockRestore();
  globalThis.fetch = realFetch;
  setSettingsPath();
  rmSync(dir, { recursive: true, force: true });
});

/** CLI-Attrappe unter callAux: Antwort festlegen; liefert die Aufrufe (Prompt, Modell) */
function model(reply: string | { isError: true }) {
  const calls: { prompt: string; model: string }[] = [];
  const spy = spyOn(claudeModule, "callClaude").mockImplementation((async (o: any) => {
    calls.push({ prompt: String(o.prompt), model: String(o.model) });
    return typeof reply === "string" ? { text: reply, isError: false } : { text: "", isError: true };
  }) as any);
  spies.push(spy);
  return calls;
}

/** Ollama-Attrappe (fetch); liefert die aufgerufenen Adressen und Modelle */
function ollama(content: string) {
  const calls: { url: string; model: string }[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), model: JSON.parse(String(init?.body ?? "{}")).model });
    return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return calls;
}

const LONG = "A".repeat(5000) + "B".repeat(5000);
const FAILED = (t: string) => t.slice(0, 500) + "\n\n(Summarization failed)";

test("der Anrufdienst fasst über call-summary zusammen und sucht dort den Auftrag", () => {
  // Attrappe für den Dienst: createPhone soll ihn mit den Funktionen aus call-summary.ts bauen.
  // Die strenge Fassung wirft bei Modellfehlern, nur so versucht der Dienst es erneut.
  let deps: Record<string, unknown> | undefined;
  spies.push(spyOn(phoneService, "createPhoneService").mockImplementation(((d: Record<string, unknown>) => {
    deps = d;
    return {} as never;
  }) as any));
  createPhone({
    send: async () => ({ ok: true }) as never,
    sendChoice: async () => ({ sent: true }),
    task: {} as never,
    env: { GO_PROJECT_ROOT: dir },
    log: () => {},
  });
  expect(deps?.summarize).toBe(summarizeTranscriptStrict);
  expect(deps?.findTask).toBe(extractTaskFromTranscript);
});

test("src/lib/voice.ts und seine nur dort genutzten Module gibt es nicht mehr (Issue #439)", () => {
  for (const name of ["voice.ts", "mac-health.ts", "capabilities.ts"]) {
    expect(existsSync(join(import.meta.dir, "..", "src", "lib", name))).toBe(false);
  }
});

describe("summarizeTranscript", () => {
  test("gibt den Text des Modells zurück, Standard ist Haiku über die CLI", async () => {
    const calls = model("Kurz: alles gut.");
    expect(await summarizeTranscript("Hallo")).toBe("Kurz: alles gut.");
    expect(calls.map(c => c.model)).toEqual([HAIKU]);
  });

  test("schickt nur die ersten 6000 Zeichen", async () => {
    const calls = model("ok");
    await summarizeTranscript(LONG);
    expect(calls[0].prompt).toContain(LONG.slice(0, 6000));
    expect(calls[0].prompt).not.toContain(LONG.slice(0, 6001));
  });

  test("isError: erste 500 Zeichen plus Hinweis", async () => {
    model({ isError: true });
    expect(await summarizeTranscript(LONG)).toBe(FAILED(LONG));
  });

  test("leere Antwort: derselbe Rückfall", async () => {
    model("");
    expect(await summarizeTranscript(LONG)).toBe(FAILED(LONG));
    model("  \n ");
    expect(await summarizeTranscript("kurz")).toBe(FAILED("kurz"));
  });

  test("geworfener Fehler (Abbruch vor dem Aufruf): derselbe Rückfall", async () => {
    spies.push(spyOn(auxModule, "callAux").mockRejectedValue(abortError()));
    expect(await summarizeTranscript(LONG)).toBe(FAILED(LONG));
  });
});

describe("summarizeTranscriptStrict (Anrufdienst)", () => {
  test("gibt den Text des Modells zurück", async () => {
    model("Kurz: alles gut.");
    expect(await summarizeTranscriptStrict("Hallo")).toBe("Kurz: alles gut.");
  });

  test("isError, leere Antwort und geworfener Fehler: wirft statt Rückfall", async () => {
    model({ isError: true });
    await expect(summarizeTranscriptStrict(LONG)).rejects.toThrow("Zusammenfassung nicht möglich");
    model("  ");
    await expect(summarizeTranscriptStrict(LONG)).rejects.toThrow("Zusammenfassung nicht möglich");
    spies.push(spyOn(auxModule, "callAux").mockRejectedValue(abortError()));
    await expect(summarizeTranscriptStrict(LONG)).rejects.toThrow("Zusammenfassung nicht möglich");
  });
});

describe("extractTaskFromTranscript", () => {
  test("schickt Zusammenfassung und die letzten 2000 Zeichen", async () => {
    const calls = model("Draft an email to the team");
    expect(await extractTaskFromTranscript(LONG, "ZUSAMMENFASSUNG-X")).toBe("Draft an email to the team");
    expect(calls[0].prompt).toContain("ZUSAMMENFASSUNG-X");
    expect(calls[0].prompt).toContain(LONG.slice(-2000));
    expect(calls[0].prompt).not.toContain(LONG.slice(-2001));
    // Ausgabeform: NONE bzw. eine Anweisung, die mit einem Verb beginnt
    expect(calls[0].prompt).toContain("NONE");
    expect(calls[0].prompt).toContain("begins with a verb");
  });

  test.each([
    ["NONE", "NONE"],
    ["NONE mit Leerraum", "  NONE\n"],
    ["no actionable task, Groß-/Kleinschreibung egal", "There is No Actionable Task here."],
    ["kürzer als 10 Zeichen", "Call Bob"],
    ["leere Antwort", ""],
    ["nur Leerraum", "   \n "],
  ])("null bei %s", async (_name, reply) => {
    model(reply);
    expect(await extractTaskFromTranscript("t", "s")).toBeNull();
  });

  test("null bei isError", async () => {
    model({ isError: true });
    expect(await extractTaskFromTranscript("t", "s")).toBeNull();
  });

  test("null bei geworfenem Fehler", async () => {
    spies.push(spyOn(auxModule, "callAux").mockRejectedValue(abortError()));
    expect(await extractTaskFromTranscript("t", "s")).toBeNull();
  });

  test.each([
    ["Anführungszeichen am Rand", "\"Draft an email to Mia\"", "Draft an email to Mia"],
    ["einfache Anführungszeichen", "'Research flight prices'", "Research flight prices"],
    ["Präfix Task:", "Task: Create a presentation", "Create a presentation"],
    ["Präfix in Anführungszeichen", "\"task:   Set up the calendar\"", "Set up the calendar"],
    ["Leerraum am Rand", "  Draft an email to Alex  ", "Draft an email to Alex"],
  ])("bereinigt %s", async (_name, reply, expected) => {
    model(reply);
    expect(await extractTaskFromTranscript("t", "s")).toBe(expected);
  });

  test("Mindestlänge gilt vor der Bereinigung", async () => {
    // 10 Zeichen mit Anführungszeichen, danach nur noch 8: bleibt erhalten
    model("\"Call Bob\"");
    expect(await extractTaskFromTranscript("t", "s")).toBe("Call Bob");
  });

  test("Präfix wird erst nach den Anführungszeichen entfernt", async () => {
    // Anführungszeichen nach dem Präfix bleiben stehen
    model("Task: \"Draft an email\"");
    expect(await extractTaskFromTranscript("t", "s")).toBe("\"Draft an email");
  });
});

describe("ohne ANTHROPIC_API_KEY und ohne OPENROUTER_API_KEY", () => {
  test("CLI-Attrappe wird aufgerufen, ihr Text kommt zurück", async () => {
    const calls = model("Book a table for Friday");
    expect(await summarizeTranscript("Hallo")).toBe("Book a table for Friday");
    expect(await extractTaskFromTranscript("Hallo", "s")).toBe("Book a table for Friday");
    expect(calls).toHaveLength(2);
  });

  test("Ollama-Attrappe wird aufgerufen, ihr Text kommt zurück", async () => {
    process.env.AUX_MODEL_CALL_SUMMARY = "ollama:qwen3:8b";
    const claude = model("nicht gefragt");
    const calls = ollama("Book a table for Friday");
    expect(await summarizeTranscript("Hallo")).toBe("Book a table for Friday");
    expect(await extractTaskFromTranscript("Hallo", "s")).toBe("Book a table for Friday");
    expect(calls.map(c => c.model)).toEqual(["qwen3:8b", "qwen3:8b"]);
    expect(calls.every(c => c.url.startsWith("http://localhost:11434/"))).toBe(true);
    expect(claude).toEqual([]);
  });

  test("Ollama: leere Antwort ergibt Rückfall bzw. null", async () => {
    process.env.AUX_MODEL_CALL_SUMMARY = "ollama:qwen3:8b";
    ollama("");
    expect(await summarizeTranscript("Hallo")).toBe(FAILED("Hallo"));
    expect(await extractTaskFromTranscript("Hallo", "s")).toBeNull();
  });

  test("OpenRouter gewählt, aber kein Schlüssel: Rückfall bzw. null, kein Netzaufruf", async () => {
    process.env.AUX_MODEL_CALL_SUMMARY = "openrouter:x/y";
    const calls = ollama("nicht gefragt");
    expect(await summarizeTranscript("Hallo")).toBe(FAILED("Hallo"));
    expect(await extractTaskFromTranscript("Hallo", "s")).toBeNull();
    expect(calls).toEqual([]);
  });
});

describe("eigener Prozess: resilient-client wird nicht geladen", () => {
  const FIXTURE = join(import.meta.dir, "call-summary-fixture.ts");

  /** Startet die Fixture ohne beide Schlüssel; extra ergänzt bzw. überschreibt Variablen */
  function runFixture(extra: Record<string, string>) {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
    for (const k of ENV_KEYS) delete env[k];
    delete env.CLAUDE_PATH;
    Object.assign(env, { TYBO_FIXTURE_SETTINGS: join(dir, "fixture-settings.json") }, extra);
    const proc = Bun.spawnSync(["bun", FIXTURE], { env, cwd: dir, stdout: "pipe", stderr: "pipe" });
    const out = proc.stdout.toString().trim().split("\n").pop() ?? "";
    expect({ exit: proc.exitCode, stderr: proc.exitCode ? proc.stderr.toString() : "" }).toEqual({ exit: 0, stderr: "" });
    return JSON.parse(out);
  }

  /** CLI-Attrappe als ausführbare Datei: antwortet je nach Prompt, schreibt jeden Aufruf mit */
  function fakeCli(): { path: string; log: string } {
    const path = join(dir, "claude");
    const log = join(dir, "cli-calls");
    writeFileSync(
      path,
      [
        "#!/bin/sh",
        'input="$(cat)"',
        'case "$input" in',
        '  *"END OF TRANSCRIPT"*) text="Book a table for Friday" ;;',
        '  *) text="CLI-Zusammenfassung" ;;',
        "esac",
        `echo "$*" >> '${log}'`,
        `printf '[{"type":"result","subtype":"success","is_error":false,"result":"%s"}]' "$text"`,
        "",
      ].join("\n")
    );
    chmodSync(path, 0o755);
    return { path, log };
  }

  test("CLI-Attrappe: beide Funktionen liefern, Client und Anthropic-SDK bleiben ungeladen", () => {
    const cli = fakeCli();
    const result = runFixture({ CLAUDE_PATH: cli.path });
    expect(result).toEqual({
      summary: "CLI-Zusammenfassung",
      task: "Book a table for Friday",
      ollamaCalls: [],
      resilientLoaded: false,
      anthropicSdkLoaded: false,
    });
    const calls = readFileSync(cli.log, "utf8").trim().split("\n");
    expect(calls).toHaveLength(2);
    expect(calls.every(c => c.includes(`--model ${HAIKU}`))).toBe(true);
  });

  test("Ollama-Attrappe: beide Funktionen liefern, Client bleibt ungeladen, die CLI wird nicht gestartet", () => {
    const cli = fakeCli();
    const result = runFixture({ CLAUDE_PATH: cli.path, AUX_MODEL_CALL_SUMMARY: "ollama:qwen3:8b" });
    expect(result.summary).toBe("Ollama-Zusammenfassung");
    expect(result.task).toBe("Book a table for Friday");
    expect(result.ollamaCalls).toHaveLength(2);
    expect(result.resilientLoaded).toBe(false);
    expect(existsSync(cli.log)).toBe(false);
  });

  test("Gegenprobe: lädt die Fixture den Client absichtlich, erkennt der Test das", () => {
    const cli = fakeCli();
    const result = runFixture({ CLAUDE_PATH: cli.path, TYBO_FIXTURE_CONTROL: "1" });
    expect(result.resilientLoaded).toBe(true);
    expect(result.anthropicSdkLoaded).toBe(true);
  });
});
