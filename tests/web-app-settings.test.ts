// Einstellungen im Browser (Issue #38): Ansicht unter #/einstellungen/agenten
// mit Modell, Effort und Anweisungen je Agent, dazu „Agent ändern …" im
// Topic-Menü. Ohne Browser: Attrappen für DOM, fetch, EventSource, Timer,
// localStorage, location und history wie in web-app-manage.test.ts. Geladen
// werden settings.js und app.js wie im Browser nacheinander.
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createInstructionsApi, InstructionsChanged, instructionsDigest, type InstructionsPort } from "../src/web/instructions";
import { createRevisionClock } from "../src/web/revision";
import { createSettingsApi, inheritedAgentValues, SettingsFileInvalid, type SettingsPort } from "../src/web/settings";
import { TYBO_BRAND } from "./brand-fixture";

const publicDir = resolve(import.meta.dir, "..", "src", "web", "public");
const settingsSource = await readFile(resolve(publicDir, "settings.js"), "utf8");
const appSource = await readFile(resolve(publicDir, "app.js"), "utf8");

interface Node {
  children: Node[];
  attributes: Record<string, string>;
  [key: string]: any;
}

/** Alle Zuweisungen an innerHTML, über alle Knoten */
let htmlWrites: string[] = [];

function node(tag = "div"): Node {
  const n: Node = {
    tagName: tag.toUpperCase(),
    children: [],
    attributes: {},
    style: {},
    className: "",
    textContent: "",
    hidden: false,
    disabled: false,
    value: "",
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
    focused: 0,
    appendChild(child: Node) { this.children.push(child); return child; },
    replaceChildren(...list: Node[]) {
      this.children = list.flatMap(c => (c.fragment ? c.children : [c]));
    },
    setAttribute(name: string, value: string) { this.attributes[name] = value; },
    getAttribute(name: string) { return this.attributes[name]; },
    removeAttribute(name: string) { delete this.attributes[name]; },
    listeners: {} as Record<string, ((e: any) => void)[]>,
    addEventListener(type: string, fn: (e: any) => void) { (this.listeners[type] ??= []).push(fn); },
    dispatch(type: string, event: any = {}) { for (const fn of this.listeners[type] ?? []) fn(event); },
    focus() { this.focused++; },
    select() {},
  };
  Object.defineProperty(n, "innerHTML", {
    set(v: string) { htmlWrites.push(v); },
    get() { return ""; },
  });
  return n;
}

class FakeEventSource {
  static all: FakeEventSource[] = [];
  listeners: Record<string, ((e: any) => void)[]> = {};
  closed = false;
  constructor(public url: string) { FakeEventSource.all.push(this); }
  addEventListener(type: string, fn: (e: any) => void) { (this.listeners[type] ??= []).push(fn); }
  close() { this.closed = true; }
  emit(type: string, event: any = {}) { for (const fn of this.listeners[type] ?? []) fn(event); }
}

const AGENTS = [
  { name: "general", label: "General" },
  { name: "research", label: "Research" },
  { name: "critic", label: "Critic" },
];
const AGENT_NAMES = AGENTS.map(a => a.name);
const CLAUDE = ["claude-opus-5-5", "claude-sonnet-5", "claude-haiku-4-5-20251001"];
const CODE = { model: { value: "claude-opus-5-5", source: "code" }, effort: { value: "high", source: "code" } };
const recently = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

const CODE_AUX = { judge: "claude:claude-opus-5", distill: "claude:claude-haiku-4-5-20251001", review: "claude:claude-haiku-4-5-20251001" };
/** Werte „aus .env" der Attrappe; Tests setzen sie und räumen sie wieder ab */
const ENV_LAYER: { aux: Record<string, string | undefined>; fallback: Record<string, string | boolean | undefined> } = { aux: {}, fallback: {} };

/** Standard-Effort aus dem Code je Modell; fest "high", außer ein Test gibt eine Regel vor */
type CodeEffort = (model: string) => string | null;
const FLAT_EFFORT: CodeEffort = () => CODE.effort.value;

/** Wirksame Werte wie die Resolver: eigener Eintrag, dann Standard aus der Datei, dann Code */
function effectiveFor(settings: any, codeEffort: CodeEffort) {
  const agents: Record<string, any> = {};
  for (const name of AGENT_NAMES) {
    const own = settings.agents?.[name] ?? {};
    const modelValue = own.model ?? settings.defaults?.model;
    const model = modelValue ? { value: modelValue, source: "settings" } : CODE.model;
    const effortValue = own.effort ?? settings.defaults?.effort;
    const effort = effortValue ? { value: effortValue, source: "settings" } : { value: codeEffort(model.value), source: "code" };
    agents[name] = { model, effort };
  }
  // Aux und Fallback (Issue #39): Datei vor .env (ENV_LAYER) vor Code
  const layer = (own: unknown, env: unknown, code: unknown) =>
    own !== undefined ? { value: own, source: "settings" } : env !== undefined ? { value: env, source: "env" } : { value: code, source: "code" };
  const aux: Record<string, any> = {};
  for (const p of ["judge", "distill", "review"]) aux[p] = layer(settings.aux?.[p], (ENV_LAYER.aux as any)[p], (CODE_AUX as any)[p]);
  const fb = settings.fallback ?? {};
  const fallback = {
    openrouterModel: layer(fb.openrouterModel, ENV_LAYER.fallback.openrouterModel, "minimax/minimax-m2.7"),
    ollamaModel: layer(fb.ollamaModel, ENV_LAYER.fallback.ollamaModel, "qwen3:8b"),
    offlineOnly: layer(fb.offlineOnly, ENV_LAYER.fallback.offlineOnly, false),
  };
  return { agents, aux, fallback };
}

/** Wirksame und geerbte Werte wie der Server; inherited über dieselbe Funktion wie in src/web/settings.ts */
function view(settings: any, extra: Record<string, unknown> = {}, codeEffort: CodeEffort = FLAT_EFFORT) {
  const port = { agents: AGENT_NAMES, effective: (s: any) => effectiveFor(s, codeEffort) as any };
  const inherited = inheritedAgentValues(port, settings);
  return { settings, effective: effectiveFor(settings, codeEffort), inherited, agents: AGENT_NAMES, effortLevels: ["low", "medium", "high", "xhigh"], ...extra };
}

interface Options {
  hash?: string;
  settings?: any;
  fileInvalid?: boolean;
  instructions?: Record<string, string[]>;
  telegram?: { dm: any; topics: any[] };
  stored?: string;
  /** Verlauf je Telegram-Gespräch */
  history?: Record<string, any[]>;
  rights?: any;
  /** GET /api/settings antwortet mit 500 */
  settingsGetFails?: boolean;
  /** Standard-Effort aus dem Code je Modell */
  codeEffort?: CodeEffort;
  /** Antwort von /api/models (Issue #39) */
  models?: any;
  /** /api/models antwortet mit 500 */
  modelsFail?: boolean;
  /** Antwort von /api/status (Issue #39) */
  status?: any;
  /** Issue #111: Seite mit Version geladen, der Server nennt eine neuere */
  newVersion?: boolean;
}

function setup(options: Options = {}) {
  FakeEventSource.all = [];
  htmlWrites = [];
  const elements: Record<string, Node> = {};
  const document: Record<string, any> = {
    activeElement: null,
    getElementById(id: string) { return (elements[id] ??= node()); },
    createElement(tag: string) { return node(tag); },
    createDocumentFragment() { const f = node(); f.fragment = true; return f; },
    visibilityState: "visible",
    addEventListener(type: string, fn: () => void) { (docListeners[type] ??= []).push(fn); },
  };
  const docListeners: Record<string, (() => void)[]> = {};
  if (options.newVersion) elements["ui-version"] = Object.assign(node(), { getAttribute: (n: string) => (n === "content" ? "0123456789abcdef" : null) });
  let reloads = 0;
  const store: Record<string, string> = {};
  if (options.stored) store["tybo-last-conversation"] = options.stored;
  const windowListeners: Record<string, ((e: any) => void)[]> = {};
  const fire = (type: string) => { for (const fn of windowListeners[type] ?? []) fn({}); };
  /** Verlauf der Adressen wie im Browser; hashchange nur bei Änderung */
  const nav = { entries: [options.hash ?? ""], index: 0, replaced: [] as string[], backs: 0 };
  const location: Record<string, any> = {
    href: "/",
    pathname: "/",
    search: "",
    reload() { reloads++; },
    get hash() { return nav.entries[nav.index]; },
    set hash(value: string) {
      const next = value && !value.startsWith("#") ? "#" + value : value;
      if (next === nav.entries[nav.index]) return;
      nav.entries = nav.entries.slice(0, nav.index + 1).concat(next);
      nav.index++;
      fire("hashchange");
    },
  };
  const history = {
    replaceState(_s: unknown, _t: string, url: string) {
      const hash = url.includes("#") ? url.slice(url.indexOf("#")) : "";
      nav.entries[nav.index] = hash;
      nav.replaced.push(url);
    },
    back() {
      nav.backs++;
      if (nav.index === 0) return;
      nav.index--;
      fire("hashchange");
    },
  };
  const window: Record<string, any> = {
    TYBO_BRAND,
    localStorage: {
      getItem: (key: string) => store[key] ?? null,
      setItem: (key: string, value: string) => { store[key] = value; },
      removeItem: (key: string) => { delete store[key]; },
    },
    matchMedia: () => ({ matches: false }),
    getComputedStyle: () => ({ lineHeight: "22", paddingTop: "0", paddingBottom: "0", borderTopWidth: "0", borderBottomWidth: "0" }),
    addEventListener(type: string, fn: (e: any) => void) { (windowListeners[type] ??= []).push(fn); },
    location,
    history,
  };
  const timers = new Map<number, () => void>();
  let nextTimer = 1;
  const setTimeout = (fn: () => void) => { const id = nextTimer++; timers.set(id, fn); return id; };
  const clearTimeout = (id: number) => { timers.delete(id); };

  const server = {
    settings: structuredClone(options.settings ?? { agents: { research: { model: "claude-sonnet-5" }, critic: { effort: "xhigh" } } }),
    fileInvalid: options.fileInvalid ?? false,
    settingsGetFails: options.settingsGetFails ?? false,
    /** GET /api/settings scheitert ohne Antwort (Netzwerkfehler) */
    settingsGetOffline: false,
    instructions: structuredClone(options.instructions ?? { research: ["Antworte kürzer."] }) as Record<string, string[]>,
    telegram: structuredClone(options.telegram ?? { dm: null, topics: [] }),
    requests: [] as { method: string; path: string; body: any }[],
    /** Feste Antworten, sonst wie der Server */
    settingsPatch: null as null | { status: number; body: any } | "offline",
    instructionsWrite: null as null | { status: number; body: any },
    restart: { status: 202, body: { requested: true, supervisor: "launchd", message: "Neustart angefordert." } } as { status: number; body: any },
    /** /api/models (Issue #39); modelsFails: HTTP 500, modelsOffline: Netzwerkfehler */
    models: structuredClone(options.models ?? { claude: { models: CLAUDE, custom: true }, openrouter: { models: [] }, ollama: { models: [] } }),
    modelsFails: options.modelsFail ?? false,
    modelsOffline: false,
    /** /api/status (Issue #39); statusOffline: Server weg (Neustart), statusCode: HTTP-Status */
    status: structuredClone(options.status ?? null) as any,
    statusOffline: false,
    statusCode: 200,
    restartRequired: false,
    agentPatch: null as null | { status: number; body: any },
    /** Antwort auf PATCH { agent } zurückhalten, bis release() */
    holdAgentPatch: false,
    release: null as null | (() => void),
    /** Anweisungs-Anfragen mit dieser Methode zurückhalten; GET liest den Stand vorher */
    holdInstructions: new Set<string>(),
    instructionReleases: [] as { method: string; release: () => void }[],
    /** Anweisungs-Schreiben dieser Methode ausführen, die Antwort aber zurückhalten */
    holdInstructionReplies: new Set<string>(),
    /** GET /api/conversations: Stand beim Absenden, Antwort bis release zurückhalten */
    holdConversations: false,
    conversationReleases: [] as (() => void)[],
    /** Antworten auf /api/settings mit dieser Methode zurückhalten; der Stand steht vorher fest */
    holdSettings: new Set<string>(),
    settingsReleases: [] as { method: string; release: () => void }[],
    /** PATCH vor dem Schreiben anhalten (Stand noch alt), bis release */
    holdPatchBeforeWrite: false,
    patchWriteRelease: null as null | (() => void),
    /** Startzeit des simulierten Prozesses (boot der Versionsnummern) */
    boot: 1000,
    /** Bot neu gestartet: neue APIs mit späterem boot, Zähler beginnen neu */
    restartProcess() {
      server.boot += 1000;
      apis = createApis();
    },
  };
  /**
   * /api/settings und die Anweisungen laufen durch die echten
   * createSettingsApi und createInstructionsApi (Schreibkette, Versionsnummern,
   * Bedingung beim Löschen); nur Speicher und Resolver sind Attrappen.
   */
  const settingsPort: SettingsPort = {
    agents: AGENT_NAMES,
    effortLevels: ["low", "medium", "high", "xhigh"],
    current: () => structuredClone(server.settings),
    readForWrite: async () => {
      if (server.fileInvalid) throw new SettingsFileInvalid();
      return structuredClone(server.settings);
    },
    validate: value => ({ ok: true, value: value as any }),
    write: async value => {
      if (server.holdPatchBeforeWrite) await new Promise<void>(r => { server.patchWriteRelease = r; });
      server.settings = structuredClone(value);
    },
    effective: settings => effectiveFor(settings, options.codeEffort ?? FLAT_EFFORT) as any,
  };
  /** Wie src/lib/agent-overrides.ts; server.instructions ist die Datei, Tests ändern sie wie /agent in Telegram */
  const unchanged = (agent: string, check?: (list: readonly string[]) => boolean) => {
    if (check && !check(server.instructions[agent] ?? [])) throw new InstructionsChanged();
  };
  const instructionsPort: InstructionsPort = {
    list: agent => [...(server.instructions[agent] ?? [])],
    add: async (agent, text) => (server.instructions[agent] ??= []).push(text),
    clear: async (agent, check) => {
      unchanged(agent, check);
      const n = (server.instructions[agent] ?? []).length;
      server.instructions[agent] = [];
      return n;
    },
    removeLast: async (agent, check) => {
      unchanged(agent, check);
      return (server.instructions[agent] ?? []).pop();
    },
  };
  const createApis = () => ({
    settings: createSettingsApi(settingsPort, () => {}, createRevisionClock(server.boot)),
    instructions: createInstructionsApi(instructionsPort, new Set(AGENT_NAMES), () => {}, createRevisionClock(server.boot)),
  });
  let apis = createApis();
  const holdSetting = (method: string) =>
    server.holdSettings.has(method)
      ? new Promise<void>(r => { server.settingsReleases.push({ method, release: r }); })
      : Promise.resolve();
  const holdInstruction = (method: string) =>
    server.holdInstructions.has(method)
      ? new Promise<void>(r => { server.instructionReleases.push({ method, release: r }); })
      : Promise.resolve();
  const fetch = async (path: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body) : undefined;
    server.requests.push({ method, path, body });
    if (path === "/api/version") return Response.json({ version: "fedcba9876543210" });
    if (path === "/api/agents") return Response.json({ agents: AGENTS, defaultAgent: "general" });
    // System-Prompt (Issue #51): hier nur Beiwerk, geprüft in web-app-agents-manage.test.ts
    const promptPath = path.match(/^\/api\/agents\/([^/]+)\/prompt$/);
    if (promptPath && method === "GET") {
      return Response.json({ name: promptPath[1], systemPrompt: "Beispiel-Prompt", codePrompt: "Beispiel-Prompt", promptSource: "code" });
    }
    if (path === "/api/conversations" && method === "GET") {
      const response = Response.json({ conversations: [], telegram: server.telegram });
      if (server.holdConversations) await new Promise<void>(r => { server.conversationReleases.push(r); });
      return response;
    }
    if (path === "/api/telegram/rights") return Response.json(options.rights ?? { group: true, manageTopics: true, deleteMessages: true });
    if (path === "/api/models") {
      if (server.modelsOffline) throw new TypeError("offline");
      if (server.modelsFails) return Response.json({ error: "kaputt" }, { status: 500 });
      return Response.json(server.models);
    }
    if (path === "/api/status") {
      if (server.statusOffline) throw new TypeError("offline");
      return Response.json(server.status ?? { error: "kein Status" }, { status: server.status ? server.statusCode : 500 });
    }
    if (path === "/api/settings" && method === "GET" && (server.settingsGetOffline || server.settingsGetFails)) {
      // Auch Fehler lassen sich zurückhalten; ob es scheitert, steht beim Absenden fest
      const offline = server.settingsGetOffline;
      await holdSetting(method);
      if (offline) throw new TypeError("offline");
      return Response.json({ error: "kaputt" }, { status: 500 });
    }
    if (path === "/api/settings" && method === "GET") {
      // Der Stand steht vor dem Zurückhalten fest
      const result = await apis.settings.get();
      await holdSetting(method);
      return Response.json(result.body, { status: result.status });
    }
    if (path === "/api/settings" && method === "PATCH") {
      if (server.settingsPatch === "offline") throw new TypeError("offline");
      if (server.settingsPatch) return Response.json(server.settingsPatch.body, { status: server.settingsPatch.status });
      const result = await apis.settings.patch(init?.body ?? "");
      if (result.status === 200 && server.restartRequired) result.body.restartRequired = true;
      await holdSetting(method);
      return Response.json(result.body, { status: result.status });
    }
    if (path === "/api/restart") {
      if ((server as any).restartThrows) throw new TypeError("offline");
      return Response.json(server.restart.body, { status: server.restart.status });
    }
    const inst = path.match(/^\/api\/agents\/([^/]+)\/instructions(\/last)?$/);
    if (inst) {
      const [, name, last] = inst;
      // GET liest den Stand vor dem Zurückhalten, Schreiben schreibt erst danach
      if (method === "GET") {
        const result = await apis.instructions.handle(name, !!last, method, "");
        await holdInstruction(method);
        return Response.json(result.body, { status: result.status });
      }
      await holdInstruction(method);
      if (server.instructionsWrite) return Response.json(server.instructionsWrite.body, { status: server.instructionsWrite.status });
      const result = await apis.instructions.handle(name, !!last, method, init?.body ?? "");
      if (server.holdInstructionReplies.has(method)) await new Promise<void>(r => { server.instructionReleases.push({ method, release: r }); });
      return Response.json(result.body, { status: result.status });
    }
    const topicPatch = path.match(/^\/api\/conversations\/(topic-\d+)$/);
    if (topicPatch && method === "PATCH") {
      if (server.holdAgentPatch) await new Promise<void>(r => { server.release = r; });
      if (server.agentPatch) return Response.json(server.agentPatch.body, { status: server.agentPatch.status });
      const t = server.telegram.topics.find((x: any) => x.id === topicPatch[1]);
      if (!t) return Response.json({ error: "Gespräch nicht gefunden" }, { status: 404 });
      t.agent = body.agent;
      return Response.json({ conversation: { ...t }, note: "Gilt ab der nächsten Nachricht in diesem Topic." });
    }
    const messages = path.match(/^\/api\/conversations\/([^/]+)\/messages$/);
    if (messages) return Response.json({ messages: options.history?.[messages[1]] ?? [], hasMore: false, running: false });
    return Response.json({ error: "unbekannt" }, { status: 404 });
  };

  elements["chat-log"] = node();
  new Function("document", "window", "fetch", "EventSource", "setTimeout", "clearTimeout", `${settingsSource}\n${appSource}`)(
    document, window, fetch, FakeEventSource, setTimeout, clearTimeout
  );

  const requests = (method: string, prefix = "") => server.requests.filter(r => r.method === method && r.path.startsWith(prefix));
  /** Tiefensuche im Einstellungsbereich */
  const all = (root: Node = elements["settings-panel"]): Node[] => [root, ...root.children.flatMap((c: Node) => all(c))];
  const byKey = (key: string) => all().find(n => n.attributes["data-focus-key"] === key);
  const agentHead = (name: string) => byKey(`agent:${name}`)!;
  const select = (id: string) => all().find(n => n.id === id)!;
  const byClass = (cls: string, root?: Node) => all(root).filter(n => String(n.className).split(" ").includes(cls));
  const texts = (cls: string, root?: Node) => byClass(cls, root).map(n => n.textContent);
  const choose = (id: string, value: string) => { const s = select(id); s.value = value; s.dispatch("change"); };
  const click = (key: string) => { const b = byKey(key); if (!b) throw new Error(`Knopf ${key} fehlt`); b.dispatch("click"); };
  const headerPanel = () => elements["conversation-actions"].children[0];
  const panelButtons = (panel: Node) => panel.children.filter((c: Node) => c.attributes["type"] === "button");
  /** Tab wird sichtbar (Issue #111) */
  const visible = () => { for (const fn of docListeners["visibilitychange"] ?? []) fn(); };
  return {
    server, elements, nav, window, requests, all, byKey, agentHead, select, byClass, texts, choose, click, headerPanel, panelButtons, timers, fire,
    visible, reloads: () => reloads,
  };
}

async function settle() {
  for (let i = 0; i < 40; i++) await Bun.sleep(0);
}

async function openAgent(app: ReturnType<typeof setup>, name: string) {
  app.agentHead(name).dispatch("click");
  await settle();
}

/** Über „Zurück" schließen und über das Zahnrad wieder öffnen */
async function closeSettings(app: ReturnType<typeof setup>) {
  app.elements["settings-back"].dispatch("click");
  await settle();
}

async function reopenSettings(app: ReturnType<typeof setup>) {
  app.elements["open-settings"].dispatch("click");
  await settle();
}

const helpers = new Function("document", "window", `${settingsSource}\nreturn { settingsTabFromHash, inheritedLabel, agentSettingsPatch, isNotOlder: typeof isNotOlder === "function" ? isNotOlder : undefined, MODEL_DEFAULT, MODEL_CUSTOM, EFFORT_DEFAULT };`)(
  { getElementById: () => null }, {}
) as any;

describe("Hilfsfunktionen", () => {
  test("Reiter aus der Adresse: unbekannte werden zu Agenten, fremde Adressen null", () => {
    expect(helpers.settingsTabFromHash("#/einstellungen/agenten")).toBe("agenten");
    expect(helpers.settingsTabFromHash("#/einstellungen")).toBe("agenten");
    // Seit Issue #39 fertig
    expect(helpers.settingsTabFromHash("#/einstellungen/modelle")).toBe("modelle");
    expect(helpers.settingsTabFromHash("#/einstellungen/status")).toBe("status");
    expect(helpers.settingsTabFromHash("#/einstellungen/quatsch")).toBe("agenten");
    for (const hash of ["", "#", "#/einstellungenX", "#/chat", undefined]) expect(helpers.settingsTabFromHash(hash)).toBeNull();
  });

  test("„Standard (…)\" nennt Wert und Quelle; ohne Effort entscheidet Claude", () => {
    expect(helpers.inheritedLabel({ value: "claude-opus-5-5", source: "code" })).toBe("Standard (claude-opus-5-5, Voreinstellung)");
    expect(helpers.inheritedLabel({ value: "medium", source: "env" })).toBe("Standard (medium, .env)");
    expect(helpers.inheritedLabel({ value: "claude-sonnet-5", source: "settings" })).toBe("Standard (claude-sonnet-5, allgemeine Einstellung)");
    expect(helpers.inheritedLabel({ value: null, source: "code" })).toBe("Standard (Claude entscheidet)");
  });

  test("Teiländerung: nur Geändertes, Standard als null, eigenes Modell getrimmt", () => {
    const { agentSettingsPatch: p, MODEL_DEFAULT: D, MODEL_CUSTOM: C, EFFORT_DEFAULT: E } = helpers;
    expect(p({ model: D, effort: E }, {})).toEqual({ patch: null });
    expect(p({ model: D, effort: E }, { model: "x", effort: "low" })).toEqual({ patch: { model: null, effort: null } });
    expect(p({ model: C, custom: "  vendor/m  ", effort: "low" }, { effort: "low" })).toEqual({ patch: { model: "vendor/m" } });
    expect(p({ model: C, custom: "   ", effort: E }, {}).error).toBeTruthy();
    expect(p({ model: "claude-sonnet-5", effort: E }, { model: "claude-sonnet-5" })).toEqual({ patch: null });
  });
});

describe("Einstellungsansicht: Einstieg, Adresse, Zurück", () => {
  test("Zahnrad in der Seitenleiste öffnet #/einstellungen/agenten; Zurück führt zum Chat", async () => {
    const app = setup();
    await settle();
    expect(app.elements["main"].attributes["data-view"]).toBeUndefined();
    expect(app.requests("GET", "/api/settings")).toHaveLength(0);

    app.elements["open-settings"].dispatch("click");
    await settle();
    expect(app.window.location.hash).toBe("#/einstellungen/agenten");
    expect(app.elements["settings"].hidden).toBe(false);
    expect(app.elements["main"].attributes["data-view"]).toBe("settings");
    expect(app.elements["open-settings"].attributes["aria-current"]).toBe("page");
    expect(app.elements["settings-title"].focused).toBe(1);
    expect(app.requests("GET", "/api/settings")).toHaveLength(1);
    expect(app.requests("GET", "/api/models")).toHaveLength(1);

    // Reiter: Agenten gewählt, Modelle und Status seit Issue #39 frei, Schlüssel seit #63
    const tabs = app.elements["settings-tabs"].children;
    expect(tabs.map((t: Node) => t.textContent)).toEqual(["Agenten", "Modelle", "Schlüssel", "Status"]);
    expect(tabs.map((t: Node) => t.attributes["role"])).toEqual(["tab", "tab", "tab", "tab"]);
    expect(tabs.map((t: Node) => t.attributes["aria-selected"])).toEqual(["true", "false", "false", "false"]);
    expect(tabs.map((t: Node) => t.disabled)).toEqual([false, false, false, false]);

    app.elements["settings-back"].dispatch("click");
    await settle();
    expect(app.nav.backs).toBe(1);
    expect(app.window.location.hash).toBe("");
    expect(app.elements["settings"].hidden).toBe(true);
    expect(app.elements["main"].attributes["data-view"]).toBe("chat");
    expect(app.elements["open-settings"].attributes["aria-current"]).toBeUndefined();
  });

  test("Direktaufruf und Neuladen: Adresse öffnet die Ansicht; Zurück entfernt den Hash ohne Verlaufsschritt", async () => {
    const app = setup({ hash: "#/einstellungen/agenten" });
    await settle();
    expect(app.elements["settings"].hidden).toBe(false);
    expect(app.elements["main"].attributes["data-view"]).toBe("settings");
    // Der Chat lädt trotzdem im Hintergrund
    expect(app.requests("GET", "/api/conversations").length).toBeGreaterThan(0);
    app.elements["settings-back"].dispatch("click");
    await settle();
    expect(app.nav.backs).toBe(0);
    expect(app.nav.replaced.at(-1)).toBe("/");
    expect(app.elements["settings"].hidden).toBe(true);
    expect(app.elements["main"].attributes["data-view"]).toBe("chat");
  });

  test("Zurück landet im Verlauf wieder auf den Einstellungen: Hash wird entfernt, Chat erscheint", async () => {
    const app = setup();
    await settle();
    app.elements["open-settings"].dispatch("click");
    await settle();
    // Der Eintrag davor ist ebenfalls eine Einstellungsadresse
    app.nav.entries[0] = "#/einstellungen/agenten";
    app.elements["settings-back"].dispatch("click");
    await settle();
    expect(app.nav.backs).toBe(1);
    expect(app.window.location.hash).toBe("");
    expect(app.elements["settings"].hidden).toBe(true);
    expect(app.elements["main"].attributes["data-view"]).toBe("chat");
  });

  test("#/einstellungen und unbekannte Reiter werden zu #/einstellungen/agenten, ohne neuen Verlaufseintrag", async () => {
    for (const hash of ["#/einstellungen", "#/einstellungen/quatsch"]) {
      const app = setup({ hash });
      await settle();
      expect(app.nav.replaced).toEqual(["/#/einstellungen/agenten"]);
      expect(app.nav.entries).toEqual(["#/einstellungen/agenten"]);
      expect(app.elements["settings"].hidden).toBe(false);
    }
  });

  test("#/einstellungen/modelle und /status öffnen ihren Reiter direkt (Issue #39)", async () => {
    for (const tab of ["modelle", "status"]) {
      const app = setup({ hash: "#/einstellungen/" + tab });
      await settle();
      expect(app.nav.replaced).toEqual([]);
      expect(app.elements["settings"].hidden).toBe(false);
      const tabs = app.elements["settings-tabs"].children;
      expect(tabs.map((t: Node) => t.attributes["aria-selected"])).toEqual(["agenten", "modelle", "schluessel", "status"].map(id => String(id === tab)));
      expect(app.elements["settings-panel"].attributes["aria-labelledby"]).toBe("settings-tab-" + tab);
    }
  });

  test("Reiter anklicken ersetzt die Adresse ohne neuen Verlaufseintrag; Pfeiltasten wechseln reihum", async () => {
    const app = setup({ hash: "#/einstellungen/agenten" });
    await settle();
    const tab = (id: string) => app.elements["settings-tabs"].children.find((t: Node) => t.attributes["id"] === "settings-tab-" + id)!;
    tab("modelle").dispatch("click");
    await settle();
    expect(app.window.location.hash).toBe("#/einstellungen/modelle");
    expect(app.nav.entries).toHaveLength(1);
    expect(tab("modelle").attributes["aria-selected"]).toBe("true");
    tab("modelle").dispatch("keydown", { key: "ArrowRight", preventDefault() {} });
    await settle();
    expect(app.window.location.hash).toBe("#/einstellungen/schluessel");
    tab("schluessel").dispatch("keydown", { key: "ArrowRight", preventDefault() {} });
    await settle();
    expect(app.window.location.hash).toBe("#/einstellungen/status");
    tab("status").dispatch("keydown", { key: "ArrowRight", preventDefault() {} });
    await settle();
    expect(app.window.location.hash).toBe("#/einstellungen/agenten");
    expect(app.nav.entries).toHaveLength(1);
  });

  test("Browser-Zurück (hashchange) schließt die Ansicht, Vor öffnet sie wieder und lädt frisch", async () => {
    const app = setup();
    await settle();
    app.elements["open-settings"].dispatch("click");
    await settle();
    app.window.history.back();
    await settle();
    expect(app.elements["settings"].hidden).toBe(true);
    app.window.location.hash = "#/einstellungen/agenten";
    await settle();
    expect(app.elements["settings"].hidden).toBe(false);
    expect(app.requests("GET", "/api/settings")).toHaveLength(2);
  });

  test("Laden fehlgeschlagen: Meldung und „Erneut laden\"", async () => {
    const app = setup({ hash: "#/einstellungen/agenten", settingsGetFails: true });
    await settle();
    expect(app.texts("actions-error")).toEqual(["Einstellungen konnten nicht geladen werden."]);
    expect(app.byKey("agent:general")).toBeUndefined();
    app.server.settingsGetFails = false;
    app.click("settings-retry");
    await settle();
    expect(app.texts("actions-error")).toEqual([]);
    expect(app.byKey("agent:general")).toBeDefined();
  });
});

describe("Agenten-Reiter", () => {
  test("je Agent eine Zeile mit Farbpunkt, Name und wirksamem Modell/Effort", async () => {
    const app = setup({ hash: "#/einstellungen/agenten" });
    await settle();
    const heads = AGENT_NAMES.map(n => app.agentHead(n));
    expect(heads.map(h => h.children[0].attributes["data-agent"])).toEqual(AGENT_NAMES);
    expect(heads.map(h => h.children[0].children[0].className)).toEqual(["agent-dot", "agent-dot", "agent-dot"]);
    expect(heads.map(h => h.children[0].children[1].textContent)).toEqual(["General", "Research", "Critic"]);
    expect(heads.map(h => h.children[1].textContent)).toEqual([
      "claude-opus-5-5 · Effort high",
      "claude-sonnet-5 · Effort high",
      "claude-opus-5-5 · Effort xhigh",
    ]);
    expect(heads.map(h => h.attributes["aria-expanded"])).toEqual(["false", "false", "false"]);
  });

  test("Aufklappen: Modell mit Standard, Claude-Liste und Eigenem; Effort-Stufen; Anweisungen laden", async () => {
    const app = setup({ hash: "#/einstellungen/agenten" });
    await settle();
    await openAgent(app, "research");
    expect(app.agentHead("research").attributes["aria-expanded"]).toBe("true");
    const model = app.select("settings-model-research");
    expect(model.children.map((o: Node) => o.textContent)).toEqual([
      "Standard (claude-opus-5-5, Voreinstellung)",
      ...CLAUDE,
      "Eigenes Modell …",
    ]);
    expect(model.value).toBe("claude-sonnet-5");
    const effort = app.select("settings-effort-research");
    expect(effort.children.map((o: Node) => o.textContent)).toEqual(["Standard (high, Voreinstellung)", "low", "medium", "high", "xhigh"]);
    expect(effort.value).toBe(helpers.EFFORT_DEFAULT);
    expect(app.requests("GET", "/api/agents/research/instructions")).toHaveLength(1);
    expect(app.all().filter(n => n.tagName === "OL")[0].children.map((li: Node) => li.textContent)).toEqual(["Antworte kürzer."]);
    expect(app.texts("actions-hint")).toContain("Wirkt ab dem nächsten neuen Gespräch dieses Agenten. Sofort: in Telegram im betroffenen Topic /new senden.");
    // Ohne Änderung ist Speichern gesperrt
    expect(app.byKey("save:research")!.disabled).toBe(true);
  });

  test("Standardwert und Quelle bei bestehendem Override aus der allgemeinen Einstellung", async () => {
    const app = setup({ hash: "#/einstellungen/agenten", settings: { defaults: { model: "claude-haiku-4-5-20251001", effort: "medium" }, agents: { research: { model: "claude-sonnet-5", effort: "low" } } } });
    await settle();
    await openAgent(app, "research");
    expect(app.select("settings-model-research").children[0].textContent).toBe("Standard (claude-haiku-4-5-20251001, allgemeine Einstellung)");
    expect(app.select("settings-effort-research").children[0].textContent).toBe("Standard (medium, allgemeine Einstellung)");
    expect(app.select("settings-effort-research").value).toBe("low");
  });

  test("Modell „Standard\" sendet Entfernen (null), danach „Gespeichert.\" und neuer Stand", async () => {
    const app = setup({ hash: "#/einstellungen/agenten" });
    await settle();
    await openAgent(app, "research");
    app.choose("settings-model-research", helpers.MODEL_DEFAULT);
    expect(app.byKey("save:research")!.disabled).toBe(false);
    app.click("save:research");
    await settle();
    expect(app.requests("PATCH", "/api/settings")).toEqual([{ method: "PATCH", path: "/api/settings", body: { agents: { research: { model: null } } } }]);
    expect(app.server.settings.agents.research).toBeUndefined();
    expect(app.texts("settings-status")).toEqual(["Gespeichert."]);
    expect(app.agentHead("research").children[1].textContent).toBe("claude-opus-5-5 · Effort high");
    expect(app.select("settings-model-research").value).toBe(helpers.MODEL_DEFAULT);
    expect(app.byKey("save:research")!.disabled).toBe(true);
    // Bestätigung verschwindet nach kurzer Zeit
    for (const fn of [...app.timers.values()]) fn();
    expect(app.texts("settings-status")).toEqual([""]);
    // Kein Neustart-Hinweis ohne restartRequired
    expect(app.byKey("restart:research")).toBeUndefined();
  });

  test("erneutes Öffnen: unveränderte Felder übernehmen den neuen Serverstand, nur Effort wird gesendet", async () => {
    const app = setup({ hash: "#/einstellungen/agenten" });
    await settle();
    await openAgent(app, "research");
    expect(app.select("settings-model-research").value).toBe("claude-sonnet-5");
    // Unverändert verlassen, anderer Browser setzt Haiku
    await closeSettings(app);
    app.server.settings.agents.research.model = "claude-haiku-4-5-20251001";
    await reopenSettings(app);
    expect(app.select("settings-model-research").value).toBe("claude-haiku-4-5-20251001");
    expect(app.byKey("save:research")!.disabled).toBe(true);
    app.choose("settings-effort-research", "low");
    app.click("save:research");
    await settle();
    expect(app.requests("PATCH", "/api/settings").map(r => r.body)).toEqual([{ agents: { research: { effort: "low" } } }]);
    expect(app.server.settings.agents.research).toEqual({ model: "claude-haiku-4-5-20251001", effort: "low" });
  });

  test("erneutes Öffnen: echte lokale Änderung bleibt, das unveränderte Feld folgt dem Server", async () => {
    const app = setup({ hash: "#/einstellungen/agenten" });
    await settle();
    await openAgent(app, "research");
    app.choose("settings-model-research", "claude-opus-5-5");
    await closeSettings(app);
    app.server.settings.agents.research.effort = "medium";
    await reopenSettings(app);
    expect(app.select("settings-model-research").value).toBe("claude-opus-5-5");
    expect(app.select("settings-effort-research").value).toBe("medium");
    expect(app.byKey("save:research")!.disabled).toBe(false);
    app.click("save:research");
    await settle();
    expect(app.requests("PATCH", "/api/settings").map(r => r.body)).toEqual([{ agents: { research: { model: "claude-opus-5-5" } } }]);
    expect(app.server.settings.agents.research).toEqual({ model: "claude-opus-5-5", effort: "medium" });
  });

  test("Speichern eines Agenten: unveränderte Felder anderer Agenten übernehmen den neuen Serverstand", async () => {
    const app = setup({ hash: "#/einstellungen/agenten" });
    await settle();
    await openAgent(app, "research");
    await openAgent(app, "general");
    expect(app.select("settings-model-research").value).toBe("claude-sonnet-5");
    // Anderer Browser setzt Research auf Haiku, hier wird nur General gespeichert
    app.server.settings.agents.research.model = "claude-haiku-4-5-20251001";
    app.choose("settings-effort-general", "low");
    app.click("save:general");
    await settle();
    expect(app.select("settings-model-research").value).toBe("claude-haiku-4-5-20251001");
    expect(app.byKey("save:research")!.disabled).toBe(true);
    app.choose("settings-effort-research", "low");
    app.click("save:research");
    await settle();
    expect(app.requests("PATCH", "/api/settings").map(r => r.body)).toEqual([
      { agents: { general: { effort: "low" } } },
      { agents: { research: { effort: "low" } } },
    ]);
    expect(app.server.settings.agents.research).toEqual({ model: "claude-haiku-4-5-20251001", effort: "low" });
  });

  test("Speichern eines Agenten: echte lokale Änderung bei einem anderen Agenten bleibt stehen", async () => {
    const app = setup({ hash: "#/einstellungen/agenten" });
    await settle();
    await openAgent(app, "research");
    await openAgent(app, "general");
    app.choose("settings-model-research", "claude-opus-5-5");
    app.server.settings.agents.research.effort = "medium";
    app.choose("settings-effort-general", "low");
    app.click("save:general");
    await settle();
    expect(app.select("settings-model-research").value).toBe("claude-opus-5-5");
    expect(app.select("settings-effort-research").value).toBe("medium");
    app.click("save:research");
    await settle();
    expect(app.requests("PATCH", "/api/settings").map(r => r.body)[1]).toEqual({ agents: { research: { model: "claude-opus-5-5" } } });
    expect(app.server.settings.agents.research).toEqual({ model: "claude-opus-5-5", effort: "medium" });
  });

  test("erneutes Öffnen: Effort-Änderung bleibt, auch wenn das eigene Modell noch leer ist", async () => {
    const app = setup({ hash: "#/einstellungen/agenten" });
    await settle();
    await openAgent(app, "research");
    app.choose("settings-effort-research", "low");
    app.choose("settings-model-research", helpers.MODEL_CUSTOM);
    await closeSettings(app);
    await reopenSettings(app);
    expect(app.select("settings-effort-research").value).toBe("low");
    expect(app.select("settings-model-research").value).toBe(helpers.MODEL_CUSTOM);
    const custom = app.select("settings-custom-research");
    custom.value = "vendor/model";
    custom.dispatch("input");
    app.click("save:research");
    await settle();
    expect(app.requests("PATCH", "/api/settings").map(r => r.body)).toEqual([{ agents: { research: { model: "vendor/model", effort: "low" } } }]);
    expect(app.server.settings.agents.research).toEqual({ model: "vendor/model", effort: "low" });
  });

  test("Speichern eines Agenten: Effort-Änderung eines anderen bleibt, auch wenn dessen eigenes Modell leer ist", async () => {
    const app = setup({ hash: "#/einstellungen/agenten" });
    await settle();
    await openAgent(app, "research");
    await openAgent(app, "general");
    app.choose("settings-effort-research", "low");
    app.choose("settings-model-research", helpers.MODEL_CUSTOM);
    app.choose("settings-effort-general", "low");
    app.click("save:general");
    await settle();
    expect(app.select("settings-effort-research").value).toBe("low");
    expect(app.select("settings-model-research").value).toBe(helpers.MODEL_CUSTOM);
    const custom = app.select("settings-custom-research");
    custom.value = "vendor/model";
    custom.dispatch("input");
    app.click("save:research");
    await settle();
    expect(app.requests("PATCH", "/api/settings").map(r => r.body)).toEqual([
      { agents: { general: { effort: "low" } } },
      { agents: { research: { model: "vendor/model", effort: "low" } } },
    ]);
    expect(app.server.settings.agents.research).toEqual({ model: "vendor/model", effort: "low" });
  });

  test("Eigenes Modell sendet den Text; leer wird nicht gesendet", async () => {
    const app = setup({ hash: "#/einstellungen/agenten" });
    await settle();
    await openAgent(app, "general");
    app.choose("settings-model-general", helpers.MODEL_CUSTOM);
    const custom = app.select("settings-custom-general");
    expect(custom.attributes["type"]).toBe("text");
    app.click("save:general");
    await settle();
    expect(app.requests("PATCH")).toHaveLength(0);
    expect(app.texts("actions-error")).toContain("Bitte einen Modellnamen eingeben.");
    custom.value = "  vendor/modell-<b>x</b>  ";
    custom.dispatch("input");
    app.click("save:general");
    await settle();
    expect(app.requests("PATCH", "/api/settings")[0].body).toEqual({ agents: { general: { model: "vendor/modell-<b>x</b>" } } });
    // Nicht in der Liste: bleibt als eigenes Modell sichtbar
    expect(app.select("settings-model-general").value).toBe(helpers.MODEL_CUSTOM);
    expect(app.select("settings-custom-general").value).toBe("vendor/modell-<b>x</b>");
    expect(app.agentHead("general").children[1].textContent).toBe("vendor/modell-<b>x</b> · Effort high");
    expect(htmlWrites).toEqual([]);
  });

  test("Effort zurück auf Standard sendet null; Effort setzen sendet die Stufe", async () => {
    const app = setup({ hash: "#/einstellungen/agenten" });
    await settle();
    await openAgent(app, "critic");
    expect(app.select("settings-effort-critic").value).toBe("xhigh");
    app.choose("settings-effort-critic", helpers.EFFORT_DEFAULT);
    app.click("save:critic");
    await settle();
    expect(app.requests("PATCH", "/api/settings")[0].body).toEqual({ agents: { critic: { effort: null } } });
    app.choose("settings-effort-critic", "medium");
    app.click("save:critic");
    await settle();
    expect(app.requests("PATCH", "/api/settings")[1].body).toEqual({ agents: { critic: { effort: "medium" } } });
  });

  test("Speicherfehler (400, 500, offline): Meldung, Eingaben bleiben, erneut speichern möglich", async () => {
    const app = setup({ hash: "#/einstellungen/agenten" });
    await settle();
    await openAgent(app, "general");
    app.choose("settings-model-general", helpers.MODEL_CUSTOM);
    const custom = app.select("settings-custom-general");
    custom.value = "vendor/kaputt";
    custom.dispatch("input");
    app.choose("settings-effort-general", "low");
    for (const [failure, text] of [
      [{ status: 400, body: { error: "Ungültige Einstellungen: agents.general.model (ungültiger Wert)" } }, "Ungültige Einstellungen: agents.general.model (ungültiger Wert)"],
      [{ status: 500, body: { error: "Einstellungen konnten nicht gespeichert werden" } }, "Einstellungen konnten nicht gespeichert werden"],
      ["offline", "Server nicht erreichbar, nichts gespeichert."],
    ] as const) {
      app.server.settingsPatch = failure as any;
      app.click("save:general");
      await settle();
      expect(app.texts("actions-error")).toContain(text);
      expect(app.select("settings-model-general").value).toBe(helpers.MODEL_CUSTOM);
      expect(app.select("settings-custom-general").value).toBe("vendor/kaputt");
      expect(app.select("settings-effort-general").value).toBe("low");
      expect(app.byKey("save:general")!.disabled).toBe(false);
      expect(app.texts("settings-status")).toEqual([""]);
    }
    app.server.settingsPatch = null;
    app.click("save:general");
    await settle();
    expect(app.texts("actions-error")).toEqual([]);
    expect(app.server.settings.agents.general).toEqual({ model: "vendor/kaputt", effort: "low" });
  });

  test("ungültige Datei: Hinweis oben, Speichern gesperrt; 409 beim Speichern zeigt den Hinweis", async () => {
    const app = setup({ hash: "#/einstellungen/agenten", fileInvalid: true });
    await settle();
    expect(app.elements["settings-notice"].hidden).toBe(false);
    expect(app.elements["settings-notice"].textContent).toContain("config/settings.json ist ungültig");
    await openAgent(app, "general");
    app.choose("settings-effort-general", "low");
    expect(app.byKey("save:general")!.disabled).toBe(true);

    const other = setup({ hash: "#/einstellungen/agenten" });
    await settle();
    expect(other.elements["settings-notice"].hidden).toBe(true);
    await openAgent(other, "general");
    other.choose("settings-effort-general", "low");
    other.server.settingsPatch = { status: 409, body: { error: "config/settings.json ist ungültig. Bitte die Datei reparieren oder löschen, dann erneut speichern." } };
    other.click("save:general");
    await settle();
    expect(other.texts("actions-error")[0]).toContain("reparieren oder löschen");
    expect(other.elements["settings-notice"].hidden).toBe(false);
    expect(other.select("settings-effort-general").value).toBe("low");
  });

  test("restartRequired: Hinweis mit „Jetzt neu starten\", Neustart nur nach Klick; 202 und 409 ohne Supervisor", async () => {
    const app = setup({ hash: "#/einstellungen/agenten" });
    await settle();
    app.server.restartRequired = true;
    await openAgent(app, "general");
    app.choose("settings-effort-general", "low");
    app.click("save:general");
    await settle();
    expect(app.texts("actions-hint")).toContain("Diese Änderung greift erst nach einem Neustart von tybo.");
    expect(app.byKey("restart:general")!.textContent).toBe("Jetzt neu starten");
    expect(app.requests("POST", "/api/restart")).toHaveLength(0);

    // Ohne Supervisor: 409 mit Erklärung, Knopf bleibt für einen neuen Versuch
    app.server.restart = { status: 409, body: { error: "tybo läuft nicht unter launchd oder PM2. Bitte tybo manuell neu starten.", supervisor: null } };
    app.click("restart:general");
    await settle();
    expect(app.requests("POST", "/api/restart")).toHaveLength(1);
    expect(app.texts("actions-error")).toContain("tybo läuft nicht unter launchd oder PM2. Bitte tybo manuell neu starten.");
    expect(app.byKey("restart:general")).toBeDefined();

    app.server.restart = { status: 202, body: { requested: true, supervisor: "launchd", message: "Neustart angefordert. tybo startet nach der laufenden Antwort neu." } };
    app.click("restart:general");
    await settle();
    expect(app.requests("POST", "/api/restart")).toHaveLength(2);
    expect(app.texts("actions-hint")).toContain("Neustart angefordert. tybo startet nach der laufenden Antwort neu.");
    expect(app.byKey("restart:general")).toBeUndefined();
  });
});

describe("Veraltete Gesamtstände (Codex-Befund Runde 5 zu PR #43)", () => {
  test("zurückgehaltenes GET nach Speichern setzt den bestätigten Stand nicht zurück", async () => {
    const app = setup({ hash: "#/einstellungen/agenten" });
    await settle();
    await openAgent(app, "research");
    expect(app.select("settings-model-research").value).toBe("claude-sonnet-5");
    // Einstellungen erneut öffnen, dessen GET hängt (liefert noch Sonnet)
    app.server.holdSettings = new Set(["GET"]);
    await closeSettings(app);
    await reopenSettings(app);
    app.server.holdSettings = new Set();
    // Research ist noch aufgeklappt; der alte Stand wird angezeigt, bis das GET kommt
    app.choose("settings-model-research", "claude-opus-5-5");
    app.click("save:research");
    await settle();
    expect(app.select("settings-model-research").value).toBe("claude-opus-5-5");
    // Jetzt kommt die alte GET-Antwort mit Sonnet
    for (const r of app.server.settingsReleases.splice(0)) r.release();
    await settle();
    expect(app.select("settings-model-research").value).toBe("claude-opus-5-5");
    expect(app.server.settings.agents.research.model).toBe("claude-opus-5-5");
  });

  test("verspätete PATCH-Antwort eines Agenten setzt den danach gespeicherten anderen Agenten nicht zurück", async () => {
    const app = setup({ hash: "#/einstellungen/agenten" });
    await settle();
    await openAgent(app, "research");
    await openAgent(app, "general");
    // Research wird serverseitig gespeichert, die Antwort hängt
    app.server.holdSettings = new Set(["PATCH"]);
    app.choose("settings-model-research", "claude-opus-5-5");
    app.click("save:research");
    await settle();
    app.server.holdSettings = new Set();
    // General danach speichern, Antwort kommt sofort (enthält beide Änderungen)
    app.choose("settings-effort-general", "low");
    app.click("save:general");
    await settle();
    expect(app.select("settings-effort-general").value).toBe("low");
    // Alte Research-Antwort (ohne General-low) trifft jetzt ein
    for (const r of app.server.settingsReleases.splice(0)) r.release();
    await settle();
    expect(app.select("settings-effort-general").value).toBe("low");
    expect(app.select("settings-model-research").value).toBe("claude-opus-5-5");
    expect(app.server.settings.agents.general).toEqual({ effort: "low" });
    // Beide Formulare gelten als gespeichert: nichts mehr zu senden
    expect(app.byKey("save:general")!.disabled).toBe(true);
    expect(app.byKey("save:research")!.disabled).toBe(true);
  });

  test("GET, das während des Speicherns startet und den alten Stand liest, setzt den bestätigten Wert nicht zurück (Runde 6)", async () => {
    const app = setup({ hash: "#/einstellungen/agenten" });
    await settle();
    await openAgent(app, "research");
    await openAgent(app, "general");
    app.choose("settings-effort-general", "high");
    expect(app.select("settings-model-research").value).toBe("claude-sonnet-5");
    // PATCH läuft, der Server hat noch nicht geschrieben
    app.server.holdPatchBeforeWrite = true;
    app.choose("settings-model-research", "claude-opus-5-5");
    app.click("save:research");
    await settle();
    // Während des Speicherns schließen und wieder öffnen: das GET liest noch Sonnet
    app.server.holdSettings = new Set(["GET"]);
    await closeSettings(app);
    await reopenSettings(app);
    app.server.holdSettings = new Set();
    app.server.holdPatchBeforeWrite = false;
    // Zuerst schließt das PATCH ab
    app.server.patchWriteRelease!();
    await settle();
    expect(app.select("settings-model-research").value).toBe("claude-opus-5-5");
    // Dann kommt das alte GET
    for (const r of app.server.settingsReleases.splice(0)) r.release();
    await settle();
    expect(app.select("settings-model-research").value).toBe("claude-opus-5-5");
    expect(app.byKey("save:research")!.disabled).toBe(true);
    expect(app.server.settings.agents.research.model).toBe("claude-opus-5-5");
    // Lokale Eingabe bei General bleibt
    expect(app.select("settings-effort-general").value).toBe("high");
  });

  test("neuer Prozessstart (anderer boot) wird übernommen, auch mit kleinerer Nummer", async () => {
    const app = setup({ hash: "#/einstellungen/agenten" });
    await settle();
    await openAgent(app, "research");
    app.choose("settings-model-research", "claude-opus-5-5");
    app.click("save:research");
    await settle();
    // Bot neu gestartet: Zähler beginnt neu, Datei hat inzwischen Haiku
    app.server.restartProcess();
    app.server.settings.agents.research.model = "claude-haiku-4-5-20251001";
    await closeSettings(app);
    await reopenSettings(app);
    expect(app.select("settings-model-research").value).toBe("claude-haiku-4-5-20251001");
  });

  test("lokale Eingabe bei einem dritten Agenten bleibt über alle Antworten hinweg stehen", async () => {
    const app = setup({ hash: "#/einstellungen/agenten" });
    await settle();
    await openAgent(app, "research");
    await openAgent(app, "general");
    app.choose("settings-effort-general", "high");
    app.server.holdSettings = new Set(["PATCH"]);
    app.choose("settings-model-research", "claude-opus-5-5");
    app.click("save:research");
    await settle();
    app.server.holdSettings = new Set();
    for (const r of app.server.settingsReleases.splice(0)) r.release();
    await settle();
    expect(app.select("settings-effort-general").value).toBe("high");
    expect(app.byKey("save:general")!.disabled).toBe(false);
  });
});

describe("Version gehört zum Inhalt, nicht zur Anfrage (Plan-Session 2 zu PR #43)", () => {
  test("verspätete Speicherantwort nach ungültig gewordener Datei: Hinweis bleibt, Speichern gesperrt", async () => {
    const app = setup({ hash: "#/einstellungen/agenten" });
    await settle();
    await openAgent(app, "research");
    // Research speichern: der Server schreibt, die Antwort hängt
    app.server.holdSettings = new Set(["PATCH"]);
    app.choose("settings-model-research", "claude-opus-5-5");
    app.click("save:research");
    await settle();
    app.server.holdSettings = new Set();
    expect(app.server.settings.agents.research.model).toBe("claude-opus-5-5");
    // Danach wird die Datei von Hand kaputt gemacht; erneutes Öffnen zeigt den Hinweis
    app.server.fileInvalid = true;
    await closeSettings(app);
    await reopenSettings(app);
    expect(app.elements["settings-notice"].hidden).toBe(false);
    // Jetzt trifft die ältere Speicherantwort ein (damals war die Datei gültig)
    for (const r of app.server.settingsReleases.splice(0)) r.release();
    await settle();
    expect(app.elements["settings-notice"].hidden).toBe(false);
    expect(app.elements["settings-notice"].textContent).toContain("config/settings.json ist ungültig");
    app.choose("settings-effort-research", "low");
    expect(app.byKey("save:research")!.disabled).toBe(true);
  });

  test("von Hand geänderte Datei: ein älteres GET mit gleichem Schreibzähler setzt den neueren Stand nicht zurück", async () => {
    const app = setup({ hash: "#/einstellungen/agenten" });
    await settle();
    await openAgent(app, "research");
    // Erstes erneutes Öffnen: GET liest Sonnet, die Antwort hängt
    app.server.holdSettings = new Set(["GET"]);
    await closeSettings(app);
    await reopenSettings(app);
    app.server.holdSettings = new Set();
    // Datei von Hand auf Haiku, noch einmal öffnen: dieses GET kommt sofort
    app.server.settings.agents.research.model = "claude-haiku-4-5-20251001";
    await closeSettings(app);
    await reopenSettings(app);
    expect(app.select("settings-model-research").value).toBe("claude-haiku-4-5-20251001");
    // Das ältere GET mit Sonnet trifft zuletzt ein
    for (const r of app.server.settingsReleases.splice(0)) r.release();
    await settle();
    expect(app.select("settings-model-research").value).toBe("claude-haiku-4-5-20251001");
    expect(app.byKey("save:research")!.disabled).toBe(true);
  });

  test("Antwort aus dem Prozess vor einem Neustart ist älter als eine aus dem neuen Prozess", async () => {
    const app = setup({ hash: "#/einstellungen/agenten" });
    await settle();
    await openAgent(app, "research");
    app.server.holdSettings = new Set(["GET"]);
    await closeSettings(app);
    await reopenSettings(app);
    app.server.holdSettings = new Set();
    // Bot neu gestartet, Datei inzwischen Haiku; der neue Prozess antwortet zuerst
    app.server.restartProcess();
    app.server.settings.agents.research.model = "claude-haiku-4-5-20251001";
    await closeSettings(app);
    await reopenSettings(app);
    expect(app.select("settings-model-research").value).toBe("claude-haiku-4-5-20251001");
    for (const r of app.server.settingsReleases.splice(0)) r.release();
    await settle();
    expect(app.select("settings-model-research").value).toBe("claude-haiku-4-5-20251001");
  });

  test("Helfer isNotOlder: späterer Prozess neuer, früherer älter, im Prozess nach seq, ohne Nummer übernehmen", () => {
    const { isNotOlder } = helpers;
    expect(isNotOlder({ boot: 1, seq: 5 }, { boot: 1, seq: 5 })).toBe(true);
    expect(isNotOlder({ boot: 1, seq: 5 }, { boot: 1, seq: 6 })).toBe(true);
    expect(isNotOlder({ boot: 1, seq: 5 }, { boot: 1, seq: 4 })).toBe(false);
    expect(isNotOlder({ boot: 1, seq: 5 }, { boot: 2, seq: 1 })).toBe(true);
    expect(isNotOlder({ boot: 2, seq: 1 }, { boot: 1, seq: 9 })).toBe(false);
    expect(isNotOlder(null, { boot: 1, seq: 1 })).toBe(true);
    expect(isNotOlder({ boot: 1, seq: 1 }, undefined)).toBe(true);
  });
});

describe("Abgleich mit dem Server sichtbar (Codex-Befund Runde 7 zu PR #43)", () => {
  const alerts = (app: ReturnType<typeof setup>) => app.all().filter(n => n.attributes["role"] === "alert").map(n => n.textContent);
  const STALE = "Einstellungen konnten nicht geladen werden. Angezeigt ist der zuletzt geladene Stand, er kann veraltet sein.";

  for (const [kind, fail] of [
    ["HTTP-Fehler", (app: ReturnType<typeof setup>, on: boolean) => { app.server.settingsGetFails = on; }],
    ["Netzwerkfehler", (app: ReturnType<typeof setup>, on: boolean) => { app.server.settingsGetOffline = on; }],
  ] as const) {
    test(`${kind} beim Wiederöffnen: Meldung und „Erneut laden", Formulare und lokale Eingaben bleiben`, async () => {
      const app = setup({ hash: "#/einstellungen/agenten" });
      await settle();
      await openAgent(app, "research");
      app.choose("settings-effort-research", "low");
      await closeSettings(app);
      fail(app, true);
      await reopenSettings(app);
      expect(alerts(app)).toEqual([STALE]);
      expect(app.byKey("settings-retry")!.disabled).toBe(false);
      // Vorhandener Stand und Eingabe bleiben, Speichern bleibt möglich
      expect(app.agentHead("research").children[1].textContent).toBe("claude-sonnet-5 · Effort high");
      expect(app.select("settings-effort-research").value).toBe("low");
      expect(app.byKey("save:research")!.disabled).toBe(false);
      // Erneut laden: Meldung weg, Eingabe bleibt, neuer Serverstand kommt an
      fail(app, false);
      app.server.settings.agents.research.model = "claude-haiku-4-5-20251001";
      app.click("settings-retry");
      await settle();
      expect(alerts(app)).toEqual([]);
      expect(app.select("settings-effort-research").value).toBe("low");
      expect(app.select("settings-model-research").value).toBe("claude-haiku-4-5-20251001");
    });
  }

  test("während „Erneut laden\" läuft, ist der Knopf gesperrt; scheitert es wieder, bleibt die Meldung", async () => {
    const app = setup({ hash: "#/einstellungen/agenten" });
    await settle();
    await closeSettings(app);
    app.server.settingsGetFails = true;
    await reopenSettings(app);
    app.server.holdSettings = new Set(["GET"]);
    app.click("settings-retry");
    await settle();
    expect(app.byKey("settings-retry")!.disabled).toBe(true);
    expect(alerts(app)).toEqual([STALE]);
    for (const r of app.server.settingsReleases.splice(0)) r.release();
    await settle();
    expect(app.byKey("settings-retry")!.disabled).toBe(false);
    expect(alerts(app)).toEqual([STALE]);
  });

  test("erfolgreiches Speichern liefert den ganzen Stand und hebt die Kennzeichnung auf", async () => {
    const app = setup({ hash: "#/einstellungen/agenten" });
    await settle();
    await openAgent(app, "research");
    await closeSettings(app);
    app.server.settingsGetFails = true;
    await reopenSettings(app);
    expect(alerts(app)).toEqual([STALE]);
    app.choose("settings-effort-research", "low");
    app.click("save:research");
    await settle();
    expect(alerts(app)).toEqual([]);
    expect(app.texts("settings-status")).toEqual(["Gespeichert."]);
  });

  test("ein älteres Laden, das erst nach dem Speichern scheitert, kennzeichnet den bestätigten Stand nicht", async () => {
    const app = setup({ hash: "#/einstellungen/agenten" });
    await settle();
    await openAgent(app, "research");
    // Wiederöffnen startet ein GET, das später scheitert
    await closeSettings(app);
    app.server.settingsGetFails = true;
    app.server.holdSettings = new Set(["GET"]);
    await reopenSettings(app);
    app.server.holdSettings = new Set();
    app.server.settingsGetFails = false;
    // Danach speichern: die Antwort ist ein vollständiger, neuerer Stand
    app.choose("settings-model-research", "claude-opus-5-5");
    app.click("save:research");
    await settle();
    for (const r of app.server.settingsReleases.splice(0)) r.release();
    await settle();
    expect(alerts(app)).toEqual([]);
    expect(app.select("settings-model-research").value).toBe("claude-opus-5-5");
  });
});

describe("„Standard (…)\" beim Effort hängt vom Modell ab (Codex-Befund Runde 7 zu PR #43)", () => {
  /** Wie defaultEffort ohne CLAUDE_EFFORT: Opus und Fable xhigh, sonst entscheidet Claude */
  const byModel = (model: string) => (model.includes("opus") || model.includes("fable") ? "xhigh" : null);
  const settings = { agents: { research: { model: "claude-sonnet-5", effort: "low" }, critic: { effort: "medium" } } };
  const effortDefault = (app: ReturnType<typeof setup>, name: string) => app.select(`settings-effort-${name}`).children[0].textContent;

  test("eigenes Modell Sonnet: Standard-Effort nennt, was nach dem Zurücksetzen gilt", async () => {
    const app = setup({ hash: "#/einstellungen/agenten", settings, codeEffort: byModel });
    await settle();
    await openAgent(app, "research");
    expect(effortDefault(app, "research")).toBe("Standard (Claude entscheidet)");
    app.choose("settings-effort-research", helpers.EFFORT_DEFAULT);
    app.click("save:research");
    await settle();
    expect(app.requests("PATCH", "/api/settings").map(r => r.body)).toEqual([{ agents: { research: { effort: null } } }]);
    expect(app.agentHead("research").children[1].textContent).toBe("claude-sonnet-5 · Effort automatisch");
    expect(effortDefault(app, "research")).toBe("Standard (Claude entscheidet)");
  });

  test("Modell im Formular geändert: kein Wert statt eines falschen; nach dem Speichern der richtige", async () => {
    const app = setup({ hash: "#/einstellungen/agenten", settings, codeEffort: byModel });
    await settle();
    await openAgent(app, "research");
    app.choose("settings-model-research", "claude-opus-5-5");
    expect(effortDefault(app, "research")).toBe("Standard (richtet sich nach dem Modell)");
    app.choose("settings-effort-research", helpers.EFFORT_DEFAULT);
    app.click("save:research");
    await settle();
    expect(app.requests("PATCH", "/api/settings").map(r => r.body)).toEqual([{ agents: { research: { model: "claude-opus-5-5", effort: null } } }]);
    expect(app.agentHead("research").children[1].textContent).toBe("claude-opus-5-5 · Effort xhigh");
    expect(effortDefault(app, "research")).toBe("Standard (xhigh, Voreinstellung)");
    // Modell zurück auf Standard im Formular: wieder kein Wert, bis gespeichert ist
    app.choose("settings-model-research", helpers.MODEL_DEFAULT);
    expect(effortDefault(app, "research")).toBe("Standard (richtet sich nach dem Modell)");
    app.choose("settings-model-research", "claude-opus-5-5");
    expect(effortDefault(app, "research")).toBe("Standard (xhigh, Voreinstellung)");
  });

  test("für jeden Agenten und jedes Feld: der Wert hinter „Standard\" ist der nach dem Speichern wirksame", async () => {
    const start = { agents: { research: { model: "claude-sonnet-5", effort: "low" }, critic: { model: "claude-haiku-4-5-20251001", effort: "medium" }, general: { model: "claude-opus-5-5", effort: "low" } } };
    for (const name of AGENT_NAMES) {
      for (const field of ["model", "effort"] as const) {
        const app = setup({ hash: "#/einstellungen/agenten", settings: start, codeEffort: byModel });
        await settle();
        await openAgent(app, name);
        const promised = app.select(`settings-${field}-${name}`).children[0].textContent;
        app.choose(`settings-${field}-${name}`, field === "model" ? helpers.MODEL_DEFAULT : helpers.EFFORT_DEFAULT);
        app.click(`save:${name}`);
        await settle();
        const eff = view(app.server.settings, {}, byModel).effective.agents[name][field];
        expect({ name, field, promised }).toEqual({ name, field, promised: helpers.inheritedLabel(eff) });
      }
    }
  });
});

describe("Anweisungen", () => {
  const textarea = (app: ReturnType<typeof setup>, name: string) => app.byKey(`inst-text:${name}`)!;
  const lines = (app: ReturnType<typeof setup>) => app.all().filter(n => n.tagName === "OL").flatMap((ol: Node) => ol.children.map((li: Node) => li.textContent));

  test("Hinzufügen sendet POST { text } und zeigt die neue Liste; Text nur als textContent", async () => {
    const app = setup({ hash: "#/einstellungen/agenten" });
    await settle();
    await openAgent(app, "research");
    const text = "  Nenne Quellen <img src=x onerror=alert(1)>  ";
    textarea(app, "research").value = text;
    textarea(app, "research").dispatch("input");
    app.click("inst-add:research");
    await settle();
    expect(app.requests("POST", "/api/agents/research/instructions")).toEqual([
      { method: "POST", path: "/api/agents/research/instructions", body: { text: "Nenne Quellen <img src=x onerror=alert(1)>" } },
    ]);
    expect(lines(app)).toEqual(["Antworte kürzer.", "Nenne Quellen <img src=x onerror=alert(1)>"]);
    expect(textarea(app, "research").value).toBe("");
    expect(htmlWrites).toEqual([]);
  });

  test("leer oder zu lang: nichts senden, Meldung; Serverfehler: Text bleibt im Feld", async () => {
    const app = setup({ hash: "#/einstellungen/agenten" });
    await settle();
    await openAgent(app, "research");
    for (const value of ["   ", "x".repeat(1001)]) {
      textarea(app, "research").value = value;
      textarea(app, "research").dispatch("input");
      app.click("inst-add:research");
      await settle();
    }
    expect(app.requests("POST")).toHaveLength(0);
    expect(app.texts("actions-error")).toContain("Eine Anweisung muss 1 bis 1000 Zeichen lang sein, ohne Steuerzeichen.");
    app.server.instructionsWrite = { status: 500, body: { error: "Anweisungen konnten nicht gespeichert werden" } };
    textarea(app, "research").value = "Bleib da";
    textarea(app, "research").dispatch("input");
    app.click("inst-add:research");
    await settle();
    expect(app.texts("actions-error")).toContain("Anweisungen konnten nicht gespeichert werden");
    expect(textarea(app, "research").value).toBe("Bleib da");
    expect(lines(app)).toEqual(["Antworte kürzer."]);
  });

  test("„Letzte entfernen\" ruft DELETE .../last; ohne Anweisungen gesperrt", async () => {
    const app = setup({ hash: "#/einstellungen/agenten", instructions: { research: ["Eins", "Zwei"] } });
    await settle();
    await openAgent(app, "research");
    app.click("inst-last:research");
    await settle();
    expect(app.requests("DELETE")).toEqual([{ method: "DELETE", path: "/api/agents/research/instructions/last", body: { expected: instructionsDigest(["Eins", "Zwei"]) } }]);
    expect(lines(app)).toEqual(["Eins"]);
    await openAgent(app, "critic");
    expect(app.byKey("inst-last:critic")!.disabled).toBe(true);
    expect(app.byKey("inst-clear:critic")!.disabled).toBe(true);
  });

  test("„Alle entfernen\" erst nach Rückfrage: Abbrechen sendet nichts, Bestätigen ruft DELETE", async () => {
    const app = setup({ hash: "#/einstellungen/agenten", instructions: { research: ["Eins", "Zwei"] } });
    await settle();
    await openAgent(app, "research");
    app.click("inst-clear:research");
    expect(app.texts("actions-question")).toEqual(["Alle 2 Anweisungen für Research entfernen?"]);
    app.click("inst-clear-no:research");
    expect(app.requests("DELETE")).toHaveLength(0);
    expect(app.texts("actions-question")).toEqual([]);
    app.click("inst-clear:research");
    app.click("inst-clear-yes:research");
    await settle();
    expect(app.requests("DELETE")).toEqual([{ method: "DELETE", path: "/api/agents/research/instructions", body: { expected: instructionsDigest(["Eins", "Zwei"]) } }]);
    expect(lines(app)).toEqual([]);
    expect(app.texts("settings-empty")).toContain("Keine zusätzlichen Anweisungen.");
  });

  test("erneutes Öffnen lädt die Liste neu, ungesendeter Text bleibt; Löschen trifft die angezeigte letzte", async () => {
    const app = setup({ hash: "#/einstellungen/agenten", instructions: { research: ["Eins"] } });
    await settle();
    await openAgent(app, "research");
    textarea(app, "research").value = "Noch nicht gesendet";
    textarea(app, "research").dispatch("input");
    await closeSettings(app);
    // Zwischenzeitlich per Telegram ergänzt
    app.server.instructions.research.push("Zwei");
    await reopenSettings(app);
    expect(app.requests("GET", "/api/agents/research/instructions")).toHaveLength(2);
    expect(lines(app)).toEqual(["Eins", "Zwei"]);
    expect(textarea(app, "research").value).toBe("Noch nicht gesendet");
    app.click("inst-clear:research");
    expect(app.texts("actions-question")).toEqual(["Alle 2 Anweisungen für Research entfernen?"]);
    app.click("inst-clear-no:research");
    app.click("inst-last:research");
    await settle();
    expect(app.requests("DELETE")).toEqual([{ method: "DELETE", path: "/api/agents/research/instructions/last", body: { expected: instructionsDigest(["Eins", "Zwei"]) } }]);
    expect(app.server.instructions.research).toEqual(["Eins"]);
    expect(lines(app)).toEqual(["Eins"]);
    expect(textarea(app, "research").value).toBe("Noch nicht gesendet");
  });

  test("verspätete Ladeantwort nach bestätigtem Hinzufügen wird verworfen; Löschen trifft die angezeigte letzte", async () => {
    const app = setup({ hash: "#/einstellungen/agenten", instructions: { research: ["Eins"] } });
    await settle();
    await openAgent(app, "research");
    app.server.holdInstructions = new Set(["POST", "GET"]);
    textarea(app, "research").value = "Zwei";
    textarea(app, "research").dispatch("input");
    app.click("inst-add:research");
    await settle();
    // Während der POST läuft: schließen und wieder öffnen, der neue GET liest noch ["Eins"]
    await closeSettings(app);
    await reopenSettings(app);
    expect(app.server.instructionReleases.map(r => r.method)).toEqual(["POST", "GET"]);
    app.server.holdInstructions = new Set();
    const [post, get] = app.server.instructionReleases;
    post.release();
    await settle();
    expect(lines(app)).toEqual(["Eins", "Zwei"]);
    get.release();
    await settle();
    expect(lines(app)).toEqual(["Eins", "Zwei"]);
    expect(textarea(app, "research").value).toBe("");
    app.click("inst-last:research");
    await settle();
    expect(app.requests("DELETE")).toEqual([{ method: "DELETE", path: "/api/agents/research/instructions/last", body: { expected: instructionsDigest(["Eins", "Zwei"]) } }]);
    expect(app.server.instructions.research).toEqual(["Eins"]);
    expect(lines(app)).toEqual(["Eins"]);
  });

  test("erneutes Öffnen: zugeklappter Agent lädt seine Anweisungen beim nächsten Aufklappen neu", async () => {
    const app = setup({ hash: "#/einstellungen/agenten", instructions: { research: ["Eins"] } });
    await settle();
    await openAgent(app, "research");
    await openAgent(app, "research");
    await closeSettings(app);
    app.server.instructions.research.push("Zwei");
    await reopenSettings(app);
    expect(app.requests("GET", "/api/agents/research/instructions")).toHaveLength(1);
    await openAgent(app, "research");
    expect(app.requests("GET", "/api/agents/research/instructions")).toHaveLength(2);
    expect(lines(app)).toEqual(["Eins", "Zwei"]);
  });
});

describe("Anweisungen: Version vom Server und Löschen nur der angezeigten Liste (Plan-Session 2 zu PR #43)", () => {
  const textarea = (app: ReturnType<typeof setup>, name: string) => app.byKey(`inst-text:${name}`)!;
  const lines = (app: ReturnType<typeof setup>) => app.all().filter(n => n.tagName === "OL").flatMap((ol: Node) => ol.children.map((li: Node) => li.textContent));
  const alerts = (app: ReturnType<typeof setup>) => app.all().filter(n => n.attributes["role"] === "alert").map(n => n.textContent);
  const CHANGED = "Die Anweisungen wurden inzwischen geändert, zum Beispiel per /agent in Telegram. Nichts entfernt, bitte die Liste prüfen.";

  test("verspätete Antwort auf Hinzufügen ersetzt keine neuere Liste mit einer Änderung aus Telegram", async () => {
    const app = setup({ hash: "#/einstellungen/agenten", instructions: { research: ["Eins"] } });
    await settle();
    await openAgent(app, "research");
    // POST wird ausgeführt, seine Antwort hängt
    app.server.holdInstructionReplies = new Set(["POST"]);
    textarea(app, "research").value = "Zwei";
    textarea(app, "research").dispatch("input");
    app.click("inst-add:research");
    await settle();
    app.server.holdInstructionReplies = new Set();
    // Danach per /agent in Telegram ergänzt; erneutes Öffnen lädt die neue Liste
    app.server.instructions.research.push("Drei");
    await closeSettings(app);
    await reopenSettings(app);
    expect(lines(app)).toEqual(["Eins", "Zwei", "Drei"]);
    // Die ältere POST-Antwort ([Eins, Zwei]) trifft zuletzt ein
    for (const r of app.server.instructionReleases.splice(0)) r.release();
    await settle();
    expect(lines(app)).toEqual(["Eins", "Zwei", "Drei"]);
    // „Letzte entfernen" trifft die angezeigte letzte
    app.click("inst-last:research");
    await settle();
    expect(app.server.instructions.research).toEqual(["Eins", "Zwei"]);
    expect(lines(app)).toEqual(["Eins", "Zwei"]);
  });

  test("„Letzte entfernen\" nach Änderung in Telegram: nichts entfernt, aktuelle Liste und Hinweis", async () => {
    const app = setup({ hash: "#/einstellungen/agenten", instructions: { research: ["Eins", "Zwei"] } });
    await settle();
    await openAgent(app, "research");
    expect(lines(app)).toEqual(["Eins", "Zwei"]);
    // Während die Liste angezeigt wird, kommt per /agent eine dazu
    app.server.instructions.research.push("Drei");
    app.click("inst-last:research");
    await settle();
    expect(app.requests("DELETE")).toEqual([{ method: "DELETE", path: "/api/agents/research/instructions/last", body: { expected: instructionsDigest(["Eins", "Zwei"]) } }]);
    expect(app.server.instructions.research).toEqual(["Eins", "Zwei", "Drei"]);
    expect(lines(app)).toEqual(["Eins", "Zwei", "Drei"]);
    expect(alerts(app)).toContain(CHANGED);
    // Erneut geklickt: jetzt ist die angezeigte die gespeicherte, „Drei" geht
    app.click("inst-last:research");
    await settle();
    expect(app.server.instructions.research).toEqual(["Eins", "Zwei"]);
    expect(lines(app)).toEqual(["Eins", "Zwei"]);
    expect(alerts(app)).not.toContain(CHANGED);
  });

  test("„Alle entfernen\" nach Änderung in Telegram: nichts entfernt, Rückfrage mit veralteter Anzahl schließt", async () => {
    const app = setup({ hash: "#/einstellungen/agenten", instructions: { research: ["Eins", "Zwei"] } });
    await settle();
    await openAgent(app, "research");
    app.click("inst-clear:research");
    expect(app.texts("actions-question")).toEqual(["Alle 2 Anweisungen für Research entfernen?"]);
    app.server.instructions.research.push("Drei");
    app.click("inst-clear-yes:research");
    await settle();
    expect(app.requests("DELETE")).toEqual([{ method: "DELETE", path: "/api/agents/research/instructions", body: { expected: instructionsDigest(["Eins", "Zwei"]) } }]);
    expect(app.server.instructions.research).toEqual(["Eins", "Zwei", "Drei"]);
    expect(lines(app)).toEqual(["Eins", "Zwei", "Drei"]);
    expect(app.texts("actions-question")).toEqual([]);
    expect(alerts(app)).toContain(CHANGED);
    // Neue Rückfrage nennt die aktuelle Anzahl
    app.click("inst-clear:research");
    expect(app.texts("actions-question")).toEqual(["Alle 3 Anweisungen für Research entfernen?"]);
  });
});

describe("„Agent ändern …\" im Topic-Menü", () => {
  const DM = { id: "dm", title: "Direktchat", agent: "general", lastActivity: recently(1) };
  const TOPICS = () => ({
    dm: DM,
    topics: [
      { id: "topic-443", title: "Recherche", agent: "research", lastActivity: recently(5) },
      { id: "topic-12", title: "Zahlen", agent: "critic", lastActivity: recently(30) },
      { id: "topic-1", title: "General", agent: "general", lastActivity: recently(10) },
    ],
  });
  const HISTORY = {
    "topic-443": [
      { id: "m1", role: "user", text: "Frage", createdAt: "2026-09-24T08:00:00.000Z" },
      { id: "m2", role: "assistant", html: "<p>Antwort</p>", text: "Antwort", createdAt: "2026-09-24T08:00:05.000Z" },
    ],
  };
  const sidebarMeta = (app: ReturnType<typeof setup>, id: string) => {
    const li = app.elements["topic-list"].children.find((l: Node) => l.children[0].attributes["data-id"] === id);
    return li.children[0].children[1];
  };
  const speakers = (app: ReturnType<typeof setup>) =>
    app.elements["messages"].children.filter((m: Node) => m.className === "msg msg-assistant").map((m: Node) => m.children[1].attributes["data-agent"]);

  test("Kopfzeilen-Menü: Liste der Agenten, aktueller markiert; Wahl sendet PATCH { agent } und aktualisiert Kopfzeile und Seitenleiste", async () => {
    const app = setup({ telegram: TOPICS(), stored: "topic-443", history: HISTORY });
    await settle();
    expect(speakers(app)).toEqual(["research"]);
    app.elements["conversation-menu"].dispatch("click");
    await settle();
    const change = app.panelButtons(app.headerPanel()).find((b: Node) => b.textContent === "Agent ändern …")!;
    change.dispatch("click");
    const panel = app.headerPanel();
    const choices = panel.children.filter((c: Node) => c.attributes["data-agent-choice"]);
    expect(choices.map((c: Node) => c.children[0].children[1].textContent)).toEqual(["General", "Research (aktuell)", "Critic"]);
    expect(choices.map((c: Node) => c.attributes["aria-current"])).toEqual([undefined, "true", undefined]);
    expect(choices.map((c: Node) => c.children[0].attributes["data-agent"])).toEqual(["general", "research", "critic"]);
    choices[2].dispatch("click");
    await settle();
    expect(app.requests("PATCH")).toEqual([{ method: "PATCH", path: "/api/conversations/topic-443", body: { agent: "critic" } }]);
    expect(app.elements["agent-name"].textContent).toBe("Critic");
    expect(app.elements["agent-name"].attributes["data-agent"]).toBe("critic");
    expect(sidebarMeta(app, "topic-443").attributes["data-agent"]).toBe("critic");
    expect(sidebarMeta(app, "topic-443").children[1].textContent).toBe("Critic");
    expect(app.elements["conversation-actions"].hidden).toBe(true);
    expect(app.elements["connection"].textContent).toBe("Gilt ab der nächsten Nachricht in diesem Topic.");
    // Ältere Antwort behält ihren Sprecher
    expect(speakers(app)).toEqual(["research"]);
  });

  test("aktuellen Agenten wählen schließt nur das Menü; auch ohne Löschrecht verfügbar", async () => {
    const app = setup({ telegram: TOPICS(), stored: "topic-443", rights: { group: true, manageTopics: true, deleteMessages: false } });
    await settle();
    app.elements["conversation-menu"].dispatch("click");
    await settle();
    const change = app.panelButtons(app.headerPanel()).find((b: Node) => b.textContent === "Agent ändern …")!;
    expect(change.disabled).toBe(false);
    change.dispatch("click");
    app.headerPanel().children.find((c: Node) => c.attributes["data-agent-choice"] === "research").dispatch("click");
    await settle();
    expect(app.requests("PATCH")).toHaveLength(0);
    expect(app.elements["conversation-actions"].hidden).toBe(true);
  });

  test("Eintrag in der Seitenleiste: nicht offenes Topic ändern, offene Kopfzeile bleibt", async () => {
    const app = setup({ telegram: TOPICS(), stored: "topic-443" });
    await settle();
    const row = () => app.elements["topic-list"].children.find((l: Node) => l.children[0].attributes["data-id"] === "topic-12");
    row().children[1].dispatch("click");
    await settle();
    app.panelButtons(row().children[2]).find((b: Node) => b.textContent === "Agent ändern …")!.dispatch("click");
    row().children[2].children.find((c: Node) => c.attributes["data-agent-choice"] === "general").dispatch("click");
    await settle();
    expect(app.requests("PATCH")).toEqual([{ method: "PATCH", path: "/api/conversations/topic-12", body: { agent: "general" } }]);
    expect(sidebarMeta(app, "topic-12").attributes["data-agent"]).toBe("general");
    expect(app.elements["agent-name"].textContent).toBe("Research");
  });

  test("Fehler: Meldung im Menü, Auswahl bleibt offen, nichts geändert", async () => {
    const app = setup({ telegram: TOPICS(), stored: "topic-443" });
    await settle();
    app.server.agentPatch = { status: 500, body: { error: "Agent-Zuordnung nicht gespeichert" } };
    app.elements["conversation-menu"].dispatch("click");
    await settle();
    app.panelButtons(app.headerPanel()).find((b: Node) => b.textContent === "Agent ändern …")!.dispatch("click");
    app.headerPanel().children.find((c: Node) => c.attributes["data-agent-choice"] === "critic").dispatch("click");
    await settle();
    const panel = app.headerPanel();
    expect(panel.children.filter((c: Node) => c.className === "actions-error").map((c: Node) => c.textContent)).toEqual(["Agent-Zuordnung nicht gespeichert"]);
    expect(panel.children.some((c: Node) => c.attributes["data-agent-choice"])).toBe(true);
    expect(app.elements["agent-name"].textContent).toBe("Research");
  });

  test("späte Antwort nach Gesprächswechsel überschreibt die Kopfzeile des anderen Gesprächs nicht", async () => {
    const app = setup({ telegram: TOPICS(), stored: "topic-443" });
    await settle();
    app.server.holdAgentPatch = true;
    app.elements["conversation-menu"].dispatch("click");
    await settle();
    app.panelButtons(app.headerPanel()).find((b: Node) => b.textContent === "Agent ändern …")!.dispatch("click");
    app.headerPanel().children.find((c: Node) => c.attributes["data-agent-choice"] === "critic").dispatch("click");
    await settle();
    // Anderes Gespräch öffnen, während die Antwort noch aussteht
    const dm = app.elements["dm-list"].children[0].children[0];
    dm.dispatch("click");
    await settle();
    expect(app.elements["agent-name"].textContent).toBe("General");
    app.server.release!();
    await settle();
    expect(app.elements["agent-name"].textContent).toBe("General");
    expect(sidebarMeta(app, "topic-443").attributes["data-agent"]).toBe("critic");
  });

  test("Liste, die vor dem bestätigten Agentenwechsel angefragt wurde, setzt Kopfzeile und Seitenleiste nicht zurück", async () => {
    const app = setup({ telegram: TOPICS(), stored: "topic-443", history: HISTORY });
    await settle();
    // Ein Topic-Ereignis holt die Liste; sie liest noch Research, die Antwort hängt
    app.server.holdConversations = true;
    const activity = FakeEventSource.all.find(e => e.url === "/api/telegram/events" && !e.closed)!;
    activity.emit("topic", { data: JSON.stringify({ id: "topic-12" }) });
    await settle();
    app.server.holdConversations = false;
    expect(app.server.conversationReleases).toHaveLength(1);
    // Agent ändern wird bestätigt
    app.elements["conversation-menu"].dispatch("click");
    await settle();
    app.panelButtons(app.headerPanel()).find((b: Node) => b.textContent === "Agent ändern …")!.dispatch("click");
    app.headerPanel().children.find((c: Node) => c.attributes["data-agent-choice"] === "critic")!.dispatch("click");
    await settle();
    expect(app.elements["agent-name"].textContent).toBe("Critic");
    // Die ältere Liste trifft ein: verworfen, eine neue wird geholt
    const before = app.requests("GET", "/api/conversations").length;
    for (const r of app.server.conversationReleases.splice(0)) r();
    await settle();
    expect(app.requests("GET", "/api/conversations").length).toBe(before + 1);
    expect(app.elements["agent-name"].textContent).toBe("Critic");
    expect(app.elements["agent-name"].attributes["data-agent"]).toBe("critic");
    expect(sidebarMeta(app, "topic-443").attributes["data-agent"]).toBe("critic");
  });

  test("General und Direktchat haben kein Menü, also kein „Agent ändern\"", async () => {
    const app = setup({ telegram: TOPICS(), stored: "topic-1" });
    await settle();
    expect(app.elements["conversation-menu"].hidden).toBe(true);
    const general = app.elements["topic-list"].children.find((l: Node) => l.children[0].attributes["data-id"] === "topic-1");
    expect(general.children).toHaveLength(1);
  });
});

// --- Issue #39: Reiter „Modelle" -------------------------------------------------

const OPENROUTER = Array.from({ length: 300 }, (_, i) => ({ id: `vendor${i % 7}/modell-${i}`, name: `Modell ${i}` }))
  .concat([{ id: "moonshotai/kimi-k3", name: "Kimi K3" }, { id: "minimax/minimax-m2.7", name: "MiniMax M2.7" }]);
const MODELS = {
  claude: { models: CLAUDE, custom: true },
  openrouter: { models: OPENROUTER },
  ollama: { models: ["qwen3:8b", "llama4:1b"] },
};

const modelHelpers = new Function("document", "window", `${settingsSource}\nreturn { splitAuxSpec, globalFieldValue, globalSectionPatch, globalFieldState, listEntries, filterEntries, formatUptime, formatSessions, GLOBAL_SECTIONS, MODEL_DEFAULT, MODEL_CUSTOM, MODEL_NONE, PROVIDER_DEFAULT, OFFLINE_DEFAULT };`)(
  { getElementById: () => null }, {}
) as any;

async function openModels(options: Options = {}) {
  const app = setup({ hash: "#/einstellungen/modelle", models: MODELS, ...options });
  await settle();
  return app;
}

const tabButton = (app: ReturnType<typeof setup>, id: string) =>
  app.elements["settings-tabs"].children.find((t: Node) => t.attributes["id"] === "settings-tab-" + id)!;
const optionValues = (app: ReturnType<typeof setup>, id: string) => app.select(id).children.map((o: Node) => o.value);
const optionTexts = (app: ReturnType<typeof setup>, id: string) => app.select(id).children.map((o: Node) => o.textContent);
const patches = (app: ReturnType<typeof setup>) => app.requests("PATCH", "/api/settings").map(r => r.body);

describe("Reiter „Modelle\": Hilfsfunktionen", () => {
  test("Aux nur am ersten Doppelpunkt zerlegen, Anbieter claude/openrouter/ollama", () => {
    expect(modelHelpers.splitAuxSpec("ollama:qwen3:8b")).toEqual({ provider: "ollama", model: "qwen3:8b" });
    expect(modelHelpers.splitAuxSpec("openrouter:vendor/m")).toEqual({ provider: "openrouter", model: "vendor/m" });
    expect(modelHelpers.splitAuxSpec("Claude:claude-sonnet-5")).toEqual({ provider: "claude", model: "claude-sonnet-5" });
    for (const bad of ["", "qwen3", ":x", "gpt:x", "ollama:", null, undefined]) expect(modelHelpers.splitAuxSpec(bad)).toBeNull();
  });

  test("Aux-Wert: Format anbieter:modell, Standard ist null, ohne Modell ein Fehler", () => {
    const { globalFieldValue: v, MODEL_CUSTOM: C, MODEL_NONE: N, PROVIDER_DEFAULT: P } = modelHelpers;
    const aux = { key: "judge", kind: "aux" };
    expect(v(aux, { provider: "ollama", choice: "qwen3:8b", custom: "" })).toEqual({ value: "ollama:qwen3:8b" });
    expect(v(aux, { provider: "openrouter", choice: C, custom: "  vendor/x  " })).toEqual({ value: "openrouter:vendor/x" });
    expect(v(aux, { provider: P, choice: N, custom: "" })).toEqual({ value: null });
    expect(v(aux, { provider: "claude", choice: N, custom: "" }).error).toBeTruthy();
    expect(v(aux, { provider: "claude", choice: C, custom: " " }).error).toBeTruthy();
  });

  test("Abschnitt: nur Geändertes; offlineOnly false ist ein Wert, Standard ist null", () => {
    const { globalSectionPatch: p, globalFieldState: st } = modelHelpers;
    const lists = { claude: CLAUDE, openrouter: ["x/y"], ollama: ["qwen3:8b"] };
    const fields = (saved: any) => ({
      openrouterModel: st({ key: "openrouterModel", kind: "model", list: "openrouter" }, saved.openrouterModel, lists),
      ollamaModel: st({ key: "ollamaModel", kind: "model", list: "ollama" }, saved.ollamaModel, lists),
      offlineOnly: st({ key: "offlineOnly", kind: "offline" }, saved.offlineOnly, lists),
    });
    expect(p("fallback", fields({}), {})).toEqual({ patch: null });
    const f = fields({ offlineOnly: true });
    f.offlineOnly.choice = "false";
    expect(p("fallback", f, { offlineOnly: true })).toEqual({ patch: { offlineOnly: false } });
    f.offlineOnly.choice = modelHelpers.OFFLINE_DEFAULT;
    expect(p("fallback", f, { offlineOnly: true })).toEqual({ patch: { offlineOnly: null } });
    // Nicht in der Liste: eigenes Modell, gespeichert als reine ID
    const custom = fields({ openrouterModel: "vendor/eigen" });
    expect(custom.openrouterModel).toEqual({ choice: modelHelpers.MODEL_CUSTOM, custom: "vendor/eigen", filter: "" });
    expect(p("fallback", custom, { openrouterModel: "vendor/eigen" })).toEqual({ patch: null });
  });

  test("Listen: OpenRouter {id,name}, Claude und Ollama Texte; Filter nach ID und Name", () => {
    const entries = modelHelpers.listEntries([{ id: "a/b", name: "Alpha" }, "qwen3:8b", { id: "c/d" }, { name: "ohne id" }, 5, "a/b"]);
    expect(entries).toEqual([{ id: "a/b", label: "Alpha (a/b)" }, { id: "qwen3:8b", label: "qwen3:8b" }, { id: "c/d", label: "c/d" }]);
    expect(modelHelpers.filterEntries(entries, "ALPHA").map((e: any) => e.id)).toEqual(["a/b"]);
    expect(modelHelpers.filterEntries(entries, " qwen ").map((e: any) => e.id)).toEqual(["qwen3:8b"]);
    expect(modelHelpers.filterEntries(entries, "")).toHaveLength(3);
  });
});

describe("Reiter „Modelle\"", () => {
  test("drei Abschnitte; „Standard (…)\" nennt Wert und Quelle, auch bei Aux und Fallback", async () => {
    const app = await openModels({ settings: { agents: { research: { model: "claude-sonnet-5" }, critic: { effort: "xhigh" } } } });
    expect(app.all().filter(n => n.tagName === "H3").map(n => n.textContent)).toEqual(["Standard für alle Agenten", "Nebenmodelle", "Fallback"]);
    expect(optionTexts(app, "settings-g-defaults-model")[0]).toBe("Standard (claude-opus-5-5, Voreinstellung)");
    expect(optionTexts(app, "settings-g-defaults-effort")[0]).toBe("Standard (high, Voreinstellung)");
    expect(optionValues(app, "settings-g-defaults-model")).toEqual([" standard", ...CLAUDE, " eigenes"]);
    expect(optionTexts(app, "settings-g-aux-judge-provider")).toEqual(["Standard (claude:claude-opus-5, Voreinstellung)", "Claude", "OpenRouter", "Ollama"]);
    expect(optionTexts(app, "settings-g-fallback-openrouterModel")[0]).toBe("Standard (minimax/minimax-m2.7, Voreinstellung)");
    expect(optionValues(app, "settings-g-fallback-ollamaModel")).toEqual([" standard", "qwen3:8b", "llama4:1b", " eigenes"]);
    // Agenten mit eigenen Werten werden genannt
    expect(app.texts("actions-hint").some(t => t === "Eigene Werte im Reiter Agenten behalten: Research (Modell), Critic (Effort).")).toBe(true);
    // Ohne Änderung ist Speichern gesperrt
    for (const s of ["defaults", "aux", "fallback"]) expect(app.byKey(`save:section-${s}`)!.disabled).toBe(true);
    expect(htmlWrites).toEqual([]);
  });

  test("Aux-Auswahl sendet anbieter:modell; nach Neuladen steht dasselbe wieder da (ollama:qwen3:8b)", async () => {
    const app = await openModels();
    app.choose("settings-g-aux-judge-provider", "ollama");
    await settle();
    // Nur die Ollama-Liste, ohne „Standard"
    expect(optionValues(app, "settings-g-aux-judge")).toEqual([" wählen", "qwen3:8b", "llama4:1b", " eigenes"]);
    app.click("save:section-aux");
    await settle();
    expect(patches(app)).toEqual([]);
    expect(app.texts("actions-error")).toEqual(["Bitte ein Modell wählen oder eingeben."]);
    app.choose("settings-g-aux-judge", "qwen3:8b");
    // Review: OpenRouter mit eigenem Modell
    app.choose("settings-g-aux-review-provider", "openrouter");
    await settle();
    app.choose("settings-g-aux-review", " eigenes");
    await settle();
    const custom = app.select("settings-g-aux-review-custom");
    custom.value = "  vendor/eigen  ";
    custom.dispatch("input");
    app.click("save:section-aux");
    await settle();
    expect(patches(app)).toEqual([{ aux: { judge: "ollama:qwen3:8b", review: "openrouter:vendor/eigen" } }]);
    expect(app.server.settings.aux).toEqual({ judge: "ollama:qwen3:8b", review: "openrouter:vendor/eigen" });
    expect(app.texts("settings-status")).toContain("Gespeichert.");

    // Neuladen: frische Seite mit dem gespeicherten Stand
    const again = await openModels({ settings: app.server.settings });
    expect(again.select("settings-g-aux-judge-provider").value).toBe("ollama");
    expect(again.select("settings-g-aux-judge").value).toBe("qwen3:8b");
    expect(again.select("settings-g-aux-review-provider").value).toBe("openrouter");
    expect(again.select("settings-g-aux-review").value).toBe(" eigenes");
    expect(again.select("settings-g-aux-review-custom").value).toBe("openrouter:vendor/eigen".slice("openrouter:".length));
  });

  test("Aux auf Standard sendet null; der geerbte Wert nennt .env als Quelle", async () => {
    ENV_LAYER.aux.judge = "openrouter:vendor/env-judge";
    try {
      const app = await openModels({ settings: { aux: { judge: "ollama:qwen3:8b" } } });
      expect(optionTexts(app, "settings-g-aux-judge-provider")[0]).toBe("Standard (openrouter:vendor/env-judge, .env)");
      app.choose("settings-g-aux-judge-provider", " standard");
      await settle();
      expect(app.select("settings-g-aux-judge")).toBeUndefined();
      app.click("save:section-aux");
      await settle();
      expect(patches(app)).toEqual([{ aux: { judge: null } }]);
      expect(app.server.settings).toEqual({});
      // Anbieter wie beim geerbten Wert: dessen Modell ist vorgewählt
      app.choose("settings-g-aux-judge-provider", "openrouter");
      await settle();
      expect(app.select("settings-g-aux-judge").value).toBe(" eigenes");
      expect(app.select("settings-g-aux-judge-custom").value).toBe("vendor/env-judge");
    } finally {
      delete ENV_LAYER.aux.judge;
    }
  });

  test("Fallback-Filter filtert ohne Serveranfrage; gewählter Eintrag bleibt; gespeichert wird die reine ID", async () => {
    const app = await openModels();
    const before = app.server.requests.length;
    const filter = app.byKey("g-filter:fallback.openrouterModel")!;
    expect(filter.attributes["type"]).toBe("search");
    expect(optionValues(app, "settings-g-fallback-openrouterModel")).toHaveLength(1 + 200 + 1);
    expect(app.texts("actions-hint")).toContain("302 Modelle in der Liste.");
    filter.value = "KIMI";
    filter.dispatch("input");
    expect(optionValues(app, "settings-g-fallback-openrouterModel")).toEqual([" standard", "moonshotai/kimi-k3", " eigenes"]);
    expect(optionTexts(app, "settings-g-fallback-openrouterModel")[1]).toBe("Kimi K3 (moonshotai/kimi-k3)");
    expect(app.texts("actions-hint")).toContain("1 Treffer.");
    app.choose("settings-g-fallback-openrouterModel", "moonshotai/kimi-k3");
    await settle();
    // Der Filter bleibt nach dem Neuzeichnen stehen, ein anderer Filter blendet den gewählten nicht aus
    const again = app.byKey("g-filter:fallback.openrouterModel")!;
    expect(again.value).toBe("KIMI");
    again.value = "vendor3/";
    again.dispatch("input");
    expect(optionValues(app, "settings-g-fallback-openrouterModel")[1]).toBe("moonshotai/kimi-k3");
    expect(app.select("settings-g-fallback-openrouterModel").value).toBe("moonshotai/kimi-k3");
    again.value = "gibt-es-nicht";
    again.dispatch("input");
    expect(app.texts("actions-hint")).toContain("Keine Treffer.");
    // Nur Tippen im Filter: keine einzige Anfrage an den Server
    expect(app.server.requests.length).toBe(before);
    app.click("save:section-fallback");
    await settle();
    expect(patches(app)).toEqual([{ fallback: { openrouterModel: "moonshotai/kimi-k3" } }]);
  });

  test("Nur offline: Aus speichert false, Standard entfernt (null); nach Neuladen ist Aus gewählt", async () => {
    ENV_LAYER.fallback.offlineOnly = true;
    try {
      const app = await openModels();
      const checked = (a: ReturnType<typeof setup>) => a.all().filter(n => n.attributes["role"] === "radio" && n.attributes["aria-checked"] === "true").map(n => n.textContent);
      expect(checked(app)).toEqual(["Standard"]);
      expect(app.texts("actions-hint").some(t => t.endsWith("Standard ist zurzeit an (.env)."))).toBe(true);
      app.click("g-offline:false");
      await settle();
      expect(checked(app)).toEqual(["Aus"]);
      app.click("save:section-fallback");
      await settle();
      expect(patches(app)).toEqual([{ fallback: { offlineOnly: false } }]);
      expect(app.server.settings.fallback).toEqual({ offlineOnly: false });
      const reloaded = await openModels({ settings: app.server.settings });
      expect(checked(reloaded)).toEqual(["Aus"]);
      // Pfeiltaste nach links: Standard; Speichern sendet null
      reloaded.byKey("g-offline:false")!.dispatch("keydown", { key: "ArrowLeft", preventDefault() {} });
      await settle();
      expect(checked(reloaded)).toEqual(["An"]);
      reloaded.click("g-offline: standard");
      await settle();
      reloaded.click("save:section-fallback");
      await settle();
      expect(patches(reloaded)).toEqual([{ fallback: { offlineOnly: null } }]);
      expect(reloaded.server.settings.fallback).toBeUndefined();
    } finally {
      delete ENV_LAYER.fallback.offlineOnly;
    }
  });

  test("Standardmodell und -Effort speichern und zurücksetzen; Effort-Standard folgt dem Modell", async () => {
    const app = await openModels({ codeEffort: m => (m.includes("sonnet") ? null : "high") });
    app.choose("settings-g-defaults-model", "claude-sonnet-5");
    await settle();
    expect(optionTexts(app, "settings-g-defaults-effort")[0]).toBe("Standard (richtet sich nach dem Modell)");
    app.choose("settings-g-defaults-effort", "low");
    app.click("save:section-defaults");
    await settle();
    expect(patches(app)).toEqual([{ defaults: { model: "claude-sonnet-5", effort: "low" } }]);
    // Wirkt bei allen Agenten ohne eigenen Wert
    expect(app.server.settings.defaults).toEqual({ model: "claude-sonnet-5", effort: "low" });
    expect(optionTexts(app, "settings-g-defaults-effort")[0]).toBe("Standard (Claude entscheidet)");
    app.choose("settings-g-defaults-model", " standard");
    app.choose("settings-g-defaults-effort", " standard");
    app.click("save:section-defaults");
    await settle();
    expect(patches(app).at(-1)).toEqual({ defaults: { model: null, effort: null } });
    expect(app.server.settings.defaults).toBeUndefined();
  });

  test("Listen nicht erreichbar: Hinweis je Anbieter bzw. insgesamt, eigenes Modell bleibt möglich", async () => {
    const app = await openModels({
      models: { claude: { models: CLAUDE, custom: true }, openrouter: { models: [], error: "OpenRouter ist nicht erreichbar" }, ollama: { models: [], error: "Ollama antwortet nicht (Zeitüberschreitung)" } },
    });
    expect(app.texts("actions-hint")).toContain("OpenRouter ist nicht erreichbar. Eigenes Modell bleibt möglich.");
    expect(app.texts("actions-hint")).toContain("Ollama antwortet nicht (Zeitüberschreitung). Eigenes Modell bleibt möglich.");
    expect(optionValues(app, "settings-g-fallback-openrouterModel")).toEqual([" standard", " eigenes"]);
    app.choose("settings-g-fallback-ollamaModel", " eigenes");
    await settle();
    const custom = app.select("settings-g-fallback-ollamaModel-custom");
    custom.value = "qwen3:32b";
    custom.dispatch("input");
    expect(app.byKey("save:section-fallback")!.disabled).toBe(false);
    custom.dispatch("keydown", { key: "Enter", preventDefault() {} });
    await settle();
    expect(patches(app)).toEqual([{ fallback: { ollamaModel: "qwen3:32b" } }]);

    const failed = setup({ hash: "#/einstellungen/modelle", modelsFail: true });
    await settle();
    expect(failed.byClass("settings-lists-failed").map(n => n.textContent)).toEqual(["Modelllisten konnten nicht geladen werden. Modellnamen lassen sich trotzdem eingeben."]);
    failed.choose("settings-g-aux-distill-provider", "claude");
    await settle();
    expect(optionValues(failed, "settings-g-aux-distill")).toEqual([" wählen", " eigenes"]);
  });

  test("Listen erst geladen, dann gescheitert (HTTP 500, Netzwerk): Hinweis sichtbar, alte Listen und eigenes Modell bleiben", async () => {
    const app = await openModels();
    const hint = () => app.byClass("settings-lists-failed").map(n => n.textContent);
    expect(hint()).toEqual([]);
    const reopenModels = async () => {
      await closeSettings(app);
      await reopenSettings(app);
      tabButton(app, "modelle").dispatch("click");
      await settle();
    };
    for (const fail of ["http", "offline"] as const) {
      if (fail === "http") app.server.modelsFails = true;
      else app.server.modelsOffline = true;
      await reopenModels();
      expect(hint()).toEqual(["Modelllisten konnten nicht geladen werden. Modellnamen lassen sich trotzdem eingeben."]);
      // Zwischengespeicherte Liste bleibt auswählbar
      expect(optionValues(app, "settings-g-fallback-ollamaModel")).toContain("llama4:1b");
      // Freitext bleibt nutzbar
      app.choose("settings-g-fallback-ollamaModel", " eigenes");
      await settle();
      const custom = app.select("settings-g-fallback-ollamaModel-custom");
      custom.value = "qwen3:32b-" + fail;
      custom.dispatch("input");
      app.click("save:section-fallback");
      await settle();
      expect(app.server.settings.fallback).toEqual({ ollamaModel: "qwen3:32b-" + fail });
      // Nächster Abruf klappt: Hinweis verschwindet
      app.server.modelsFails = false;
      app.server.modelsOffline = false;
      await reopenModels();
      expect(hint()).toEqual([]);
    }
  });

  test("Speicherfehler: Meldung, Eingaben bleiben; offline ebenso", async () => {
    const app = await openModels();
    app.choose("settings-g-fallback-ollamaModel", "llama4:1b");
    await settle();
    app.server.settingsPatch = { status: 400, body: { error: "Ungültige Einstellungen: fallback.ollamaModel (ungültiger Wert)" } };
    app.click("save:section-fallback");
    await settle();
    expect(app.texts("actions-error")).toEqual(["Ungültige Einstellungen: fallback.ollamaModel (ungültiger Wert)"]);
    expect(app.select("settings-g-fallback-ollamaModel").value).toBe("llama4:1b");
    app.server.settingsPatch = "offline";
    app.click("save:section-fallback");
    await settle();
    expect(app.texts("actions-error")).toEqual(["Server nicht erreichbar, nichts gespeichert."]);
    app.server.settingsPatch = null;
    app.click("save:section-fallback");
    await settle();
    expect(app.server.settings.fallback).toEqual({ ollamaModel: "llama4:1b" });
    expect(app.texts("actions-error")).toEqual([]);
  });

  test("erneutes Öffnen: unveränderte Felder folgen dem Server, ungespeicherte Eingaben bleiben", async () => {
    const app = await openModels();
    app.choose("settings-g-aux-distill-provider", "ollama");
    await settle();
    app.choose("settings-g-aux-distill", "llama4:1b");
    await settle();
    // Inzwischen anderswo gespeichert (anderer Browser)
    app.server.settings = { aux: { judge: "claude:claude-sonnet-5" }, fallback: { offlineOnly: true } };
    await closeSettings(app);
    await reopenSettings(app);
    tabButton(app, "modelle").dispatch("click");
    await settle();
    expect(app.select("settings-g-aux-judge-provider").value).toBe("claude");
    expect(app.select("settings-g-aux-judge").value).toBe("claude-sonnet-5");
    expect(app.select("settings-g-aux-distill-provider").value).toBe("ollama");
    expect(app.select("settings-g-aux-distill").value).toBe("llama4:1b");
    expect(app.byKey("g-offline:true")!.attributes["aria-checked"]).toBe("true");
    app.click("save:section-aux");
    await settle();
    expect(patches(app)).toEqual([{ aux: { distill: "ollama:llama4:1b" } }]);
    expect(app.server.settings.aux).toEqual({ judge: "claude:claude-sonnet-5", distill: "ollama:llama4:1b" });
  });

  test("veraltete Antwort: ein zurückgehaltenes GET setzt einen danach gespeicherten Wert nicht zurück", async () => {
    const app = await openModels();
    app.server.holdSettings.add("GET");
    await closeSettings(app);
    await reopenSettings(app);
    app.server.holdSettings.delete("GET");
    tabButton(app, "modelle").dispatch("click");
    await settle();
    app.choose("settings-g-fallback-ollamaModel", "llama4:1b");
    await settle();
    app.click("save:section-fallback");
    await settle();
    expect(app.server.settings.fallback).toEqual({ ollamaModel: "llama4:1b" });
    for (const r of app.server.settingsReleases.splice(0)) r.release();
    await settle();
    expect(app.select("settings-g-fallback-ollamaModel").value).toBe("llama4:1b");
    expect(app.byKey("save:section-fallback")!.disabled).toBe(true);
  });

  test("Modellnamen aus Listen und Datei nur als Text; ungültige Datei sperrt Speichern", async () => {
    const evil = "<img src=x onerror=alert(1)>";
    const app = await openModels({
      settings: { fallback: { openrouterModel: evil } },
      models: { claude: { models: CLAUDE, custom: true }, openrouter: { models: [{ id: "a/b", name: "<b>fett</b>" }] }, ollama: { models: [] } },
      fileInvalid: true,
    });
    expect(optionTexts(app, "settings-g-fallback-openrouterModel")).toContain("<b>fett</b> (a/b)");
    expect(app.select("settings-g-fallback-openrouterModel-custom").value).toBe(evil);
    expect(htmlWrites).toEqual([]);
    expect(app.elements["settings-notice"].hidden).toBe(false);
    app.choose("settings-g-fallback-openrouterModel", "a/b");
    await settle();
    expect(app.byKey("save:section-fallback")!.disabled).toBe(true);
  });
});

// --- Issue #39: Reiter „Status" --------------------------------------------------

const SECRET = "sk-or-v1-GEHEIM-9f3a";
function statusBody(overrides: Record<string, unknown> = {}) {
  return {
    version: { app: "2.12.0", commit: "abc1234" },
    startedAt: "2026-09-24T06:00:00.000Z",
    uptimeSeconds: 2 * 3600 + 17 * 60 + 5,
    supervisor: "launchd",
    storage: "supabase",
    sessions: { mode: "resume", stored: 4, resumable: 3 },
    running: { executions: 1, claudeCalls: 1 },
    restartRequested: false,
    keys: [
      { name: "ANTHROPIC_API_KEY", group: "Anthropic", set: true },
      // Falls der Server je mehr schickte: angezeigt wird nur gesetzt/fehlt
      { name: "OPENROUTER_API_KEY", group: "OpenRouter", set: true, value: SECRET, last4: "9f3a" },
      { name: "GEMINI_API_KEY", group: "Gemini", set: false },
    ],
    ...overrides,
  };
}

async function openStatus(options: Options = {}) {
  const app = setup({ hash: "#/einstellungen/status", status: statusBody(), ...options });
  await settle();
  return app;
}

/** Alle wartenden Timer einmal ausführen (Abfragen nach dem Neustart) */
async function runTimers(app: ReturnType<typeof setup>) {
  const pending = [...app.timers.values()];
  app.timers.clear();
  for (const fn of pending) fn();
  await settle();
}

const facts = (app: ReturnType<typeof setup>) => {
  const dl = app.all().find(n => n.tagName === "DL");
  if (!dl) return {};
  const out: Record<string, string> = {};
  for (let i = 0; i < dl.children.length; i += 2) out[dl.children[i].textContent] = dl.children[i + 1].textContent;
  return out;
};
const statusRequests = (app: ReturnType<typeof setup>) => app.requests("GET", "/api/status").length;
const restartPosts = (app: ReturnType<typeof setup>) => app.requests("POST", "/api/restart").length;

describe("Reiter „Status\"", () => {
  test("Hilfen: Laufzeit und Sessions in Worten, null als unbekannt", () => {
    expect(modelHelpers.formatUptime(30)).toBe("unter einer Minute");
    expect(modelHelpers.formatUptime(42 * 60)).toBe("42 Min");
    expect(modelHelpers.formatUptime(2 * 3600 + 17 * 60)).toBe("2 Std 17 Min");
    expect(modelHelpers.formatUptime(3 * 86400 + 4 * 3600)).toBe("3 Tage 4 Std");
    expect(modelHelpers.formatSessions(null)).toBe("unbekannt");
    expect(modelHelpers.formatSessions({ mode: "off", stored: 2, resumable: 0 })).toBe("Session-Modus aus (2 gespeichert)");
  });

  test("zeigt Version, Laufzeit, Supervisor, Speicher, Sessions und beide Zähler getrennt", async () => {
    const app = await openStatus();
    const f = facts(app);
    expect(f["Version"]).toBe("2.12.0 (abc1234)");
    expect(f["Laufzeit"].startsWith("2 Std 17 Min, seit ")).toBe(true);
    expect(f["Supervisor"]).toBe("launchd");
    expect(f["Speicher"]).toBe("Supabase");
    expect(f["Sessions"]).toBe("4 gespeichert, 3 fortsetzbar");
    // Nicht addiert: dieselbe Antwort steckt in beiden Zählern
    expect(f["Ausführungen (laufend und wartend)"]).toBe("1");
    expect(f["Claude-Aufrufe"]).toBe("1");
    expect(f["Neustart angefordert"]).toBe("nein");
    expect(Object.values(f)).not.toContain("2");
    expect(htmlWrites).toEqual([]);
  });

  test("null bei Sessions, Neustart-Marker und Supervisor heißt unbekannt bzw. keiner", async () => {
    const app = await openStatus({ status: statusBody({ sessions: null, restartRequested: null, supervisor: null, storage: "none", version: { app: "2.12.0", commit: null } }) });
    const f = facts(app);
    expect(f["Sessions"]).toBe("unbekannt");
    expect(f["Neustart angefordert"]).toBe("unbekannt");
    expect(f["Supervisor"]).toBe("keiner");
    expect(f["Speicher"]).toBe("keiner");
    expect(f["Version"]).toBe("2.12.0");
  });

  test("Schlüssel nur als Name und gesetzt/fehlt, nie Werte oder Teile davon", async () => {
    const app = await openStatus();
    const rows = app.byClass("settings-keys").flatMap(ul => ul.children).map((li: Node) => li.children.map((c: Node) => c.textContent).join(" = "));
    expect(rows).toEqual(["ANTHROPIC_API_KEY = gesetzt", "OPENROUTER_API_KEY = gesetzt", "GEMINI_API_KEY = fehlt"]);
    expect(app.texts("settings-group-label")).toEqual(["Anthropic", "OpenRouter", "Gemini"]);
    const everything = app.all().map(n => `${n.textContent}|${n.value}|${JSON.stringify(n.attributes)}`).join("\n");
    expect(everything).not.toContain(SECRET);
    expect(everything).not.toContain("9f3a");
  });

  test("Neustart erst nach Rückfrage: Abbrechen sendet nichts, Doppelklick nur eine Anfrage", async () => {
    const app = await openStatus();
    app.click("status-restart");
    await settle();
    expect(restartPosts(app)).toBe(0);
    expect(app.texts("actions-question")).toEqual(["tybo jetzt neu starten?"]);
    expect(app.byKey("status-restart-no")).toBeDefined();
    app.click("status-restart-no");
    await settle();
    expect(restartPosts(app)).toBe(0);
    expect(app.texts("actions-question")).toEqual([]);
    expect(app.byKey("status-restart")).toBeDefined();

    app.click("status-restart");
    await settle();
    const yes = app.byKey("status-restart-yes")!;
    yes.dispatch("click");
    yes.dispatch("click");
    await settle();
    expect(restartPosts(app)).toBe(1);
    expect(app.texts("settings-status")).toContain("Neustart nach der laufenden Antwort. Die Seite verbindet sich danach selbst neu.");
    expect(app.texts("actions-hint")).toContain("Neustart angefordert.");
    // Während gewartet wird, gibt es keinen zweiten Knopf
    expect(app.byKey("status-restart")).toBeUndefined();
  });

  for (const [label, status, body, expected] of [
    ["409 ohne Supervisor", 409, { error: "tybo läuft nicht unter launchd oder PM2. Bitte tybo manuell neu starten.", supervisor: null }, "tybo läuft nicht unter launchd oder PM2. Bitte tybo manuell neu starten."],
    ["500", 500, { error: "Neustart konnte nicht angefordert werden" }, "Neustart konnte nicht angefordert werden"],
    ["500 ohne Text", 500, null, "Neustart konnte nicht angefordert werden (Fehler 500)."],
  ] as const) {
    test(`${label}: Fehler statt Erfolg, keine Abfragen danach`, async () => {
      const app = await openStatus();
      app.server.restart = { status, body };
      app.click("status-restart");
      await settle();
      app.click("status-restart-yes");
      await settle();
      expect(restartPosts(app)).toBe(1);
      expect(app.texts("actions-error")).toEqual([expected]);
      expect(app.texts("settings-status")).not.toContain("Neustart nach der laufenden Antwort. Die Seite verbindet sich danach selbst neu.");
      const before = statusRequests(app);
      await runTimers(app);
      expect(statusRequests(app)).toBe(before);
      // Erneut versuchen geht, wieder nur mit Rückfrage
      expect(app.byKey("status-restart")).toBeDefined();
    });
  }

  test("Server nicht erreichbar beim Anfordern: Meldung, kein Erfolg", async () => {
    const app = await openStatus();
    app.server.restart = { status: 0, body: null };
    const original = app.server.requests;
    // fetch wirft für /api/restart: über statusOffline nicht abbildbar, daher eigener Fall
    (app.server as any).restartThrows = true;
    app.click("status-restart");
    await settle();
    app.click("status-restart-yes");
    await settle();
    expect(original.filter(r => r.path === "/api/restart")).toHaveLength(1);
    expect(app.texts("actions-error")).toEqual(["Server nicht erreichbar, kein Neustart angefordert."]);
  });

  test("nach dem Neustart: Ausfall, dann neuer Prozess; die Seite verbindet sich ohne offenes Gespräch neu", async () => {
    const app = await openStatus();
    expect(FakeEventSource.all.filter(s => s.url.includes("/api/conversations/"))).toHaveLength(0);
    app.click("status-restart");
    await settle();
    app.click("status-restart-yes");
    await settle();
    // Noch derselbe Prozess: weiter warten
    await runTimers(app);
    expect(app.texts("settings-status")).toContain("Neustart nach der laufenden Antwort. Die Seite verbindet sich danach selbst neu.");
    // Bot beendet sich: Abfragen scheitern
    app.server.statusOffline = true;
    await runTimers(app);
    expect(app.texts("settings-status")).toContain("Verbindung getrennt, tybo startet neu …");
    expect(app.texts("actions-error")).toEqual([]);
    // Neuer Prozess mit anderem Start und neuer Version
    app.server.statusOffline = false;
    app.server.status = statusBody({ startedAt: "2026-09-24T08:30:00.000Z", uptimeSeconds: 12, version: { app: "2.13.0", commit: "def5678" }, running: { executions: 0, claudeCalls: 0 } });
    await runTimers(app);
    expect(app.texts("settings-status")).toContain("tybo ist neu gestartet, die Seite ist wieder verbunden.");
    expect(facts(app)["Version"]).toBe("2.13.0 (def5678)");
    expect(facts(app)["Laufzeit"].startsWith("unter einer Minute")).toBe(true);
    // Fertig: keine weiteren Abfragen, Knopf wieder da
    const before = statusRequests(app);
    await runTimers(app);
    expect(statusRequests(app)).toBe(before);
    expect(app.byKey("status-restart")).toBeDefined();
    expect(FakeEventSource.all.filter(s => s.url.includes("/api/conversations/"))).toHaveLength(0);
  });

  test("Reiter verlassen stoppt die Abfragen; zurück auf Status erkennt den Neustart", async () => {
    const app = await openStatus();
    app.click("status-restart");
    await settle();
    app.click("status-restart-yes");
    await settle();
    tabButton(app, "agenten").dispatch("click");
    await settle();
    const before = statusRequests(app);
    await runTimers(app);
    expect(statusRequests(app)).toBe(before);
    app.server.status = statusBody({ startedAt: "2026-09-24T08:30:00.000Z" });
    tabButton(app, "status").dispatch("click");
    await settle();
    expect(app.texts("settings-status")).toContain("tybo ist neu gestartet, die Seite ist wieder verbunden.");
  });

  test("ohne erkannten Neustart hören die Abfragen nach 30 Minuten auf, mit Hinweis", async () => {
    const realNow = Date.now;
    let clock = realNow();
    Date.now = () => clock;
    try {
      const app = await openStatus();
      app.click("status-restart");
      await settle();
      app.click("status-restart-yes");
      await settle();
      clock += 31 * 60_000;
      await runTimers(app);
      expect(app.texts("settings-status")).toContain('Noch kein Neustart erkannt. Vermutlich läuft noch eine Antwort. Mit „Aktualisieren" lässt sich später nachsehen.');
      const before = statusRequests(app);
      await runTimers(app);
      expect(statusRequests(app)).toBe(before);
      // „Aktualisieren" erkennt den Neustart später trotzdem
      app.server.status = statusBody({ startedAt: "2026-09-24T09:00:00.000Z" });
      app.click("status-refresh");
      await settle();
      expect(app.texts("settings-status")).toContain("tybo ist neu gestartet, die Seite ist wieder verbunden.");
    } finally {
      Date.now = realNow;
    }
  });

  test("Status nicht ladbar: Meldung und „Aktualisieren\"; kein Neustart-Knopf ohne Stand", async () => {
    const app = setup({ hash: "#/einstellungen/status" });
    await settle();
    expect(app.texts("actions-error")).toEqual(["kein Status"]);
    expect(app.byKey("status-restart")).toBeUndefined();
    app.server.status = statusBody();
    app.click("status-refresh");
    await settle();
    expect(facts(app)["Version"]).toBe("2.12.0 (abc1234)");
  });
});

describe("Neu laden mit ungespeicherten Einstellungen (Issue #111)", () => {
  const note = (app: ReturnType<typeof setup>) => app.elements["settings-update-note"];
  const press = (app: ReturnType<typeof setup>, label: string) =>
    note(app).children[1].children.find((b: Node) => b.textContent === label)!.dispatch("click");

  test("Hinweis in den Einstellungen; geändertes Modell fragt nach, gespeichert lädt sofort", async () => {
    const app = setup({ hash: "#/einstellungen/agenten", newVersion: true });
    await settle();
    app.visible();
    await settle();
    expect(note(app).children[0].textContent).toBe("Neue Version von tybo verfügbar");
    await openAgent(app, "research");
    app.choose("settings-model-research", helpers.MODEL_DEFAULT);
    press(app, "Neu laden");
    expect(app.reloads()).toBe(0);
    expect(note(app).children[0].textContent).toBe("Ungespeicherte Einstellungen gehen verloren. Trotzdem neu laden?");
    press(app, "Abbrechen");
    app.click("save:research");
    await settle();
    press(app, "Neu laden");
    expect(app.reloads()).toBe(1);
  });

  test("offener Editor für Anweisungen mit Text zählt als ungespeichert", async () => {
    const app = setup({ hash: "#/einstellungen/agenten", newVersion: true });
    await settle();
    app.visible();
    await settle();
    await openAgent(app, "research");
    const area = app.byKey("inst-text:research")!;
    area.value = "antworte kürzer";
    area.dispatch("input");
    press(app, "Neu laden");
    expect(app.reloads()).toBe(0);
    expect(note(app).children[0].textContent).toContain("Ungespeicherte Einstellungen");
  });
});
