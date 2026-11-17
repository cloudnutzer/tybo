/**
 * Issue #490: Agent aus Rezept anlegen, ändern und löschen, Handänderungen,
 * Geheimnisse. Nur gegen die Attrappe, im temporären Ordner.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElevenLabsLayer } from "../src/lib/voice-agents/elevenlabs";
import { recipeHash } from "../src/lib/voice-agents/base";
import { readState, updateState } from "../src/lib/voice-agents/state";
import { parseLayerState, type VoiceLayerState } from "../src/lib/voice-agents/layer";
import { API_KEY, BRIDGE_ENV, BRIDGE_TOKEN, BRIDGE_URL, baseRecipe, bridgeRecipe, ENV, FakeElevenLabs, fakeClock, jsonResponse, recipeFrom } from "./voice-agents-elevenlabs-fixture";

const PROMPT = "Du bist ein Assistent.";
let root: string;
let paths: { dataDir: string };
let fake: FakeElevenLabs;

function layer(env: Record<string, string | undefined> = ENV) {
  return createElevenLabsLayer({ env, fetch: fake.fetch, paths, clock: fakeClock() });
}
const stateFile = () => readFileSync(join(paths.dataDir, "beispiel", "state.json"), "utf8");
const loaded = async (): Promise<VoiceLayerState> => parseLayerState((await readState("beispiel", paths))!);
function expectClean(text: string) {
  expect(text).not.toContain(API_KEY);
  expect(text).not.toContain(BRIDGE_TOKEN);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tybo-sprachschicht-"));
  paths = { dataDir: join(root, "voice-agents") };
  fake = new FakeElevenLabs();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("Anlegen aus dem Rezept", () => {
  test("überträgt Stimme, Modell, Tempo, Sprache und Dauer", async () => {
    const recipe = recipeFrom(baseRecipe());
    const result = await layer().deploy(recipe, PROMPT);
    expect(result.status).toBe("angelegt");

    const body = fake.of("POST", /^\/agents\/create$/)[0]!.body;
    expect(body.name).toBe("Beispiel");
    const config = body.conversation_config;
    expect(config.agent.prompt.prompt).toBe(PROMPT);
    expect(config.agent.prompt.llm).toBe("claude-sonnet-5-5");
    expect(config.agent.prompt.custom_llm).toBeNull();
    expect(config.agent.prompt.built_in_tools.end_call.params.system_tool_type).toBe("end_call");
    expect(config.agent.language).toBe("de");
    expect(config.tts).toEqual({ voice_id: "stimme-1", model_id: "eleven_flash_v2_5", speed: 1.1 });
    expect(config.conversation.max_duration_seconds).toBe(12 * 60);

    const state = await loaded();
    expect(state.agentId).toBe("agent_1");
    expect(state.anbieter).toBe("elevenlabs");
    expect(state.kennung).toBe("beispiel");
    expect(state.letzterHash).toBe(recipeHash(recipe));
    expect(state.abgeglichenAm).toBeString();
  });

  test("KI-Hinweis steht vor dem ersten Satz und lässt sich nicht unterbrechen", async () => {
    const raw = baseRecipe();
    raw.persona.kiHinweis = "Hier spricht eine KI.";
    await layer().deploy(recipeFrom(raw), PROMPT);
    const agent = fake.of("POST", /^\/agents\/create$/)[0]!.body.conversation_config.agent;
    expect(agent.first_message).toBe("Hier spricht eine KI. Was liegt an?");
    expect(agent.disable_first_message_interruptions).toBe(true);
  });

  test("ohne KI-Hinweis bleibt der erste Satz unterbrechbar", async () => {
    await layer().deploy(recipeFrom(baseRecipe()), PROMPT);
    const agent = fake.of("POST", /^\/agents\/create$/)[0]!.body.conversation_config.agent;
    expect(agent.first_message).toBe("Was liegt an?");
    expect(agent.disable_first_message_interruptions).toBe(false);
  });

  test("weitere Sprachen werden Varianten mit Spracherkennung", async () => {
    const raw = baseRecipe();
    raw.persona.sprachen = ["de", "en"];
    await layer().deploy(recipeFrom(raw), PROMPT);
    const config = fake.of("POST", /^\/agents\/create$/)[0]!.body.conversation_config;
    expect(config.agent.language).toBe("de");
    expect(config.language_presets).toEqual({ en: { overrides: { agent: { language: "en" } } } });
    expect(config.agent.prompt.built_in_tools.language_detection.name).toBe("language_detection");
  });

  test("Anmeldepflicht ist immer an, in jeder Variante", async () => {
    await layer().deploy(recipeFrom(baseRecipe()), PROMPT);
    await layer(BRIDGE_ENV).deploy(bridgeRecipe(), PROMPT);
    const writes = [...fake.of("POST", /^\/agents\/create$/), ...fake.of("PATCH", /^\/agents\//)];
    expect(writes).toHaveLength(2);
    for (const call of writes) expect(call.body.platform_settings.auth.enable_auth).toBe(true);
  });

  test("Stimme oder Schlüssel fehlen: kein Aufruf", async () => {
    const raw = baseRecipe();
    delete raw.stimme.voiceId;
    const noVoice = await layer().deploy(recipeFrom(raw), PROMPT);
    expect(noVoice.status).toBe("fehler");
    const noKey = await layer({}).deploy(recipeFrom(baseRecipe()), PROMPT);
    expect(noKey).toMatchObject({ status: "fehler", fehler: "ELEVENLABS_API_KEY fehlt" });
    expect(fake.calls).toHaveLength(0);
  });

  test("zwei Abgleiche zugleich legen nur einen Agenten an", async () => {
    const recipe = recipeFrom(baseRecipe());
    const results = await Promise.all([layer().deploy(recipe, PROMPT), layer().deploy(recipe, PROMPT)]);
    expect(results.map((result) => result.status).sort()).toEqual(["angelegt", "unveraendert"]);
    expect(fake.of("POST", /^\/agents\/create$/)).toHaveLength(1);
  });
});

describe("Abgleich", () => {
  test("unveränderter Hash ruft nichts auf", async () => {
    const recipe = recipeFrom(baseRecipe());
    await layer().deploy(recipe, PROMPT);
    fake.calls = [];
    const result = await layer().deploy(recipe, PROMPT);
    expect(result.status).toBe("unveraendert");
    expect(fake.calls).toHaveLength(0);
  });

  test("anderer Prompt bei gleichem Rezept: kein Aufruf, aber ein Hinweis; übernommen wird er mit der nächsten Rezeptänderung", async () => {
    const raw = baseRecipe();
    await layer().deploy(recipeFrom(raw), PROMPT);
    fake.calls = [];
    const result: any = await layer().deploy(recipeFrom(raw), "Neuer Prompt");
    expect(result.status).toBe("unveraendert");
    expect(result.hinweise[0]).toContain("bis sich das Rezept ändert");
    expect(fake.calls).toHaveLength(0);

    raw.zugang.maxMinuten = 20;
    expect((await layer().deploy(recipeFrom(raw), "Neuer Prompt")).status).toBe("geaendert");
    expect(fake.agents.get("agent_1").conversation_config.agent.prompt.prompt).toBe("Neuer Prompt");
  });

  test("geändertes Rezept ändert den vorhandenen Agenten", async () => {
    const raw = baseRecipe();
    await layer().deploy(recipeFrom(raw), PROMPT);
    raw.zugang.maxMinuten = 20;
    const result = await layer().deploy(recipeFrom(raw), PROMPT);
    expect(result.status).toBe("geaendert");
    expect(fake.of("POST", /^\/agents\/create$/)).toHaveLength(1);
    expect(fake.of("PATCH", /^\/agents\/agent_1$/)[0]!.body.conversation_config.conversation.max_duration_seconds).toBe(1200);
    expect((await loaded()).letzterHash).toBe(recipeHash(recipeFrom(raw)));
  });

  test("Nachfrage scheitert nach dem Anlegen: Kennung bleibt, nächster Lauf bestätigt, ohne zu schreiben", async () => {
    const recipe = recipeFrom(baseRecipe());
    fake.override((call) => call.method === "GET", () => jsonResponse({ detail: "kaputt" }, 503));
    const first = await layer().deploy(recipe, PROMPT);
    expect(first).toMatchObject({ status: "fehler", vorlaeufig: true });
    const state = await loaded();
    expect(state.agentId).toBe("agent_1");
    expect(state.letzterHash).toBeUndefined();

    fake.calls = [];
    const second: any = await layer().deploy(recipe, PROMPT);
    expect(second.status).toBe("geaendert");
    expect(second.hinweise[0]).toContain("erst jetzt bestätigen");
    expect(fake.writes()).toHaveLength(0);
    const after = await loaded();
    expect(after.letzterHash).toBe(recipeHash(recipe));
    expect(after.ausstehend).toBeUndefined();
    expect(after.anbieterStand).toBeDefined();

    fake.calls = [];
    expect((await layer().deploy(recipe, PROMPT)).status).toBe("unveraendert");
    expect(fake.calls).toHaveLength(0);
  });

  test("übernimmt der Anbieter die Anmeldepflicht nicht, gilt der Agent nicht als abgeglichen", async () => {
    fake.override((call) => call.method === "GET", () => jsonResponse({ name: "x", conversation_config: { agent: { prompt: {} } }, platform_settings: { auth: { enable_auth: false } } }));
    const result: any = await layer().deploy(recipeFrom(baseRecipe()), PROMPT);
    expect(result.status).toBe("fehler");
    expect(result.fehler).toContain("Anmeldepflicht");
    expect((await loaded()).letzterHash).toBeUndefined();
  });
});

describe("Brücke", () => {
  test("nur bei bruecke: custom_llm mit Adresse, Rezept-Kopf und Variablen als Verweis", async () => {
    await layer(BRIDGE_ENV).deploy(bridgeRecipe(), PROMPT);
    const prompt = fake.of("POST", /^\/agents\/create$/)[0]!.body.conversation_config.agent.prompt;
    expect(prompt.llm).toBe("custom-llm");
    expect(prompt.custom_llm).toEqual({
      url: BRIDGE_URL,
      model_id: "claude-opus-5-5",
      api_key: { secret_id: "secret_1" },
      api_type: "chat_completions",
      request_headers: {
        "x-tybo-rezept": "beispiel",
        "x-voice-caller-id": { variable_name: "system__caller_id" },
        "x-voice-called-number": { variable_name: "system__called_number" },
        "x-voice-channel": { variable_name: "system__channel" },
        "x-voice-conversation-id": { variable_name: "system__conversation_id" },
      },
    });
  });

  test("Kopf x-tybo-rezept fehlt bei anbieter", async () => {
    await layer(BRIDGE_ENV).deploy(recipeFrom(baseRecipe()), PROMPT);
    expect(fake.calls.map((call) => call.raw).join()).not.toContain("x-tybo-rezept");
    expect(fake.secrets.size).toBe(0);
  });

  test("Das Token geht nur ins Geheimnis, nie in den Agenten oder den Zustand", async () => {
    await layer(BRIDGE_ENV).deploy(bridgeRecipe(), PROMPT);
    const withToken = fake.calls.filter((call) => call.raw.includes(BRIDGE_TOKEN));
    expect(withToken.map((call) => `${call.method} ${call.path}`)).toEqual(["POST /secrets"]);
    expectClean(stateFile());
    expect((await loaded()).brueckenGeheimnisId).toBe("secret_1");
  });

  test.each([
    ["Adresse fehlt", { ...ENV, VOICE_BRIDGE_TOKEN: BRIDGE_TOKEN }, "VOICE_BRIDGE_URL"],
    ["Token fehlt", { ...ENV, VOICE_BRIDGE_URL: BRIDGE_URL }, "VOICE_BRIDGE_TOKEN"],
    ["ohne TLS", { ...BRIDGE_ENV, VOICE_BRIDGE_URL: "http://bruecke.example.com/v1/chat/completions" }, "VOICE_BRIDGE_URL"],
    ["mit Zugangsdaten", { ...BRIDGE_ENV, VOICE_BRIDGE_URL: "https://a:b@bruecke.example.com/v1/chat/completions" }, "VOICE_BRIDGE_URL"],
    ["mit Parameter", { ...BRIDGE_ENV, VOICE_BRIDGE_URL: `${BRIDGE_URL}?token=x` }, "VOICE_BRIDGE_URL"],
    ["falscher Pfad", { ...BRIDGE_ENV, VOICE_BRIDGE_URL: "https://bruecke.example.com/" }, "VOICE_BRIDGE_URL"],
    ["keine Adresse", { ...BRIDGE_ENV, VOICE_BRIDGE_URL: "bruecke" }, "VOICE_BRIDGE_URL"],
  ])("%s: Fehler ohne Aufruf", async (_name, env, expected) => {
    const result: any = await layer(env).deploy(bridgeRecipe(), PROMPT);
    expect(result.status).toBe("fehler");
    expect(result.fehler).toContain(expected);
    expectClean(result.fehler);
    expect(fake.calls).toHaveLength(0);
  });

  test("Wechsel zu anbieter entfernt die Brücke samt Geheimnis", async () => {
    await layer(BRIDGE_ENV).deploy(bridgeRecipe(), PROMPT);
    const result = await layer(BRIDGE_ENV).deploy(recipeFrom(baseRecipe()), PROMPT);
    expect(result.status).toBe("geaendert");
    const prompt = fake.agents.get("agent_2").conversation_config.agent.prompt;
    expect(prompt.custom_llm).toBeNull();
    expect(prompt.llm).toBe("claude-sonnet-5-5");
    expect(fake.secrets.size).toBe(0);
    const state = await loaded();
    expect(state.brueckenGeheimnisId).toBeUndefined();
    expect(state.letzterHash).toBe(recipeHash(recipeFrom(baseRecipe())));
  });

  test("Bleibt die alte Brücke beim Anbieter, gilt der Wechsel nicht als geschafft und das Geheimnis bleibt", async () => {
    await layer(BRIDGE_ENV).deploy(bridgeRecipe(), PROMPT);
    fake.override((call) => call.method === "PATCH" && call.path.startsWith("/agents/"), () => jsonResponse({}));
    const result: any = await layer(BRIDGE_ENV).deploy(recipeFrom(baseRecipe()), PROMPT);
    expect(result.status).toBe("fehler");
    expect(result.fehler).toContain("alte Brücke");
    expect(fake.secrets.size).toBe(1);
    expect((await loaded()).brueckenGeheimnisId).toBe("secret_1");
  });

  test("Scheitert das Löschen des Geheimnisses, bleibt der Verweis, und die nächste Rezeptänderung versucht es nochmal", async () => {
    await layer(BRIDGE_ENV).deploy(bridgeRecipe(), PROMPT);
    fake.override((call) => call.method === "DELETE" && call.path.startsWith("/secrets/"), () => jsonResponse({ detail: "in use" }, 500));
    const raw = baseRecipe();
    const recipe = recipeFrom(raw);
    const result: any = await layer().deploy(recipe, PROMPT);
    expect(result.status).toBe("geaendert");
    expect(result.hinweise.join()).toContain("nicht löschen");
    expect((await loaded()).brueckenGeheimnisId).toBe("secret_1");

    const again: any = await layer().deploy(recipe, PROMPT);
    expect(again.status).toBe("unveraendert");
    expect(again.hinweise.join()).toContain("alten Brücke");
    fake.calls = [];
    raw.zugang.maxMinuten = 20;
    await layer().deploy(recipeFrom(raw), PROMPT);
    expect(fake.secrets.size).toBe(0);
    expect((await loaded()).brueckenGeheimnisId).toBeUndefined();
  });

  test("neues Token: kein Aufruf bei gleichem Rezept, aber Hinweis; die nächste Rezeptänderung erneuert das Geheimnis", async () => {
    const raw = baseRecipe();
    raw.gehirn = { art: "bruecke", modell: "claude-opus-5-5" };
    const recipe = recipeFrom(raw);
    await layer(BRIDGE_ENV).deploy(recipe, PROMPT);
    fake.calls = [];
    const rotated = { ...BRIDGE_ENV, VOICE_BRIDGE_TOKEN: "neues-token-1234567" };
    const result: any = await layer(rotated).deploy(recipe, PROMPT);
    expect(result.status).toBe("unveraendert");
    expect(result.hinweise).toHaveLength(1);
    expect(fake.calls).toHaveLength(0);

    raw.zugang.maxMinuten = 20;
    await layer(rotated).deploy(recipeFrom(raw), PROMPT);
    expect(fake.secrets.get("secret_1").value).toBe("neues-token-1234567");
    expect(fake.secrets.size).toBe(1);
  });
});

describe("Handänderungen beim Anbieter", () => {
  async function deployed() {
    const raw = baseRecipe();
    await layer().deploy(recipeFrom(raw), PROMPT);
    raw.zugang.maxMinuten = 20;
    fake.calls = [];
    return recipeFrom(raw);
  }

  test("Warnung statt stillem Überschreiben, Zustand bleibt", async () => {
    const next = await deployed();
    fake.agents.get("agent_1").conversation_config.agent.prompt.prompt = "Von Hand geändert";
    fake.agents.get("agent_1").conversation_config.tts.voice_id = "andere-stimme";
    const before = stateFile();
    const result: any = await layer().deploy(next, PROMPT);
    expect(result.status).toBe("handaenderung");
    expect(result.felder).toEqual(["Prompt", "Stimme"]);
    expect(result.warnung).toContain("Nichts wurde überschrieben");
    expect(result.warnung).not.toContain("Von Hand geändert");
    expect(fake.writes()).toHaveLength(0);
    expect(stateFile()).toBe(before);
  });

  test("Wird die Handänderung zurückgenommen, geht der Abgleich weiter", async () => {
    const next = await deployed();
    fake.agents.get("agent_1").conversation_config.agent.prompt.prompt = "Von Hand geändert";
    expect((await layer().deploy(next, PROMPT)).status).toBe("handaenderung");
    fake.agents.get("agent_1").conversation_config.agent.prompt.prompt = PROMPT;
    expect((await layer().deploy(next, PROMPT)).status).toBe("geaendert");
    expect(fake.agents.get("agent_1").conversation_config.conversation.max_duration_seconds).toBe(1200);
  });

  test("Entfernen und neu anlegen übernimmt das Rezept", async () => {
    const next = await deployed();
    fake.agents.get("agent_1").conversation_config.agent.prompt.prompt = "Von Hand geändert";
    expect((await layer().deploy(next, PROMPT)).status).toBe("handaenderung");
    expect((await layer().remove(await loaded())).status).toBe("ok");
    expect((await layer().deploy(next, PROMPT)).status).toBe("angelegt");
    expect(fake.agents.get("agent_2").conversation_config.agent.prompt.prompt).toBe(PROMPT);
  });

  test("Gleicher Hash ruft auch bei einer Handänderung nichts auf", async () => {
    const recipe = recipeFrom(baseRecipe());
    await layer().deploy(recipe, PROMPT);
    fake.agents.get("agent_1").conversation_config.agent.prompt.prompt = "Von Hand geändert";
    fake.calls = [];
    expect((await layer().deploy(recipe, PROMPT)).status).toBe("unveraendert");
    expect(fake.calls).toHaveLength(0);
  });

  const handEdits: [string, string, (agent: any) => void][] = [
    ["Name", "Name", (agent) => (agent.name = "Anders")],
    ["Schlagwort", "Schlagwörter", (agent) => agent.tags.push("fremd")],
    ["erster Satz", "erster Satz", (agent) => (agent.conversation_config.agent.first_message = "Anders")],
    ["Schutz", "Schutz des ersten Satzes", (agent) => (agent.conversation_config.agent.disable_first_message_interruptions = true)],
    ["Hauptsprache", "Sprache", (agent) => (agent.conversation_config.agent.language = "fr")],
    ["Sprache innerhalb der Variante", "weitere Sprachen", (agent) => (agent.conversation_config.language_presets.en.overrides.agent.language = "fr")],
    ["erster Satz innerhalb der Variante", "weitere Sprachen", (agent) => (agent.conversation_config.language_presets.en.overrides.agent.first_message = "Hello there")],
    ["neue Variante", "weitere Sprachen", (agent) => (agent.conversation_config.language_presets.fr = { overrides: { agent: { language: "fr" } } })],
    ["entfernte Variante", "weitere Sprachen", (agent) => delete agent.conversation_config.language_presets.en],
    ["Modell", "Modell", (agent) => (agent.conversation_config.agent.prompt.llm = "anderes-modell")],
    ["Werkzeug entfernt", "eingebaute Werkzeuge", (agent) => (agent.conversation_config.agent.prompt.built_in_tools.end_call = null)],
    ["Inhalt eines Werkzeugs", "eingebaute Werkzeuge", (agent) => (agent.conversation_config.agent.prompt.built_in_tools.end_call.description = "Nie auflegen")],
    ["Stimmmodell", "Stimmmodell", (agent) => (agent.conversation_config.tts.model_id = "anders")],
    ["Tempo", "Tempo", (agent) => (agent.conversation_config.tts.speed = 0.7)],
    ["Höchstdauer", "Höchstdauer", (agent) => (agent.conversation_config.conversation.max_duration_seconds = 9)],
    ["Anmeldepflicht", "Anmeldepflicht", (agent) => (agent.platform_settings.auth.enable_auth = false)],
  ];

  test.each(handEdits)("%s von Hand geändert: Warnung vor jedem Schreibaufruf", async (_name, label, edit) => {
    const raw = baseRecipe();
    raw.persona.sprachen = ["de", "en"];
    await layer().deploy(recipeFrom(raw), PROMPT);
    edit(fake.agents.get("agent_1"));
    raw.zugang.maxMinuten = 20;
    fake.calls = [];
    const before = stateFile();
    const result: any = await layer().deploy(recipeFrom(raw), PROMPT);
    expect(result.status).toBe("handaenderung");
    expect(result.felder).toEqual([label]);
    expect(fake.writes()).toHaveLength(0);
    expect(stateFile()).toBe(before);
  });

  test("Brücke: auch api_type zählt als eigener Wert", async () => {
    const raw = baseRecipe();
    raw.gehirn = { art: "bruecke", modell: "claude-opus-5-5" };
    await layer(BRIDGE_ENV).deploy(recipeFrom(raw), PROMPT);
    fake.agents.get("agent_2").conversation_config.agent.prompt.custom_llm.api_type = "responses";
    raw.zugang.maxMinuten = 20;
    fake.calls = [];
    const result: any = await layer(BRIDGE_ENV).deploy(recipeFrom(raw), PROMPT);
    expect(result.felder).toEqual(["Brücke"]);
    expect(fake.writes()).toHaveLength(0);
  });

  test("Füllt der Anbieter eine Variante mit null auf, ist das keine Handänderung", async () => {
    const raw = baseRecipe();
    raw.persona.sprachen = ["de", "en"];
    await layer().deploy(recipeFrom(raw), PROMPT);
    const preset = fake.agents.get("agent_1").conversation_config.language_presets.en;
    preset.first_message_translation = null;
    preset.overrides.tts = null;
    preset.overrides.agent.prompt = null;
    raw.zugang.maxMinuten = 20;
    expect((await layer().deploy(recipeFrom(raw), PROMPT)).status).toBe("geaendert");
  });

  test("Was der Anbieter außerhalb des Rezepts ergänzt, zählt nicht", async () => {
    const next = await deployed();
    const agent = fake.agents.get("agent_1");
    agent.metadata.updated = 99;
    agent.conversation_config.asr.quality = "low";
    expect((await layer().deploy(next, PROMPT)).status).toBe("geaendert");
  });

  test("Agent von Hand gelöscht: Warnung; nach dem Entfernen neu angelegt", async () => {
    const next = await deployed();
    fake.agents.delete("agent_1");
    const result: any = await layer().deploy(next, PROMPT);
    expect(result.status).toBe("handaenderung");
    expect(result.felder).toEqual(["Agent gelöscht"]);
    expect(fake.writes()).toHaveLength(0);

    expect((await layer().remove(await loaded())).status).toBe("ok");
    expect((await layer().deploy(next, PROMPT)).status).toBe("angelegt");
    expect((await loaded()).agentId).toBe("agent_2");
  });

  test("Stand nicht lesbar: nichts wird überschrieben", async () => {
    const next = await deployed();
    fake.override((call) => call.method === "GET", () => jsonResponse({ detail: "weg" }, 500));
    expect(await layer().deploy(next, PROMPT)).toMatchObject({ status: "fehler", vorlaeufig: true });
    fake.override((call) => call.method === "GET", () => jsonResponse({ unsinn: true }));
    expect(await layer().deploy(next, PROMPT)).toMatchObject({ status: "fehler", vorlaeufig: false });
    expect(fake.writes()).toHaveLength(0);
  });
});

describe("Nachfrage nach dem Schreiben scheitert", () => {
  const getFails = () => {
    let gets = 0;
    return (call: { method: string }) => call.method === "GET" && ++gets === 2;
  };

  test("Schreiben gelingt, GET scheitert, Handänderung, erneuter Abgleich: Die Handänderung bleibt", async () => {
    const raw = baseRecipe();
    await layer().deploy(recipeFrom(raw), PROMPT);
    raw.zugang.maxMinuten = 20;
    fake.override(getFails(), () => jsonResponse({ detail: "kaputt" }, 503));
    expect(await layer().deploy(recipeFrom(raw), PROMPT)).toMatchObject({ status: "fehler", vorlaeufig: true });
    expect(fake.agents.get("agent_1").conversation_config.conversation.max_duration_seconds).toBe(1200);

    fake.agents.get("agent_1").conversation_config.agent.prompt.prompt = "Von Hand geändert";
    fake.calls = [];
    const before = stateFile();
    const result: any = await layer().deploy(recipeFrom(raw), PROMPT);
    expect(result.status).toBe("handaenderung");
    expect(result.felder).toEqual(["Prompt"]);
    expect(result.warnung).toContain("Nichts wurde überschrieben");
    expect(fake.writes()).toHaveLength(0);
    expect(stateFile()).toBe(before);
    expect(fake.agents.get("agent_1").conversation_config.agent.prompt.prompt).toBe("Von Hand geändert");
  });

  test("Auch nach dem Anlegen bleibt eine Handänderung erhalten, sogar mit neuem Rezept", async () => {
    const raw = baseRecipe();
    fake.override((call) => call.method === "GET", () => jsonResponse({ detail: "kaputt" }, 503));
    await layer().deploy(recipeFrom(raw), PROMPT);
    fake.agents.get("agent_1").conversation_config.tts.voice_id = "von-hand";
    raw.name = "Neuer Name";
    fake.calls = [];
    const result: any = await layer().deploy(recipeFrom(raw), PROMPT);
    expect(result.status).toBe("handaenderung");
    expect(result.felder).toEqual(["Stimme"]);
    expect(fake.writes()).toHaveLength(0);
    expect(fake.agents.get("agent_1").conversation_config.tts.voice_id).toBe("von-hand");
  });

  test("Ohne Handänderung und mit neuem Rezept: bestätigt, dann geschrieben", async () => {
    const raw = baseRecipe();
    await layer().deploy(recipeFrom(raw), PROMPT);
    raw.zugang.maxMinuten = 20;
    fake.override(getFails(), () => jsonResponse({ detail: "kaputt" }, 503));
    await layer().deploy(recipeFrom(raw), PROMPT);
    raw.zugang.maxMinuten = 30;
    expect((await layer().deploy(recipeFrom(raw), PROMPT)).status).toBe("geaendert");
    expect(fake.agents.get("agent_1").conversation_config.conversation.max_duration_seconds).toBe(1800);
    const state = await loaded();
    expect(state.letzterHash).toBe(recipeHash(recipeFrom(raw)));
    expect(state.ausstehend).toBeUndefined();
  });

  test("Wechsel zu anbieter: Das Geheimnis fällt erst, wenn der Schreibstand bestätigt ist", async () => {
    await layer(BRIDGE_ENV).deploy(bridgeRecipe(), PROMPT);
    const recipe = recipeFrom(baseRecipe());
    fake.override(getFails(), () => jsonResponse({ detail: "kaputt" }, 503));
    await layer(BRIDGE_ENV).deploy(recipe, PROMPT);
    expect(fake.secrets.size).toBe(1);
    expect((await layer(BRIDGE_ENV).deploy(recipe, PROMPT)).status).toBe("geaendert");
    expect(fake.secrets.size).toBe(0);
    expect((await loaded()).brueckenGeheimnisId).toBeUndefined();
  });

  test("Ohne jede Vergleichsgrundlage: Warnung, kein Schreibaufruf", async () => {
    const raw = baseRecipe();
    await layer().deploy(recipeFrom(raw), PROMPT);
    await updateState("beispiel", { anbieterStand: undefined, letzterHash: undefined } as any, paths);
    raw.zugang.maxMinuten = 20;
    fake.calls = [];
    const result: any = await layer().deploy(recipeFrom(raw), PROMPT);
    expect(result.status).toBe("handaenderung");
    expect(result.felder).toEqual(["Stand unbekannt"]);
    expect(fake.writes()).toHaveLength(0);
  });

  test("Entfernen räumt auch den ausstehenden Stand ab", async () => {
    const recipe = recipeFrom(baseRecipe());
    fake.override((call) => call.method === "GET", () => jsonResponse({ detail: "kaputt" }, 503));
    await layer().deploy(recipe, PROMPT);
    expect((await loaded()).ausstehend).toBeDefined();
    await layer().remove(await loaded());
    expect((await loaded()).ausstehend).toBeUndefined();
    expect((await layer().deploy(recipe, PROMPT)).status).toBe("angelegt");
  });
});

describe("Sprachen ändern", () => {
  async function fromTwoToOne(extra: (raw: any) => void = () => {}, env = ENV as Record<string, string | undefined>) {
    const raw = baseRecipe();
    extra(raw);
    raw.persona.sprachen = ["de", "en"];
    await layer(env).deploy(recipeFrom(raw), PROMPT);
    raw.persona.sprachen = ["de"];
    fake.calls = [];
    return raw;
  }
  const presets = (id = "agent_1") => fake.agents.get(id).conversation_config.language_presets;
  const deleteOld = (call: { method: string; path: string }) => call.method === "DELETE" && call.path === "/agents/agent_1";

  test.each(["zusammenfuehren", "ersetzen"] as const)("Entfernte Sprache (PATCH: %s): neuer Agent, der alte ist weg, kein PATCH", async (mode) => {
    fake.presetPatch = mode;
    const raw = await fromTwoToOne();
    const result: any = await layer().deploy(recipeFrom(raw), PROMPT);
    expect(result.status).toBe("geaendert");
    expect(result.hinweise.join(" ")).toContain("neue Kennung");

    expect(fake.of("PATCH", /^\/agents\//)).toHaveLength(0);
    expect(fake.of("POST", /^\/agents\/create$/)).toHaveLength(1);
    expect(fake.calls.map((call) => `${call.method} ${call.path}`)).toEqual(["GET /agents/agent_1", "POST /agents/create", "GET /agents/agent_2", "DELETE /agents/agent_1"]);
    expect(fake.agents.has("agent_1")).toBe(false);
    expect(presets("agent_2")).toEqual({});
    expect(fake.agents.get("agent_2").conversation_config.agent.prompt.built_in_tools.language_detection).toBeNull();
    expect(fake.agents.get("agent_2").platform_settings.auth.enable_auth).toBe(true);

    const state = await loaded();
    expect(state.agentId).toBe("agent_2");
    expect(state.ersetzterAgentId).toBeUndefined();
    expect(state.ausstehend).toBeUndefined();
    expect(state.letzterHash).toBe(recipeHash(recipeFrom(raw)));

    fake.calls = [];
    expect((await layer().deploy(recipeFrom(raw), PROMPT)).status).toBe("unveraendert");
    expect(fake.calls).toHaveLength(0);

    raw.zugang.maxMinuten = 20;
    expect((await layer().deploy(recipeFrom(raw), PROMPT)).status).toBe("geaendert");
    expect(fake.of("PATCH", /^\/agents\/agent_2$/)).toHaveLength(1);
    expect(fake.agents.size).toBe(1);
  });

  test("Tests bleiben erhalten und laufen gegen den neuen Agenten", async () => {
    const raw = baseRecipe();
    raw.persona.sprachen = ["de", "en"];
    await layer().deploy(recipeFrom(raw), PROMPT);
    await layer().syncTests(recipeFrom(raw), await loaded());
    const before = (await loaded()).tests;
    raw.persona.sprachen = ["de"];
    await layer().deploy(recipeFrom(raw), PROMPT);
    expect((await loaded()).tests).toEqual(before);
    const { agentId } = await loaded();
    expect(agentId).not.toBe("agent_1");
    expect((await layer().runTests(await loaded())).status).toBe("gestartet");
    expect(fake.of("POST", /\/run-tests$/).map((call) => call.path)).toEqual([`/agents/${agentId}/run-tests`]);
  });

  test("Neu anlegen scheitert: Der alte Agent bleibt, ein neuer Aufruf holt es ohne Warnung nach", async () => {
    const raw = await fromTwoToOne();
    const before = await loaded();
    fake.override((call) => call.path === "/agents/create", () => jsonResponse({ detail: "kaputt" }, 503));
    const result: any = await layer().deploy(recipeFrom(raw), PROMPT);
    expect(result).toMatchObject({ status: "fehler", vorlaeufig: true });
    expect(fake.of("DELETE", /^\/agents\//)).toHaveLength(0);
    const after = await loaded();
    expect(after.agentId).toBe("agent_1");
    expect(after.letzterHash).toBe(before.letzterHash);
    expect(after.ersetzterAgentId).toBeUndefined();

    expect((await layer().deploy(recipeFrom(raw), PROMPT)).status).toBe("geaendert");
    expect((await loaded()).agentId).toBe("agent_2");
    expect(fake.agents.has("agent_1")).toBe(false);
  });

  test("Nachfrage beim neuen Agenten scheitert: Der alte fällt erst nach der Bestätigung", async () => {
    const raw = await fromTwoToOne();
    fake.override((call) => call.method === "GET" && call.path === "/agents/agent_2", () => jsonResponse({ detail: "kaputt" }, 503));
    const first: any = await layer().deploy(recipeFrom(raw), PROMPT);
    expect(first.status).toBe("fehler");
    expect(fake.agents.has("agent_1")).toBe(true);
    const pending = await loaded();
    expect(pending.agentId).toBe("agent_2");
    expect(pending.ersetzterAgentId).toBe("agent_1");
    expect(pending.letzterHash).toBeUndefined();

    fake.calls = [];
    expect((await layer().deploy(recipeFrom(raw), PROMPT)).status).toBe("geaendert");
    expect(fake.of("POST", /^\/agents\/create$/)).toHaveLength(0);
    expect(fake.agents.has("agent_1")).toBe(false);
    expect((await loaded()).ersetzterAgentId).toBeUndefined();
  });

  test("Alter Agent lässt sich nicht löschen: Hinweis, kein Aufruf bei gleichem Hash, remove räumt beide ab", async () => {
    const raw = await fromTwoToOne();
    fake.override(deleteOld, () => jsonResponse({ detail: "kaputt" }, 500));
    const result: any = await layer().deploy(recipeFrom(raw), PROMPT);
    expect(result.status).toBe("geaendert");
    expect(result.hinweise.join(" ")).toContain("ersetzte Agent");
    expect((await loaded()).ersetzterAgentId).toBe("agent_1");
    expect((await loaded()).letzterHash).toBe(recipeHash(recipeFrom(raw)));

    fake.calls = [];
    const same: any = await layer().deploy(recipeFrom(raw), PROMPT);
    expect(same.status).toBe("unveraendert");
    expect(same.hinweise.join(" ")).toContain("ersetzte Agent");
    expect(fake.calls).toHaveLength(0);

    expect((await layer().remove(await loaded())).status).toBe("ok");
    expect(fake.agents.size).toBe(0);
    expect((await loaded()).ersetzterAgentId).toBeUndefined();
  });

  test("Alter Agent schon weg (404): gilt als gelöscht", async () => {
    const raw = await fromTwoToOne();
    fake.override(deleteOld, () => jsonResponse({ detail: "not found" }, 404));
    const result: any = await layer().deploy(recipeFrom(raw), PROMPT);
    expect(result.status).toBe("geaendert");
    expect((await loaded()).ersetzterAgentId).toBeUndefined();
  });

  test("Noch ein Ersetzter offen und nicht löschbar: Kein weiterer Agent, seine Kennung geht nicht verloren", async () => {
    const raw = baseRecipe();
    raw.persona.sprachen = ["de", "en", "fr"];
    await layer().deploy(recipeFrom(raw), PROMPT);
    raw.persona.sprachen = ["de", "en"];
    fake.override(deleteOld, () => jsonResponse({ detail: "kaputt" }, 500));
    await layer().deploy(recipeFrom(raw), PROMPT);
    expect((await loaded()).ersetzterAgentId).toBe("agent_1");

    raw.persona.sprachen = ["de"];
    fake.calls = [];
    fake.override(deleteOld, () => jsonResponse({ detail: "kaputt" }, 500));
    const blocked: any = await layer().deploy(recipeFrom(raw), PROMPT);
    expect(blocked.status).toBe("fehler");
    expect(fake.of("POST", /^\/agents\/create$/)).toHaveLength(0);
    expect((await loaded()).ersetzterAgentId).toBe("agent_1");
    expect((await loaded()).agentId).toBe("agent_2");

    expect((await layer().deploy(recipeFrom(raw), PROMPT)).status).toBe("geaendert");
    expect([...fake.agents.keys()]).toEqual(["agent_3"]);
  });

  test.each([
    ["Telefonnummer", { phone_numbers: [{ phone_number_id: "nummer_1" }] }],
    ["WhatsApp-Konto", { whatsapp_accounts: [{ phone_number_id: "wa_1" }] }],
  ])("%s am Agenten: Fehler ohne Schreibaufruf, die Zuordnung bleibt", async (_name, binding) => {
    const raw = await fromTwoToOne();
    Object.assign(fake.agents.get("agent_1"), binding);
    const result: any = await layer().deploy(recipeFrom(raw), PROMPT);
    expect(result).toMatchObject({ status: "fehler", vorlaeufig: false });
    expect(result.fehler).toContain("Nichts wurde geändert");
    expect(fake.writes()).toHaveLength(0);
    expect((await loaded()).agentId).toBe("agent_1");
  });

  test("Handänderung vor dem Entfernen einer Sprache: Warnung, kein neuer Agent", async () => {
    const raw = await fromTwoToOne();
    presets().en.overrides.agent.language = "fr";
    const result: any = await layer().deploy(recipeFrom(raw), PROMPT);
    expect(result.status).toBe("handaenderung");
    expect(result.felder).toEqual(["weitere Sprachen"]);
    expect(fake.writes()).toHaveLength(0);
  });

  test("Brücke zu Anbieter mit entfallender Sprache: erst der alte Agent, dann das Geheimnis", async () => {
    const raw = await fromTwoToOne((recipe) => (recipe.gehirn = { art: "bruecke", modell: "claude-opus-5-5" }), BRIDGE_ENV);
    raw.gehirn = { art: "anbieter", modell: "claude-sonnet-5-5" };
    expect((await layer(BRIDGE_ENV).deploy(recipeFrom(raw), PROMPT)).status).toBe("geaendert");
    const deletes = fake.writes().filter((call) => call.method === "DELETE").map((call) => call.path);
    expect(deletes).toEqual(["/agents/agent_2", "/secrets/secret_1"]);
    expect((await loaded()).brueckenGeheimnisId).toBeUndefined();
    expect(fake.agents.get("agent_3").conversation_config.agent.prompt.custom_llm).toBeNull();
    expect(stateFile()).not.toContain(BRIDGE_TOKEN);
  });

  test.each([
    ["Hauptsprache", (agent: any) => (agent.conversation_config.agent.language = "fr")],
    ["fehlende Variante", (agent: any) => (agent.conversation_config.language_presets = {})],
    ["falscher Inhalt der Variante", (agent: any) => (agent.conversation_config.language_presets.en.overrides.agent.language = "fr")],
  ])("Zurückgelesen falsch (%s): kein letzterHash", async (_name, spoil) => {
    const raw = baseRecipe();
    raw.persona.sprachen = ["de", "en"];
    const original = fake.fetch;
    const spoiled = async (url: string, init: RequestInit) => {
      const response = await original(url, init);
      if (init.method !== "GET") return response;
      const agent = await response.json();
      spoil(agent);
      return jsonResponse(agent);
    };
    const result: any = await createElevenLabsLayer({ env: ENV, fetch: spoiled, paths, clock: fakeClock() }).deploy(recipeFrom(raw), PROMPT);
    expect(result.status).toBe("fehler");
    expect(result.fehler).toContain("Sprachen");
    expect((await loaded()).letzterHash).toBeUndefined();
  });

  test.each(["zusammenfuehren", "ersetzen"] as const)("Neue Sprache kommt hinzu (PATCH: %s): gleicher Agent", async (mode) => {
    fake.presetPatch = mode;
    const raw = baseRecipe();
    await layer().deploy(recipeFrom(raw), PROMPT);
    raw.persona.sprachen = ["de", "en"];
    expect((await layer().deploy(recipeFrom(raw), PROMPT)).status).toBe("geaendert");
    expect(fake.of("POST", /^\/agents\/create$/)).toHaveLength(1);
    expect(presets()).toEqual({ en: { overrides: { agent: { language: "en" } } } });
    expect(fake.agents.get("agent_1").conversation_config.agent.prompt.built_in_tools.language_detection.name).toBe("language_detection");
  });

  test("Wechsel der Hauptsprache: Die frühere Hauptsprache wird Variante, die neue fällt als Variante weg", async () => {
    const raw = baseRecipe();
    raw.persona.sprachen = ["de", "en"];
    await layer().deploy(recipeFrom(raw), PROMPT);
    raw.persona.sprachen = ["en", "de"];
    expect((await layer().deploy(recipeFrom(raw), PROMPT)).status).toBe("geaendert");
    expect(fake.agents.has("agent_1")).toBe(false);
    const config = fake.agents.get("agent_2").conversation_config;
    expect(config.agent.language).toBe("en");
    expect(config.language_presets).toEqual({ de: { overrides: { agent: { language: "de" } } } });
  });
});

describe("Geheimnisse", () => {
  const echo = (status: number) => async (call: { raw: string; apiKey: string | null }) =>
    jsonResponse({ detail: `abgelehnt: ${call.apiKey} ${call.raw} ${encodeURIComponent(BRIDGE_TOKEN)} ${Buffer.from(API_KEY).toString("base64")} Bearer ${BRIDGE_TOKEN}` }, status);

  test.each([[422], [500]])("HTTP %i spiegelt Schlüssel und Token: Fehlertext bleibt sauber", async (status) => {
    fake.override((call) => call.path === "/secrets", echo(status));
    const result: any = await layer(BRIDGE_ENV).deploy(bridgeRecipe(), PROMPT);
    expect(result.status).toBe("fehler");
    expect(result.fehler).toStartWith(`HTTP ${status}`);
    expectClean(result.fehler);
    expect(result.fehler).not.toContain(encodeURIComponent(BRIDGE_TOKEN));
    expect(result.fehler).not.toContain(Buffer.from(API_KEY).toString("base64"));
  });

  test("Netzfehler mit Schlüssel in der Meldung: nur ein allgemeiner Text", async () => {
    const leaky = () => {
      throw new Error(`connect failed ${API_KEY} ${BRIDGE_TOKEN}`);
    };
    const failing = createElevenLabsLayer({ env: BRIDGE_ENV, fetch: leaky, paths, clock: fakeClock() });
    const result: any = await failing.deploy(bridgeRecipe(), PROMPT);
    expect(result).toMatchObject({ status: "fehler", fehler: "Anbieter nicht erreichbar", vorlaeufig: true });
  });

  test("Zeitablauf heißt Zeitablauf", async () => {
    const slow = () => {
      throw new DOMException("zu lang", "TimeoutError");
    };
    const result = await createElevenLabsLayer({ env: ENV, fetch: slow, paths, clock: fakeClock() }).deploy(recipeFrom(baseRecipe()), PROMPT);
    expect(result).toMatchObject({ fehler: "Zeitablauf", vorlaeufig: true });
  });

  test("Spiegelt der Agent Schlüssel und Token, bleiben Zustand und Warnung sauber", async () => {
    const raw = baseRecipe();
    await layer(BRIDGE_ENV).deploy(recipeFrom(raw), PROMPT);
    const agent = fake.agents.get("agent_1");
    agent.conversation_config.agent.prompt.custom_llm = { url: BRIDGE_URL, request_headers: { Authorization: `Bearer ${BRIDGE_TOKEN}`, "xi-api-key": API_KEY } };
    raw.zugang.maxMinuten = 20;

    const warned: any = await layer(BRIDGE_ENV).deploy(recipeFrom(raw), PROMPT);
    expect(warned.status).toBe("handaenderung");
    expect(warned.felder).toEqual(["Brücke"]);
    expectClean(JSON.stringify(warned));
    expectClean(stateFile());
  });

  test("Auch nach dem Abgleich mit gespiegelten Werten steht kein Geheimnis im Zustand", async () => {
    const raw = baseRecipe();
    await layer(BRIDGE_ENV).deploy(recipeFrom(raw), PROMPT);
    let gets = 0;
    fake.override((call) => call.method === "GET" && ++gets === 2, () => jsonResponse({ name: `Agent ${API_KEY} ${BRIDGE_TOKEN}`, conversation_config: { agent: { language: "de", prompt: { prompt: BRIDGE_TOKEN } } }, platform_settings: { auth: { enable_auth: true } } }));
    raw.name = "Neu";
    expect((await layer(BRIDGE_ENV).deploy(recipeFrom(raw), PROMPT)).status).toBe("geaendert");
    expect((await loaded()).anbieterStand).toBeDefined();
    expectClean(stateFile());
  });

  test("Eine Kennung, die den Schlüssel spiegelt, wird nicht gespeichert", async () => {
    fake.override((call) => call.path === "/agents/create", () => jsonResponse({ agent_id: API_KEY }));
    const result: any = await layer().deploy(recipeFrom(baseRecipe()), PROMPT);
    expect(result.status).toBe("fehler");
    expectClean(JSON.stringify(result));
  });

  test("Der Adapter schreibt nichts ins Log", async () => {
    const spies = [spyOn(console, "log"), spyOn(console, "error"), spyOn(console, "warn"), spyOn(console, "info")];
    try {
      fake.override((call) => call.path === "/secrets", echo(422));
      await layer(BRIDGE_ENV).deploy(bridgeRecipe(), PROMPT);
      await layer(BRIDGE_ENV).deploy(bridgeRecipe(), PROMPT);
      await layer().remove(await loaded());
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  test("Der Schlüssel geht nur in den Kopf der Anfrage", async () => {
    await layer().deploy(recipeFrom(baseRecipe()), PROMPT);
    for (const call of fake.calls) {
      expect(call.apiKey).toBe(API_KEY);
      expect(call.raw).not.toContain(API_KEY);
    }
  });
});

describe("Löschen", () => {
  async function full() {
    const recipe = bridgeRecipe();
    const created: any = await layer(BRIDGE_ENV).deploy(recipe, PROMPT);
    const synced: any = await layer(BRIDGE_ENV).syncTests(recipe, created.state);
    return synced.state as VoiceLayerState;
  }

  test("entfernt Tests, Agent und Geheimnis und vergisst die Kennungen", async () => {
    const state = await full();
    const result: any = await layer(BRIDGE_ENV).remove(state);
    expect(result.status).toBe("ok");
    expect(fake.agents.size).toBe(0);
    expect(fake.secrets.size).toBe(0);
    expect(fake.tests.size).toBe(0);
    const after = await loaded();
    expect(after.agentId).toBeUndefined();
    expect(after.letzterHash).toBeUndefined();
    expect(after.brueckenGeheimnisId).toBeUndefined();
    expect(after.tests).toEqual({});
  });

  test("Das Geheimnis fällt nach dem Agenten, sonst lehnt ElevenLabs ab", async () => {
    const state = await full();
    fake.calls = [];
    await layer(BRIDGE_ENV).remove(state);
    const order = fake.calls.map((call) => call.path.split("/")[1]);
    expect(order.indexOf("secrets")).toBeGreaterThan(order.indexOf("agents"));
  });

  test("Schon beim Anbieter gelöscht zählt als gelöscht", async () => {
    const state = await full();
    fake.agents.clear();
    fake.secrets.clear();
    fake.tests.clear();
    expect((await layer(BRIDGE_ENV).remove(state)).status).toBe("ok");
  });

  test("Teilerfolg bleibt gespeichert, ein zweiter Aufruf macht den Rest", async () => {
    const state = await full();
    fake.override((call) => call.method === "DELETE" && call.path.startsWith("/agents/"), () => jsonResponse({ detail: "später" }, 503));
    const first: any = await layer(BRIDGE_ENV).remove(state);
    expect(first).toMatchObject({ status: "fehler", vorlaeufig: true });
    expect(first.state.tests).toEqual({});
    expect(first.state.agentId).toBe("agent_2");
    expect(fake.agents.size).toBe(1);

    fake.calls = [];
    expect((await layer(BRIDGE_ENV).remove(first.state)).status).toBe("ok");
    expect(fake.of("DELETE", /^\/agent-testing\//)).toHaveLength(0);
    expect(fake.agents.size).toBe(0);
  });

  test("Zustand ohne Kennung: kein Aufruf", async () => {
    const result = await layer().remove({ erstelltAm: "x", geaendertAm: "x", agentId: "a" });
    expect(result.status).toBe("fehler");
    expect(fake.calls).toHaveLength(0);
  });
});
