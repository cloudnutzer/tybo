/**
 * Issue #492, Checkbox 2: Art "sprachagent" im Rückfragen-Register und das
 * Löschen dahinter. Echtes Register mit eigener Datei, Sprachschicht als
 * Attrappe (tests/voice-agents-manage-fixture.ts); kein Anbieteraufruf.
 */
import { afterAll, afterEach, beforeEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decideChoice, getChoice, listChoices, onChoiceDecided, setChoicesFileForTests, type ChoiceConversation } from "../src/lib/choices";
import { updateState } from "../src/lib/voice-agents/state";
import { VOICE_AGENT_CONFIRM_TTL_MS, VOICE_AGENT_SOURCE, VOICE_AGENT_TEXT } from "../src/lib/voice-agents/manage";
import { createChoicePort } from "../src/web/choices";
import { register } from "./choices-fixture";
import { deployed, FIXED_NOW, manageHarness, removeHarnessDirs, writeRecipe, type ManageHarness } from "./voice-agents-manage-fixture";

const DM: ChoiceConversation = { type: "telegram", chatId: "123456" };
const WEB_ID = "0c1a2b3c-0000-4000-8000-000000000000";
const WEB: ChoiceConversation = { type: "web", conversationId: WEB_ID };
/**
 * Manager und Register lesen dieselbe Uhr (Date.now), gestellt mit setSystemTime.
 * Jeder Fall läuft zweimal: am Tag der festen Testzeit und lange nach Ablauf
 * einer dort gestellten Rückfrage (nach dem 08.11.2026), damit kein Test an der
 * Rechnerzeit hängt.
 */
const CLOCKS = [FIXED_NOW, Date.parse("2027-03-15T08:30:00Z")];
let NOW = FIXED_NOW;
let STAMP = "";

let off: (() => void)[] = [];
let logSpy: ReturnType<typeof spyOn>;
let counter = 0;
let choicesRoot = "";

beforeEach(() => {
  const h = manageHarness();
  choicesRoot = h.paths.dataDir;
  setChoicesFileForTests(join(choicesRoot, `choices-${++counter}.json`));
  logSpy = spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  setSystemTime();
  for (const stop of off.splice(0)) stop();
  logSpy.mockRestore();
});
afterAll(() => {
  setChoicesFileForTests(null);
  removeHarnessDirs();
});

/** Harness, dessen Handler im echten Register angemeldet ist */
function wired(options: Parameters<typeof manageHarness>[0] = {}): ManageHarness {
  const h = manageHarness(options);
  off.push(onChoiceDecided("sprachagent", h.manager.handler));
  return h;
}

const recipeFile = (h: ManageHarness, kennung: string) => join(h.paths.configDir, `${kennung}.json`);
const archiveDir = (h: ManageHarness, kennung: string) => join(h.paths.dataDir, kennung, "geloescht");
const archives = (h: ManageHarness, kennung: string) => (existsSync(archiveDir(h, kennung)) ? readdirSync(archiveDir(h, kennung)).sort() : []);
const removes = (h: ManageHarness) => h.layer.calls.filter(c => c.method === "remove").length;

async function ask(h: ManageHarness, kennung = "jarvis", conversation: ChoiceConversation = DM) {
  const outcome = await h.manager.offerDelete(kennung, conversation);
  expect(outcome.status).toBe("gefragt");
  return h.sent.at(-1)!;
}

for (const clock of CLOCKS) {
  describe(`Uhr ${new Date(clock).toISOString()}`, () => {
    beforeEach(() => {
      NOW = clock;
      STAMP = new Date(clock).toISOString().replace(/[:.]/g, "-");
      setSystemTime(new Date(clock));
    });

    describe("Rückfrage", () => {
      test("Art sprachagent, Schritt dauerhaft in action, Knöpfe Ja/Abbrechen, gilt einen Tag; nichts gelöscht", async () => {
        const h = wired();
        writeRecipe(h, "jarvis");
        await deployed(h, "jarvis");
        const choice = await ask(h);
        expect(choice).toMatchObject({
          kind: "sprachagent",
          conversation: DM,
          ref: "jarvis",
          action: "loeschen",
          state: "open",
          options: [
            { key: "ja", label: VOICE_AGENT_TEXT.yes },
            { key: "nein", label: VOICE_AGENT_TEXT.no },
          ],
          expiresAt: NOW + VOICE_AGENT_CONFIRM_TTL_MS,
        });
        expect(choice.text).toBe(VOICE_AGENT_TEXT.confirmDelete("Jarvis", "jarvis"));
        expect(existsSync(recipeFile(h, "jarvis"))).toBe(true);
        expect(h.layer.calls).toEqual([]);
      });

      test("reines Web-Gespräch: Frage mit choiceId ins Gespräch", async () => {
        const posts: unknown[] = [];
        const h = wired({ deps: { postWeb: async (id, post) => (posts.push({ id, post }), true) } });
        writeRecipe(h, "jarvis");
        const choice = await ask(h, "jarvis", WEB);
        expect(posts).toEqual([{ id: WEB_ID, post: { text: choice.text, kind: "notice", source: VOICE_AGENT_SOURCE, choiceId: choice.id } }]);
      });

      test("unbekannte Kennung: keine Frage", async () => {
        const h = wired();
        expect(await h.manager.offerDelete("gibtsnicht", DM)).toEqual({ status: "unbekannt" });
        expect(await h.manager.offerDelete("../etc", DM)).toEqual({ status: "unbekannt" });
        expect(await listChoices()).toEqual([]);
      });

      test("nirgends zugestellt: Frage läuft sofort ab", async () => {
        const h = wired({ sendFails: true });
        writeRecipe(h, "jarvis");
        expect(await h.manager.offerDelete("jarvis", DM)).toEqual({ status: "nicht_zugestellt" });
        expect((await getChoice(h.sent[0]!.id))?.state).toBe("expired");
      });

      test("neue Rückfrage für dieselbe Kennung lässt die ältere ablaufen", async () => {
        const h = wired();
        writeRecipe(h, "jarvis");
        const first = await ask(h);
        const second = await ask(h);
        expect((await getChoice(first.id))?.state).toBe("expired");
        expect((await getChoice(second.id))?.state).toBe("open");
        expect(await decideChoice(first.id, "ja", "telegram")).toEqual({ status: "expired" });
        expect(removes(h)).toBe(0);
      });
    });

    describe("Entscheidung", () => {
      test("Abbrechen: nichts beim Anbieter, Rezept bleibt, Meldung ins Gespräch", async () => {
        const h = wired();
        writeRecipe(h, "jarvis");
        await deployed(h, "jarvis");
        const choice = await ask(h);
        expect((await decideChoice(choice.id, "nein", "telegram")).status).toBe("decided");
        expect(h.layer.calls).toEqual([]);
        expect(existsSync(recipeFile(h, "jarvis"))).toBe(true);
        expect(h.notes).toEqual([{ conversation: DM, text: VOICE_AGENT_TEXT.cancelled("jarvis") }]);
      });

      test("Ja: Agent und Tests beim Anbieter weg, Rezept im Archiv, nicht endgültig gelöscht", async () => {
        const h = wired();
        const raw = writeRecipe(h, "jarvis");
        await deployed(h, "jarvis");
        const original = readFileSync(recipeFile(h, "jarvis"), "utf8");
        const choice = await ask(h);
        const outcome = await decideChoice(choice.id, "ja", "web");
        expect(outcome.status).toBe("decided");
        expect(outcome.status === "decided" ? outcome.choice.handlerError : "x").toBeUndefined();
        expect(h.layer.calls).toEqual([{ method: "remove", arg: "jarvis" }]);
        expect(existsSync(recipeFile(h, "jarvis"))).toBe(false);
        expect(archives(h, "jarvis")).toEqual([`${STAMP}.json`]);
        expect(readFileSync(join(archiveDir(h, "jarvis"), `${STAMP}.json`), "utf8")).toBe(original);
        expect(JSON.parse(original).kennung).toBe(raw.kennung);
        expect(h.notes).toHaveLength(1);
        expect(h.notes[0]!.conversation).toEqual(DM);
        expect(h.notes[0]!.text).toContain("jarvis gelöscht");
        expect(h.notes[0]!.text).toContain(`geloescht/${STAMP}.json`);
        expect((await h.manager.overview()).agents).toEqual([]);
      });

      test("zweiter Klick tut nichts, auch gleichzeitig", async () => {
        const h = wired();
        writeRecipe(h, "jarvis");
        await deployed(h, "jarvis");
        const choice = await ask(h);
        const results = await Promise.all([decideChoice(choice.id, "ja", "telegram"), decideChoice(choice.id, "ja", "web"), decideChoice(choice.id, "nein", "terminal")]);
        expect(results.map(r => r.status).sort()).toEqual(["already", "already", "decided"]);
        expect((await decideChoice(choice.id, "ja", "telegram")).status).toBe("already");
        expect(removes(h)).toBeLessThanOrEqual(1);
        expect(h.notes).toHaveLength(1);
        expect(archives(h, "jarvis").length).toBeLessThanOrEqual(1);
      });

      test("Fehler beim Anbieter lässt das Rezept stehen; neue Rückfrage versucht es erneut", async () => {
        const h = wired();
        writeRecipe(h, "jarvis");
        await deployed(h, "jarvis");
        h.layer.removeResult = async state => ({ status: "fehler", fehler: "HTTP 500", vorlaeufig: true, state });
        const choice = await ask(h);
        expect((await decideChoice(choice.id, "ja", "telegram")).status).toBe("decided");
        expect(existsSync(recipeFile(h, "jarvis"))).toBe(true);
        expect(archives(h, "jarvis")).toEqual([]);
        expect(h.notes[0]!.text).toBe(`${VOICE_AGENT_TEXT.providerFailed("jarvis", "HTTP 500")}\n${VOICE_AGENT_TEXT.retry("jarvis")}`);
        // Die Frage bleibt entschieden, wiederholen braucht eine neue
        expect((await getChoice(choice.id))?.state).toBe("done");
        expect((await decideChoice(choice.id, "ja", "telegram")).status).toBe("already");

        h.layer.removeResult = null;
        const again = await ask(h);
        await decideChoice(again.id, "ja", "telegram");
        expect(existsSync(recipeFile(h, "jarvis"))).toBe(false);
        expect(archives(h, "jarvis")).toEqual([`${STAMP}.json`]);
      });

      test("nie angelegt: kein Aufruf beim Anbieter, nur Archiv", async () => {
        const h = wired();
        writeRecipe(h, "jarvis");
        await decideChoice((await ask(h)).id, "ja", "telegram");
        expect(h.layer.calls).toEqual([]);
        expect(archives(h, "jarvis")).toEqual([`${STAMP}.json`]);
      });

      test("Zustand ohne Reste beim Anbieter: kein Aufruf, auch ohne Anbieter archivierbar", async () => {
        const h = wired({ withLayer: false });
        writeRecipe(h, "jarvis");
        await updateState("jarvis", { kennung: "jarvis", tests: {} } as never, h.paths);
        await decideChoice((await ask(h)).id, "ja", "telegram");
        expect(archives(h, "jarvis")).toEqual([`${STAMP}.json`]);
      });

      test("Anbieter nicht eingerichtet, Agent angelegt: Rezept bleibt", async () => {
        const h = wired({ withLayer: false });
        writeRecipe(h, "jarvis");
        await deployed(h, "jarvis");
        await decideChoice((await ask(h)).id, "ja", "telegram");
        expect(existsSync(recipeFile(h, "jarvis"))).toBe(true);
        expect(h.notes[0]!.text).toBe(VOICE_AGENT_TEXT.noProvider("jarvis"));
      });

      test("vorhandenes Archiv wird nie überschrieben", async () => {
        const h = wired();
        writeRecipe(h, "jarvis");
        mkdirSync(archiveDir(h, "jarvis"), { recursive: true });
        writeFileSync(join(archiveDir(h, "jarvis"), `${STAMP}.json`), "alt");
        await decideChoice((await ask(h)).id, "ja", "telegram");
        expect(archives(h, "jarvis")).toEqual([`${STAMP}-2.json`, `${STAMP}.json`]);
        expect(readFileSync(join(archiveDir(h, "jarvis"), `${STAMP}.json`), "utf8")).toBe("alt");
        expect(existsSync(recipeFile(h, "jarvis"))).toBe(false);
      });

      test("Archivordner als symbolischer Link: Fehler, Rezept bleibt, erneuter Versuch möglich", async () => {
        const h = wired();
        writeRecipe(h, "jarvis");
        await deployed(h, "jarvis");
        const outside = join(h.paths.dataDir, "..", "draussen");
        mkdirSync(outside, { recursive: true });
        symlinkSync(outside, archiveDir(h, "jarvis"));
        await decideChoice((await ask(h)).id, "ja", "telegram");
        expect(existsSync(recipeFile(h, "jarvis"))).toBe(true);
        expect(readdirSync(outside)).toEqual([]);
        expect(h.notes[0]!.text).toContain("ließ sich aber nicht archivieren");
        expect(h.notes[0]!.text).toContain(VOICE_AGENT_TEXT.retry("jarvis"));
      });

      test("Zwischen Anbieter und Archiv neu angelegt: nichts archiviert", async () => {
        const h = wired();
        writeRecipe(h, "jarvis");
        await deployed(h, "jarvis");
        h.layer.removeResult = async state => {
          // Ein Abgleich, der nach remove und vor dem Archiv durchkommt
          await updateState("jarvis", { agentId: "agent-neu" } as never, h.paths);
          return { status: "ok", state };
        };
        await decideChoice((await ask(h)).id, "ja", "telegram");
        expect(existsSync(recipeFile(h, "jarvis"))).toBe(true);
        expect(archives(h, "jarvis")).toEqual([]);
        expect(h.notes[0]!.text).toContain(VOICE_AGENT_TEXT.redeployed("jarvis"));
      });

      test("Rezept inzwischen von Hand entfernt: nichts gelöscht", async () => {
        const h = wired();
        writeRecipe(h, "jarvis");
        await deployed(h, "jarvis");
        const choice = await ask(h);
        (await import("node:fs")).rmSync(recipeFile(h, "jarvis"));
        await decideChoice(choice.id, "ja", "telegram");
        expect(h.layer.calls).toEqual([]);
        expect(h.notes[0]!.text).toBe(VOICE_AGENT_TEXT.gone("jarvis"));
      });

      test("unbekannter Schritt oder Knopf: der Handler wirft, nichts gelöscht", async () => {
        const h = wired();
        writeRecipe(h, "jarvis");
        await deployed(h, "jarvis");
        const choice = await ask(h);
        const decided = (action: string, key: string) => ({ ...choice, action, state: "done" as const, result: { key, label: key, via: "web" as const, at: NOW } });
        await expect(Promise.resolve(h.manager.handler(decided("umbenennen", "ja")))).rejects.toThrow("unbekannter Schritt");
        await expect(Promise.resolve(h.manager.handler(decided("loeschen", "vielleicht")))).rejects.toThrow("unbekannte Antwort");
        expect(existsSync(recipeFile(h, "jarvis"))).toBe(true);
        expect(h.layer.calls).toEqual([]);
      });
    });

    describe("Kanäle", () => {
      function port(userId: string) {
        return createChoicePort({ register, userId, groupId: () => "-100200", every: () => () => {}, log: () => {} });
      }

      test("fremdes Gespräch kann nicht entscheiden, das eigene schon", async () => {
        const h = wired();
        writeRecipe(h, "jarvis");
        await deployed(h, "jarvis");
        const choice = await ask(h, "jarvis", WEB);
        const p = port("123456");
        expect(await p.decide("dm", choice.id, "ja", "web")).toEqual({ status: "not_found" });
        expect(await p.decide("11111111-2222-4333-8444-555555555555", choice.id, "ja", "terminal")).toEqual({ status: "not_found" });
        expect((await getChoice(choice.id))?.state).toBe("open");
        expect(removes(h)).toBe(0);
        expect((await p.decide(WEB_ID, choice.id, "ja", "web")).status).toBe("decided");
        expect(removes(h)).toBe(1);
        expect(h.notes[0]!.conversation).toEqual(WEB);
      });

      test("Terminal und Direktchat ohne Telegram (Chat web) entscheiden wie der Browser", async () => {
        const h = wired();
        writeRecipe(h, "jarvis");
        const choice = await ask(h, "jarvis", { type: "telegram", chatId: "web" });
        expect((await port("web").decide("dm", choice.id, "ja", "terminal")).status).toBe("decided");
        expect(archives(h, "jarvis")).toEqual([`${STAMP}.json`]);
      });
    });
  });
}
