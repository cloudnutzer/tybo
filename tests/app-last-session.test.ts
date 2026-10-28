// Issue #342: letzte Session des Bots in session-state.json (src/app/last-session.ts)
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { createLastSessionStore } from "../src/app/last-session";

describe("letzte Session", () => {
  let dir = "";
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = "";
  });
  const fresh = async () => {
    dir = await mkdtemp(join(tmpdir(), "tybo-last-session-"));
    return join(dir, "session-state.json");
  };

  test("ohne Datei: leerer Stand", async () => {
    const store = createLastSessionStore({ path: await fresh() });
    await store.load();
    expect(store.current()).toEqual({ sessionId: null, engine: null });
  });

  test("merken schreibt sofort, im bisherigen Format, und übersteht einen Neustart", async () => {
    const path = await fresh();
    const store = createLastSessionStore({ path });
    await store.remember("sess-1", "codex");
    expect(JSON.parse(await readFile(path, "utf-8"))).toEqual({ sessionId: "sess-1", engine: "codex" });
    expect(await readFile(path, "utf-8")).toBe(JSON.stringify({ sessionId: "sess-1", engine: "codex" }, null, 2));
    // keine Reste vom atomaren Schreiben
    expect(await readdir(dir)).toEqual(["session-state.json"]);

    const again = createLastSessionStore({ path });
    await again.load();
    expect(again.current()).toEqual({ sessionId: "sess-1", engine: "codex" });
  });

  test("alte Datei ohne Motor: Claude", async () => {
    const path = await fresh();
    await writeFile(path, JSON.stringify({ sessionId: "alt-7" }));
    const store = createLastSessionStore({ path });
    await store.load();
    expect(store.current()).toEqual({ sessionId: "alt-7", engine: "claude" });
  });

  test("ohne Session-ID auch ohne Motor; kaputte Datei: leerer Stand", async () => {
    const path = await fresh();
    for (const content of [JSON.stringify({ sessionId: null }), "{kaputt", "null", JSON.stringify({ sessionId: 5 })]) {
      await writeFile(path, content);
      const store = createLastSessionStore({ path });
      await store.load();
      expect(store.current()).toEqual({ sessionId: null, engine: null });
    }
  });

  test("Schreibfehler: geschluckt, Stand im Speicher bleibt", async () => {
    const store = createLastSessionStore({ path: "/nirgends", read: async () => "{}", write: async () => { throw new Error("voll"); } });
    await expect(store.remember("s", "claude")).resolves.toBeUndefined();
    await expect(store.save()).resolves.toBeUndefined();
    expect(store.current()).toEqual({ sessionId: "s", engine: "claude" });
  });

  test("current gibt eine Kopie heraus", async () => {
    const store = createLastSessionStore({ path: await fresh() });
    const snapshot = store.current();
    snapshot.sessionId = "verändert";
    expect(store.current().sessionId).toBeNull();
  });
});
