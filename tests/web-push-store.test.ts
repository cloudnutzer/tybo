/**
 * Abo-Speicher (Issue #225, src/web/push-store.ts) bei Schreibfehlern: eine
 * Änderung gilt erst, wenn die Datei geschrieben ist. Scheitert das Schreiben,
 * bleiben Speicher und Datei beim alten Stand, der nächste Versuch klappt, und
 * nach einem Neustart (neu laden) stimmt der Stand mit dem Speicher überein.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PushSubscriptionStore } from "../src/web/push-store";

const P256DH = "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";
const AUTH = "BTBZMqHH6r4Tts7J_aSIgg";
const root = await mkdtemp(join(tmpdir(), "tybo-push-store-"));
let counter = 0;

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

function endpoint(n: number): string {
  return `https://fcm.googleapis.com/fcm/send/geheim-${n}`;
}

/** Speicher mit Datei-Attrappe: solange broken.on gilt, scheitert jedes Schreiben */
async function setup() {
  const file = join(root, `case-${++counter}`, "push-subscriptions.json");
  const broken = { on: false };
  const failing = (async (...args: Parameters<typeof writeFile>) => {
    if (broken.on) throw Object.assign(new Error("Platte voll"), { code: "ENOSPC" });
    return writeFile(...args);
  }) as typeof writeFile;
  const store = new PushSubscriptionStore({ file, writeFile: failing });
  const first = await store.upsert({ endpoint: endpoint(1), keys: { p256dh: P256DH, auth: AUTH }, name: "Mac · Chrome" });
  if (first.status !== "ok") throw new Error("Anlegen fehlgeschlagen");
  const reload = async () => {
    const again = new PushSubscriptionStore({ file });
    await again.load();
    return again;
  };
  return { store, broken, device: first.device, reload };
}

describe("Schreibfehler", () => {
  test("Löschen: Gerät bleibt im Speicher, Wiederholung klappt, Neustart zeigt den Stand der Datei", async () => {
    const { store, broken, device, reload } = await setup();
    broken.on = true;
    await expect(store.remove(device.id)).rejects.toThrow("Platte voll");
    expect(store.get(device.id)?.endpoint).toBe(endpoint(1));
    expect((await reload()).get(device.id)).toBeDefined();
    broken.on = false;
    expect(await store.remove(device.id)).toBe(true);
    expect(store.get(device.id)).toBeUndefined();
    expect((await reload()).list()).toEqual([]);
  });

  test("Anlegen: kein Gerät im Speicher ohne Datei, Wiederholung legt es an", async () => {
    const { store, broken, reload } = await setup();
    broken.on = true;
    const input = { endpoint: endpoint(2), keys: { p256dh: P256DH, auth: AUTH }, name: "iPhone · Safari" };
    await expect(store.upsert(input)).rejects.toThrow("Platte voll");
    expect(store.list().map(d => d.endpoint)).toEqual([endpoint(1)]);
    broken.on = false;
    const result = await store.upsert(input);
    expect(result.status === "ok" && result.created).toBe(true);
    expect((await reload()).list().map(d => d.endpoint)).toEqual([endpoint(1), endpoint(2)]);
  });

  test("Endpunktwechsel, Umbenennen, lastOkAt und removeIfEndpoint: alter Stand bleibt bei Fehler", async () => {
    const { store, broken, device, reload } = await setup();
    broken.on = true;
    await expect(store.upsert({ id: device.id, endpoint: endpoint(3), keys: { p256dh: P256DH, auth: AUTH }, name: "x" })).rejects.toThrow();
    await expect(store.rename(device.id, "Laptop")).rejects.toThrow();
    await expect(store.markOk(device.id, endpoint(1))).rejects.toThrow();
    await expect(store.removeIfEndpoint(device.id, endpoint(1))).rejects.toThrow();
    expect(store.get(device.id)).toEqual(device);
    expect((await reload()).get(device.id)).toEqual(device);
    broken.on = false;
    expect((await store.rename(device.id, "Laptop"))?.name).toBe("Laptop");
    await store.markOk(device.id, endpoint(1));
    expect(store.get(device.id)?.lastOkAt).toBeString();
    const after = (await reload()).get(device.id)!;
    expect(after.name).toBe("Laptop");
    expect(after.lastOkAt).toBe(store.get(device.id)!.lastOkAt!);
    expect(await store.removeIfEndpoint(device.id, endpoint(1))).toBe(true);
    expect((await reload()).list()).toEqual([]);
  });
});
