// Teilen-Ziel in der Oberfläche (app.js, Issue #229): Übergaben aus dem
// Cache des Service Workers landen als Entwurf und Anhänge im zuletzt offenen
// Gespräch, nie gesendet; „Anderes Gespräch" verschiebt nur den geteilten
// Anteil. Ohne Browser: Attrappen aus app-mobile-fixture.ts.
import { describe, expect, test } from "bun:test";
import { draftKeys, fakeCaches, fakeLocks, handoffId, html, loginSource, MINUTE, ORIGIN, png, putHandoff, settle, setup, SHARE_CACHE, shareKeys, source, WEB2 } from "./app-mobile-fixture";

/** Uhr für die Dauer von fn vorstellen (Verfall geteilter Inhalte) */
async function later<T>(ms: number, fn: () => Promise<T> | T): Promise<T> {
  const now = Date.now;
  Date.now = () => now() + ms;
  try {
    return await fn();
  } finally {
    Date.now = now;
  }
}

/** Anhänge über die Büroklammer im offenen Gespräch */
function attach(app: ReturnType<typeof setup>, ...files: File[]) {
  app.elements["file-input"].files = files;
  app.elements["file-input"].dispatch("change");
}

describe("Übernahme ins offene Gespräch", () => {
  test("Text und zwei Bilder nach #/teilen: Entwurf plus zwei Anhänge, nichts gesendet, Übergabe gelöscht", async () => {
    const caches = fakeCaches();
    await putHandoff(caches, { text: "Schau dir das an", url: "https://example.org/artikel", files: [png("a.png"), png("b.png", 60)] });
    const app = setup({ hash: "#/teilen", caches });
    await settle();
    expect(app.title()).toBe("Recherche");
    expect(app.input.value).toBe("Schau dir das an\nhttps://example.org/artikel");
    expect(app.chipNames()).toEqual(["a.png", "b.png"]);
    expect(app.shareLine()).toBe("Geteilt: 2 Bilder, Text");
    expect(app.elements["share-move"].textContent).toBe("Anderes Gespräch");
    expect(app.location.hash).toBe("");
    // Nie automatisch senden, nichts hochgeladen
    expect(app.server.posts()).toEqual([]);
    expect(app.server.uploads()).toEqual([]);
    expect(await shareKeys(caches)).toEqual([]);
    // Senden bleibt ein Tipp des Nutzers
    expect(app.elements["send"].disabled).toBe(false);
  });

  test("ein vorhandener Entwurf bleibt davor stehen (auch über das Neuladen gesichert)", async () => {
    const caches = fakeCaches();
    await putHandoff(caches, { text: "geteilt" });
    const app = setup({ hash: "#/teilen", caches, session: { "tybo-reload-drafts": JSON.stringify({ drafts: { "topic-8": "Mein Entwurf" } }) } });
    await settle();
    expect(app.input.value).toBe("Mein Entwurf\n\ngeteilt");
    expect(app.shareLine()).toBe("Geteilt: Text");
  });

  test("nur Link: Titel und Link, Zeile sagt Link", async () => {
    const caches = fakeCaches();
    await putHandoff(caches, { title: "Ein Artikel", url: "https://example.org/x" });
    const app = setup({ hash: "#/teilen", caches });
    await settle();
    expect(app.input.value).toBe("Ein Artikel\nhttps://example.org/x");
    expect(app.shareLine()).toBe("Geteilt: Link");
  });

  test("auch ohne #/teilen (Adresse verloren) übernimmt der Start eine liegende Übergabe", async () => {
    const caches = fakeCaches();
    await putHandoff(caches, { files: [png("a.png")] });
    const app = setup({ caches });
    await settle();
    expect(app.chipNames()).toEqual(["a.png"]);
    expect(app.shareLine()).toBe("Geteilt: 1 Bild");
  });

  test("abgelaufene Übergaben (älter als zehn Minuten) werden verworfen, nicht übernommen", async () => {
    const caches = fakeCaches();
    await putHandoff(caches, { text: "alt", at: Date.now() - 10 * MINUTE - 1 });
    const app = setup({ hash: "#/teilen", caches });
    await settle();
    expect(app.input.value).toBe("");
    expect(app.shareLine()).toBe("");
    expect(await shareKeys(caches)).toEqual([]);
  });

  test("vom Worker abgewiesene Dateien: Hinweis mit Grund, der Rest ist übernommen", async () => {
    const caches = fakeCaches();
    await putHandoff(caches, {
      files: [png("ok.png")],
      rejected: [{ name: "riesig.jpg", reason: "size", kind: "image" }, { name: "notiz.txt", reason: "type" }],
    });
    const app = setup({ hash: "#/teilen", caches });
    await settle();
    expect(app.chipNames()).toEqual(["ok.png"]);
    expect(app.note()).toBe("riesig.jpg: Bild ist zu groß (höchstens 20 MB). 1 weitere Datei ebenfalls nicht übernommen.");
    const typeOnly = fakeCaches();
    await putHandoff(typeOnly, { rejected: [{ name: "notiz.txt", reason: "type" }] });
    const other = setup({ hash: "#/teilen", caches: typeOnly });
    await settle();
    expect(other.note()).toBe("notiz.txt: Nur Bilder (PNG, JPEG, WebP, GIF), PDFs und Sprachdateien.");
  });

  test("#/teilen/fehler: Hinweis, dass das Zwischenspeichern scheiterte", async () => {
    const app = setup({ hash: "#/teilen/fehler" });
    await settle();
    expect(app.note()).toContain("Teilen hat nicht geklappt");
    expect(app.location.hash).toBe("");
  });

  test("Grenze fünf Anhänge: schon vier im Gespräch, zwei geteilt, einer kommt dazu, Hinweis nennt den Rest", async () => {
    const caches = fakeCaches();
    const app = setup({ caches });
    await settle();
    app.elements["file-input"].files = [png("1.png"), png("2.png"), png("3.png"), png("4.png")];
    app.elements["file-input"].dispatch("change");
    await putHandoff(caches, { files: [png("g1.png"), png("g2.png")] });
    app.location.hash = "#/teilen";
    app.fire("hashchange");
    await settle();
    expect(app.chipNames()).toEqual(["1.png", "2.png", "3.png", "4.png", "g1.png"]);
    expect(app.note()).toBe("Höchstens 5 Anhänge je Nachricht: 1 geteilte Datei wurde nicht übernommen.");
    expect(app.server.posts()).toEqual([]);
  });

  test("wiederholte Übernahme: dieselbe Übergabe kommt nur einmal an, auch bei doppeltem #/teilen", async () => {
    const caches = fakeCaches();
    await putHandoff(caches, { text: "einmal", files: [png("a.png")] });
    const app = setup({ hash: "#/teilen", caches });
    // Zweites #/teilen, während die erste Übernahme läuft
    app.fire("hashchange");
    await settle();
    app.location.hash = "#/teilen";
    app.fire("hashchange");
    await settle();
    expect(app.input.value).toBe("einmal");
    expect(app.chipNames()).toEqual(["a.png"]);
  });

  test("zwei Übergaben nacheinander: beide kommen an, älteste zuerst", async () => {
    const caches = fakeCaches();
    await putHandoff(caches, { text: "erste", at: Date.now() - 2000 });
    await putHandoff(caches, { text: "zweite", at: Date.now() - 1000 });
    const app = setup({ hash: "#/teilen", caches });
    await settle();
    expect(app.input.value).toBe("erste\n\nzweite");
  });
});

describe("Worker schreibt noch", () => {
  test("gleichzeitiger App-Start: halb geschriebene Übergabe bleibt liegen, nach 303 kommen beide Bilder an", async () => {
    const caches = fakeCaches();
    // Der Worker hat das erste Bild abgelegt, das zweite und die Beschreibung fehlen noch
    const id = handoffId();
    const cache = await caches.open(SHARE_CACHE);
    await cache.put(`${ORIGIN}/teilen/${id}/0`, new Response(png("a.png"), { headers: { "Content-Type": "image/png" } }));
    const app = setup({ caches });
    await settle();
    expect(await shareKeys(caches)).toEqual([`${ORIGIN}/teilen/${id}/0`]);
    expect(app.chipNames()).toEqual([]);
    await cache.put(`${ORIGIN}/teilen/${id}/1`, new Response(png("b.png", 60), { headers: { "Content-Type": "image/png" } }));
    const meta = {
      v: 1, id, at: Date.now(), title: "", text: "", url: "", rejected: [],
      files: [{ n: 0, name: "a.png", type: "image/png", size: 40, kind: "image" }, { n: 1, name: "b.png", type: "image/png", size: 60, kind: "image" }],
    };
    await cache.put(`${ORIGIN}/teilen/${id}`, new Response(JSON.stringify(meta), { headers: { "Content-Type": "application/json" } }));
    // 303 des Workers auf /#/teilen
    app.location.hash = "#/teilen";
    await settle();
    expect(app.chipNames()).toEqual(["a.png", "b.png"]);
    expect(app.note()).toBe("");
    expect(await shareKeys(caches)).toEqual([]);
  });

  test("ohne 303 (Adresse verloren): die App sieht selbst noch einmal nach, sobald die Übergabe fertig ist", async () => {
    const caches = fakeCaches();
    const id = handoffId();
    const cache = await caches.open(SHARE_CACHE);
    await cache.put(`${ORIGIN}/teilen/${id}/0`, new Response(png("a.png"), { headers: { "Content-Type": "image/png" } }));
    const app = setup({ caches, timers: true });
    await settle();
    const meta = { v: 1, id, at: Date.now(), title: "", text: "fertig", url: "", rejected: [], files: [{ n: 0, name: "a.png", type: "image/png", size: 40, kind: "image" }] };
    await cache.put(`${ORIGIN}/teilen/${id}`, new Response(JSON.stringify(meta), { headers: { "Content-Type": "application/json" } }));
    await Bun.sleep(700);
    await settle();
    expect(app.input.value).toBe("fertig");
    expect(app.chipNames()).toEqual(["a.png"]);
  });

  test("abgebrochene Übergabe (Datei ohne Beschreibung, älter als zehn Minuten) räumt die App weg", async () => {
    const caches = fakeCaches();
    const id = handoffId(Date.now() - 10 * MINUTE - 1);
    const cache = await caches.open(SHARE_CACHE);
    await cache.put(`${ORIGIN}/teilen/${id}/0`, new Response(png("a.png"), { headers: { "Content-Type": "image/png" } }));
    const app = setup({ hash: "#/teilen", caches });
    await settle();
    expect(app.chipNames()).toEqual([]);
    expect(await shareKeys(caches)).toEqual([]);
  });
});

describe("Anderes Gespräch", () => {
  test("nimmt nur den geteilten Anteil mit; eigene Entwürfe und Anhänge beider Gespräche bleiben", async () => {
    const caches = fakeCaches();
    const app = setup({ caches });
    await settle();
    // Im Ziel liegt schon ein Entwurf mit Anhang
    app.entry("topic-9").dispatch("click");
    app.input.value = "Ziel-Entwurf";
    app.elements["file-input"].files = [png("ziel.png")];
    app.elements["file-input"].dispatch("change");
    app.entry("topic-8").dispatch("click");
    app.input.value = "Eigener Text";
    app.elements["file-input"].files = [png("eigen.png")];
    app.elements["file-input"].dispatch("change");
    await putHandoff(caches, { text: "geteilt", files: [png("g.png")] });
    app.location.hash = "#/teilen";
    app.fire("hashchange");
    await settle();
    expect(app.input.value).toBe("Eigener Text\n\ngeteilt");
    expect(app.chipNames()).toEqual(["eigen.png", "g.png"]);

    app.elements["share-move"].dispatch("click");
    expect(app.elements["sidebar"].attributes["data-open"]).toBe("true");
    expect(app.shareLine()).toBe("Geteilt: 1 Bild, Text. Gespräch in der Liste wählen.");
    app.entry("topic-9").dispatch("click");
    expect(app.title()).toBe("Strategie");
    expect(app.input.value).toBe("Ziel-Entwurf\n\ngeteilt");
    expect(app.chipNames()).toEqual(["ziel.png", "g.png"]);
    expect(app.shareLine()).toBe("Geteilt: 1 Bild, Text");
    // Zurück: dort steht nur noch das Eigene
    app.entry("topic-8").dispatch("click");
    expect(app.input.value).toBe("Eigener Text");
    expect(app.chipNames()).toEqual(["eigen.png"]);
    expect(app.shareLine()).toBe("");
    expect(app.server.posts()).toEqual([]);
  });

  test("im alten Gespräch bearbeiteter Text bleibt dort, das Ziel bekommt eine Kopie", async () => {
    const caches = fakeCaches();
    await putHandoff(caches, { text: "geteilt" });
    const app = setup({ hash: "#/teilen", caches });
    await settle();
    app.input.value = "geteilt, ergänzt";
    app.elements["share-move"].dispatch("click");
    app.entry("topic-9").dispatch("click");
    expect(app.input.value).toBe("geteilt");
    app.entry("topic-8").dispatch("click");
    expect(app.input.value).toBe("geteilt, ergänzt");
  });

  test("Ziel hat schon vier Anhänge: einer wandert, der Rest bleibt im alten Gespräch mit Hinweis", async () => {
    const caches = fakeCaches();
    const app = setup({ caches });
    await settle();
    app.entry("topic-9").dispatch("click");
    app.elements["file-input"].files = [png("1.png"), png("2.png"), png("3.png"), png("4.png")];
    app.elements["file-input"].dispatch("change");
    app.entry("topic-8").dispatch("click");
    await putHandoff(caches, { files: [png("g1.png"), png("g2.png")] });
    app.location.hash = "#/teilen";
    app.fire("hashchange");
    await settle();
    app.elements["share-move"].dispatch("click");
    app.entry("topic-9").dispatch("click");
    expect(app.chipNames()).toEqual(["1.png", "2.png", "3.png", "4.png", "g1.png"]);
    expect(app.note()).toBe("Höchstens 5 Anhänge je Nachricht: 1 geteilte Datei ist im vorherigen Gespräch geblieben.");
    app.entry("topic-8").dispatch("click");
    expect(app.chipNames()).toEqual(["g2.png"]);
  });

  test("Liste ohne Wahl geschlossen (Scrim): nichts wandert, spätere Wechsel auch nicht", async () => {
    const caches = fakeCaches();
    await putHandoff(caches, { text: "geteilt" });
    const app = setup({ hash: "#/teilen", caches });
    await settle();
    app.elements["share-move"].dispatch("click");
    app.elements["scrim"].dispatch("click");
    expect(app.shareLine()).toBe("Geteilt: Text");
    app.entry("topic-9").dispatch("click");
    expect(app.input.value).toBe("");
    app.entry("topic-8").dispatch("click");
    expect(app.input.value).toBe("geteilt");
  });

  test("geschlossenes Topic als Ziel: nichts wandert, Hinweis", async () => {
    const caches = fakeCaches();
    await putHandoff(caches, { text: "geteilt", files: [png("g.png")] });
    const app = setup({ hash: "#/teilen", caches });
    await settle();
    app.elements["older-toggle"].dispatch("click");
    app.elements["share-move"].dispatch("click");
    app.entry("topic-5").dispatch("click");
    expect(app.title()).toBe("Alt");
    expect(app.chipNames()).toEqual([]);
    expect(app.note()).toContain("geschlossen");
    app.entry("topic-8").dispatch("click");
    expect(app.input.value).toBe("geteilt");
    expect(app.chipNames()).toEqual(["g.png"]);
  });

  test("nach dem Senden verschwindet die Zeile", async () => {
    const caches = fakeCaches();
    await putHandoff(caches, { text: "geteilt" });
    const app = setup({ hash: "#/teilen", caches });
    await settle();
    expect(app.shareLine()).toBe("Geteilt: Text");
    app.submit();
    await settle();
    expect(app.server.posts().length).toBe(1);
    expect(app.shareLine()).toBe("");
  });
});

describe("ohne offenes Gespräch", () => {
  test("zuletzt offenes Gespräch geschlossen: Zeile „Noch in keinem Gespräch“, Wahl bringt es unter", async () => {
    const caches = fakeCaches();
    await putHandoff(caches, { text: "geteilt", files: [png("g.png")] });
    const app = setup({ hash: "#/teilen", caches, stored: "topic-5" });
    await settle();
    expect(app.title()).toBe("Alt");
    expect(app.shareLine()).toBe("Geteilt: 1 Bild, Text. Noch in keinem Gespräch.");
    expect(app.elements["share-move"].textContent).toBe("Gespräch wählen");
    // Solange nichts untergebracht ist, bleibt die Übergabe im Gerät
    expect((await shareKeys(caches)).length).toBe(2);
    app.elements["share-move"].dispatch("click");
    app.entry("topic-9").dispatch("click");
    await settle();
    expect(app.input.value).toBe("geteilt");
    expect(app.chipNames()).toEqual(["g.png"]);
    expect(await shareKeys(caches)).toEqual([]);
  });

  test("gar kein Gespräch vorhanden: wartet, bis eins offen ist", async () => {
    const caches = fakeCaches();
    await putHandoff(caches, { text: "geteilt" });
    const app = setup({ hash: "#/teilen", caches, conversations: [], topics: [] });
    await settle();
    expect(app.shareLine()).toBe("Geteilt: Text. Noch in keinem Gespräch.");
    expect(app.server.posts()).toEqual([]);
  });
});

describe("zwei Fenster", () => {
  test("lesen beide gleichzeitig, übernimmt genau eines die Übergabe (mit und ohne Web Locks)", async () => {
    for (const locks of [fakeLocks(), null]) {
      const caches = fakeCaches();
      await putHandoff(caches, { text: "einmal", files: [png("a.png")] });
      const a = setup({ hash: "#/teilen", caches, locks });
      const b = setup({ hash: "#/teilen", caches, locks });
      await settle();
      expect([a, b].map(app => app.input.value).sort()).toEqual(["", "einmal"]);
      expect([a, b].flatMap(app => app.chipNames())).toEqual(["a.png"]);
      expect([a, b].map(app => app.shareLine()).filter(Boolean)).toEqual(["Geteilt: 1 Bild, Text"]);
      expect(await shareKeys(caches)).toEqual([]);
    }
  });

  test("wartet eines ohne Gespräch, bekommt ein zweites sie nicht; sie bleibt bis zur Wahl im Gerät", async () => {
    const caches = fakeCaches();
    const locks = fakeLocks();
    await putHandoff(caches, { text: "geteilt" });
    const waiting = setup({ hash: "#/teilen", caches, locks, stored: "topic-5" });
    await settle();
    expect(waiting.shareLine()).toBe("Geteilt: Text. Noch in keinem Gespräch.");
    const other = setup({ hash: "#/teilen", caches, locks });
    await settle();
    expect(other.input.value).toBe("");
    expect(other.shareLine()).toBe("");
    expect((await shareKeys(caches)).length).toBe(1);
    waiting.elements["share-move"].dispatch("click");
    waiting.entry("topic-9").dispatch("click");
    await settle();
    expect(waiting.input.value).toBe("geteilt");
    expect(await shareKeys(caches)).toEqual([]);
    expect(locks.held.size).toBe(0);
  });
});

describe("Verfall beim Warten", () => {
  test("geschlossenes Ziel, Gesprächswahl nach zehn Minuten: verworfen, aus Zustand und Gerät", async () => {
    const caches = fakeCaches();
    await putHandoff(caches, { text: "geteilt", files: [png("g.png")] });
    const app = setup({ hash: "#/teilen", caches, stored: "topic-5" });
    await settle();
    expect(app.shareLine()).toBe("Geteilt: 1 Bild, Text. Noch in keinem Gespräch.");
    await later(10 * MINUTE, async () => {
      app.elements["share-move"].dispatch("click");
      app.entry("topic-9").dispatch("click");
      await settle();
    });
    expect(app.title()).toBe("Strategie");
    expect(app.input.value).toBe("");
    expect(app.chipNames()).toEqual([]);
    expect(app.shareLine()).toBe("");
    expect(app.note()).toBe("Geteilter Inhalt war älter als zehn Minuten und ist verworfen. Bitte noch einmal teilen.");
    expect(await shareKeys(caches)).toEqual([]);
    // Auch später kommt nichts mehr an
    app.entry("topic-8").dispatch("click");
    await settle();
    expect(app.input.value).toBe("");
    expect(app.chipNames()).toEqual([]);
  });

  test("fehlendes Ziel: ein neues Gespräch vor Ablauf nimmt es auf, nach Ablauf nicht", async () => {
    for (const [wait, placed] of [[9 * MINUTE, true], [10 * MINUTE, false]] as const) {
      const caches = fakeCaches();
      await putHandoff(caches, { text: "geteilt", files: [png("g.png")] });
      const app = setup({ hash: "#/teilen", caches, conversations: [], topics: [] });
      await settle();
      expect(app.shareLine()).toBe("Geteilt: 1 Bild, Text. Noch in keinem Gespräch.");
      await later(wait, async () => {
        app.elements["new-chat"].dispatch("click");
        app.elements["agent-options"].children[0].children[0].dispatch("click");
        await settle();
      });
      expect(app.title()).toBe("Neues Gespräch");
      expect(app.server.requests.some(r => r.method === "POST" && r.path === "/api/conversations")).toBe(true);
      expect(app.input.value).toBe(placed ? "geteilt" : "");
      expect(app.chipNames()).toEqual(placed ? ["g.png"] : []);
      expect(app.shareLine()).toBe(placed ? "Geteilt: 1 Bild, Text" : "");
      if (!placed) expect(app.note()).toContain("älter als zehn Minuten");
      expect(await shareKeys(caches)).toEqual([]);
      expect(app.server.posts()).toEqual([]);
    }
  });
});

describe("Teilen während des Sendens", () => {
  test("Upload offen: die Übergabe geht nicht mit, danach genau einmal als neuer Entwurf", async () => {
    let open!: () => void;
    const uploadGate = new Promise<void>(resolve => (open = resolve));
    const caches = fakeCaches();
    const app = setup({ caches, uploadGate });
    await settle();
    app.input.value = "Meine Nachricht";
    attach(app, png("eigen.png"));
    app.submit();
    await settle();
    expect(app.server.uploads().length).toBe(1);
    expect(app.server.posts()).toEqual([]);

    await putHandoff(caches, { text: "geteilt", files: [png("g.png")] });
    app.location.hash = "#/teilen";
    await settle();
    // Nichts überschrieben, nichts dazugelegt, die Übergabe wartet im Gerät
    expect(app.input.value).toBe("Meine Nachricht");
    expect(app.chipNames()).toEqual(["eigen.png"]);
    expect(app.shareLine()).toBe("Geteilt: 1 Bild, Text. Noch in keinem Gespräch.");
    expect((await shareKeys(caches)).length).toBe(2);

    open();
    await settle();
    expect(app.server.uploads().length).toBe(1);
    const posts = app.server.posts();
    expect(posts.length).toBe(1);
    const body = JSON.parse(posts[0].body as string);
    expect(body.text).toBe("Meine Nachricht");
    expect(body.attachments.length).toBe(1);
    expect(app.input.value).toBe("geteilt");
    expect(app.chipNames()).toEqual(["g.png"]);
    expect(app.shareLine()).toBe("Geteilt: 1 Bild, Text");
    expect(await shareKeys(caches)).toEqual([]);

    // Ein weiteres #/teilen bringt nichts doppelt
    app.location.hash = "#/teilen";
    await settle();
    expect(app.input.value).toBe("geteilt");
    expect(app.chipNames()).toEqual(["g.png"]);
    expect(app.server.posts().length).toBe(1);
  });

  test("Nachricht offen (POST läuft): die Übergabe geht nicht mit, danach genau einmal als neuer Entwurf", async () => {
    let open!: () => void;
    const postGate = new Promise<void>(resolve => (open = resolve));
    const caches = fakeCaches();
    const app = setup({ caches, postGate });
    await settle();
    app.input.value = "Meine Nachricht";
    app.submit();
    await settle();
    expect(app.server.posts().length).toBe(1);

    await putHandoff(caches, { text: "geteilt" });
    app.location.hash = "#/teilen";
    await settle();
    expect(app.input.value).toBe("Meine Nachricht");
    expect(app.shareLine()).toBe("Geteilt: Text. Noch in keinem Gespräch.");

    open();
    await settle();
    const posts = app.server.posts();
    expect(posts.length).toBe(1);
    expect(JSON.parse(posts[0].body as string)).toEqual({ text: "Meine Nachricht" });
    expect(app.input.value).toBe("geteilt");
    expect(app.shareLine()).toBe("Geteilt: Text");
    expect(await shareKeys(caches)).toEqual([]);
    app.location.hash = "#/teilen";
    await settle();
    expect(app.input.value).toBe("geteilt");
  });
});

describe("Teilen, während ein verborgenes Fenster sendet (nur ruhende Entwürfe wandern)", () => {
  const ELSEWHERE = "Entwurf wird noch in einem anderen Fenster gesendet.";

  /**
   * Entwurf im anderen Gespräch, dann im offenen Text und Bild senden, mit
   * offenem Upload oder POST, und in die andere App wechseln. Das sendende
   * Gespräch bleibt in diesem Fenster, das ruhende kommt in die Sicherung.
   */
  async function sendHidden(gate: "uploadGate" | "postGate", postFails = false) {
    let open!: () => void;
    const caches = fakeCaches();
    const locks = fakeLocks();
    const app = setup({ caches, locks, [gate]: new Promise<void>(resolve => (open = resolve)), postFails });
    await settle();
    app.entry("topic-9").dispatch("click");
    app.input.value = "Strategie-Notiz";
    attach(app, png("plan.png"));
    app.entry("topic-8").dispatch("click");
    app.input.value = "Meine Nachricht";
    attach(app, png("eigen.png"));
    app.submit();
    await settle();
    app.setVisibility("hidden");
    await settle();
    expect((await draftKeys(caches)).length).toBeGreaterThan(0);
    return { app, caches, locks, open };
  }

  /** Teilen öffnet ein neues Fenster */
  async function shareInto(caches: ReturnType<typeof fakeCaches>, locks: ReturnType<typeof fakeLocks>) {
    await putHandoff(caches, { text: "geteilt", files: [png("g.png")] });
    const second = setup({ hash: "#/teilen", caches, locks });
    await settle();
    return second;
  }

  /** Fenster verlassen (verborgen, pagehide) und mit demselben sessionStorage neu laden */
  async function reload(win: ReturnType<typeof setup>, caches: ReturnType<typeof fakeCaches>, locks: ReturnType<typeof fakeLocks>) {
    win.setVisibility("hidden");
    win.fire("pagehide");
    await settle();
    const next = setup({ caches, locks, session: win.session });
    await settle();
    return next;
  }

  /** Das ruhende Gespräch kam genau einmal an */
  function expectStrategy(win: ReturnType<typeof setup>) {
    win.entry("topic-9").dispatch("click");
    expect(win.input.value).toBe("Strategie-Notiz");
    expect(win.chipNames()).toEqual(["plan.png"]);
    win.entry("topic-8").dispatch("click");
  }

  for (const gate of ["uploadGate", "postGate"] as const) {
    const label = gate === "uploadGate" ? "Upload" : "Nachricht (POST)";

    test(`${label} offen, neues Fenster: nur Geteiltes und das ruhende Gespräch, Hinweis; das sendende bleibt im alten Fenster`, async () => {
      const { app, caches, locks, open } = await sendHidden(gate);
      const second = await shareInto(caches, locks);
      expect(second.input.value).toBe("geteilt");
      expect(second.chipNames()).toEqual(["g.png"]);
      expect(second.note()).toBe(ELSEWHERE);
      expectStrategy(second);

      open();
      await settle();
      const posts = app.server.posts();
      expect(posts.length).toBe(1);
      expect(JSON.parse(posts[0].body as string)).toMatchObject({ text: "Meine Nachricht" });
      expect(app.server.uploads().length).toBe(1);
      // Gesendet: im alten Fenster ist das Gespräch leer
      app.setVisibility("visible");
      await settle();
      expect(app.input.value).toBe("");
      expect(app.chipNames()).toEqual([]);
      // Das neue Fenster sendet nur Geteiltes
      expect(second.input.value).toBe("geteilt");
      second.submit();
      await settle();
      expect(second.server.posts().length).toBe(1);
      expect(JSON.parse(second.server.posts()[0].body as string).text).toBe("geteilt");
    });

    test(`${label} vor dem neuen Fenster fertig: es bekommt Ungesendetes und Geteiltes, keinen Hinweis`, async () => {
      const { app, caches, locks, open } = await sendHidden(gate);
      open();
      await settle();
      expect(app.server.posts().length).toBe(1);
      const second = await shareInto(caches, locks);
      expect(second.input.value).toBe("geteilt");
      expect(second.chipNames()).toEqual(["g.png"]);
      expect(second.note()).toBe("");
      expectStrategy(second);
      expect(second.server.posts()).toEqual([]);
      expect(await draftKeys(caches)).toEqual([]);
    });

    for (const finished of [true, false]) {
      const when = finished ? "vor" : "nach";
      test(`${label} offen, Empfänger lädt mit demselben sessionStorage neu, Senden ${when} dem Neuladen fertig: gesendeter Text kommt nie zurück`, async () => {
        const { app, caches, locks, open } = await sendHidden(gate);
        const second = await shareInto(caches, locks);
        expect(second.input.value).toBe("geteilt");
        if (finished) {
          open();
          await settle();
        }
        const third = await reload(second, caches, locks);
        if (!finished) {
          open();
          await settle();
        }
        expect(app.server.posts().length).toBe(1);
        expect(third.input.value).toBe("geteilt");
        expect(third.chipNames()).toEqual(["g.png"]);
        expectStrategy(third);
        // Erneutes Senden wiederholt die ursprüngliche Nachricht nicht
        third.submit();
        await settle();
        expect(third.server.posts().length).toBe(1);
        expect(JSON.parse(third.server.posts()[0].body as string).text).toBe("geteilt");
      });
    }
  }

  test("Upload offen, geteilt, dann Upload fertig und Nachricht scheitert (500): eigener Text und eigen.png bleiben im alten Fenster", async () => {
    const { app, caches, locks, open } = await sendHidden("uploadGate", true);
    const second = await shareInto(caches, locks);
    expect(second.input.value).toBe("geteilt");
    expect(second.chipNames()).toEqual(["g.png"]);
    expect(second.note()).toBe(ELSEWHERE);
    open();
    await settle();
    expect(app.server.uploads().length).toBe(1);
    expect(app.server.posts().length).toBe(1);
    app.setVisibility("visible");
    await settle();
    expect(app.input.value).toBe("Meine Nachricht");
    expect(app.chipNames()).toEqual(["eigen.png"]);
    // Das neue Fenster behält Geteiltes und das ruhende Gespräch, nichts doppelt
    expect(second.input.value).toBe("geteilt");
    expect(second.chipNames()).toEqual(["g.png"]);
    expectStrategy(second);
  });

  test("Nachricht scheitert, weiterer Seitenwechsel: eigener Text und eigen.png kommen samt Geteiltem an, je einmal", async () => {
    const { app, caches, locks, open } = await sendHidden("uploadGate", true);
    const second = await shareInto(caches, locks);
    open();
    await settle();
    expect(app.server.posts().length).toBe(1);
    // Das alte Fenster bleibt verborgen; das Gespräch ruht jetzt und kommt in die Sicherung
    const third = await reload(second, caches, locks);
    expect(third.input.value).toBe("geteilt\n\nMeine Nachricht");
    expect(third.chipNames().sort()).toEqual(["eigen.png", "g.png"]);
    expectStrategy(third);
    expect(third.server.posts()).toEqual([]);
    expect(await draftKeys(caches)).toEqual([]);
  });

  test("Senden scheitert vor dem neuen Fenster: Text und Anhang bleiben in der Sicherung, das neue Fenster bekommt sie samt Geteiltem", async () => {
    const { caches, locks, open } = await sendHidden("postGate", true);
    open();
    await settle();
    const second = await shareInto(caches, locks);
    expect(second.input.value).toBe("Meine Nachricht\n\ngeteilt");
    expect(second.chipNames()).toEqual(["eigen.png", "g.png"]);
    expect(second.note()).toBe("");
    expectStrategy(second);
  });

  test("das sendende Fenster selbst lädt neu (Teilen lädt es neu), POST offen: der Text kommt nicht als Entwurf zurück", async () => {
    let open!: () => void;
    const caches = fakeCaches();
    const locks = fakeLocks();
    const app = setup({ caches, locks, postGate: new Promise<void>(resolve => (open = resolve)) });
    await settle();
    app.entry("topic-9").dispatch("click");
    app.input.value = "Strategie-Notiz";
    app.entry("topic-8").dispatch("click");
    app.input.value = "Meine Nachricht";
    app.submit();
    await settle();
    expect(app.server.posts().length).toBe(1);
    const next = await reload(app, caches, locks);
    open();
    await settle();
    expect(next.input.value).toBe("");
    next.entry("topic-9").dispatch("click");
    expect(next.input.value).toBe("Strategie-Notiz");
  });
});

describe("Entwürfe über den Seitenwechsel beim Teilen", () => {
  test("Fenster lädt neu: vorhandener Text und Anhänge bleiben, der geteilte Anteil kommt dazu", async () => {
    const caches = fakeCaches();
    const app = setup({ caches });
    await settle();
    app.input.value = "Mein Entwurf";
    attach(app, png("eigen.png"));
    // In die Galerie wechseln und dort teilen: der Browser lädt das App-Fenster mit #/teilen neu
    app.setVisibility("hidden");
    await settle();
    app.fire("pagehide");
    await settle();
    await putHandoff(caches, { text: "geteilt", files: [png("g.png")] });
    const after = setup({ hash: "#/teilen", caches, session: app.session });
    await settle();
    expect(after.input.value).toBe("Mein Entwurf\n\ngeteilt");
    expect(after.chipNames()).toEqual(["eigen.png", "g.png"]);
    expect(after.shareLine()).toBe("Geteilt: 1 Bild, Text");
    expect(await draftKeys(caches)).toEqual([]);
    expect(after.server.posts()).toEqual([]);
    expect(after.server.uploads()).toEqual([]);
  });

  test("wiederholtes Teilen: jeder Stand kommt genau einmal an, nichts doppelt", async () => {
    const caches = fakeCaches();
    let app = setup({ caches });
    await settle();
    app.input.value = "Mein Entwurf";
    attach(app, png("eigen.png"));
    for (const [text, name] of [["erstes", "g1.png"], ["zweites", "g2.png"]]) {
      app.setVisibility("hidden");
      await settle();
      app.fire("pagehide");
      await settle();
      await putHandoff(caches, { text, files: [png(name)] });
      app = setup({ hash: "#/teilen", caches, session: app.session });
      await settle();
    }
    expect(app.input.value).toBe("Mein Entwurf\n\nerstes\n\nzweites");
    expect(app.chipNames()).toEqual(["eigen.png", "g1.png", "g2.png"]);
    expect(await draftKeys(caches)).toEqual([]);
    // Einfach neu geladen, ohne Teilen: derselbe Stand, nicht doppelt
    app.setVisibility("hidden");
    await settle();
    app.fire("pagehide");
    await settle();
    const again = setup({ caches, session: app.session });
    await settle();
    expect(again.input.value).toBe("Mein Entwurf\n\nerstes\n\nzweites");
    expect(again.chipNames()).toEqual(["eigen.png", "g1.png", "g2.png"]);
  });

  test("neues Fenster: bekommt Texte und Anhänge aller Gespräche aus dem verborgenen Fenster", async () => {
    const caches = fakeCaches();
    const locks = fakeLocks();
    const first = setup({ caches, locks });
    await settle();
    first.entry("topic-9").dispatch("click");
    first.input.value = "Strategie-Notiz";
    attach(first, png("plan.png"));
    first.entry("topic-8").dispatch("click");
    first.input.value = "Mein Entwurf";
    attach(first, png("eigen.png"));
    // Wechsel in die andere App; das alte Fenster bleibt bestehen, ohne pagehide
    first.setVisibility("hidden");
    await settle();
    await putHandoff(caches, { text: "geteilt", files: [png("g.png")] });
    // Neues Fenster: eigener Tab-Speicher (sessionStorage leer), gemeinsamer Cache
    const second = setup({ hash: "#/teilen", caches, locks });
    await settle();
    expect(second.input.value).toBe("Mein Entwurf\n\ngeteilt");
    expect(second.chipNames()).toEqual(["eigen.png", "g.png"]);
    second.entry("topic-9").dispatch("click");
    expect(second.input.value).toBe("Strategie-Notiz");
    expect(second.chipNames()).toEqual(["plan.png"]);
    expect(await draftKeys(caches)).toEqual([]);
    expect(second.server.posts()).toEqual([]);
    // Das alte Fenster kommt zurück: sein Stand ist unverändert da
    first.setVisibility("visible");
    await settle();
    expect(first.input.value).toBe("Mein Entwurf");
    expect(first.chipNames()).toEqual(["eigen.png"]);
  });

  test("wieder sichtbar ohne Teilen: der Stand im Gerät ist weg; Abmelden räumt alle Stände weg", async () => {
    const caches = fakeCaches();
    const app = setup({ caches });
    await settle();
    app.input.value = "Mein Entwurf";
    attach(app, png("eigen.png"));
    app.setVisibility("hidden");
    await settle();
    expect((await draftKeys(caches)).length).toBe(2);
    app.setVisibility("visible");
    await settle();
    expect(await draftKeys(caches)).toEqual([]);
    const later = setup({ caches });
    await settle();
    expect(later.input.value).toBe("");
    expect(later.chipNames()).toEqual([]);

    // Ein anderes Fenster liegt verborgen im Gerät; Abmelden hier verwirft auch dessen Stand
    const out = setup({ caches });
    const hidden = setup({ caches });
    await settle();
    hidden.input.value = "geheim";
    hidden.setVisibility("hidden");
    await settle();
    expect((await draftKeys(caches)).length).toBe(1);
    out.elements["logout"].dispatch("click");
    await settle();
    expect(out.location.href).toBe("/login");
    expect(await draftKeys(caches)).toEqual([]);
    const next = setup({ caches });
    await settle();
    expect(next.input.value).toBe("");
  });

  test("pagehide gleich nach dem Verbergen, ohne Wartepause: neues Fenster bekommt Text und Anhang", async () => {
    const caches = fakeCaches();
    const locks = fakeLocks();
    const app = setup({ caches, locks });
    await settle();
    app.input.value = "Mein Entwurf";
    attach(app, png("eigen.png"));
    app.setVisibility("hidden");
    await settle();
    const puts = caches.state.puts;
    // Das Teilen lädt neu: pagehide und sofort das neue Fenster, eigener Tab-Speicher
    app.fire("pagehide");
    const after = setup({ caches, locks });
    await settle();
    expect(after.input.value).toBe("Mein Entwurf");
    expect(after.chipNames()).toEqual(["eigen.png"]);
    // Unveränderter Stand: pagehide schreibt nichts neu
    expect(caches.state.puts).toBe(puts);
    expect(await draftKeys(caches)).toEqual([]);
  });

  test("Seite stirbt beim erneuten Sichern (verzögerte Cache-Schreibvorgänge): der vorige vollständige Stand bleibt", async () => {
    const caches = fakeCaches();
    // Ohne Web Locks: die Sperre eines sterbenden Fensters lässt sich hier nicht freigeben
    const app = setup({ caches, locks: null });
    await settle();
    app.input.value = "Mein Entwurf";
    attach(app, png("eigen.png"));
    app.setVisibility("hidden");
    await settle();
    // Noch eine Änderung, dann pagehide; das Gerät schreibt langsam, die Seite ist vorher weg
    app.input.value = "Mein Entwurf, länger";
    caches.hold();
    app.fire("pagehide");
    const after = setup({ caches, locks: null });
    await settle();
    expect(after.input.value).toBe("Mein Entwurf");
    expect(after.chipNames()).toEqual(["eigen.png"]);
  });

  test("verzögerte Cache-Schreibvorgänge: das neue Fenster wartet auf das Sichern, statt den Stand zu überspringen", async () => {
    const caches = fakeCaches();
    const locks = fakeLocks();
    const app = setup({ caches, locks });
    await settle();
    app.input.value = "Mein Entwurf";
    attach(app, png("eigen.png"), png("zwei.png"));
    // Die erste Datei liegt schon im Gerät, der Rest samt Beschreibung kommt später
    const release = caches.hold(1);
    app.setVisibility("hidden");
    await settle();
    expect((await draftKeys(caches)).length).toBe(1);
    const second = setup({ caches, locks });
    await settle();
    // Noch nichts übernommen: die Übernahme wartet auf die Sperre des schreibenden Fensters
    expect(second.chipNames()).toEqual([]);
    release();
    await settle();
    await settle();
    expect(second.input.value).toBe("Mein Entwurf");
    expect(second.chipNames()).toEqual(["eigen.png", "zwei.png"]);
    expect(await draftKeys(caches)).toEqual([]);
  });

  test("ohne Web Locks: ein noch unfertiger erster Stand wird abgewartet, nicht übersprungen", async () => {
    const caches = fakeCaches();
    const app = setup({ caches, locks: null });
    await settle();
    app.input.value = "Mein Entwurf";
    attach(app, png("eigen.png"), png("zwei.png"));
    const release = caches.hold(1);
    app.setVisibility("hidden");
    await settle();
    expect((await draftKeys(caches)).length).toBe(1);
    const second = setup({ caches, locks: null, timers: true });
    await settle();
    await Bun.sleep(50);
    release();
    await Bun.sleep(700);
    await settle();
    expect(second.input.value).toBe("Mein Entwurf");
    expect(second.chipNames()).toEqual(["eigen.png", "zwei.png"]);
    expect(await draftKeys(caches)).toEqual([]);
  });
});

describe("Entwürfe und Anmeldung", () => {
  test("Verlassen der Seite (Teilen lädt das Fenster neu) sichert Entwürfe im Tab, Abmelden nicht", async () => {
    const app = setup();
    await settle();
    app.input.value = "halb fertig";
    app.fire("pagehide");
    expect(JSON.parse(app.session["tybo-reload-drafts"])).toEqual({ drafts: { "topic-8": "halb fertig" } });
    // Aus dem Zurück-Cache: die Sicherung gilt nicht mehr
    app.fire("pageshow", { persisted: true });
    expect(app.session["tybo-reload-drafts"]).toBeUndefined();

    const out = setup();
    await settle();
    out.input.value = "geheim";
    out.elements["logout"].dispatch("click");
    out.fire("pagehide");
    expect(out.session["tybo-reload-drafts"]).toBeUndefined();
  });

  test("Sitzung abgelaufen: zur Anmeldung mit #/teilen, die Übergabe bleibt im Gerät liegen", async () => {
    const caches = fakeCaches();
    await putHandoff(caches, { text: "geteilt" });
    const app = setup({ hash: "#/teilen", caches, expired: true });
    await settle();
    expect(app.location.href).toBe("/login#/teilen");
    expect((await shareKeys(caches)).length).toBe(1);
    // Nach der Anmeldung (neuer Start mit #/teilen) kommt sie an
    const after = setup({ hash: "#/teilen", caches });
    await settle();
    expect(after.input.value).toBe("geteilt");
  });

  test("#/teilen übersteht die Anmeldung (keptHash in app.js und login.js)", async () => {
    // Sitzung abgelaufen: die App schickt zur Anmeldung und behält #/teilen
    const location: Record<string, string> = { href: "", hash: "" };
    const keep = (file: string, hash: string) => {
      const fn = new Function("document", "window", `${file}\nreturn keptHash;`);
      // Ohne #chat-log startet app.js nicht; login.js braucht nur sein Formular
      const doc = { getElementById: (id: string) => (id === "chat-log" ? null : { addEventListener() {} }) };
      return fn(doc, { location, isSecureContext: false })(hash);
    };
    for (const file of [source, loginSource]) {
      expect(keep(file, "#/teilen")).toBe("#/teilen");
      expect(keep(file, "#/teilen/fehler")).toBe("#/teilen/fehler");
      expect(keep(file, "#/teilen/x")).toBe("");
      expect(keep(file, "#/teilenx")).toBe("");
    }
  });

  test("index.html hat die Teilen-Zeile mit Knopf über den Anhängen", () => {
    expect(html).toMatch(/<div id="share-note" class="share-note" role="status" hidden>[\s\S]*id="share-text"[\s\S]*id="share-move"[\s\S]*Anderes Gespräch[\s\S]*id="attach-note"/);
  });
});
