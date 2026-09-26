/**
 * Issue #161, Checkbox 4: setup.js mit dem Test-Schritt. Vorausgefüllte
 * Standardwerte, „Auswahl laden“, „Einrichten“ mit Plan, Fortschritt,
 * Abbrechen. DOM-Attrappe wie in setup-web-app.test.ts; setup.js spricht
 * über HTTP mit dem echten Einrichtungs-Server im temporären Projekt, die
 * Abfrage alle 2 s läuft über einen eingesetzten Zeitgeber.
 */

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { SetupContext } from "../src/setup/context";
import type { SetupStep } from "../src/setup/model";
import { checkStep, SETUP_STEPS } from "../src/setup/steps";
import { cleanup, FULL_ENV, makeCtx } from "./setup-fixture";
import { ABORTED_MESSAGE, FLOW, FLOW_ID, makeFlowStep, type FlowOptions } from "./setup-flow-fixture";
import { login, PROFILE, startSetup, type Started, type TestCtx } from "./setup-web-fixture";
import { TYBO_BRAND } from "./brand-fixture";

const setupSource = await readFile(resolve(import.meta.dir, "..", "src", "setup", "public", "setup.js"), "utf8");

interface Node {
  tagName: string;
  children: Node[];
  attributes: Record<string, string>;
  [key: string]: any;
}

let created: Node[] = [];
let htmlWrites: string[] = [];
const elements: Record<string, Node> = {};

function node(tag = "div"): Node {
  const n: Node = {
    tagName: tag.toUpperCase(),
    children: [],
    attributes: {},
    className: "",
    textContent: "",
    hidden: false,
    disabled: false,
    value: "",
    type: "",
    id: "",
    appendChild(child: Node) {
      this.children.push(child);
      return child;
    },
    replaceChildren(...list: Node[]) {
      this.children = list;
    },
    setAttribute(name: string, value: string) { this.attributes[name] = String(value); },
    getAttribute(name: string) { return this.attributes[name] ?? null; },
    listeners: {} as Record<string, ((e: any) => unknown)[]>,
    addEventListener(type: string, fn: (e: any) => unknown) { (this.listeners[type] ??= []).push(fn); },
    async dispatch(type: string, event: any = {}) {
      for (const fn of this.listeners[type] ?? []) await fn({ preventDefault() {}, ...event });
    },
    focus() {},
  };
  Object.defineProperty(n, "innerHTML", { set(v: string) { htmlWrites.push(v); }, get() { return ""; } });
  created.push(n);
  return n;
}

const doc = {
  getElementById(id: string) { return (elements[id] ??= node()); },
  createElement(tag: string) { return node(tag); },
  createTextNode(text: string) { const t = node("#text"); t.textContent = text; return t; },
};

function all(root: Node | undefined): Node[] {
  if (!root) return [];
  return [root, ...root.children.flatMap(c => all(c))];
}

async function settle() {
  for (let i = 0; i < 6; i++) await Bun.sleep(5);
}

const running: Started[] = [];
afterEach(async () => {
  for (const s of running.splice(0)) await s.server.stop();
});
afterAll(cleanup);

const sleepUntilAbort = (_ms: number, signal?: AbortSignal) =>
  new Promise<void>(res => {
    if (signal?.aborted) return res();
    signal?.addEventListener("abort", () => res(), { once: true });
  });

interface OpenExtra {
  env?: string;
  overrides?: Partial<SetupContext>;
  /** Hält eine Anfrage an, bevor sie zum Server geht (verspätete Antworten) */
  gate?(method: string, path: string, body: any): Promise<void> | undefined;
}

async function openFlow(options: FlowOptions = {}, extra: OpenExtra = {}) {
  created = [];
  htmlWrites = [];
  for (const k of Object.keys(elements)) delete elements[k];
  const ctx = (await makeCtx({ env: extra.env ?? FULL_ENV, profile: PROFILE, overrides: extra.overrides })) as TestCtx;
  const step = makeFlowStep(options);
  const steps: SetupStep[] = [...SETUP_STEPS.filter(s => s.id !== "pruefung"), step, checkStep];
  const s = await startSetup({ ctx, steps });
  running.push(s);
  const cookie = await login(s);
  const sent: Array<{ method: string; path: string; body: any }> = [];
  const timers: Array<{ fn: () => unknown; ms: number }> = [];
  const api = async (method: string, path: string, body?: unknown) => {
    sent.push({ method, path, body });
    await extra.gate?.(method, path, body);
    const res = await fetch(`${s.base}${path}`, {
      method,
      headers: { "Content-Type": "application/json", Origin: s.origin, Cookie: cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, ok: res.ok, data: await res.json().catch(() => null) };
  };
  const view = new Function("document", "window", `${setupSource}\nreturn createSetupView;`)(doc, { TYBO_BRAND })({
    api,
    navigate: () => {},
    scrollTop: () => {},
    schedule: (fn: () => unknown, ms: number) => timers.push({ fn, ms }),
  });
  await view.start();
  await settle();
  await view.open(FLOW_ID);
  await settle();

  const panelNodes = () => all(elements["setup-panel"]);
  const button = (action: string) => panelNodes().find(n => n.tagName === "BUTTON" && n.attributes["data-action"] === action);
  const actions = () => panelNodes().filter(n => n.tagName === "BUTTON").map(n => n.attributes["data-action"]);
  const input = (name: string) => panelNodes().find(n => n.id === `field-${name}`)!;
  const text = () => panelNodes().map(n => n.textContent).filter(Boolean).join("\n");
  const click = async (action: string) => {
    const b = button(action);
    if (!b) throw new Error(`Knopf ${action} fehlt`);
    await b.dispatch("click");
    await settle();
  };
  /** Nächste Abfrage auslösen (statt 2 s zu warten) */
  const tick = async () => {
    const t = timers.shift();
    if (!t) throw new Error("keine Abfrage geplant");
    expect(t.ms).toBe(2000);
    await t.fn();
    await settle();
  };
  return { s, step, view, sent, timers, button, actions, input, text, click, tick };
}

function options(select: Node): string[] {
  return select.children.map(o => `${o.value}:${o.textContent}`);
}

describe("Felder", () => {
  test("Standard vorausgefüllt, geladene Auswahl erst nach „Auswahl laden“, „Einrichten“ statt Testen/Speichern", async () => {
    const app = await openFlow();
    expect(app.input("FLOW_MODE").value).toBe("neu");
    expect(app.input("FLOW_NAME").value).toBe("tybo");
    expect(app.input("FLOW_TOKEN").value).toBe("");
    expect(app.input("FLOW_PASSWORD").value).toBe("");
    const org = app.input("FLOW_ORG");
    expect(org.disabled).toBe(true);
    expect(options(org)).toEqual([":Erst die Auswahl laden"]);
    expect(app.actions()).toEqual(["load-FLOW_ORG", "run", "next"]);
    expect(app.button("run")!.textContent).toBe("Einrichten");

    app.input("FLOW_TOKEN").value = FLOW.token;
    await app.click("load-FLOW_ORG");
    expect(org.disabled).toBe(false);
    expect(options(org)).toEqual([":Bitte wählen", `${FLOW.org}:${FLOW.orgLabel}`, "org-beta:Beta AG"]);
    const load = app.sent.find(r => r.path.endsWith("/choices/FLOW_ORG"))!;
    expect(load.body.values.FLOW_TOKEN).toBe(FLOW.token);

    // Token geändert: Liste verworfen
    app.input("FLOW_TOKEN").value = FLOW.otherToken;
    await app.input("FLOW_TOKEN").dispatch("input");
    expect(org.disabled).toBe(true);
    expect(org.value).toBe("");
    expect(options(org)).toEqual([":Erst die Auswahl laden"]);
    expect(htmlWrites).toEqual([]);
  });

  test("genau eine Auswahl vom Anbieter: vorausgewählt (Issue #163)", async () => {
    const app = await openFlow({ choices: async () => ({ choices: [{ value: FLOW.org, label: FLOW.orgLabel }] }) });
    app.input("FLOW_TOKEN").value = FLOW.token;
    await app.click("load-FLOW_ORG");
    const org = app.input("FLOW_ORG");
    expect(org.disabled).toBe(false);
    expect(org.value).toBe(FLOW.org);
    // Mehrere: keine Vorauswahl (siehe oben „Bitte wählen“)
  });

  test("gesetzter Wert: kein Vorschlag", async () => {
    const app = await openFlow({}, { env: `${FULL_ENV}FLOW_NAME=eigenes\n` });
    expect(app.input("FLOW_NAME").value).toBe("");
    expect(app.input("FLOW_NAME").attributes.placeholder).toBe("Gesetzt. Leer lassen, um den Wert zu behalten.");
  });

  test("Art gewechselt: Testen und Speichern statt Einrichten; view bekommt nie Geheimnisse", async () => {
    const app = await openFlow();
    app.input("FLOW_TOKEN").value = FLOW.token;
    app.input("FLOW_PASSWORD").value = FLOW.password;
    app.input("FLOW_MODE").value = "vorhanden";
    await app.input("FLOW_MODE").dispatch("change");
    await new Promise(r => setTimeout(r, 30));
    expect(app.actions()).toEqual(["load-FLOW_ORG", "apply", "test", "next"]);
    const views = app.sent.filter(r => r.path.endsWith("/view"));
    expect(views.length).toBeGreaterThan(0);
    for (const v of views) {
      expect(JSON.stringify(v.body)).not.toContain(FLOW.token);
      expect(JSON.stringify(v.body)).not.toContain(FLOW.password);
    }
  });

  test("Ladefehler erscheint am Feld, verspätete Antwort wird ignoriert", async () => {
    const gates: Array<() => void> = [];
    const app = await openFlow({
      async choices(values) {
        await new Promise<void>(r => gates.push(r));
        if (values.FLOW_TOKEN === FLOW.otherToken) return { error: "Token abgelehnt." };
        return { choices: [{ value: "alt", label: "Alte Liste" }] };
      },
    });
    app.input("FLOW_TOKEN").value = FLOW.token;
    const first = app.button("load-FLOW_ORG")!.dispatch("click");
    await settle();
    app.input("FLOW_TOKEN").value = FLOW.otherToken;
    await app.input("FLOW_TOKEN").dispatch("input");
    const second = app.button("load-FLOW_ORG")!.dispatch("click");
    await settle();
    gates[1]();
    await second;
    await settle();
    expect(app.text()).toContain("Token abgelehnt.");
    gates[0]();
    await first;
    await settle();
    expect(options(app.input("FLOW_ORG"))).toEqual([":Erst die Auswahl laden"]);
  });
});

describe("Ablauf", () => {
  test("Plan, Jetzt ausführen, Fortschritt per Abfrage, Ergebnis", async () => {
    const app = await openFlow();
    app.input("FLOW_TOKEN").value = FLOW.token;
    await app.click("load-FLOW_ORG");
    app.input("FLOW_ORG").value = FLOW.org;
    app.input("FLOW_PASSWORD").value = FLOW.password;
    await app.click("run");
    expect(app.text()).toContain("Das passiert jetzt:");
    expect(app.text()).toContain("Warten, bis das Projekt bereit ist.");
    expect(app.step.log.runs).toEqual([]);

    await app.click("run-confirm");
    const start = app.sent.find(r => r.path.endsWith("/run"))!;
    expect(start.body.values).toMatchObject({ FLOW_TOKEN: FLOW.token, FLOW_ORG: FLOW.org, FLOW_NAME: "tybo", FLOW_PASSWORD: FLOW.password });
    expect(app.view.state().busy).toBe(true);
    // Die erste Abfrage kommt sofort; bis der Ablauf fertig ist, alle 2 s
    for (let i = 0; i < 20 && app.view.state().running; i++) await app.tick();
    expect(app.view.state()).toMatchObject({ busy: false, running: null });
    const t = app.text();
    expect(t).toContain("Projekt angelegt und eingetragen.");
    expect(t).toContain("Geändert: FLOW_TOKEN, FLOW_ORG, FLOW_NAME");
    expect(t).toContain("[2/3] Warte, bis das Projekt bereit ist (0:40)");
    expect(t).toContain("[3/3] Schreibe die Zugangsdaten");
    expect(t).not.toContain(FLOW.token);
    expect(t).not.toContain(FLOW.password);
    expect(htmlWrites).toEqual([]);
  });

  test("Abbrechen löst signal aus, die Meldung des Ablaufs erscheint", async () => {
    const app = await openFlow({}, { overrides: { sleep: sleepUntilAbort } });
    app.input("FLOW_TOKEN").value = FLOW.token;
    await app.click("load-FLOW_ORG");
    app.input("FLOW_ORG").value = FLOW.org;
    await app.click("run");
    await app.click("run-confirm");
    expect(app.text()).toContain("Läuft …");
    await app.click("run-cancel");
    expect(app.button("run-cancel")!.textContent).toBe("Breche ab …");
    expect(app.step.log.signals[0].aborted).toBe(true);
    for (let i = 0; i < 20 && app.view.state().running; i++) await app.tick();
    expect(app.text()).toContain(ABORTED_MESSAGE);
    expect(app.view.state().busy).toBe(false);
  });

  test("Start abgelehnt (ohne geladene Auswahl): Meldung, nichts läuft", async () => {
    const app = await openFlow();
    app.input("FLOW_TOKEN").value = FLOW.token;
    await app.click("run");
    await app.click("run-confirm");
    expect(app.text()).toContain("Organisation fehlt");
    expect(app.view.state()).toMatchObject({ busy: false, running: null });
    expect(app.step.log.runs).toEqual([]);
  });
});

describe("Plan und Eingabestand", () => {
  const bothModes: FlowOptions = { runWhen: () => true, plan: v => [`Aktion ${v.FLOW_MODE} ausführen.`] };

  test("Wechsel A → B nach der Plananzeige: Bestätigung verworfen, neuer Plan, gestartet wird B", async () => {
    const app = await openFlow(bothModes);
    app.input("FLOW_TOKEN").value = FLOW.token;
    await app.click("run");
    expect(app.text()).toContain("Aktion neu ausführen.");
    const staleConfirm = app.button("run-confirm")!;

    app.input("FLOW_MODE").value = "vorhanden";
    await app.input("FLOW_MODE").dispatch("change");
    await settle();
    expect(app.button("run-confirm")).toBeUndefined();
    expect(app.text()).not.toContain("Aktion neu ausführen.");

    // Der alte Knopf (schon angeklickt, bevor die Oberfläche nachkam) startet nichts, sondern zeigt den neuen Plan
    await staleConfirm.dispatch("click");
    await settle();
    expect(app.sent.filter(r => r.path.endsWith("/run"))).toEqual([]);
    expect(app.text()).toContain("Aktion vorhanden ausführen.");
    expect(app.text()).not.toContain("Aktion neu ausführen.");

    await app.click("run-confirm");
    const start = app.sent.find(r => r.path.endsWith("/run"))!;
    expect(start.body.values.FLOW_MODE).toBe("vorhanden");
    for (let i = 0; i < 20 && app.view.state().running; i++) await app.tick();
    expect(app.step.log.runs[0].FLOW_MODE).toBe("vorhanden");
  });

  test("Texteingabe nach der Plananzeige verwirft die Bestätigung", async () => {
    const app = await openFlow(bothModes);
    app.input("FLOW_TOKEN").value = FLOW.token;
    await app.click("run");
    expect(app.button("run-confirm")).toBeDefined();
    app.input("FLOW_NAME").value = "anders";
    await app.input("FLOW_NAME").dispatch("input");
    expect(app.button("run-confirm")).toBeUndefined();
    expect(app.step.log.runs).toEqual([]);
  });

  test("verspätete view-Antwort setzt keinen älteren Stand ein", async () => {
    let release: (() => void) | null = null;
    let holdNext = false;
    const app = await openFlow({}, {
      gate(_m, path) {
        if (!path.endsWith("/view") || !holdNext) return undefined;
        holdNext = false;
        return new Promise<void>(r => (release = r));
      },
    });
    expect(app.actions()).toContain("run");
    holdNext = true;
    app.input("FLOW_MODE").value = "vorhanden";
    const first = app.input("FLOW_MODE").dispatch("change");
    await settle();
    app.input("FLOW_MODE").value = "neu";
    await app.input("FLOW_MODE").dispatch("change");
    await settle();
    expect(app.actions()).toContain("run");
    release!();
    await first;
    await settle();
    // Die Antwort zu „vorhanden“ kam zuletzt, gilt aber nicht mehr
    expect(app.actions()).toContain("run");
    expect(app.actions()).not.toContain("apply");
  });

  test("eingegebenes Geheimnis erreicht die Modusentscheidung nur als Name", async () => {
    const app = await openFlow({ runWhen: v => v.FLOW_MODE === "neu" && !!v.FLOW_TOKEN });
    expect(app.actions()).toContain("apply");
    app.input("FLOW_TOKEN").value = FLOW.token;
    await app.input("FLOW_TOKEN").dispatch("input");
    await app.input("FLOW_TOKEN").dispatch("change");
    await settle();
    expect(app.actions()).toContain("run");
    const last = app.sent.filter(r => r.path.endsWith("/view")).at(-1)!;
    expect(last.body.present).toEqual(["FLOW_TOKEN"]);
    expect(JSON.stringify(last.body)).not.toContain(FLOW.token);
  });
});
