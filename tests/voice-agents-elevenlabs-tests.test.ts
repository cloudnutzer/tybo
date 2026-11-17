/**
 * Issue #490: Testszenarien anlegen und abgleichen, Testlauf starten, Ergebnis
 * nach Zeitplan abholen. Nur gegen die Attrappe, mit Uhr-Attrappe.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElevenLabsLayer, POLL_SCHEDULE_MS, TEST_RUN_TIMEOUT_MS } from "../src/lib/voice-agents/elevenlabs";
import { parseLayerState, type VoiceLayerState } from "../src/lib/voice-agents/layer";
import { readState } from "../src/lib/voice-agents/state";
import { effectiveTests } from "../src/lib/voice-agents/prompt";
import { TEMPLATES } from "../src/lib/voice-agents/templates";
import { API_KEY, BRIDGE_ENV, BRIDGE_TOKEN, BRIDGE_URL, baseRecipe, bridgeRecipe, ENV, FakeElevenLabs, fakeClock, jsonResponse, recipeFrom } from "./voice-agents-elevenlabs-fixture";

const PROMPT = "Du bist ein Assistent.";
let root: string;
let paths: { dataDir: string };
let fake: FakeElevenLabs;
let clock: ReturnType<typeof fakeClock>;

function layer(env: Record<string, string | undefined> = ENV) {
  return createElevenLabsLayer({ env, fetch: fake.fetch, paths, clock });
}
async function deployed(raw = baseRecipe()): Promise<VoiceLayerState> {
  const result: any = await layer().deploy(recipeFrom(raw), PROMPT);
  fake.calls = [];
  return result.state;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tybo-sprachtests-"));
  paths = { dataDir: join(root, "voice-agents") };
  fake = new FakeElevenLabs();
  clock = fakeClock();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("syncTests", () => {
  test("legt die Standard-Tests der Vorlage und die des Rezepts an", async () => {
    const state = await deployed();
    const recipe = recipeFrom(baseRecipe());
    const expected = effectiveTests(recipe, TEMPLATES.jarvis);
    const result: any = await layer().syncTests(recipe, state);
    expect(result.status).toBe("ok");
    expect(result.angelegt).toEqual(expected.map((item) => item.name));
    expect(result.angelegt).toContain("Notfall");
    expect(result.angelegt).toContain("Erster");
    expect(Object.keys(result.state.tests)).toEqual(expected.map((item) => item.name));
    expect(fake.tests.size).toBe(expected.length);
  });

  test("überträgt Szenario, Kriterien und Züge als Simulation", async () => {
    const state = await deployed();
    await layer().syncTests(recipeFrom(baseRecipe()), state);
    const bodies = fake.of("POST", /^\/agent-testing\/create$/).map((call) => call.body);
    expect(bodies.find((body) => body.name === "beispiel: Erster")).toEqual({
      type: "simulation",
      name: "beispiel: Erster",
      simulation_scenario: "Jemand fragt nach",
      success_conditions: ["antwortet"],
      simulation_max_turns: 4,
    });
  });

  test("wiederholter Abgleich: kein Aufruf, keine Duplikate", async () => {
    const state = await deployed();
    const recipe = recipeFrom(baseRecipe());
    const first: any = await layer().syncTests(recipe, state);
    const count = fake.tests.size;
    fake.calls = [];
    const second: any = await layer().syncTests(recipe, first.state);
    expect(second.status).toBe("ok");
    expect(second.angelegt).toEqual([]);
    expect(second.unveraendert).toHaveLength(count);
    expect(fake.calls).toHaveLength(0);
    expect(fake.tests.size).toBe(count);
  });

  test("geändertes Szenario wird aktualisiert, die Kennung bleibt", async () => {
    const raw = baseRecipe();
    const state = await deployed(raw);
    const first: any = await layer().syncTests(recipeFrom(raw), state);
    const id = first.state.tests.Erster.id;
    raw.tests[0].szenario = "Jemand fragt anders";
    fake.calls = [];
    const second: any = await layer().syncTests(recipeFrom(raw), first.state);
    expect(second.geaendert).toEqual(["Erster"]);
    expect(fake.of("PUT", /.*/)).toHaveLength(1);
    expect(fake.of("POST", /.*/)).toHaveLength(0);
    expect(second.state.tests.Erster.id).toBe(id);
    expect(fake.tests.get(id).simulation_scenario).toBe("Jemand fragt anders");
  });

  test("entferntes Szenario wird gelöscht, der Standard-Test bleibt", async () => {
    const raw = baseRecipe();
    raw.tests.push({ name: "Dritter", szenario: "Noch einer", kriterien: ["ok"], maxZuege: 2 });
    const state = await deployed(raw);
    const first: any = await layer().syncTests(recipeFrom(raw), state);
    const id = first.state.tests.Dritter.id;
    raw.tests.pop();
    const second: any = await layer().syncTests(recipeFrom(raw), first.state);
    expect(second.entfernt).toEqual(["Dritter"]);
    expect(second.state.tests.Dritter).toBeUndefined();
    expect(second.state.tests.Notfall).toBeDefined();
    expect(fake.tests.has(id)).toBe(false);
  });

  test("von Hand gelöschter Test wird beim Ändern neu angelegt", async () => {
    const raw = baseRecipe();
    const first: any = await layer().syncTests(recipeFrom(raw), await deployed(raw));
    fake.tests.delete(first.state.tests.Erster.id);
    raw.tests[0].maxZuege = 9;
    const second: any = await layer().syncTests(recipeFrom(raw), first.state);
    expect(second.angelegt).toEqual(["Erster"]);
    expect(second.state.tests.Erster.id).not.toBe(first.state.tests.Erster.id);
  });

  test("Teilerfolg bleibt erhalten; bei unverändertem Agenten holt ein neuer Aufruf nur den Rest nach", async () => {
    const raw = baseRecipe();
    const recipe = recipeFrom(raw);
    const state = await deployed(raw);
    let seen = 0;
    fake.override(
      (call) => call.path === "/agent-testing/create" && ++seen === 2,
      () => jsonResponse({ detail: "später" }, 503),
    );
    const failed: any = await layer().syncTests(recipe, state);
    expect(failed).toMatchObject({ status: "fehler", vorlaeufig: true });
    expect(Object.keys(failed.state.tests)).toHaveLength(1);
    const kept = Object.values<any>(failed.state.tests)[0].id;

    // Der Agent selbst ist abgeglichen: deploy ruft nichts auf, syncTests holt nach
    fake.calls = [];
    expect((await layer().deploy(recipe, PROMPT)).status).toBe("unveraendert");
    expect(fake.calls).toHaveLength(0);
    const retried: any = await layer().syncTests(recipe, failed.state);
    expect(retried.status).toBe("ok");
    expect(Object.values<any>(retried.state.tests).map((item) => item.id)).toContain(kept);
    expect(fake.tests.size).toBe(effectiveTests(recipe, TEMPLATES.jarvis).length);
    expect(fake.of("POST", /^\/agent-testing\/create$/).map((call) => call.body.name)).not.toContain(Object.keys(failed.state.tests)[0]);
  });

  test("Antwort ohne Kennung ist ein Fehler, kein leerer Eintrag", async () => {
    const state = await deployed();
    fake.override((call) => call.path === "/agent-testing/create", () => jsonResponse({ id: "" }));
    const result: any = await layer().syncTests(recipeFrom(baseRecipe()), state);
    expect(result.status).toBe("fehler");
    expect(result.state.tests).toBeUndefined();
  });

  test("ohne Agent oder mit fremdem Zustand: kein Aufruf", async () => {
    const recipe = recipeFrom(baseRecipe());
    const foreign = await layer().syncTests(recipe, { kennung: "anderes", erstelltAm: "x", geaendertAm: "x" });
    expect(foreign.status).toBe("fehler");
    const missing = await layer().syncTests(recipe, { kennung: "beispiel", erstelltAm: "x", geaendertAm: "x" });
    expect(missing.status).toBe("fehler");
    expect(fake.calls).toHaveLength(0);
  });

  test("Fehlertexte spiegeln weder Schlüssel noch Token", async () => {
    const state = await deployed();
    fake.override((call) => call.path === "/agent-testing/create", (call) => jsonResponse({ detail: `${call.apiKey} ${BRIDGE_TOKEN}` }, 422));
    const result: any = await layer(BRIDGE_ENV).syncTests(recipeFrom(baseRecipe()), state);
    expect(result.status).toBe("fehler");
    expect(JSON.stringify(result)).not.toContain(API_KEY);
    expect(JSON.stringify(result)).not.toContain(BRIDGE_TOKEN);
  });
});

describe("Testnamen wie Eigenschaften von Object", () => {
  const SPECIAL = ["__proto__", "constructor", "toString", "hasOwnProperty"];
  function specialRaw() {
    const raw = baseRecipe();
    for (const name of SPECIAL) raw.tests.push({ name, szenario: `Szenario ${name}`, kriterien: ["ok"], maxZuege: 3 });
    return raw;
  }
  const own = (tests: object | undefined, name: string) => Object.getOwnPropertyDescriptor(tests ?? {}, name)?.value;
  const onDisk = async () => parseLayerState((await readState("beispiel", paths))!);

  test("Synchronisieren: Sie gelten nicht als vorhanden, und jeder behält seine Kennung", async () => {
    const raw = specialRaw();
    const state = await deployed(raw);
    const result: any = await layer().syncTests(recipeFrom(raw), state);
    expect(result.status).toBe("ok");
    for (const name of SPECIAL) {
      expect(result.angelegt).toContain(name);
      expect(own(result.state.tests, name).id).toMatch(/^test_/);
    }
    expect(fake.of("PUT", /.*/)).toHaveLength(0);
    expect(fake.calls.map((call) => call.path).join()).not.toContain("undefined");
    expect(Object.getPrototypeOf(result.state.tests)).toBe(Object.prototype);
    const saved = await onDisk();
    for (const name of SPECIAL) expect(own(saved.tests, name).id).toBe(own(result.state.tests, name).id);
  });

  test("Erneutes Synchronisieren: kein Aufruf, keine Duplikate", async () => {
    const raw = specialRaw();
    const first: any = await layer().syncTests(recipeFrom(raw), await deployed(raw));
    const count = fake.tests.size;
    fake.calls = [];
    const second: any = await layer().syncTests(recipeFrom(raw), await onDisk());
    expect(second.status).toBe("ok");
    expect(second.angelegt).toEqual([]);
    for (const name of SPECIAL) expect(second.unveraendert).toContain(name);
    expect(fake.calls).toHaveLength(0);
    expect(fake.tests.size).toBe(count);
    expect(own(second.state.tests, "__proto__").id).toBe(own(first.state.tests, "__proto__").id);
  });

  test("Ändern behält die Kennung", async () => {
    const raw = specialRaw();
    const first: any = await layer().syncTests(recipeFrom(raw), await deployed(raw));
    const id = own(first.state.tests, "__proto__").id;
    raw.tests.find((item: any) => item.name === "__proto__").szenario = "Anders";
    fake.calls = [];
    const second: any = await layer().syncTests(recipeFrom(raw), first.state);
    expect(second.geaendert).toEqual(["__proto__"]);
    expect(fake.of("PUT", /.*/).map((call) => call.path)).toEqual([`/agent-testing/${id}`]);
    expect(own(second.state.tests, "__proto__").id).toBe(id);
  });

  test("Ausführen: Alle kommen mit", async () => {
    const raw = specialRaw();
    await layer().syncTests(recipeFrom(raw), await deployed(raw));
    const state = await onDisk();
    await layer().runTests(state);
    const ids = fake.of("POST", /run-tests$/)[0]!.body.tests.map((item: any) => item.test_id);
    expect(ids).toHaveLength(fake.tests.size);
    for (const name of SPECIAL) expect(ids).toContain(own(state.tests, name).id);
  });

  test("Aus dem Rezept entfernen löscht sie beim Anbieter und im Zustand", async () => {
    const raw = specialRaw();
    const first: any = await layer().syncTests(recipeFrom(raw), await deployed(raw));
    const id = own(first.state.tests, "__proto__").id;
    raw.tests = raw.tests.filter((item: any) => !SPECIAL.includes(item.name));
    const second: any = await layer().syncTests(recipeFrom(raw), first.state);
    expect(second.entfernt.sort()).toEqual([...SPECIAL].sort());
    expect(fake.tests.has(id)).toBe(false);
    const saved = await onDisk();
    for (const name of SPECIAL) expect(own(saved.tests, name)).toBeUndefined();
  });

  test("Der Agent wird entfernt: Auch ihre Tests fallen", async () => {
    const raw = specialRaw();
    await layer().syncTests(recipeFrom(raw), await deployed(raw));
    const result = await layer().remove(await onDisk());
    expect(result.status).toBe("ok");
    expect(fake.tests.size).toBe(0);
    expect((await onDisk()).tests).toEqual({});
  });
});

describe("runTests", () => {
  async function synced(): Promise<VoiceLayerState> {
    const raw = baseRecipe();
    const result: any = await layer().syncTests(recipeFrom(raw), await deployed(raw));
    fake.calls = [];
    return result.state;
  }

  test("startet alle Tests und liefert die Kennung des Laufs", async () => {
    const state = await synced();
    const result = await layer().runTests(state);
    expect(result).toEqual({ status: "gestartet", runId: "lauf_1" });
    const call = fake.of("POST", /run-tests$/)[0]!;
    expect(call.path).toBe(`/agents/${state.agentId}/run-tests`);
    expect(call.body.tests).toEqual(Object.values(state.tests!).map((item) => ({ test_id: item.id })));
    expect(call.body.agent_config_override).toBeUndefined();
  });

  test("Abweichungen für den Lauf übersetzt der Adapter, leere gehen nicht mit", async () => {
    const state = await synced();
    await layer().runTests(state, { prompt: "Anders", modell: "claude-haiku-5-5", ersterSatz: "Hallo" });
    expect(fake.of("POST", /run-tests$/)[0]!.body.agent_config_override).toEqual({
      conversation_config: { agent: { first_message: "Hallo", prompt: { prompt: "Anders", llm: "claude-haiku-5-5" } } },
      platform_settings: {},
    });
    fake.calls = [];
    await layer().runTests(state, {});
    expect(fake.of("POST", /run-tests$/)[0]!.body.agent_config_override).toBeUndefined();
  });

  test("Nur Prompt oder erster Satz: Der Agent wird nicht gelesen", async () => {
    const state = await synced();
    await layer().runTests(state, { prompt: "Anders", ersterSatz: "Hallo" });
    expect(fake.of("GET", /.*/)).toHaveLength(0);
    expect(fake.of("POST", /run-tests$/)[0]!.body.agent_config_override.conversation_config.agent).toEqual({ first_message: "Hallo", prompt: { prompt: "Anders" } });
  });

  describe("Modellwechsel nach Gehirnart", () => {
    const MODELL = "claude-haiku-5-5";
    const agentPath = /^\/agents\/[^/]+$/;
    const promptOf = (state: VoiceLayerState) => fake.agents.get(state.agentId!).conversation_config.agent.prompt;
    const sentPrompt = () => fake.of("POST", /run-tests$/)[0]!.body.agent_config_override.conversation_config.agent.prompt;

    /** Brückenagent mit Tests. Danach kennt die Schicht die Brücke nur noch vom Anbieter, nicht aus der .env. */
    async function syncedBridge(): Promise<VoiceLayerState> {
      const recipe = bridgeRecipe();
      const result: any = await layer(BRIDGE_ENV).deploy(recipe, PROMPT);
      expect(result.status).toBe("angelegt");
      const synced: any = await layer(BRIDGE_ENV).syncTests(recipe, result.state);
      fake.calls = [];
      return synced.state;
    }

    test("anbieter: Das direkte Modell wird überschrieben, eine Brücke kommt nicht vor", async () => {
      const state = await synced();
      expect((await layer().runTests(state, { modell: MODELL })).status).toBe("gestartet");
      expect(sentPrompt()).toEqual({ llm: MODELL });
      expect(fake.calls.map((call) => call.method)).toEqual(["GET", "POST"]);
      expect(promptOf(state).llm).toBe("claude-sonnet-5-5");
    });

    test("bruecke: llm bleibt custom-llm, nur das Modell der Brücke wechselt", async () => {
      const state = await syncedBridge();
      const before = structuredClone(promptOf(state));
      expect((await layer().runTests(state, { modell: MODELL })).status).toBe("gestartet");
      const prompt = sentPrompt();
      expect(prompt.llm).toBe("custom-llm");
      expect(prompt.llm).not.toBe(MODELL);
      expect(prompt.custom_llm).toEqual({ ...before.custom_llm, model_id: MODELL });
      expect(prompt.custom_llm.url).toBe(BRIDGE_URL);
      expect(prompt.custom_llm.api_key).toEqual({ secret_id: state.brueckenGeheimnisId });
      expect(prompt.custom_llm.request_headers["x-tybo-rezept"]).toBe("beispiel");
      expect(prompt.custom_llm.request_headers["x-voice-caller-id"]).toEqual({ variable_name: "system__caller_id" });
      // Nur für den Lauf: Der Agent bleibt, das Token geht nicht mit
      expect(fake.writes().map((call) => call.path)).toEqual([`/agents/${state.agentId}/run-tests`]);
      expect(promptOf(state)).toEqual(before);
      expect(fake.of("POST", /run-tests$/)[0]!.raw).not.toContain(BRIDGE_TOKEN);
    });

    test("bruecke: Was der Anbieter zusätzlich führt, bleibt erhalten", async () => {
      const state = await syncedBridge();
      promptOf(state).custom_llm.api_version = "2026-10";
      await layer().runTests(state, { prompt: "Anders", modell: MODELL });
      expect(sentPrompt().prompt).toBe("Anders");
      expect(sentPrompt().custom_llm.api_version).toBe("2026-10");
    });

    test("bruecke: Noch unbestätigter Schreibvorgang zählt, wenn beim Anbieter das Gesendete steht", async () => {
      let reads = 0;
      fake.override((call) => call.method === "GET" && agentPath.test(call.path) && ++reads === 1, () => jsonResponse({ detail: "später" }, 503));
      const recipe = bridgeRecipe();
      const deployed: any = await layer(BRIDGE_ENV).deploy(recipe, PROMPT);
      expect(deployed.status).toBe("fehler");
      expect(deployed.state.ausstehend).toBeDefined();
      const synced: any = await layer(BRIDGE_ENV).syncTests(recipe, deployed.state);
      fake.calls = [];
      expect((await layer().runTests(synced.state, { modell: MODELL })).status).toBe("gestartet");
      expect(sentPrompt().llm).toBe("custom-llm");
    });

    test.each([
      ["nicht gefunden", 404, false],
      ["Anbieter gestört", 503, true],
    ])("Agent nicht lesbar (%s): kein Lauf", async (_name, status, vorlaeufig) => {
      const state = await syncedBridge();
      fake.override((call) => call.method === "GET" && agentPath.test(call.path), (call) => jsonResponse({ detail: call.apiKey }, status));
      const result: any = await layer().runTests(state, { modell: MODELL });
      expect(result).toMatchObject({ status: "fehler", vorlaeufig });
      expect(result.fehler).not.toContain(API_KEY);
      expect(fake.of("POST", /run-tests$/)).toHaveLength(0);
    });

    test.each([
      ["kein JSON", () => new Response("<html>", { status: 200 })],
      ["ohne Konfiguration", () => jsonResponse({ agent_id: "a" })],
    ])("Antwort unlesbar (%s): kein Lauf", async (_name, reply) => {
      const state = await syncedBridge();
      fake.override((call) => call.method === "GET" && agentPath.test(call.path), reply);
      const result: any = await layer().runTests(state, { modell: MODELL });
      expect(result.status).toBe("fehler");
      expect(result.fehler).toContain("unlesbar");
      expect(fake.of("POST", /run-tests$/)).toHaveLength(0);
    });

    test.each<[string, (prompt: any) => void]>([
      ["von Hand auf ein direktes Modell gestellt", (prompt) => { prompt.llm = "claude-sonnet-5-5"; prompt.custom_llm = null; }],
      ["direktes Modell, Brücke steht noch da", (prompt) => { prompt.llm = "claude-sonnet-5-5"; }],
      ["Brücke entfernt", (prompt) => { prompt.custom_llm = null; }],
      ["andere Adresse", (prompt) => { prompt.custom_llm.url = "https://fremd.example.com/v1/chat/completions"; }],
      ["anderer Verweis", (prompt) => { prompt.custom_llm.api_key = { secret_id: "fremd" }; }],
      ["andere Köpfe", (prompt) => { prompt.custom_llm.request_headers = {}; }],
    ])("Weicht vom letzten Abgleich ab (%s): kein Lauf", async (_name, change) => {
      const state = await syncedBridge();
      change(promptOf(state));
      const result: any = await layer().runTests(state, { modell: MODELL });
      expect(result).toMatchObject({ status: "fehler", vorlaeufig: false });
      expect(result.fehler).toContain("Kein Test wurde gestartet");
      expect(fake.of("POST", /run-tests$/)).toHaveLength(0);
    });

    test("anbieter von Hand auf die Brücke gestellt: kein Lauf", async () => {
      const state = await synced();
      Object.assign(promptOf(state), { llm: "custom-llm", custom_llm: { url: BRIDGE_URL, api_key: { secret_id: "s" }, request_headers: {} } });
      expect((await layer().runTests(state, { modell: MODELL })).status).toBe("fehler");
      expect(fake.of("POST", /run-tests$/)).toHaveLength(0);
    });

    test("Stand unbekannt: kein Lauf", async () => {
      const state = await syncedBridge();
      const result: any = await layer().runTests({ ...state, anbieterStand: undefined }, { modell: MODELL });
      expect(result.fehler).toContain("Kein Test wurde gestartet");
      expect(fake.of("POST", /run-tests$/)).toHaveLength(0);
    });

    // Der Anbieter meldete schon beim Abgleich eine unvollständige Brücke, der Stand stimmt also überein
    test.each<[string, (custom: any) => void]>([
      ["ohne Adresse", (custom) => { delete custom.url; }],
      ["ohne Verweis", (custom) => { custom.api_key = null; }],
      ["Verweis ohne Kennung", (custom) => { custom.api_key = { env_var_label: "X" }; }],
      ["ohne Köpfe", (custom) => { custom.request_headers = null; }],
    ])("Brücke unvollständig (%s): kein Lauf", async (_name, change) => {
      fake.override(
        (call) => call.method === "GET" && agentPath.test(call.path),
        (call) => {
          const id = call.path.split("/").at(-1)!;
          const agent = fake.agents.get(id);
          change(agent.conversation_config.agent.prompt.custom_llm);
          return jsonResponse({ agent_id: id, ...agent });
        },
      );
      const state = await syncedBridge();
      const result: any = await layer().runTests(state, { modell: MODELL });
      expect(result.status).toBe("fehler");
      expect(result.fehler).toContain("unlesbar");
      expect(fake.of("POST", /run-tests$/)).toHaveLength(0);
    });
  });

  test("ohne Agent oder Tests: kein Aufruf", async () => {
    const base = { erstelltAm: "x", geaendertAm: "x" };
    expect((await layer().runTests(base)).status).toBe("fehler");
    expect((await layer().runTests({ ...base, agentId: "a", tests: {} })).status).toBe("fehler");
    expect(fake.calls).toHaveLength(0);
  });

  test.each([
    [422, false],
    [429, true],
    [500, true],
  ])("HTTP %i: Fehler, vorläufig %p", async (status, vorlaeufig) => {
    const state = await synced();
    fake.override((call) => call.path.endsWith("/run-tests"), () => jsonResponse({ detail: API_KEY }, status));
    const result: any = await layer().runTests(state);
    expect(result).toMatchObject({ status: "fehler", vorlaeufig });
    expect(result.fehler).not.toContain(API_KEY);
  });

  test("Antwort ohne Kennung ist ein Fehler", async () => {
    const state = await synced();
    fake.override((call) => call.path.endsWith("/run-tests"), () => jsonResponse({ test_runs: [] }));
    expect((await layer().runTests(state)).status).toBe("fehler");
  });
});

describe("testResult", () => {
  const run = (status: string, extra: object = {}) => ({ test_run_id: "r", test_invocation_id: "lauf_1", agent_id: "a", test_id: `id-${status}`, test_name: `Test ${status}`, status, ...extra });
  const failing = (messages: string[], summary = "") => run("failed", { condition_result: { result: "failure", rationale: { messages, summary } } });

  test("bestanden", async () => {
    fake.invocations = [{ id: "lauf_1", test_runs: [run("passed", { condition_result: { result: "success" } })] }];
    const result: any = await layer().testResult("lauf_1");
    expect(result.status).toBe("fertig");
    expect(result.gesamt).toBe("bestanden");
    expect(result.tests).toEqual([{ testId: "id-passed", name: "Test passed", status: "bestanden" }]);
    expect(clock.sleeps).toEqual([]);
    expect(fake.calls[0]!.path).toBe("/test-invocations/lauf_1");
  });

  test("durchgefallen mit Kriterium", async () => {
    fake.invocations = [{ id: "lauf_1", test_runs: [failing(["112 wurde nicht genannt", "legte nicht auf"])] }];
    const result: any = await layer().testResult("lauf_1");
    expect(result.gesamt).toBe("durchgefallen");
    expect(result.tests[0]).toMatchObject({ status: "durchgefallen", kriterium: "112 wurde nicht genannt; legte nicht auf" });
  });

  test("ohne einzelne Gründe gilt die Zusammenfassung", async () => {
    fake.invocations = [{ id: "lauf_1", test_runs: [failing([], "Ziel verfehlt")] }];
    const result: any = await layer().testResult("lauf_1");
    expect(result.tests[0].kriterium).toBe("Ziel verfehlt");
  });

  test("Das Kriterium spiegelt keine Geheimnisse", async () => {
    fake.invocations = [{ id: "lauf_1", test_runs: [failing([`Agent sagte ${BRIDGE_TOKEN} und ${API_KEY}`])] }];
    const result: any = await layer(BRIDGE_ENV).testResult("lauf_1");
    expect(JSON.stringify(result)).not.toContain(BRIDGE_TOKEN);
    expect(JSON.stringify(result)).not.toContain(API_KEY);
    expect(result.tests[0].kriterium).toContain("[entfernt]");
  });

  test("gemischt: Ein durchgefallener Test bestimmt das Ganze", async () => {
    fake.invocations = [{ id: "lauf_1", test_runs: [run("passed"), failing(["nein"]), run("cancelled")] }];
    const result: any = await layer().testResult("lauf_1");
    expect(result.gesamt).toBe("durchgefallen");
    expect(result.tests.map((item: any) => item.status)).toEqual(["bestanden", "durchgefallen", "abgebrochen"]);
  });

  test("abgebrochen zählt nicht als bestanden", async () => {
    fake.invocations = [{ id: "lauf_1", test_runs: [run("passed"), run("cancelled")] }];
    expect(await layer().testResult("lauf_1")).toMatchObject({ status: "fertig", gesamt: "abgebrochen" });
  });

  test("abgebrochener Lauf mit offenen Tests wartet nicht bis zur Frist", async () => {
    fake.invocations = [{ id: "lauf_1", cancelled: true, test_runs: [run("pending")] }];
    expect(await layer().testResult("lauf_1")).toMatchObject({ status: "fertig", gesamt: "abgebrochen" });
    expect(clock.sleeps).toEqual([]);
  });

  test("Status bestanden mit Bewertung failure zählt als durchgefallen", async () => {
    fake.invocations = [{ id: "lauf_1", test_runs: [run("passed", { condition_result: { result: "failure" } })] }];
    expect(await layer().testResult("lauf_1")).toMatchObject({ gesamt: "durchgefallen" });
  });

  test("Abfrage-Zeitplan: wartet nach Plan, bis alle fertig sind", async () => {
    const pending = { id: "lauf_1", test_runs: [run("pending"), run("passed")] };
    fake.invocations = [pending, pending, pending, { id: "lauf_1", test_runs: [run("passed")] }];
    const result = await layer().testResult("lauf_1");
    expect(result.status).toBe("fertig");
    expect(clock.sleeps).toEqual([...POLL_SCHEDULE_MS.slice(0, 3)]);
    expect(fake.calls).toHaveLength(4);
  });

  test("Zeitüberschreitung: Gesamtfrist endet das Warten, der Zwischenstand kommt mit", async () => {
    fake.invocations = [{ id: "lauf_1", test_runs: [run("pending"), run("passed")] }];
    const start = clock.now();
    const result: any = await layer().testResult("lauf_1");
    expect(result.status).toBe("zeitueberschreitung");
    expect(result.tests.map((item: any) => item.status)).toEqual(["offen", "bestanden"]);
    expect(clock.now() - start).toBeLessThanOrEqual(TEST_RUN_TIMEOUT_MS);
    // Der letzte Wert des Plans wiederholt sich
    expect(clock.sleeps.at(-1)).toBe(POLL_SCHEDULE_MS.at(-1)!);
    expect(result.grund).toBeUndefined();
  });

  test("eigene Frist und eigener Plan gelten", async () => {
    fake.invocations = [{ id: "lauf_1", test_runs: [run("pending")] }];
    const quick = createElevenLabsLayer({ env: ENV, fetch: fake.fetch, paths, clock, pollScheduleMs: [10], testRunTimeoutMs: 25 });
    expect((await quick.testResult("lauf_1")).status).toBe("zeitueberschreitung");
    expect(clock.sleeps).toEqual([10, 10]);
  });

  test("5xx und 429 sind vorübergehend: Es wird weiter abgefragt", async () => {
    fake.override((call) => call.path.startsWith("/test-invocations/"), () => jsonResponse({ detail: "später" }, 503));
    fake.override((call) => call.path.startsWith("/test-invocations/"), () => jsonResponse({ detail: "zu viel" }, 429));
    fake.invocations = [{ id: "lauf_1", test_runs: [run("passed")] }];
    const result = await layer().testResult("lauf_1");
    expect(result).toMatchObject({ status: "fertig", gesamt: "bestanden" });
    expect(clock.sleeps).toHaveLength(2);
  });

  test("Netzfehler sind vorübergehend", async () => {
    let calls = 0;
    const flaky = async (url: string, init: RequestInit) => {
      if (++calls === 1) throw new Error("kaputt");
      return fake.fetch(url, init);
    };
    fake.invocations = [{ id: "lauf_1", test_runs: [run("passed")] }];
    const result = await createElevenLabsLayer({ env: ENV, fetch: flaky, paths, clock }).testResult("lauf_1");
    expect(result.status).toBe("fertig");
  });

  test("Dauerhaft 5xx endet an der Frist und nennt den Grund ohne Geheimnis", async () => {
    fake.override((call) => call.path.startsWith("/test-invocations/"), (call) => jsonResponse({ detail: `kaputt ${call.apiKey}` }, 500), Number.MAX_SAFE_INTEGER);
    const result: any = await layer().testResult("lauf_1");
    expect(result.status).toBe("zeitueberschreitung");
    expect(result.grund).toStartWith("HTTP 500");
    expect(result.grund).not.toContain(API_KEY);
  });

  test.each([[401], [404], [422]])("HTTP %i endet sofort als Fehler", async (status) => {
    fake.override((call) => call.path.startsWith("/test-invocations/"), () => jsonResponse({ detail: "nein" }, status));
    const result: any = await layer().testResult("lauf_1");
    expect(result).toMatchObject({ status: "fehler", vorlaeufig: false });
    expect(result.fehler).toStartWith(`HTTP ${status}`);
    expect(clock.sleeps).toEqual([]);
  });

  test.each([
    ["kein JSON", () => new Response("<html>", { status: 200 })],
    ["ohne Liste", () => jsonResponse({ id: "lauf_1" })],
    ["leere Liste", () => jsonResponse({ id: "lauf_1", test_runs: [] })],
    ["unbekannter Status", () => jsonResponse({ id: "lauf_1", test_runs: [{ status: "toll", test_id: "t" }] })],
  ])("ungültige Antwort (%s) gilt nie als bestanden", async (_name, reply) => {
    fake.override((call) => call.path.startsWith("/test-invocations/"), reply);
    const result: any = await layer().testResult("lauf_1");
    expect(result.status).toBe("fehler");
    expect(result.fehler).toContain("unlesbar");
  });

  const complete = { test_run_id: "r", test_invocation_id: "lauf_1", agent_id: "a", test_id: "t", test_name: "T", status: "passed" };
  const without = (field: string) => Object.fromEntries(Object.entries(complete).filter(([key]) => key !== field));
  test.each([
    ["nur der Status", { status: "passed" }],
    ["ohne test_id", without("test_id")],
    ["leere test_id", { ...complete, test_id: "" }],
    ["test_id als Zahl", { ...complete, test_id: 7 }],
    ["test_id null", { ...complete, test_id: null }],
    ["test_id mit Pfad", { ...complete, test_id: "../x" }],
    ["test_id spiegelt den Schlüssel", { ...complete, test_id: API_KEY }],
    ["ohne test_run_id", without("test_run_id")],
    ["ohne test_invocation_id", without("test_invocation_id")],
    ["ohne agent_id", without("agent_id")],
    ["agent_id als Zahl", { ...complete, agent_id: 1 }],
    ["Status als Zahl", { ...complete, status: 1 }],
    ["test_name als Zahl", { ...complete, test_name: 1 }],
    ["Bewertung kein Objekt", { ...complete, condition_result: "success" }],
    ["Bewertung ohne Ergebnis", { ...complete, condition_result: {} }],
    ["Bewertung mit fremdem Ergebnis", { ...complete, condition_result: { result: "toll" } }],
    ["Eintrag null", null],
    ["Eintrag als Text", "passed"],
    ["Eintrag als Liste", [complete]],
  ])("unvollständiger Eintrag (%s) gilt nie als bestanden", async (_name, entry) => {
    fake.invocations = [{ id: "lauf_1", test_runs: [complete, entry] }];
    const result: any = await layer().testResult("lauf_1");
    expect(result.status).toBe("fehler");
    expect(result.fehler).toContain("unlesbar");
    expect(clock.sleeps).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(API_KEY);
  });

  test.each(["__proto__", "constructor", "toString", "hasOwnProperty"])("Status %s ist unlesbar, nie bestanden", async (status) => {
    fake.invocations = [{ id: "lauf_1", test_runs: [{ ...complete, status }] }];
    const result: any = await layer().testResult("lauf_1");
    expect(result.status).toBe("fehler");
    expect(result.fehler).toContain("unlesbar");
    expect(result.gesamt).toBeUndefined();
    expect(clock.sleeps).toEqual([]);
  });

  test("Ohne Namen trägt der Test seine Kennung; fehlende Bewertung ist laut Schema erlaubt", async () => {
    fake.invocations = [{ id: "lauf_1", test_runs: [{ ...without("test_name"), condition_result: null }] }];
    expect(await layer().testResult("lauf_1")).toEqual({ status: "fertig", gesamt: "bestanden", tests: [{ testId: "t", name: "t", status: "bestanden" }] });
  });

  test("Status bestanden mit Bewertung unknown zählt nicht als bestanden", async () => {
    fake.invocations = [{ id: "lauf_1", test_runs: [{ ...complete, condition_result: { result: "unknown" } }] }];
    expect(await layer().testResult("lauf_1")).toMatchObject({ status: "fertig", gesamt: "durchgefallen" });
  });

  describe("Gesamtfrist", () => {
    const passed = { id: "lauf_1", test_runs: [run("passed")] };
    const pending = { id: "lauf_1", test_runs: [run("pending")] };

    /** Attrappe, die eine Anfrage die Uhr um ms vorrücken lässt */
    function slowFetch(ms: number) {
      return async (url: string, init: RequestInit) => {
        clock.time += ms;
        return fake.fetch(url, init);
      };
    }

    test("Eine verspätete Erfolgsmeldung zählt nicht", async () => {
      fake.invocations = [passed];
      const late = createElevenLabsLayer({ env: ENV, fetch: slowFetch(30), paths, clock, testRunTimeoutMs: 25 });
      const result: any = await late.testResult("lauf_1");
      expect(result.status).toBe("zeitueberschreitung");
      expect(result.tests).toEqual([]);
      expect(result.grund).toContain("nach der Frist");
    });

    test("Eine Antwort genau zur Frist ist schon zu spät", async () => {
      fake.invocations = [passed];
      const late = createElevenLabsLayer({ env: ENV, fetch: slowFetch(25), paths, clock, testRunTimeoutMs: 25 });
      expect((await late.testResult("lauf_1")).status).toBe("zeitueberschreitung");
    });

    test("Eine langsame Antwort innerhalb der Frist zählt", async () => {
      fake.invocations = [passed];
      const slow = createElevenLabsLayer({ env: ENV, fetch: slowFetch(24), paths, clock, testRunTimeoutMs: 25 });
      expect(await slow.testResult("lauf_1")).toMatchObject({ status: "fertig", gesamt: "bestanden" });
    });

    test("Verspätet nach einem offenen Zwischenstand: Der Zwischenstand bleibt", async () => {
      fake.invocations = [pending, passed];
      let calls = 0;
      const fetchSecondLate = async (url: string, init: RequestInit) => {
        if (++calls === 2) clock.time += 100;
        return fake.fetch(url, init);
      };
      const late = createElevenLabsLayer({ env: ENV, fetch: fetchSecondLate, paths, clock, pollScheduleMs: [10], testRunTimeoutMs: 50 });
      const result: any = await late.testResult("lauf_1");
      expect(result.status).toBe("zeitueberschreitung");
      expect(result.tests.map((item: any) => item.status)).toEqual(["offen"]);
    });

    test("Verspäteter Fehler endet als Zeitüberschreitung mit Grund", async () => {
      fake.override((call) => call.path.startsWith("/test-invocations/"), (call) => jsonResponse({ detail: `kaputt ${call.apiKey}` }, 401));
      const late = createElevenLabsLayer({ env: ENV, fetch: slowFetch(30), paths, clock, testRunTimeoutMs: 25 });
      const result: any = await late.testResult("lauf_1");
      expect(result.status).toBe("zeitueberschreitung");
      expect(result.grund).toStartWith("HTTP 401");
      expect(result.grund).not.toContain(API_KEY);
    });

    test("Vor einer Anfrage: Ist die Frist beim Warten abgelaufen, gibt es keine Anfrage mehr", async () => {
      fake.invocations = [pending];
      const overslept = { now: clock.now, sleep: async (ms: number) => void (clock.time += ms + 1_000) };
      const late = createElevenLabsLayer({ env: ENV, fetch: fake.fetch, paths, clock: overslept, pollScheduleMs: [10], testRunTimeoutMs: 50 });
      const result: any = await late.testResult("lauf_1");
      expect(result.status).toBe("zeitueberschreitung");
      expect(fake.calls).toHaveLength(1);
    });

    test("Frist von null: keine einzige Anfrage", async () => {
      const none = createElevenLabsLayer({ env: ENV, fetch: fake.fetch, paths, clock, testRunTimeoutMs: 0 });
      expect((await none.testResult("lauf_1")).status).toBe("zeitueberschreitung");
      expect(fake.calls).toHaveLength(0);
    });

    test("Das Zeitlimit der Anfrage ist die verbleibende Zeit, höchstens das eigene Limit", async () => {
      fake.invocations = [pending, pending, passed];
      const spy = spyOn(AbortSignal, "timeout");
      try {
        const limited = createElevenLabsLayer({ env: ENV, fetch: fake.fetch, paths, clock, timeoutMs: 500, pollScheduleMs: [300], testRunTimeoutMs: 700 });
        await limited.testResult("lauf_1");
        expect(spy.mock.calls.map((call) => call[0])).toEqual([500, 400, 100]);
      } finally {
        spy.mockRestore();
      }
    });

    test("Frist läuft während der Anfrage ab: Die Anfrage wird abgebrochen", async () => {
      const hanging = (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal!.addEventListener("abort", () => reject(init.signal!.reason));
        });
      const started = Date.now();
      const real = createElevenLabsLayer({ env: ENV, fetch: hanging, paths, testRunTimeoutMs: 30 });
      const result: any = await real.testResult("lauf_1");
      expect(result.status).toBe("zeitueberschreitung");
      expect(result.grund).toBe("Zeitablauf");
      expect(Date.now() - started).toBeLessThan(5_000);
    });

    test("Frist läuft ab, während die Antwort noch kommt: nie unlesbar, nie bestanden", async () => {
      const hangingBody = async (_url: string, init: RequestInit) =>
        new Response(
          new ReadableStream({
            start(controller) {
              init.signal!.addEventListener("abort", () => controller.error(init.signal!.reason));
            },
          }),
          { status: 200 },
        );
      const real = createElevenLabsLayer({ env: ENV, fetch: hangingBody, paths, testRunTimeoutMs: 30 });
      const result: any = await real.testResult("lauf_1");
      expect(result.status).toBe("zeitueberschreitung");
      expect(result.grund).toBe("Zeitablauf");
    });
  });

  test("Die Kennung des Laufs wird für die Adresse maskiert", async () => {
    fake.invocations = [{ id: "x", test_runs: [run("passed")] }];
    await layer().testResult("a/b");
    expect(fake.calls[0]!.path).toBe("/test-invocations/a%2Fb");
  });
});
