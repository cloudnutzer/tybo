// Aufräumen nicht abgeschickter Anhänge (Issue #72, Schritt 4): nach 24
// Stunden pending wird gelöscht; abgeschickte und gerade angenommene bleiben.
// Der Zustand steht in meta.json und übersteht einen Neustart.
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { WebServer } from "../src/web/server";
import { UPLOAD_MAX_AGE_MS, UploadStore } from "../src/web/uploads";
import { TOPIC, fakeTelegramChat, makeRoot, startAttachmentServer, waitUntil } from "./attachments-fixture";
import { PDF, PNG } from "./media-fixture";

const root = await makeRoot("tybo-web-uploads-clean-");
afterAll(() => root.cleanup());
const servers: WebServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop();
});

const T0 = Date.parse("2026-09-25T08:00:00.000Z");

function clock(start = T0) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

async function saved(store: UploadStore, conversationId: string, bytes = PNG): Promise<string> {
  const result = await store.save(conversationId, bytes, undefined);
  if (!result.ok) throw new Error(result.error);
  return result.attachment.id;
}

describe("UploadStore.cleanup", () => {
  test("genau ab 24 Stunden: pending gelöscht, jüngere und abgeschickte bleiben", async () => {
    const dir = root.next();
    const c = clock();
    const store = new UploadStore({ dir, now: c.now, log: () => {} });
    const old = await saved(store, TOPIC);
    const sent = await saved(store, TOPIC);
    expect((await store.claim(TOPIC, [sent])).ok).toBe(true);
    c.advance(60_000);
    const younger = await saved(store, "dm");

    c.advance(UPLOAD_MAX_AGE_MS - 60_000);
    // Genau 24 Stunden: noch nicht älter als die Grenze
    expect(await store.cleanup()).toBe(0);
    c.advance(1);
    expect(await store.cleanup()).toBe(1);
    expect(await store.find(TOPIC, old)).toBeNull();
    expect((await store.find(TOPIC, sent))?.state).toBe("sent");
    expect((await store.find("dm", younger))?.state).toBe("pending");
    c.advance(60_000);
    expect(await store.cleanup()).toBe(1);
    expect(await store.find("dm", younger)).toBeNull();
    // Abgeschickte bleiben auch viel später (Download im Verlauf)
    c.advance(30 * UPLOAD_MAX_AGE_MS);
    expect(await store.cleanup()).toBe(0);
    expect(await store.find(TOPIC, sent)).not.toBeNull();
  });

  test("Neustart: Zustand aus meta.json, eine neue Ablage räumt dasselbe auf", async () => {
    const dir = root.next();
    const first = new UploadStore({ dir, now: () => T0, log: () => {} });
    const pending = await saved(first, TOPIC);
    const sent = await saved(first, TOPIC, PDF);
    await first.claim(TOPIC, [sent]);
    const back = await saved(first, TOPIC);
    await first.claim(TOPIC, [back]);
    await first.unclaim(TOPIC, [back]);

    const second = new UploadStore({ dir, now: () => T0 + UPLOAD_MAX_AGE_MS + 1, log: () => {} });
    expect((await second.find(TOPIC, sent))?.state).toBe("sent");
    expect(await second.cleanup()).toBe(2);
    expect(await second.find(TOPIC, pending)).toBeNull();
    expect(await second.find(TOPIC, back)).toBeNull();
    expect((await second.read(TOPIC, sent)).bytes).toEqual(PDF);
    // Abgeschickt bleibt abgeschickt: nicht noch einmal annehmbar
    expect((await second.claim(TOPIC, [sent])).ok).toBe(false);
  });

  test("abgebrochenes Ablegen ohne meta.json: nach Alter des Ordners gelöscht, fremde Einträge bleiben", async () => {
    const dir = root.next();
    const orphan = join(dir, TOPIC, crypto.randomUUID());
    await mkdir(orphan, { recursive: true });
    await writeFile(join(orphan, "file.png"), PNG);
    await writeFile(join(dir, TOPIC, "notiz.txt"), "bleibt");
    await mkdir(join(dir, "kein-gespraech"), { recursive: true });
    expect(await new UploadStore({ dir, log: () => {} }).cleanup()).toBe(0);
    const later = new UploadStore({ dir, now: () => Date.now() + UPLOAD_MAX_AGE_MS + 1000, log: () => {} });
    expect(await later.cleanup()).toBe(1);
    expect((await readdir(join(dir, TOPIC))).sort()).toEqual(["notiz.txt"]);
    expect(await readdir(dir)).toContain("kein-gespraech");
  });

  test("gleichzeitiges Senden und Aufräumen: nie angenommen und zugleich gelöscht", async () => {
    for (let round = 0; round < 20; round++) {
      const dir = root.next();
      const c = clock();
      const store = new UploadStore({ dir, now: c.now, log: () => {} });
      const id = await saved(store, TOPIC);
      c.advance(UPLOAD_MAX_AGE_MS + 1);
      // Abwechselnd zuerst gestartet, mit Versatz um einige Mikrotasks
      const delay = async (n: number) => {
        for (let i = 0; i < n; i++) await Promise.resolve();
      };
      const claimP = (round % 2 ? delay(round) : Promise.resolve()).then(() => store.claim(TOPIC, [id]));
      const cleanP = (round % 2 ? Promise.resolve() : delay(round)).then(() => store.cleanup());
      const [claim, removed] = await Promise.all([claimP, cleanP]);
      if (claim.ok) {
        expect(removed).toBe(0);
        expect((await store.find(TOPIC, id))?.state).toBe("sent");
        expect((await store.read(TOPIC, id)).bytes).toEqual(PNG);
      } else {
        expect(removed).toBe(1);
        expect(await store.find(TOPIC, id)).toBeNull();
      }
    }
  });

  test("zweimal gleichzeitig dieselbe ID annehmen: genau einer", async () => {
    const store = new UploadStore({ dir: root.next(), log: () => {} });
    const id = await saved(store, TOPIC);
    const results = await Promise.all([store.claim(TOPIC, [id]), store.claim(TOPIC, [id])]);
    expect(results.filter(r => r.ok)).toHaveLength(1);
  });
});

describe("Aufräumen im Server", () => {
  test("beim Start sofort, laufender Turn behält seine Anhänge", async () => {
    const dir = root.next();
    const c = clock();
    const { rec, factory } = fakeTelegramChat(join(dir, "media"));
    let release!: () => void;
    rec.core = () => new Promise(resolve => (release = () => resolve("fertig")));
    // Alter Anhang aus der Zeit vor dem Start
    const early = new UploadStore({ dir: join(dir, "uploads"), now: () => T0 - UPLOAD_MAX_AGE_MS - 1, log: () => {} });
    const stale = await saved(early, TOPIC);
    const ctx = await startAttachmentServer({ dir, servers, telegramChat: factory, now: c.now });
    for (let i = 0; i < 100 && (await ctx.uploads.find(TOPIC, stale)); i++) await Bun.sleep(5);
    expect(await ctx.uploads.find(TOPIC, stale)).toBeNull();

    const res = await ctx.upload(TOPIC, PNG);
    const { id } = await res.json();
    const sent = await ctx.api(`/api/conversations/${TOPIC}/messages`, { method: "POST", body: { attachments: [id] } });
    expect(sent.status).toBe(202);
    await waitUntil(() => rec.turns.length === 1);
    c.advance(2 * UPLOAD_MAX_AGE_MS);
    expect(await ctx.uploads.cleanup()).toBe(0);
    release();
    expect((await ctx.uploads.read(TOPIC, id)).bytes).toEqual(PNG);
  });
});
