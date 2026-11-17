/**
 * Issue #515, Checkbox 2: Attrappe des Wizards für web:dev. Vorschlag für alle
 * drei Vorlagen und gescheitert, Entwurf mit revision, Bauen nach der Uhr bis
 * fertig, durchgefallen, unterbrochen oder abgebrochen, Stimmenliste und
 * Hörprobe mit festem Ton. Kein Anbieter, kein Job, kein src/lib.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createDemoVoiceAgentWizard } from "../src/web/demo-voice-agent-wizard";
import { createDemoVoiceAgents } from "../src/web/demo-voice-agents";

function demo() {
  let t = Date.parse("2026-11-09T10:00:00Z");
  const registered: string[] = [];
  const agents = createDemoVoiceAgents({ now: () => t });
  const port = createDemoVoiceAgentWizard({
    now: () => t,
    stepMs: 1_000,
    slowMs: 30,
    register: (a) => {
      registered.push(a.kennung);
      agents.register(a);
    },
    taken: agents.has,
  });
  return { port, agents, registered, advance: (ms: number) => (t += ms) };
}

const fields = (vorlage: string, extra: Record<string, unknown> = {}) => ({ vorlage, name: "Test", zweck: "Zum Testen", ...extra });

describe("Vorschlag", () => {
  for (const [satz, vorlage] of [
    ["Eine Anrufannahme für die Praxis", "anrufannahme"],
    ["Ein persönlicher Assistent wie Jarvis", "jarvis"],
    ["Ein Trainer für Preisverhandlungen", "experte"],
  ] as const) {
    test(`„${satz}“ ergibt ${vorlage} mit Name, Kennung und festen Regeln`, async () => {
      const r = await demo().port.propose({ satz });
      expect(r.status).toBe(200);
      expect(r.body.quelle).toBe("modell");
      const v = r.body.vorschlag as any;
      expect(v.felder.vorlage).toBe(vorlage);
      expect(v.kennung).toMatch(/^[a-z0-9-]+$/);
      expect(v.felder.regeln.some((r: any) => r.fest && r.text.includes("112"))).toBe(true);
      expect(v.feste[0].feld).toBe("persona.kiHinweis");
      if (vorlage === "experte") expect(v.felder.training.kriterien).toHaveLength(3);
      if (vorlage === "anrufannahme") expect(v.felder.anrufannahme.fragen.length).toBeGreaterThan(0);
    });
  }

  test("„scheitern“: kein Vorschlag, leere Felder, Vorlage experte, Hinweis", async () => {
    const r = await demo().port.propose({ satz: "Das soll scheitern" });
    expect(r.body).toMatchObject({ quelle: "leer", vorschlag: { kennung: "", felder: { vorlage: "experte" } } });
    expect(String(r.body.hinweis)).toContain("Kein Vorschlag");
  });

  test("leerer Satz: 400", async () => {
    expect((await demo().port.propose({ satz: " " })).status).toBe(400);
  });
});

describe("Entwurf und Bauen", () => {
  test("revision steigt mit PUT und Anhang, veraltete revision 409, nach dem Bauen 409 gebaut", async () => {
    const { port } = demo();
    const created = await port.put("trainer", { felder: fields("experte"), satz: "Ein Trainer", schritt: 2 });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ revision: 1, schritt: 2, phase: "wizard" });
    expect((await port.put("trainer", { felder: fields("experte") })).status).toBe(409);
    const saved = await port.put("trainer", { felder: fields("experte"), revision: 1 });
    expect(saved.body.revision).toBe(2);
    const added = await port.addAttachment("trainer", "notizen.md", new TextEncoder().encode("# Notizen"));
    expect(added.body.revision).toBe(3);
    expect((await port.put("trainer", { felder: fields("experte"), revision: 2 })).body).toMatchObject({ reason: "veraltet", revision: 3 });
    expect((await port.build("trainer", { revision: 3 })).status).toBe(202);
    expect((await port.put("trainer", { felder: fields("experte"), revision: 3 })).body.reason).toBe("gebaut");
  });

  test("Phasen nach der Uhr bis fertig: Stimme offen ohne Wizard-Stimme, dann Freigabe, Tests bestanden, Agent übernommen", async () => {
    const { port, advance, registered, agents } = demo();
    await port.put("helfer", { felder: fields("jarvis", { zugang: { web: true } }), satz: "Ein persönlicher Assistent" });
    await port.build("helfer", { revision: 1 });
    const seen: string[] = [];
    for (let i = 0; i < 6; i++) {
      const p = (await port.progress("helfer")).body as any;
      seen.push(`${p.phase}:${p.rueckfrage ?? "-"}`);
      advance(1_000);
    }
    expect(seen).toEqual(["job:-", "stimme:stimme", "freigabe:freigabe", "anlegen:-", "fertig:-", "fertig:-"]);
    const done = (await port.progress("helfer")).body as any;
    expect(done).toMatchObject({ freigeschaltet: true, web: true, tests: { status: "bestanden" } });
    expect(registered).toEqual(["helfer"]);
    expect(((await agents.admin.list()).body as any).agents.some((a: any) => a.kennung === "helfer")).toBe(true);
    const list = (await port.list()).body as any;
    expect(list.entwuerfe).toEqual([]);
    expect(list.beendet[0]).toMatchObject({ kennung: "helfer", schritt: 5 });
  });

  test("„durchfallen“: Grund je Test, Rückfrage freischalten, nicht freigeschaltet; mit Wizard-Stimme keine Stimmwahl", async () => {
    const { port, advance } = demo();
    await port.put("empfang-test", { felder: fields("anrufannahme", { stimme: { wahl: "standard" }, zugang: { web: true } }), satz: "Anruf annehmen, Tests sollen durchfallen" });
    await port.build("empfang-test", { revision: 1 });
    const phases: string[] = [];
    for (let i = 0; i < 5; i++) {
      phases.push(((await port.progress("empfang-test")).body as any).phase);
      advance(1_000);
    }
    expect(phases).toEqual(["job", "freigabe", "anlegen", "durchgefallen", "durchgefallen"]);
    const p = (await port.progress("empfang-test")).body as any;
    expect(p).toMatchObject({ rueckfrage: "freischalten", freigeschaltet: false });
    expect(p.tests.liste.find((t: any) => t.status === "durchgefallen").grund).toBeTruthy();
  });

  test("„unterbrechen“ und „abbrechen“", async () => {
    const { port, advance } = demo();
    await port.put("eins", { felder: fields("jarvis", { stimme: { wahl: "standard" } }), satz: "unterbrechen bitte" });
    await port.put("zwei", { felder: fields("jarvis"), satz: "abbrechen bitte" });
    await port.build("eins", { revision: 1 });
    await port.build("zwei", { revision: 1 });
    advance(10_000);
    expect((await port.progress("eins")).body).toMatchObject({ phase: "unterbrochen", rueckfrage: "fortsetzen" });
    expect((await port.progress("zwei")).body).toMatchObject({ phase: "abgebrochen", fehler: ["tests: mindestens 2 Tests"] });
  });

  test("Bauen abgelehnt: unvollständig 422, Kennung vergeben 409, Entwurf weg 404", async () => {
    const { port } = demo();
    await port.put("leer", { felder: { vorlage: "experte" } });
    expect((await port.build("leer", { revision: 1 })).body).toMatchObject({ reason: "unvollstaendig" });
    expect((await port.put("empfang", { felder: fields("anrufannahme") })).body.reason).toBe("vergeben");
    expect((await port.get("gibt-es-nicht")).status).toBe(404);
    expect((await port.put("wizard-x", { felder: fields("jarvis") })).status).toBe(201);
    expect((await port.remove("wizard-x")).status).toBe(200);
    expect((await port.progress("wizard-x")).status).toBe(404);
  });

  test("Vorlagenwechsel: Gedächtnis folgt der Vorlage, Kriterien bleiben gespeichert", async () => {
    const { port } = demo();
    const training = { kriterien: ["a", "b", "c"] };
    await port.put("wechsel", { felder: fields("experte", { training }) });
    const r1 = await port.put("wechsel", { felder: fields("anrufannahme", { training }), revision: 1 });
    expect((r1.body as any).felder).toMatchObject({ gedaechtnis: "keins", training });
    expect((r1.body as any).feste.some((f: any) => f.feld === "gedaechtnis" && f.wert === "keins")).toBe(true);
    const r2 = await port.put("wechsel", { felder: fields("experte", { training }), revision: 2 });
    expect((r2.body as any).felder).toMatchObject({ gedaechtnis: "thema", training });
  });
});

describe("Kennung ändern", () => {
  test("Felder, Satz, Schritt und Anhänge ziehen mit um; Konflikt lässt alles, wie es war", async () => {
    const { port } = demo();
    await port.put("segel-alt", { felder: fields("experte", { training: { kriterien: ["a", "b", "c"] } }), satz: "Segeltrainer", schritt: 3 });
    const up = (await port.addAttachment("segel-alt", "notiz.md", new TextEncoder().encode("# x"))).body as any;
    const taken = await port.rename("segel-alt", { revision: up.revision, kennung: "empfang" });
    expect(taken.status).toBe(409);
    expect(taken.body.reason).toBe("vergeben");
    expect((await port.rename("segel-alt", { revision: up.revision, kennung: "Segel Neu" })).status).toBe(422);
    expect(((await port.get("segel-alt")).body as any).anhaenge).toHaveLength(1);
    const moved = await port.rename("segel-alt", { revision: up.revision, kennung: "segel-neu" });
    expect(moved.status).toBe(200);
    expect(moved.body).toMatchObject({ kennung: "segel-neu", satz: "Segeltrainer", schritt: 3, revision: up.revision + 1 });
    expect((moved.body as any).felder.training.kriterien).toEqual(["a", "b", "c"]);
    expect((moved.body as any).anhaenge).toHaveLength(1);
    expect((await port.get("segel-alt")).status).toBe(404);
    await port.build("segel-neu", { revision: up.revision + 1 });
    expect((await port.rename("segel-neu", { revision: up.revision + 1, kennung: "segel-3" })).body.reason).toBe("gebaut");
  });
});

describe("Stimmen und Hörprobe", () => {
  test("Liste mit Standardstimme ohne Kennung und Stimmen des Kontos; Hörprobe nur für diese", async () => {
    const { port } = demo();
    const voices = (await port.voices()).body as any;
    expect(voices.standard).toEqual({ standard: true, name: "Standardstimme" });
    expect(voices.konto.map((v: any) => v.name)).toEqual(["Mia", "Alex", "Nora"]);
    // Bei „Nora“ scheitert die Hörprobe wie beim Anbieter: Fehlerzustand für den Browser-Check
    const failing = await port.probe({ voiceId: voices.konto[2].voiceId });
    expect(failing.status).toBe(502);
    expect(failing.audio).toBeUndefined();
    const probe = await port.probe({ voiceId: voices.konto[0].voiceId });
    expect(probe.status).toBe(200);
    expect(probe.audio?.type).toBe("audio/wav");
    expect(new TextDecoder().decode(probe.audio!.bytes.subarray(0, 4))).toBe("RIFF");
    expect((await port.probe({ standard: true })).status).toBe(200);
    expect((await port.probe({ voiceId: "fremd" })).status).toBe(422);
    expect((await port.probe({ voiceId: voices.konto[0].voiceId, text: "anderes" })).status).toBe(400);
  });
});

test("web:dev verdrahtet die Attrappe", () => {
  const source = readFileSync(join(import.meta.dir, "..", "scripts", "web-dev.ts"), "utf8");
  expect(source).toContain("voiceAgentWizard: demoWizard");
});
