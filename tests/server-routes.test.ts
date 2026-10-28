/**
 * Issue #351, Checkbox 1: Wege im Server-Profil (src/app/server-routes.ts).
 * /health mit Revision, /deploy mit GitHub-Signatur und /webhook/elevenlabs
 * mit ElevenLabs-Signatur, jeweils über echtes HTTP-Verhalten (Request rein,
 * Response raus). Das Deploy-Skript ist ersetzt; für die Doppelzustellung
 * läuft der echte Anrufdienst mit dauerhafter Anrufliste im Testordner, nur
 * Anbieter, Aux-Modell und Zustellung sind Attrappen. Kein Netz, src/bot.ts
 * wird nie importiert.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHmac } from "crypto";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createServerRoutes, deployRef, SERVER_BODY_LIMIT, UNKNOWN_REVISION, type DeployRun, type ServerRoutesDeps } from "../src/app/server-routes";
import { setChoicesFileForTests, type ChoiceConversation } from "../src/lib/choices";
import { createPhoneLedger, type PhoneLedger } from "../src/lib/phone/ledger";
import type { PhoneCaller, TranscriptLine, TranscriptResult } from "../src/lib/phone/provider";
import { createPhoneService, PHONE_TEXT, WAIT_MS, type PhoneService, type TranscriptDelivery } from "../src/lib/phone/service";

const DEPLOY_SECRET = "deploy-secret-fuer-tests";
const EL_SECRET = "elevenlabs-secret-fuer-tests";
const NOW = 1_800_000_000_000;
const ROOT = "/srv/tybo";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "server-routes-"));
  setChoicesFileForTests(join(dir, "choices.json"));
});
afterEach(() => {
  setChoicesFileForTests(null);
  rmSync(dir, { recursive: true, force: true });
});

function routesWith(env: Record<string, string>, extra: Partial<ServerRoutesDeps> = {}) {
  const deploys: string[] = [];
  const received: { conversationId: string; lines: TranscriptLine[] }[] = [];
  const logs: string[] = [];
  let finish: () => void = () => {};
  const routes = createServerRoutes({
    env,
    root: ROOT,
    transcripts: () => ({
      receiveTranscript: async (conversationId, lines) => (received.push({ conversationId, lines }), "accepted"),
    }),
    startDeploy: (script): DeployRun => {
      deploys.push(script);
      return { started: Promise.resolve(), done: new Promise<void>(resolve => (finish = resolve)) };
    },
    now: () => NOW,
    log: line => logs.push(line),
    ...extra,
  });
  const call = async (request: Request) => {
    const pending = routes(request);
    if (!pending) throw new Error("Pfad nicht bedient");
    const response = await pending;
    return { status: response.status, headers: response.headers, body: (await response.json()) as Record<string, any> };
  };
  return { routes, call, deploys, received, logs, finishDeploy: () => finish() };
}

const URL_BASE = "http://127.0.0.1:3080";

// ---------------------------------------------------------------------------
// /health
// ---------------------------------------------------------------------------

describe("/health", () => {
  test("GET: status ok und Revision aus RELEASE_REVISION, keine Session oder PID", async () => {
    const { call } = routesWith({ RELEASE_REVISION: "abc123" });
    const { status, body } = await call(new Request(`${URL_BASE}/health`));
    expect(status).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.revision).toBe("abc123");
    expect(body.profile).toBe("server");
    expect(body.timestamp).toBe(new Date(NOW).toISOString());
    for (const key of ["sessionId", "sessionEngine", "pid", "uptime"]) expect(body).not.toHaveProperty(key);
  });

  test("ohne RELEASE_REVISION: der dokumentierte Ersatz working-tree", async () => {
    for (const env of [{}, { RELEASE_REVISION: "  " }]) {
      const { body } = await routesWith(env).call(new Request(`${URL_BASE}/health`));
      expect(body.revision).toBe(UNKNOWN_REVISION);
      expect(UNKNOWN_REVISION).toBe("working-tree");
    }
  });

  test("falsche Methode: 405 mit Allow", async () => {
    const { status, headers } = await routesWith({}).call(new Request(`${URL_BASE}/health`, { method: "POST", body: "{}" }));
    expect(status).toBe(405);
    expect(headers.get("allow")).toContain("GET");
  });

  test("fremde Pfade bedient das Modul nicht (null), auch nicht /process", () => {
    const { routes } = routesWith({ DEPLOY_SECRET, ELEVENLABS_WEBHOOK_SECRET: EL_SECRET });
    for (const path of ["/", "/process", "/telegram", "/deploy/x", "/webhook", "/context"]) {
      expect(routes(new Request(`${URL_BASE}${path}`, { method: "POST", body: "{}" }))).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// /deploy
// ---------------------------------------------------------------------------

const githubSignature = (body: string, secret = DEPLOY_SECRET) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

function push(body: string, headers: Record<string, string | null> = {}): Request {
  const all: Record<string, string> = {};
  const merged = { "x-github-event": "push", "x-hub-signature-256": githubSignature(body), "content-type": "application/json", ...headers };
  for (const [key, value] of Object.entries(merged)) if (value !== null) all[key] = value;
  return new Request(`${URL_BASE}/deploy`, { method: "POST", body, headers: all });
}

const MASTER_PUSH = JSON.stringify({ ref: "refs/heads/master", after: "abc123" });

describe("/deploy", () => {
  test("gültige Signatur, Push auf den Standard-Branch: Skript startet, 202", async () => {
    const { call, deploys } = routesWith({ DEPLOY_SECRET });
    const { status, body } = await call(push(MASTER_PUSH));
    expect(status).toBe(202);
    expect(body.ok).toBe(true);
    expect(deploys).toEqual([join(ROOT, "deploy.sh")]);
  });

  test("DEPLOY_SCRIPT ersetzt das Standard-Skript", async () => {
    const { call, deploys } = routesWith({ DEPLOY_SECRET, DEPLOY_SCRIPT: "/opt/deploy-eigen.sh" });
    expect((await call(push(MASTER_PUSH))).status).toBe(202);
    expect(deploys).toEqual(["/opt/deploy-eigen.sh"]);
  });

  test("fehlende, falsche und fremde Signatur: 401, nichts gestartet", async () => {
    const { call, deploys, logs } = routesWith({ DEPLOY_SECRET });
    expect((await call(push(MASTER_PUSH, { "x-hub-signature-256": null }))).status).toBe(401);
    expect((await call(push(MASTER_PUSH, { "x-hub-signature-256": "sha256=00" }))).status).toBe(401);
    expect((await call(push(MASTER_PUSH, { "x-hub-signature-256": githubSignature(MASTER_PUSH, "anderes-secret") }))).status).toBe(401);
    // ohne Präfix sha256= gilt die Signatur nicht
    const bare = githubSignature(MASTER_PUSH).slice("sha256=".length);
    expect((await call(push(MASTER_PUSH, { "x-hub-signature-256": bare }))).status).toBe(401);
    expect(deploys).toEqual([]);
    expect(logs.join("\n")).not.toContain(DEPLOY_SECRET);
  });

  test("veränderter Rohbody bei unveränderter Signatur: 401", async () => {
    const { call, deploys } = routesWith({ DEPLOY_SECRET });
    const signature = githubSignature(MASTER_PUSH);
    const altered = MASTER_PUSH.replace("abc123", "abc124");
    expect((await call(push(altered, { "x-hub-signature-256": signature }))).status).toBe(401);
    // Auch nur ein zusätzliches Leerzeichen reicht
    expect((await call(push(`${MASTER_PUSH} `, { "x-hub-signature-256": signature }))).status).toBe(401);
    expect(deploys).toEqual([]);
  });

  test("ohne DEPLOY_SECRET: 503, auch mit sonst gültiger Anfrage, nichts gestartet", async () => {
    for (const env of [{}, { DEPLOY_SECRET: "   " }]) {
      const { call, deploys } = routesWith(env);
      expect((await call(push(MASTER_PUSH, { "x-hub-signature-256": githubSignature(MASTER_PUSH, "") }))).status).toBe(503);
      expect(deploys).toEqual([]);
    }
  });

  test("ungültiges JSON mit gültiger Signatur: 400", async () => {
    const { call, deploys } = routesWith({ DEPLOY_SECRET });
    for (const body of ["{kaputt", "[]", JSON.stringify({ after: "abc" }), JSON.stringify({ ref: 7 })]) {
      expect((await call(push(body))).status).toBe(400);
    }
    expect(deploys).toEqual([]);
  });

  test("Größenlimit: zu großer Body 413, vor der Signaturprüfung", async () => {
    const { call, deploys } = routesWith({ DEPLOY_SECRET });
    const huge = JSON.stringify({ ref: "refs/heads/master", pad: "x".repeat(SERVER_BODY_LIMIT) });
    expect((await call(push(huge))).status).toBe(413);
    expect(deploys).toEqual([]);
  });

  test("falsche Methode: 405 mit Allow POST", async () => {
    const { status, headers } = await routesWith({ DEPLOY_SECRET }).call(new Request(`${URL_BASE}/deploy`));
    expect(status).toBe(405);
    expect(headers.get("allow")).toBe("POST");
  });

  test("nur Push-Ereignisse: ping und andere Ereignisse lösen nichts aus", async () => {
    const { call, deploys } = routesWith({ DEPLOY_SECRET });
    const ping = await call(push(JSON.stringify({ zen: "Keep it simple." }), { "x-github-event": "ping" }));
    expect(ping.status).toBe(200);
    expect(ping.body.skipped).toBe("ping");
    expect((await call(push(MASTER_PUSH, { "x-github-event": "pull_request" }))).body.skipped).toBe("kein Push-Ereignis");
    expect((await call(push(MASTER_PUSH, { "x-github-event": null }))).body.skipped).toBe("kein Push-Ereignis");
    expect(deploys).toEqual([]);
  });

  test("anderer Branch und gelöschter Branch: übersprungen", async () => {
    const { call, deploys } = routesWith({ DEPLOY_SECRET });
    const other = await call(push(JSON.stringify({ ref: "refs/heads/feature" })));
    expect(other.status).toBe(200);
    expect(other.body.skipped).toContain("refs/heads/master");
    expect((await call(push(JSON.stringify({ ref: "refs/tags/master" })))).body.skipped).toBeDefined();
    expect((await call(push(JSON.stringify({ ref: "refs/heads/master", deleted: true })))).body.skipped).toBe("Branch gelöscht");
    expect(deploys).toEqual([]);
  });

  test("DEPLOY_BRANCH mit und ohne refs/heads/", async () => {
    expect(deployRef(undefined)).toBe("refs/heads/master");
    expect(deployRef("")).toBe("refs/heads/master");
    expect(deployRef("main")).toBe("refs/heads/main");
    expect(deployRef(" refs/heads/main ")).toBe("refs/heads/main");
    for (const branch of ["main", "refs/heads/main"]) {
      const { call, deploys } = routesWith({ DEPLOY_SECRET, DEPLOY_BRANCH: branch });
      expect((await call(push(JSON.stringify({ ref: "refs/heads/master" })))).status).toBe(200);
      expect((await call(push(JSON.stringify({ ref: "refs/heads/main" })))).status).toBe(202);
      expect(deploys).toHaveLength(1);
    }
  });

  test("höchstens ein Deploy zur Zeit; nach dem Ende wieder möglich", async () => {
    const { call, deploys, finishDeploy } = routesWith({ DEPLOY_SECRET });
    expect((await call(push(MASTER_PUSH))).status).toBe(202);
    expect((await call(push(MASTER_PUSH))).status).toBe(409);
    finishDeploy();
    await Bun.sleep(0);
    expect((await call(push(MASTER_PUSH))).status).toBe(202);
    expect(deploys).toHaveLength(2);
  });

  test("Skript startet nicht: 500, danach wieder möglich", async () => {
    let fail = true;
    const started: string[] = [];
    const { call } = routesWith(
      { DEPLOY_SECRET },
      {
        startDeploy: script => {
          if (fail) throw new Error("bash fehlt");
          started.push(script);
          return { started: Promise.resolve(), done: new Promise(() => {}) };
        },
      },
    );
    expect((await call(push(MASTER_PUSH))).status).toBe(500);
    fail = false;
    expect((await call(push(MASTER_PUSH))).status).toBe(202);
    expect(started).toHaveLength(1);
  });

  test("Startfehler als späteres error-Ereignis: 500 statt 202, Fehler im Log, danach wieder möglich", async () => {
    let fail = true;
    let attempts = 0;
    const { call, logs } = routesWith(
      { DEPLOY_SECRET },
      {
        startDeploy: () => {
          attempts++;
          if (!fail) return { started: Promise.resolve(), done: new Promise(() => {}) };
          // Wie child_process: spawn kehrt zurück, der Fehler kommt erst danach
          const started = new Promise<void>((_, reject) => setTimeout(() => reject(new Error("spawn bash ENOENT")), 5));
          return { started, done: started.catch(() => {}) };
        },
      },
    );
    const first = await call(push(MASTER_PUSH));
    expect(first.status).toBe(500);
    expect(first.body).toEqual({ ok: false, error: "Deploy nicht gestartet" });
    expect(logs.some(line => line.includes("Skript nicht gestartet") && line.includes("ENOENT"))).toBe(true);
    expect(logs.some(line => line.includes("Deploy gestartet"))).toBe(false);
    fail = false;
    expect((await call(push(MASTER_PUSH))).status).toBe(202);
    expect(attempts).toBe(2);
  });

  test("Standard-Start mit fehlendem Arbeitsordner: echtes error-Ereignis wird 500, nichts läuft", async () => {
    const logs: string[] = [];
    const routes = createServerRoutes({
      env: { DEPLOY_SECRET, DEPLOY_SCRIPT: join(dir, "deploy.sh") },
      root: join(dir, "gibt-es-nicht"),
      transcripts: () => null,
      log: line => logs.push(line),
    });
    const response = await routes(push(MASTER_PUSH))!;
    expect(response.status).toBe(500);
    expect(logs.some(line => line.includes("Skript nicht gestartet"))).toBe(true);
    // Belegung aufgehoben: der nächste Push scheitert wieder am Start, nicht mit 409
    expect((await routes(push(MASTER_PUSH))!).status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// /webhook/elevenlabs
// ---------------------------------------------------------------------------

function elevenSignature(body: string, at = NOW, secret = EL_SECRET): string {
  const t = Math.floor(at / 1000);
  return `t=${t},v0=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;
}

function postCall(body: string, signature: string | null = elevenSignature(body), method = "POST"): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (signature !== null) headers["elevenlabs-signature"] = signature;
  return new Request(`${URL_BASE}/webhook/elevenlabs`, { method, headers, ...(method === "GET" ? {} : { body }) });
}

const transcriptEvent = (conversationId = "conv-1", transcript: unknown[] = [
  { role: "agent", message: "Hallo Alex, hier ist Mia." },
  { role: "user", message: "Bitte bereite die Folien für Freitag vor." },
  { role: "agent", message: null },
]) => JSON.stringify({ type: "post_call_transcription", event_timestamp: NOW / 1000, data: { agent_id: "agent-1", conversation_id: conversationId, status: "done", transcript } });

describe("/webhook/elevenlabs", () => {
  const env = { ELEVENLABS_WEBHOOK_SECRET: EL_SECRET };

  test("gültige Signatur: Protokoll geht als Zeilen an den Anrufdienst, 200", async () => {
    const { call, received } = routesWith(env);
    const { status, body } = await call(postCall(transcriptEvent()));
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(received).toEqual([
      {
        conversationId: "conv-1",
        lines: [
          { speaker: "agent", text: "Hallo Alex, hier ist Mia." },
          { speaker: "user", text: "Bitte bereite die Folien für Freitag vor." },
        ],
      },
    ]);
  });

  test("fehlende, falsche und fremde Signatur: 401, nichts übergeben", async () => {
    const { call, received } = routesWith(env);
    const body = transcriptEvent();
    expect((await call(postCall(body, null))).status).toBe(401);
    expect((await call(postCall(body, "t=1,v0=00"))).status).toBe(401);
    expect((await call(postCall(body, elevenSignature(body, NOW, "anderes-secret")))).status).toBe(401);
    expect((await call(postCall(body, elevenSignature(body).replace(/^t=\d+,/, "")))).status).toBe(401);
    expect(received).toEqual([]);
  });

  test("veränderter Rohbody: 401", async () => {
    const { call, received } = routesWith(env);
    const body = transcriptEvent();
    const signature = elevenSignature(body);
    expect((await call(postCall(body.replace("Freitag", "Samstag"), signature))).status).toBe(401);
    expect((await call(postCall(`${body}\n`, signature))).status).toBe(401);
    expect(received).toEqual([]);
  });

  test("abgelaufener und zu weit vorausliegender Zeitstempel: 401; innerhalb von 5 Minuten gilt er", async () => {
    const { call, received } = routesWith(env);
    const body = transcriptEvent();
    expect((await call(postCall(body, elevenSignature(body, NOW - 301_000)))).status).toBe(401);
    expect((await call(postCall(body, elevenSignature(body, NOW + 301_000)))).status).toBe(401);
    expect(received).toEqual([]);
    expect((await call(postCall(body, elevenSignature(body, NOW - 299_000)))).status).toBe(200);
    expect(received).toHaveLength(1);
  });

  test("ohne ELEVENLABS_WEBHOOK_SECRET: 503, nichts übergeben", async () => {
    const { call, received } = routesWith({});
    const body = transcriptEvent();
    expect((await call(postCall(body, elevenSignature(body, NOW, "")))).status).toBe(503);
    expect(received).toEqual([]);
  });

  test("ungültiges JSON und unvollständiges Protokoll mit gültiger Signatur: 400", async () => {
    const { call, received } = routesWith(env);
    const broken = [
      "{kaputt",
      "[]",
      JSON.stringify({ type: "post_call_transcription" }),
      JSON.stringify({ type: "post_call_transcription", data: { conversation_id: "", transcript: [] } }),
      JSON.stringify({ type: "post_call_transcription", data: { conversation_id: "conv-1" } }),
      JSON.stringify({ type: "post_call_transcription", data: { conversation_id: "conv-1", transcript: ["text"] } }),
    ];
    for (const body of broken) expect((await call(postCall(body))).status).toBe(400);
    expect(received).toEqual([]);
  });

  test("Größenlimit: 413", async () => {
    const { call, received } = routesWith(env);
    const body = transcriptEvent("conv-1", [{ role: "user", message: "x".repeat(SERVER_BODY_LIMIT) }]);
    expect((await call(postCall(body))).status).toBe(413);
    expect(received).toEqual([]);
  });

  test("falsche Methode: 405", async () => {
    const { status, headers } = await routesWith(env).call(postCall("", null, "GET"));
    expect(status).toBe(405);
    expect(headers.get("allow")).toBe("POST");
  });

  test("andere Ereignisse: 200 ohne Übergabe", async () => {
    const { call, received } = routesWith(env);
    const audio = JSON.stringify({ type: "post_call_audio", data: { conversation_id: "conv-1", full_audio: "AAAA" } });
    expect((await call(postCall(audio))).body.skipped).toBe("anderes Ereignis");
    expect(received).toEqual([]);
  });

  test("Anrufdienst wirft: 500, damit ElevenLabs erneut zustellt; fehlt er: 503", async () => {
    const failing = routesWith(env, { transcripts: () => ({ receiveTranscript: async () => Promise.reject(new Error("Aux down")) }) });
    expect((await failing.call(postCall(transcriptEvent()))).status).toBe(500);
    const missing = routesWith(env, { transcripts: () => null });
    expect((await missing.call(postCall(transcriptEvent()))).status).toBe(503);
  });

  test("schon bearbeitet und unbekannter Anruf: 200 mit Hinweis", async () => {
    for (const [outcome, skipped] of [["known", "schon bearbeitet"], ["unknown", "unbekannter Anruf"]] as const) {
      const { call } = routesWith(env, { transcripts: () => ({ receiveTranscript: async (): Promise<TranscriptDelivery> => outcome }) });
      const { status, body } = await call(postCall(transcriptEvent()));
      expect(status).toBe(200);
      expect(body.skipped).toBe(skipped);
    }
  });
});

// ---------------------------------------------------------------------------
// Doppelzustellung mit dem echten Anrufdienst
// ---------------------------------------------------------------------------

const TOPIC: ChoiceConversation = { type: "telegram", chatId: "4711", topicId: 42 };
const DM: ChoiceConversation = { type: "telegram", chatId: "4711" };

interface PhoneHarness {
  service: PhoneService;
  ledger: PhoneLedger;
  notes: string[];
  /** Gespräch je Meldung, gleiche Reihenfolge wie notes */
  targets: ChoiceConversation[];
  summaries: string[];
  /** Abfrage beim Anbieter: Ergebnis je Aufruf, Standard noch laufend; wait hält sie an */
  poll: { result: TranscriptResult; wait: Promise<void> | null; calls: number };
  /** Zusammenfassung wartet, bis gate erfüllt ist (null: sofort) */
  gate: { wait: Promise<void> | null; fail: boolean };
  /** Uhr des Dienstes; null: echte Zeit */
  clock: { at: number | null };
  /** Wartezeiten des Dienstes: held hält sie an, next gibt die wartenden frei, release alle und hebt held auf */
  pause: { held: boolean; waiting(): number; next(): void; release(): void };
}

function phoneHarness(ledgerPath: string, options: { inbound?: boolean } = {}): PhoneHarness {
  const waiters: (() => void)[] = [];
  const pause = {
    held: false,
    waiting: () => waiters.length,
    next: () => {
      for (const resume of waiters.splice(0)) resume();
    },
    release: () => {
      pause.held = false;
      pause.next();
    },
  };
  const h = {
    notes: [],
    targets: [],
    summaries: [],
    poll: { result: { state: "pending", reason: "läuft" }, wait: null, calls: 0 },
    gate: { wait: null, fail: false },
    clock: { at: null },
    pause,
  } as unknown as PhoneHarness;
  const caller: PhoneCaller = {
    missing: () => [],
    dial: async () => ({ ok: true, conversationId: "conv-1" }),
    transcript: async () => {
      h.poll.calls++;
      if (h.poll.wait) await h.poll.wait;
      return h.poll.result;
    },
  };
  h.ledger = createPhoneLedger(ledgerPath);
  h.service = createPhoneService({
    caller,
    ledger: h.ledger,
    summarize: async transcript => {
      h.summaries.push(transcript);
      if (h.gate.wait) await h.gate.wait;
      if (h.gate.fail) throw new Error("Aux-Modell nicht erreichbar");
      return "Folien für Freitag besprochen.";
    },
    findTask: async () => null,
    notify: async (conversation, text) => (h.notes.push(text), h.targets.push(conversation), "delivered"),
    ask: async () => {
      throw new Error("keine Rückfrage erwartet");
    },
    runTask: async () => {},
    ...(options.inbound ? { inbound: () => ({ conversation: DM, userName: "Alex" }) } : {}),
    agentName: () => "Mia",
    now: () => h.clock.at ?? Date.now(),
    sleep: () => (pause.held ? new Promise<void>(resolve => waiters.push(resolve)) : Bun.sleep(2)),
    pollMs: 2,
    log: () => {},
  });
  return h;
}

const summaryNotes = (h: PhoneHarness) => h.notes.filter(note => note === PHONE_TEXT.summary("Folien für Freitag besprochen."));

function routesFor(h: PhoneHarness) {
  return createServerRoutes({ env: { ELEVENLABS_WEBHOOK_SECRET: EL_SECRET }, root: ROOT, transcripts: () => h.service, log: () => {} });
}

async function deliver(routes: ReturnType<typeof createServerRoutes>, body = transcriptEvent()) {
  const response = await routes(postCall(body, elevenSignature(body, Date.now())))!;
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

async function waitUntil(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 1000 && !condition(); i++) await Bun.sleep(2);
  expect(condition()).toBe(true);
}

/** Anruf von tybo, dessen Abfrage im ersten Warten angehalten ist (Uhr bei NOW) */
async function heldCall(h: PhoneHarness): Promise<string> {
  h.clock.at = NOW;
  h.pause.held = true;
  const { ref } = await h.service.startCall({ reason: "Folien", conversation: TOPIC, userName: "Alex" });
  await waitUntil(() => h.pause.waiting() > 0);
  return ref!;
}

describe("Doppelzustellung (Anrufdienst und Anrufliste)", () => {
  test("Webhook bringt das Protokoll: Zusammenfassung im Gespräch des Anrufs, genau einmal", async () => {
    const h = phoneHarness(join(dir, "data", "phone-calls.json"));
    await h.service.startCall({ reason: "Folien", conversation: TOPIC, userName: "Alex" });
    const first = await deliver(routesFor(h));
    expect(first).toEqual({ status: 200, body: { ok: true } });
    await h.service.idle();
    expect(summaryNotes(h)).toHaveLength(1);
    expect(h.summaries[0]).toContain("Alex: Bitte bereite die Folien für Freitag vor.");
    const again = await deliver(routesFor(h));
    expect(again.body.skipped).toBe("schon bearbeitet");
    await h.service.idle();
    expect(summaryNotes(h)).toHaveLength(1);
    h.service.stop();
  });

  test("parallele Zustellungen: ein Aux-Aufruf, eine Zusammenfassung", async () => {
    const h = phoneHarness(join(dir, "data", "phone-calls.json"));
    await h.service.startCall({ reason: "Folien", conversation: TOPIC, userName: "Alex" });
    let open!: () => void;
    h.gate.wait = new Promise(resolve => (open = resolve));
    const routes = routesFor(h);
    const pending = [deliver(routes), deliver(routes), deliver(routes)];
    await Bun.sleep(5);
    open();
    const results = await Promise.all(pending);
    expect(results.map(r => r.status)).toEqual([200, 200, 200]);
    expect(results.filter(r => r.body.skipped === undefined)).toHaveLength(1);
    await h.service.idle();
    expect(h.summaries).toHaveLength(1);
    expect(summaryNotes(h)).toHaveLength(1);
    h.service.stop();
  });

  test("nach einem Neustart: dieselbe Zustellung findet den Anruf bearbeitet", async () => {
    const path = join(dir, "data", "phone-calls.json");
    const before = phoneHarness(path);
    await before.service.startCall({ reason: "Folien", conversation: TOPIC, userName: "Alex" });
    expect((await deliver(routesFor(before))).body).toEqual({ ok: true });
    await before.service.idle();
    before.service.stop();

    const after = phoneHarness(path);
    after.service.resume();
    const replay = await deliver(routesFor(after));
    expect(replay.status).toBe(200);
    expect(replay.body.skipped).toBe("schon bearbeitet");
    await after.service.idle();
    expect(after.summaries).toEqual([]);
    expect(summaryNotes(after)).toEqual([]);
    after.service.stop();
  });

  test("Abfrage und Webhook gleichzeitig: genau eine Zusammenfassung im Gespräch", async () => {
    const h = phoneHarness(join(dir, "data", "phone-calls.json"));
    let open!: () => void;
    h.gate.wait = new Promise(resolve => (open = resolve));
    await h.service.startCall({ reason: "Folien", conversation: TOPIC, userName: "Alex" });
    // Die Abfrage findet das fertige Protokoll und fasst zusammen, der Webhook auch
    h.poll.result = { state: "done", lines: [{ speaker: "user", text: "Bitte bereite die Folien für Freitag vor." }] };
    await Bun.sleep(10);
    const hook = deliver(routesFor(h));
    await Bun.sleep(5);
    open();
    expect((await hook).status).toBe(200);
    await h.service.idle();
    expect(summaryNotes(h)).toHaveLength(1);
    h.service.stop();
  });

  test("Fehler beim Zusammenfassen sperrt nichts: 500, Protokoll bleibt im Eintrag, der nächste Versuch wird übernommen", async () => {
    const h = phoneHarness(join(dir, "data", "phone-calls.json"));
    const ref = await heldCall(h);
    h.gate.fail = true;
    const routes = routesFor(h);
    expect((await deliver(routes)).status).toBe(500);
    expect(h.ledger.get(ref)).toMatchObject({ stage: "received", transcript: expect.stringContaining("Alex: Bitte bereite die Folien") });
    expect(summaryNotes(h)).toEqual([]);
    h.gate.fail = false;
    expect(await deliver(routes)).toEqual({ status: 200, body: { ok: true } });
    h.pause.release();
    await h.service.idle();
    expect(summaryNotes(h)).toHaveLength(1);
    h.service.stop();
  });

  test("Frist läuft ab, während der Webhook zusammenfasst: keine Zeitablauf-Meldung, Zusammenfassung kommt", async () => {
    const h = phoneHarness(join(dir, "data", "phone-calls.json"));
    const ref = await heldCall(h);
    let open!: () => void;
    h.gate.wait = new Promise(resolve => (open = resolve));
    const hook = deliver(routesFor(h));
    await waitUntil(() => h.summaries.length === 1);
    // Frist der Abholung vorbei, die Abfrage läuft weiter
    h.clock.at = NOW + WAIT_MS + 1;
    h.pause.release();
    await Bun.sleep(20);
    expect(h.ledger.get(ref)?.stage).toBe("received");
    expect(h.notes).toEqual([]);
    open();
    expect(await hook).toEqual({ status: 200, body: { ok: true } });
    await h.service.idle();
    expect(h.summaries).toHaveLength(1);
    expect(summaryNotes(h)).toHaveLength(1);
    expect(h.notes).not.toContain(PHONE_TEXT.timeout);
    expect(h.ledger.get(ref)?.stage).toBe("closed");
    h.service.stop();
  });

  test("Anbieterfehler, während der Webhook zusammenfasst: keine Fehlermeldung, Zusammenfassung kommt", async () => {
    const h = phoneHarness(join(dir, "data", "phone-calls.json"));
    let answer!: () => void;
    h.poll.wait = new Promise(resolve => (answer = resolve));
    const { ref } = await h.service.startCall({ reason: "Folien", conversation: TOPIC, userName: "Alex" });
    await waitUntil(() => h.poll.calls === 1);
    let open!: () => void;
    h.gate.wait = new Promise(resolve => (open = resolve));
    const hook = deliver(routesFor(h));
    await waitUntil(() => h.summaries.length === 1);
    h.poll.result = { state: "error", error: "Anbieter gestört" };
    answer();
    await Bun.sleep(20);
    expect(h.ledger.get(ref!)?.stage).toBe("received");
    open();
    expect(await hook).toEqual({ status: 200, body: { ok: true } });
    await h.service.idle();
    expect(summaryNotes(h)).toHaveLength(1);
    expect(h.notes).not.toContain(PHONE_TEXT.providerError("Anbieter gestört"));
    h.service.stop();
  });

  test("gescheiterter Versuch kurz vor der Frist: Abfrage beendet nichts, die erneute Zustellung wird übernommen", async () => {
    const h = phoneHarness(join(dir, "data", "phone-calls.json"));
    const ref = await heldCall(h);
    h.clock.at = NOW + WAIT_MS - 1_000;
    h.gate.fail = true;
    const routes = routesFor(h);
    expect((await deliver(routes)).status).toBe(500);
    // Frist der Abholung vorbei: die Abfrage versucht selbst neu, scheitert wieder, beendet aber nichts
    h.clock.at = NOW + WAIT_MS + 1;
    h.pause.next();
    await waitUntil(() => h.summaries.length === 2 && h.pause.waiting() > 0);
    expect(h.ledger.get(ref)?.stage).toBe("received");
    expect(h.notes).toEqual([]);
    h.gate.fail = false;
    expect(await deliver(routes)).toEqual({ status: 200, body: { ok: true } });
    h.pause.release();
    await h.service.idle();
    expect(summaryNotes(h)).toHaveLength(1);
    expect(h.notes).not.toContain(PHONE_TEXT.timeout);
    h.service.stop();
  });

  test("Modell bleibt gestört: nach der Frist der Anfang des Protokolls statt gar keiner Zusammenfassung", async () => {
    const h = phoneHarness(join(dir, "data", "phone-calls.json"));
    const ref = await heldCall(h);
    h.gate.fail = true;
    expect((await deliver(routesFor(h))).status).toBe(500);
    h.clock.at = NOW + 2 * WAIT_MS;
    h.pause.release();
    await h.service.idle();
    const summaries = h.notes.filter(note => note.startsWith(PHONE_TEXT.summary("")));
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toContain("Alex: Bitte bereite die Folien für Freitag vor.");
    expect(summaries[0]).toContain("(Zusammenfassung nicht möglich)");
    expect(h.ledger.get(ref)).toMatchObject({ stage: "closed", note: "Zusammenfassung gescheitert" });
    h.service.stop();
  });

  test("Webhook nach Zeitablauf der Abholung, auch nach Neustart: Zusammenfassung im Gespräch des Anrufs, Wiederholung bleibt einmal", async () => {
    const path = join(dir, "data", "phone-calls.json");
    const before = phoneHarness(path);
    const ref = await heldCall(before);
    before.clock.at = NOW + WAIT_MS + 1;
    before.pause.release();
    await before.service.idle();
    expect(before.notes).toEqual([PHONE_TEXT.timeout]);
    expect(before.ledger.get(ref)).toMatchObject({ stage: "failed", note: "Zeitablauf", lateTranscript: true });
    before.service.stop();

    const after = phoneHarness(path);
    after.service.resume();
    const routes = routesFor(after);
    expect(await deliver(routes)).toEqual({ status: 200, body: { ok: true } });
    await after.service.idle();
    expect(after.summaries).toHaveLength(1);
    expect(after.summaries[0]).toContain("Alex: Bitte bereite die Folien für Freitag vor.");
    expect(summaryNotes(after)).toHaveLength(1);
    expect(after.targets[after.notes.indexOf(summaryNotes(after)[0])]).toEqual(TOPIC);
    expect(after.ledger.get(ref)).toMatchObject({ stage: "closed", conversation: TOPIC });
    expect(after.ledger.get(ref)?.lateTranscript).toBeUndefined();
    expect((await deliver(routes)).body.skipped).toBe("schon bearbeitet");
    await after.service.idle();
    expect(after.summaries).toHaveLength(1);
    expect(summaryNotes(after)).toHaveLength(1);
    after.service.stop();
  });

  test("Webhook nach Anbieterfehler der Abholung: gescheiterte Zusammenfassung 500, Wiederholung übernommen, Gespräch des Anrufs", async () => {
    const h = phoneHarness(join(dir, "data", "phone-calls.json"));
    h.poll.result = { state: "error", error: "Anbieter gestört" };
    const { ref } = await h.service.startCall({ reason: "Folien", conversation: TOPIC, userName: "Alex" });
    await h.service.idle();
    expect(h.notes).toEqual([PHONE_TEXT.providerError("Anbieter gestört")]);
    expect(h.ledger.get(ref!)).toMatchObject({ stage: "failed", lateTranscript: true });
    h.pause.held = true;
    h.gate.fail = true;
    const routes = routesFor(h);
    expect((await deliver(routes)).status).toBe(500);
    expect(h.ledger.get(ref!)).toMatchObject({ stage: "received", transcript: expect.stringContaining("Alex: Bitte bereite die Folien") });
    h.gate.fail = false;
    expect(await deliver(routes)).toEqual({ status: 200, body: { ok: true } });
    h.pause.release();
    await h.service.idle();
    expect(summaryNotes(h)).toHaveLength(1);
    expect(h.targets[h.notes.indexOf(summaryNotes(h)[0])]).toEqual(TOPIC);
    expect(h.ledger.get(ref!)).toMatchObject({ stage: "closed", conversation: TOPIC });
    expect((await deliver(routes)).body.skipped).toBe("schon bearbeitet");
    await h.service.idle();
    expect(summaryNotes(h)).toHaveLength(1);
    h.service.stop();
  });

  test("gescheitert ohne offene Abholung (Zusammenfassung nicht zugestellt): späte Zustellung öffnet nichts", async () => {
    const h = phoneHarness(join(dir, "data", "phone-calls.json"));
    h.ledger.add({ ref: "r-alt", reason: "Folien", conversation: TOPIC, userName: "Alex", createdAt: NOW, deadline: NOW, stage: "failed", updatedAt: NOW, conversationId: "conv-1", summary: "S", note: "Zusammenfassung nicht zugestellt" });
    expect((await deliver(routesFor(h))).body.skipped).toBe("schon bearbeitet");
    await h.service.idle();
    expect(h.summaries).toEqual([]);
    expect(h.notes).toEqual([]);
    expect(h.ledger.get("r-alt")?.stage).toBe("failed");
    h.service.stop();
  });

  test("leeres Protokoll per Webhook: Hinweis einmal, keine Zusammenfassung", async () => {
    const h = phoneHarness(join(dir, "data", "phone-calls.json"));
    await h.service.startCall({ reason: "Folien", conversation: TOPIC, userName: "Alex" });
    const routes = routesFor(h);
    expect((await deliver(routes, transcriptEvent("conv-1", []))).body).toEqual({ ok: true });
    expect((await deliver(routes, transcriptEvent("conv-1", []))).body.skipped).toBe("schon bearbeitet");
    await h.service.idle();
    expect(h.notes.filter(note => note === PHONE_TEXT.empty)).toHaveLength(1);
    expect(h.summaries).toEqual([]);
    h.service.stop();
  });

  test("Anruf nicht von tybo: Zusammenfassung im Direktchat, genau einmal, auch parallel und nach Neustart", async () => {
    const path = join(dir, "data", "phone-calls.json");
    const h = phoneHarness(path, { inbound: true });
    let open!: () => void;
    h.gate.wait = new Promise(resolve => (open = resolve));
    const routes = routesFor(h);
    const pending = [deliver(routes, transcriptEvent("conv-fremd")), deliver(routes, transcriptEvent("conv-fremd"))];
    await Bun.sleep(5);
    open();
    const results = await Promise.all(pending);
    expect(results.map(r => r.status)).toEqual([200, 200]);
    expect(results.filter(r => r.body.skipped === undefined)).toHaveLength(1);
    await h.service.idle();
    expect(h.summaries).toHaveLength(1);
    expect(h.summaries[0]).toContain("Alex: Bitte bereite die Folien für Freitag vor.");
    expect(summaryNotes(h)).toHaveLength(1);
    expect(h.targets[h.notes.indexOf(summaryNotes(h)[0])]).toEqual(DM);
    expect(h.ledger.byConversationId("conv-fremd")).toMatchObject({ stage: "closed", inbound: true, conversation: DM });
    h.service.stop();

    const after = phoneHarness(path, { inbound: true });
    after.service.resume();
    expect((await deliver(routesFor(after), transcriptEvent("conv-fremd"))).body.skipped).toBe("schon bearbeitet");
    await after.service.idle();
    expect(after.summaries).toEqual([]);
    expect(after.notes).toEqual([]);
    after.service.stop();
  });

  test("Anruf nicht von tybo, Zusammenfassung scheitert: 500, Eintrag bleibt, die erneute Zustellung wird übernommen", async () => {
    const h = phoneHarness(join(dir, "data", "phone-calls.json"), { inbound: true });
    h.pause.held = true;
    h.gate.fail = true;
    const routes = routesFor(h);
    expect((await deliver(routes, transcriptEvent("conv-fremd"))).status).toBe(500);
    expect(h.ledger.byConversationId("conv-fremd")?.stage).toBe("received");
    h.gate.fail = false;
    expect(await deliver(routes, transcriptEvent("conv-fremd"))).toEqual({ status: 200, body: { ok: true } });
    h.pause.release();
    await h.service.idle();
    expect(summaryNotes(h)).toHaveLength(1);
    h.service.stop();
  });

  test("Anruf nicht von tybo ohne Ziel oder mit leerem Protokoll: 200, nichts angelegt, nichts zugestellt", async () => {
    const without = phoneHarness(join(dir, "data", "phone-calls.json"));
    expect(await deliver(routesFor(without), transcriptEvent("conv-fremd"))).toEqual({ status: 200, body: { ok: true, skipped: "unbekannter Anruf" } });
    const empty = phoneHarness(join(dir, "data", "phone-calls.json"), { inbound: true });
    expect(await deliver(routesFor(empty), transcriptEvent("conv-fremd", []))).toEqual({ status: 200, body: { ok: true, skipped: "unbekannter Anruf" } });
    expect(empty.ledger.byConversationId("conv-fremd")).toBeUndefined();
    expect([...without.notes, ...empty.notes]).toEqual([]);
    expect([...without.summaries, ...empty.summaries]).toEqual([]);
  });
});
