/**
 * Issue #514, Aufgabe 2: Entwurf des Wizards lesen, speichern, fortsetzen und
 * verwerfen. Zuordnung zur Entwurfs-ID aus SA1-5 (entwurf-id), Kollisionen,
 * gleichzeitige Änderungen, Neustart, symbolische Links und Pfade. Echter
 * Entwurfsdienst und Web-Server, Job-Attrappe.
 */
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setChoicesFileForTests } from "../src/lib/choices";
import { createWizardStore } from "../src/lib/voice-agents/wizard-store";
import { WIZARD_KI_HINWEIS } from "../src/lib/voice-agents/wizard";
import { ablageDir, DM, draftRecipe, patchRecord, readRecord, removeDraftDirs, writeActive } from "./voice-agents-drafts-fixture";
import { kitchenFields, removeWizardRoots, stopWizardServers, wizardHarness } from "./voice-agent-wizard-fixture";

let counter = 0;
let logSpy: ReturnType<typeof spyOn>;
beforeEach(() => {
  setChoicesFileForTests(join(require("node:os").tmpdir(), `wizard-choices-${process.pid}-${++counter}.json`));
  logSpy = spyOn(console, "log").mockImplementation(() => {});
});
afterEach(async () => {
  logSpy.mockRestore();
  await stopWizardServers();
});
afterAll(() => {
  setChoicesFileForTests(null);
  removeWizardRoots();
  removeDraftDirs();
});

type W = Awaited<ReturnType<typeof wizardHarness>>;
const put = (w: W, kennung: string, body: unknown) => w.ctx.api(`/api/voice-agents/wizard/${kennung}`, "PUT", body);
const get = (w: W, kennung: string) => w.ctx.api(`/api/voice-agents/wizard/${kennung}`);

describe("Anlegen, lesen, fortsetzen", () => {
  test("PUT ohne revision legt an und reserviert die Kennung wie ein Entwurf aus /sprachagent neu", async () => {
    const w = await wizardHarness();
    const res = await put(w, "kochhilfe", { satz: "Eine Kochhilfe", felder: { vorlage: "jarvis", name: "Kochhilfe" } });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({ kennung: "kochhilfe", revision: 1, phase: "wizard", satz: "Eine Kochhilfe" });
    expect(body.felder.persona.kiHinweis).toBe(WIZARD_KI_HINWEIS.de);
    // Ablage: entwurf-id nennt den Entwurf, wizard.json dieselbe ID, der Entwurf trägt die Kennung
    const dir = ablageDir(w.h, "kochhilfe");
    const id = readFileSync(join(dir, "entwurf-id"), "utf8").trim();
    const file = JSON.parse(readFileSync(join(dir, "wizard.json"), "utf8"));
    expect(file.entwurf).toBe(id);
    expect(readRecord(w.h, id)).toMatchObject({ phase: "wizard", kennung: "kochhilfe", art: "neu", conversation: DM });
    // Keine Metadaten „fest“ in der Datei, nur eigene Regeln
    expect(JSON.stringify(file)).not.toContain("\"fest\"");
    // Kein Job, kein Rezept
    expect(w.h.jobs.starts).toHaveLength(0);
    expect(existsSync(join(w.h.paths.configDir, "kochhilfe.json"))).toBe(false);
  });

  test("unvollständig speicherbar, mit revision fortsetzen; Liste offener Entwürfe", async () => {
    const w = await wizardHarness();
    expect((await put(w, "kochhilfe", { felder: {} })).status).toBe(201);
    const saved = await put(w, "kochhilfe", { revision: 1, felder: { name: "Kochhilfe", zweck: "" } });
    expect(saved.status).toBe(200);
    expect((await saved.json()).revision).toBe(2);
    // Später fortsetzen: neuer Dienst auf demselben Ordner, wie nach einem Neustart
    w.h.restart();
    const again = createWizardStore({ drafts: w.h.service, paths: w.h.paths, conversation: () => DM });
    const read = await again.get("kochhilfe");
    expect(read.ok && read.value.wizard).toMatchObject({ revision: 2, felder: { name: "Kochhilfe" } });
    expect((await (await get(w, "kochhilfe")).json()).felder.zweck).toBeUndefined();
    expect((await put(w, "zweiter", { felder: { name: "Zwei" } })).status).toBe(201);
    const list = await (await w.ctx.api("/api/voice-agents/wizard/entwuerfe")).json();
    expect(list.entwuerfe.map((e: any) => [e.kennung, e.phase])).toEqual([
      ["zweiter", "wizard"],
      ["kochhilfe", "wizard"],
    ]);
  });

  test("ohne Login 401, Ändern mit fremdem Origin 403", async () => {
    const w = await wizardHarness();
    await put(w, "kochhilfe", { felder: {} });
    for (const [method, path] of [
      ["GET", "/api/voice-agents/wizard/kochhilfe"],
      ["GET", "/api/voice-agents/wizard/entwuerfe"],
      ["PUT", "/api/voice-agents/wizard/kochhilfe"],
      ["POST", "/api/voice-agents/wizard/kochhilfe/bauen"],
      ["POST", "/api/voice-agents/wizard/kochhilfe/anhaenge"],
    ]) {
      const res = await fetch(`${w.ctx.origin}${path}`, { method, headers: { origin: w.ctx.origin }, body: method === "GET" ? undefined : "{}" });
      expect(res.status).toBe(401);
    }
    expect((await w.ctx.api("/api/voice-agents/wizard/kochhilfe", "PUT", { revision: 1, felder: {} }, { origin: "http://boese.example" })).status).toBe(403);
  });

  test("fremde Kennung: 404 für Lesen, Ändern, Fortschritt, Verwerfen und Bauen", async () => {
    const w = await wizardHarness();
    for (const res of [
      await get(w, "gibtsnicht"),
      await put(w, "gibtsnicht", { revision: 1, felder: {} }),
      await w.ctx.api("/api/voice-agents/wizard/gibtsnicht/fortschritt"),
      await w.ctx.api("/api/voice-agents/wizard/gibtsnicht", "DELETE"),
      await w.ctx.api("/api/voice-agents/wizard/gibtsnicht/bauen", "POST", { revision: 1 }),
    ])
      expect(res.status).toBe(404);
  });

  test("Entwurf aus /sprachagent neu unter derselben Kennung ist für den Wizard fremd: 404 beim Lesen, 409 beim Anlegen", async () => {
    const w = await wizardHarness();
    const dir = ablageDir(w.h, "kochhilfe");
    // Ein offener Job-Entwurf hält die Ablage
    await w.h.service.startNew("Kochhilfe", DM);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "entwurf-id"), "20261107-090001-a1b2c3\n");
    expect((await get(w, "kochhilfe")).status).toBe(404);
    const res = await put(w, "kochhilfe", { felder: {} });
    expect(res.status).toBe(409);
    expect((await res.json()).reason).toBe("belegt");
    expect(existsSync(join(dir, "wizard.json"))).toBe(false);
  });

  test("Kennung eines bestehenden Agenten: 409 vergeben; ungültige und reservierte Kennungen: 422 bzw. 404, nichts außerhalb von entwuerfe/", async () => {
    const w = await wizardHarness();
    writeActive(w.h, draftRecipe("kochhilfe"));
    const taken = await put(w, "kochhilfe", { felder: {} });
    expect(taken.status).toBe(409);
    expect((await taken.json()).reason).toBe("vergeben");
    for (const kennung of ["Gross", "a_b", "entwuerfe", "..", "%2e%2e%2fx", "a%2Fb", ".steuerung", ".arbeit"]) {
      const res = await put(w, kennung, { felder: {} });
      expect([404, 405, 422]).toContain(res.status);
    }
    // Die Pfade gehören dem Agenten „wizard“, nicht dem Wizard
    for (const kennung of ["session", "rezept", "test", "link", "loeschen"]) {
      expect((await put(w, kennung, { felder: {} })).status).not.toBe(201);
    }
    const root = join(w.h.paths.dataDir, "entwuerfe");
    expect(readdirSync(root).sort()).toEqual([".steuerung"]);
    expect(existsSync(join(w.h.paths.dataDir, "x"))).toBe(false);
  });

  test("anlegen zweimal: 409 existiert; veraltete revision: 409 mit aktueller", async () => {
    const w = await wizardHarness();
    await put(w, "kochhilfe", { felder: {} });
    expect((await (await put(w, "kochhilfe", { felder: {} })).json()).reason).toBe("existiert");
    await put(w, "kochhilfe", { revision: 1, felder: { name: "A" } });
    const stale = await put(w, "kochhilfe", { revision: 1, felder: { name: "B" } });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ reason: "veraltet", revision: 2 });
    expect((await (await get(w, "kochhilfe")).json()).felder.name).toBe("A");
  });

  test("gleichzeitige PUT mit derselben revision: genau einer gewinnt", async () => {
    const w = await wizardHarness();
    await put(w, "kochhilfe", { felder: {} });
    const results = await Promise.all(["A", "B", "C", "D"].map((name) => put(w, "kochhilfe", { revision: 1, felder: { name } })));
    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409, 409]);
    expect((await (await get(w, "kochhilfe")).json()).revision).toBe(2);
  });

  test("gleichzeitiges Anlegen derselben Kennung: genau ein Entwurf", async () => {
    const w = await wizardHarness();
    const results = await Promise.all([1, 2, 3].map(() => put(w, "kochhilfe", { felder: {} })));
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409]);
    const ids = readdirSync(join(w.h.paths.dataDir, "entwuerfe", ".steuerung")).filter((n) => /^\d{8}-/.test(n));
    expect(ids).toHaveLength(1);
  });

  test("falsche Form: 400 mit Fehlern, nichts gespeichert", async () => {
    const w = await wizardHarness();
    await put(w, "kochhilfe", { felder: {} });
    for (const body of [{ revision: 1, felder: { unbekannt: 1 } }, { revision: 1, felder: { zugang: { maxMinuten: 500 } } }, { revision: 1, felder: { links: ["http://unsicher.example"] } }, { revision: 1, extra: true, felder: {} }, "[]"]) {
      const res = await put(w, "kochhilfe", body);
      expect(res.status).toBe(400);
    }
    expect((await (await get(w, "kochhilfe")).json()).revision).toBe(1);
  });

  test("Verwerfen gibt die Kennung frei; danach legt ein neuer Wizard an", async () => {
    const w = await wizardHarness();
    await put(w, "kochhilfe", { felder: { name: "Alt" } });
    const id = readFileSync(join(ablageDir(w.h, "kochhilfe"), "entwurf-id"), "utf8").trim();
    expect((await w.ctx.api("/api/voice-agents/wizard/kochhilfe", "DELETE")).status).toBe(200);
    expect(readRecord(w.h, id).phase).toBe("verworfen");
    expect((await get(w, "kochhilfe")).status).toBe(404);
    expect((await (await w.ctx.api("/api/voice-agents/wizard/entwuerfe")).json()).entwuerfe).toEqual([]);
    const fresh = await put(w, "kochhilfe", { felder: { name: "Neu" } });
    expect(fresh.status).toBe(201);
    expect((await fresh.json()).felder.name).toBe("Neu");
  });

  test("Anlegen unterbrochen nach der Reservierung (Neustart): ein neuer Dienst legt an oder verwirft, die Kennung bleibt nicht belegt", async () => {
    const w = await wizardHarness();
    // Wie ein Abbruch zwischen reserveWizard und dem Schreiben von wizard.json
    const reserved = await w.h.service.reserveWizard("kochhilfe", DM);
    if (reserved.status !== "reserviert") throw new Error(reserved.status);
    expect(existsSync(join(ablageDir(w.h, "kochhilfe"), "wizard.json"))).toBe(false);
    w.h.restart();
    const again = createWizardStore({ drafts: w.h.service, paths: w.h.paths, conversation: () => DM });
    expect(await again.get("kochhilfe")).toEqual({ ok: false, code: "unbekannt" });
    const created = await again.save("kochhilfe", { felder: { name: "Kochhilfe" } });
    if (!created.ok) throw new Error(created.code);
    expect(created.value.created).toBe(true);
    expect(created.value.entry.wizard.entwurf).toBe(reserved.id);
    const read = await get(w, "kochhilfe");
    expect(read.status).toBe(200);
    expect((await read.json()).felder.name).toBe("Kochhilfe");

    const other = await w.h.service.reserveWizard("zweiter", DM);
    if (other.status !== "reserviert") throw new Error(other.status);
    w.h.restart();
    const third = createWizardStore({ drafts: w.h.service, paths: w.h.paths, conversation: () => DM });
    expect(await third.remove("zweiter")).toEqual({ ok: true, value: null });
    expect(readRecord(w.h, other.id).phase).toBe("verworfen");
    const fresh = await third.save("zweiter", { felder: {} });
    if (!fresh.ok) throw new Error(fresh.code);
    expect(fresh.value.entry.wizard.entwurf).not.toBe(other.id);
  });

  test("Anlegen unterbrochen bei alter wizard.json eines beendeten Wizards: ein neuer Dienst legt an oder verwirft, offene Entwürfe bleiben geschützt", async () => {
    const w = await wizardHarness();
    const dir = ablageDir(w.h, "kochhilfe");
    // Früherer Wizard, beendet (etwa abgebrochen nach dem Bauen); seine wizard.json bleibt liegen
    expect((await put(w, "kochhilfe", { felder: { name: "Alt" } })).status).toBe(201);
    const oldId = readFileSync(join(dir, "entwurf-id"), "utf8").trim();
    patchRecord(w.h, oldId, (r) => (r.phase = "abgebrochen"));
    // Neues Anlegen reserviert, ein Neustart kommt vor dem Schreiben von wizard.json
    const reserved = await w.h.service.reserveWizard("kochhilfe", DM);
    if (reserved.status !== "reserviert") throw new Error(reserved.status);
    expect(JSON.parse(readFileSync(join(dir, "wizard.json"), "utf8")).entwurf).toBe(oldId);
    w.h.restart();
    const again = createWizardStore({ drafts: w.h.service, paths: w.h.paths, conversation: () => DM });
    expect(await again.get("kochhilfe")).toEqual({ ok: false, code: "unbekannt" });
    const created = await again.save("kochhilfe", { felder: { name: "Neu" } });
    if (!created.ok) throw new Error(created.code);
    expect(created.value.entry.wizard.entwurf).toBe(reserved.id);
    expect(JSON.parse(readFileSync(join(dir, "wizard.json"), "utf8")).entwurf).toBe(reserved.id);
    const read = await get(w, "kochhilfe");
    expect(read.status).toBe(200);
    expect((await read.json()).felder.name).toBe("Neu");
    expect((await (await w.ctx.api("/api/voice-agents/wizard/entwuerfe")).json()).entwuerfe.map((e: any) => e.kennung)).toEqual(["kochhilfe"]);

    // Dasselbe mit Verwerfen: die neue Reservierung wird frei, danach legt ein Wizard neu an
    expect((await put(w, "zweiter", { felder: { name: "Alt" } })).status).toBe(201);
    const oldSecond = readFileSync(join(ablageDir(w.h, "zweiter"), "entwurf-id"), "utf8").trim();
    patchRecord(w.h, oldSecond, (r) => (r.phase = "fertig"));
    const other = await w.h.service.reserveWizard("zweiter", DM);
    if (other.status !== "reserviert") throw new Error(other.status);
    w.h.restart();
    const third = createWizardStore({ drafts: w.h.service, paths: w.h.paths, conversation: () => DM });
    expect(await third.remove("zweiter")).toEqual({ ok: true, value: null });
    expect(readRecord(w.h, other.id).phase).toBe("verworfen");
    const fresh = await third.save("zweiter", { felder: { name: "Neu" } });
    if (!fresh.ok) throw new Error(fresh.code);
    expect(fresh.value.entry.wizard.entwurf).not.toBe(other.id);
    expect(fresh.value.entry.wizard.entwurf).not.toBe(oldSecond);
  });

  test("alte wizard.json nennt einen offenen Entwurf: die abweichende Reservierung wird weder übernommen noch verworfen", async () => {
    const w = await wizardHarness();
    const dir = ablageDir(w.h, "kochhilfe");
    expect((await put(w, "kochhilfe", { felder: { name: "Offen" } })).status).toBe(201);
    const openId = readFileSync(join(dir, "entwurf-id"), "utf8").trim();
    const before = readFileSync(join(dir, "wizard.json"), "utf8");
    // Von Hand erzeugter Widerspruch: zweite Reservierung, der frühere Wizard ist danach wieder offen
    patchRecord(w.h, openId, (r) => (r.phase = "abgebrochen"));
    const reserved = await w.h.service.reserveWizard("kochhilfe", DM);
    if (reserved.status !== "reserviert") throw new Error(reserved.status);
    patchRecord(w.h, openId, (r) => (r.phase = "wizard"));
    w.h.restart();
    const again = createWizardStore({ drafts: w.h.service, paths: w.h.paths, conversation: () => DM });
    expect(await again.get("kochhilfe")).toEqual({ ok: false, code: "unbekannt" });
    expect(await again.remove("kochhilfe")).toEqual({ ok: false, code: "unbekannt" });
    expect(await again.save("kochhilfe", { felder: { name: "Fremd" } })).toEqual({ ok: false, code: "belegt" });
    expect(readRecord(w.h, reserved.id).phase).toBe("wizard");
    expect(readRecord(w.h, openId).phase).toBe("wizard");
    expect(readFileSync(join(dir, "wizard.json"), "utf8")).toBe(before);

    // Offener Entwurf aus /sprachagent neu hält die Ablage, daneben die wizard.json eines beendeten Wizards
    expect((await put(w, "dritter", { felder: { name: "Alt" } })).status).toBe(201);
    const thirdDir = ablageDir(w.h, "dritter");
    const ended = readFileSync(join(thirdDir, "entwurf-id"), "utf8").trim();
    patchRecord(w.h, ended, (r) => (r.phase = "verworfen"));
    const job = await w.h.service.startNew("Dritter Agent", DM);
    if (job.status !== "gestartet") throw new Error(job.status);
    patchRecord(w.h, job.id, (r) => (r.kennung = "dritter"));
    writeFileSync(join(thirdDir, "entwurf-id"), `${job.id}\n`);
    const thirdBefore = readFileSync(join(thirdDir, "wizard.json"), "utf8");
    w.h.restart();
    const fourth = createWizardStore({ drafts: w.h.service, paths: w.h.paths, conversation: () => DM });
    expect(await fourth.get("dritter")).toEqual({ ok: false, code: "unbekannt" });
    expect(await fourth.remove("dritter")).toEqual({ ok: false, code: "unbekannt" });
    expect(await fourth.save("dritter", { felder: {} })).toEqual({ ok: false, code: "belegt" });
    expect(readRecord(w.h, job.id).phase).toBe("job");
    expect(readFileSync(join(thirdDir, "wizard.json"), "utf8")).toBe(thirdBefore);
  });

  test("Schreibfehler nach der Reservierung: die Reservierung wird zurückgenommen, erneutes Anlegen gelingt", async () => {
    const w = await wizardHarness();
    // wizard.json als Ordner: Das Schreiben scheitert erst nach reserveWizard
    const blocker = join(ablageDir(w.h, "kochhilfe"), "wizard.json");
    mkdirSync(blocker, { recursive: true });
    expect((await put(w, "kochhilfe", { felder: { name: "Alt" } })).status).toBe(500);
    const id = readFileSync(join(ablageDir(w.h, "kochhilfe"), "entwurf-id"), "utf8").trim();
    expect(readRecord(w.h, id).phase).toBe("verworfen");
    require("node:fs").rmSync(blocker, { recursive: true });
    const again = await put(w, "kochhilfe", { felder: { name: "Neu" } });
    expect(again.status).toBe(201);
    expect((await (await get(w, "kochhilfe")).json()).felder.name).toBe("Neu");
  });

  test("symbolischer Link statt Ablage oder wizard.json: Fehler, nichts gelesen oder geschrieben", async () => {
    const w = await wizardHarness();
    const outside = join(w.h.root, "draussen");
    mkdirSync(outside, { recursive: true });
    mkdirSync(join(w.h.paths.dataDir, "entwuerfe"), { recursive: true });
    symlinkSync(outside, ablageDir(w.h, "kochhilfe"));
    expect((await put(w, "kochhilfe", { felder: {} })).status).toBe(500);
    expect(readdirSync(outside)).toEqual([]);

    await put(w, "andere", { felder: {} });
    const file = join(ablageDir(w.h, "andere"), "wizard.json");
    const fake = join(outside, "wizard.json");
    writeFileSync(fake, readFileSync(file));
    require("node:fs").rmSync(file);
    symlinkSync(fake, file);
    expect((await get(w, "andere")).status).toBe(500);
    expect((await put(w, "andere", { revision: 1, felder: { name: "x" } })).status).toBe(500);
    expect(JSON.parse(readFileSync(fake, "utf8")).revision).toBe(1);
  });

  test("beschädigte wizard.json: 500, keine Inhalte in der Antwort", async () => {
    const w = await wizardHarness();
    await put(w, "kochhilfe", { felder: {} });
    writeFileSync(join(ablageDir(w.h, "kochhilfe"), "wizard.json"), "{kaputt");
    const res = await get(w, "kochhilfe");
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain(w.h.root);
  });
});
