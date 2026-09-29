// Handy-Feinschliff in der Oberfläche (app.js, Issue #229): Zurück und
// Wischen unter 56rem mit eigenen Verlaufseinträgen, Kamera-Menü an der
// Büroklammer auf Touch-Geräten, sichtbare Höhe bei offener Tastatur
// (visualViewport). Reine Funktionen direkt, Abläufe mit den Attrappen aus
// app-mobile-fixture.ts (Verlauf wie im Browser: pushState, back, popstate).
import { describe, expect, test } from "bun:test";
import { css, html, png, settle, setup, source } from "./app-mobile-fixture";

const pure = new Function(
  "document",
  "window",
  `${source}\nreturn { keyboardViewport, navMark, navOnPop, navOnOpen, navOnClose, swipeGesture, SWIPE_EDGE_PX, SWIPE_MIN_PX };`
)({ getElementById: () => null }, {});

describe("reine Funktionen", () => {
  test("keyboardViewport: nur bei kleinerem oder verschobenem sichtbarem Bereich, nie bei Zoom", () => {
    const { keyboardViewport } = pure;
    expect(keyboardViewport(undefined, 844)).toBeNull();
    expect(keyboardViewport({ height: 844, offsetTop: 0, scale: 1 }, 844)).toBeNull();
    // Rundung: halbe Pixel sind keine Tastatur
    expect(keyboardViewport({ height: 843.5, offsetTop: 0, scale: 1 }, 844)).toBeNull();
    expect(keyboardViewport({ height: 500, offsetTop: 0, scale: 1 }, 844)).toEqual({ height: 500, top: 0 });
    // iOS schiebt die Seite beim Tippen hoch
    expect(keyboardViewport({ height: 480.4, offsetTop: 210.6, scale: 1 }, 844)).toEqual({ height: 480, top: 211 });
    expect(keyboardViewport({ height: 500, offsetTop: 0, scale: 2 }, 844)).toBeNull();
    expect(keyboardViewport({ height: 90, offsetTop: 0, scale: 1 }, 844)).toBeNull();
    expect(keyboardViewport({ height: 500, offsetTop: 0 }, 0)).toBeNull();
  });

  test("Verlaufseinträge: Markierung, Zurück, Öffnen und Schließen der Schublade", () => {
    const { navMark, navOnPop, navOnOpen, navOnClose } = pure;
    expect([{ tyboNav: "base" }, { tyboNav: "chat" }, { tyboNav: "drawer" }, { tyboNav: "x" }, null, "chat"].map(navMark))
      .toEqual(["base", "chat", "drawer", null, null, null]);
    expect(["base", "chat", "drawer", null].map(navOnPop)).toEqual(["open", "close", "open", null]);
    expect(["base", "chat", "drawer", null].map(navOnOpen)).toEqual([null, "push", null, null]);
    expect(["base", "chat", "drawer", null].map(navOnClose)).toEqual(["push", null, "back", null]);
  });

  test("Wischschwelle: Start in den ersten 20 px, mindestens 60 px, vor allem waagrecht", () => {
    const { swipeGesture, SWIPE_EDGE_PX, SWIPE_MIN_PX } = pure;
    expect([SWIPE_EDGE_PX, SWIPE_MIN_PX]).toEqual([20, 60]);
    const g = (x0: number, y0: number, x1: number, y1: number, open = false) => swipeGesture({ x: x0, y: y0 }, { x: x1, y: y1 }, open);
    expect(g(20, 300, 80, 300)).toBe("open");
    expect(g(0, 300, 200, 350)).toBe("open");
    expect(g(21, 300, 200, 300)).toBeNull();
    expect(g(10, 300, 69, 300)).toBeNull();
    // Zu steil: das ist Scrollen
    expect(g(10, 300, 110, 360)).toBeNull();
    expect(g(10, 300, 110, 350)).toBe("open");
    // Nach links schließt nur eine offene Schublade
    expect(g(250, 300, 190, 300, true)).toBe("close");
    expect(g(250, 300, 191, 300, true)).toBeNull();
    expect(g(250, 300, 150, 300, false)).toBeNull();
    expect(g(10, 300, 200, 300, true)).toBeNull();
    expect(swipeGesture(null, { x: 1, y: 1 }, false)).toBeNull();
  });
});

describe("Zurück am Handy (unter 56rem)", () => {
  const phone = (extra: Parameters<typeof setup>[0] = {}) => setup({ narrow: true, touch: true, browserHistory: true, ...extra });

  test("Kaltstart → Gespräch → Zurück → Liste → Gespräch wählen → Zurück → Liste → Zurück verlässt die App", async () => {
    const app = phone();
    await settle();
    expect(app.nav.entries.map(e => e.state)).toEqual([{ tyboNav: "base" }, { tyboNav: "chat" }]);
    expect(app.nav.index).toBe(1);
    expect(app.drawerOpen()).toBe(false);
    app.back();
    await settle();
    expect(app.drawerOpen()).toBe(true);
    expect(app.nav.exited).toBe(false);
    app.entry("topic-9").dispatch("click");
    await settle();
    expect(app.title()).toBe("Strategie");
    expect(app.drawerOpen()).toBe(false);
    // Kein doppelter Eintrag: wieder genau Liste und Gespräch
    expect(app.nav.entries.map(e => e.state)).toEqual([{ tyboNav: "base" }, { tyboNav: "chat" }]);
    expect(app.nav.index).toBe(1);
    app.back();
    await settle();
    expect(app.drawerOpen()).toBe(true);
    app.back();
    await settle();
    expect(app.nav.exited).toBe(true);
  });

  test("Menü öffnet mit eigenem Eintrag, Zurück schließt nur die Schublade", async () => {
    const app = phone();
    await settle();
    app.elements["menu"].dispatch("click");
    expect(app.drawerOpen()).toBe(true);
    expect(app.nav.entries.map(e => e.state)).toEqual([{ tyboNav: "base" }, { tyboNav: "chat" }, { tyboNav: "drawer" }]);
    app.back();
    await settle();
    expect(app.drawerOpen()).toBe(false);
    expect(app.nav.index).toBe(1);
    expect(app.title()).toBe("Recherche");
  });

  test("Scrim und Schließen gehen einen Schritt zurück; kein Wiederöffnen, keine Schleife", async () => {
    const app = phone();
    await settle();
    for (const closer of ["scrim", "sidebar-close"]) {
      app.elements["menu"].dispatch("click");
      expect(app.nav.index).toBe(2);
      app.elements[closer].dispatch("click");
      expect(app.drawerOpen()).toBe(false);
      await settle();
      expect({ closer, index: app.nav.index, open: app.drawerOpen() }).toEqual({ closer, index: 1, open: false });
    }
    expect(app.nav.pushes).toBe(3);
  });

  test("Gespräch aus der offenen Schublade wählen: Eintrag der Schublade weg, Zurück führt zur Liste", async () => {
    const app = phone();
    await settle();
    app.elements["menu"].dispatch("click");
    app.entry("topic-9").dispatch("click");
    await settle();
    expect(app.title()).toBe("Strategie");
    expect(app.drawerOpen()).toBe(false);
    expect(app.nav.index).toBe(1);
    app.back();
    await settle();
    expect(app.drawerOpen()).toBe(true);
    expect(app.nav.index).toBe(0);
  });

  test("Wischen: vom linken Rand öffnet (mit Eintrag), nach links schließt (Schritt zurück); nicht auf Code, nicht aus der Mitte", async () => {
    const app = phone();
    await settle();
    app.swipe(40, 300, 200, 300);
    expect(app.drawerOpen()).toBe(false);
    const code = { closest: (sel: string) => (sel.includes("pre") ? {} : null) };
    app.swipe(5, 300, 200, 300, code);
    expect(app.drawerOpen()).toBe(false);
    app.swipe(5, 300, 200, 310);
    expect(app.drawerOpen()).toBe(true);
    expect(app.nav.index).toBe(2);
    app.swipe(250, 300, 100, 305);
    expect(app.drawerOpen()).toBe(false);
    await settle();
    expect(app.nav.index).toBe(1);
    expect(app.drawerOpen()).toBe(false);
  });

  test("Direktlink aus einer Benachrichtigung (Kaltstart): Gespräch offen, Zurück zeigt die Liste und öffnet den Link nicht noch einmal", async () => {
    const app = phone({ hash: "#/gespraech/topic-9" });
    await settle();
    expect(app.title()).toBe("Strategie");
    // Liste ohne Direktlink, Gespräch mit geleerter Adresse, Markierung erhalten
    expect(app.nav.entries).toEqual([{ state: { tyboNav: "base" }, url: "/" }, { state: { tyboNav: "chat" }, url: "/" }]);
    app.entry("topic-8").dispatch("click");
    await settle();
    app.back();
    await settle();
    expect(app.drawerOpen()).toBe(true);
    expect(app.title()).toBe("Recherche");
  });

  test("Einstellungen aus der Schublade: Zurück schließt sie und zeigt wieder die Liste, dann das Gespräch", async () => {
    const app = phone({ withSettings: true });
    await settle();
    app.elements["menu"].dispatch("click");
    app.elements["open-settings"].dispatch("click");
    await settle();
    expect(app.elements["main"].getAttribute("data-view")).toBe("settings");
    expect(app.drawerOpen()).toBe(false);
    expect(app.location.hash).toBe("#/einstellungen/agenten");
    app.elements["settings-back"].dispatch("click");
    await settle();
    expect(app.elements["main"].getAttribute("data-view")).toBe("chat");
    expect(app.drawerOpen()).toBe(true);
    app.back();
    await settle();
    expect(app.drawerOpen()).toBe(false);
    expect(app.nav.index).toBe(1);
    expect(app.nav.exited).toBe(false);
  });

  test("Neuladen legt keine Einträge doppelt an; mit offener Schublade bleibt sie offen", async () => {
    const reloaded = phone({ historyState: { tyboNav: "chat" } });
    await settle();
    expect(reloaded.nav.entries.length).toBe(1);
    expect(reloaded.nav.pushes).toBe(0);
    const drawer = phone({ historyState: { tyboNav: "drawer" } });
    await settle();
    expect(drawer.drawerOpen()).toBe(true);
    expect(drawer.nav.pushes).toBe(0);
  });

  test("am Rechner (ab 56rem) keine Einträge und kein Wischen", async () => {
    const app = setup({ browserHistory: true });
    await settle();
    app.elements["menu"].dispatch("click");
    app.swipe(5, 300, 200, 300);
    expect(app.nav.pushes).toBe(0);
    expect(app.nav.entries.length).toBe(1);
    expect(app.windowListeners["popstate"] ?? []).toEqual([]);
  });

  test("Schublade gleitet mit prefers-reduced-motion nicht", () => {
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.sidebar, \.sidebar\[data-open="true"\] \{ transition: none; \}/);
  });
});

describe("Kamera an der Büroklammer", () => {
  test("Touch: Büroklammer öffnet das Menü; Foto aufnehmen öffnet die Kamera, das Foto wird Anhang", async () => {
    const app = setup({ touch: true });
    await settle();
    const attach = app.elements["attach"];
    expect(attach.attributes["aria-haspopup"]).toBe("menu");
    expect(attach.attributes["aria-expanded"]).toBe("false");
    attach.dispatch("click");
    expect(app.elements["attach-menu"].hidden).toBe(false);
    expect(attach.attributes["aria-expanded"]).toBe("true");
    expect(app.elements["file-input"].clicks).toBe(0);
    app.elements["attach-camera"].dispatch("click");
    expect(app.elements["attach-menu"].hidden).toBe(true);
    expect(app.elements["camera-input"].clicks).toBe(1);
    app.elements["camera-input"].files = [png("foto.png")];
    app.elements["camera-input"].dispatch("change");
    expect(app.chipNames()).toEqual(["foto.png"]);
    expect(app.elements["camera-input"].value).toBe("");
    // Datei wählen wie bisher
    attach.dispatch("click");
    app.elements["attach-file"].dispatch("click");
    expect(app.elements["file-input"].clicks).toBe(1);
    expect(app.server.posts()).toEqual([]);
  });

  test("Kamera liefert ein nicht erlaubtes Format (HEIC): verständlicher Hinweis, kein Anhang", async () => {
    const app = setup({ touch: true });
    await settle();
    app.elements["camera-input"].files = [new File([new Uint8Array([1, 2, 3])], "IMG_0001.HEIC", { type: "image/heic" })];
    app.elements["camera-input"].dispatch("change");
    expect(app.chipNames()).toEqual([]);
    expect(app.note()).toBe("Nur Bilder (PNG, JPEG, WebP, GIF), PDFs und Sprachdateien.");
  });

  test("Escape, zweiter Tipp und Tipp daneben schließen das Menü", async () => {
    const app = setup({ touch: true });
    await settle();
    const menu = app.elements["attach-menu"];
    app.elements["attach"].dispatch("click");
    app.fire("keydown", { key: "Escape" });
    expect(menu.hidden).toBe(true);
    app.elements["attach"].dispatch("click");
    app.elements["attach"].dispatch("click");
    expect(menu.hidden).toBe(true);
    app.elements["attach"].dispatch("click");
    app.fire("click", { target: { closest: () => null } });
    expect(menu.hidden).toBe(true);
  });

  test("am Rechner öffnet die Büroklammer direkt die Dateiwahl", async () => {
    const app = setup();
    await settle();
    app.elements["attach"].dispatch("click");
    expect(app.elements["file-input"].clicks).toBe(1);
    expect(app.elements["attach-menu"].hidden).toBe(true);
    expect(app.elements["attach"].attributes["aria-haspopup"]).toBeUndefined();
  });

  test("index.html: zweites Feld nur für Bilder mit Rückkamera, Menü mit zwei Einträgen", () => {
    expect(html).toContain('<input type="file" id="camera-input" accept="image/*" capture="environment" tabindex="-1" aria-hidden="true" hidden>');
    expect(html).toMatch(/<div id="attach-menu" class="attach-menu" role="menu"[^>]*hidden>[\s\S]*id="attach-camera"[\s\S]*Foto aufnehmen[\s\S]*id="attach-file"[\s\S]*Datei wählen/);
  });
});

describe("Tastatur und sichtbarer Bereich", () => {
  test("Tastatur auf: App-Rahmen auf die sichtbare Höhe, Verlauf bleibt unten; zu: zurück auf 100dvh", async () => {
    const app = setup({ viewport: { height: 844 }, layoutHeight: 844 });
    await settle();
    const log = app.elements["chat-log"];
    Object.assign(log, { scrollHeight: 2000, clientHeight: 600, scrollTop: 1400 });
    log.dispatch("scroll");
    expect(app.rootStyle).toEqual({});
    app.setViewport({ height: 500 });
    expect(app.rootStyle).toEqual({ "--app-height": "500px", "--app-top": "0px" });
    // Kleinerer Verlauf: wieder ganz nach unten
    Object.assign(log, { clientHeight: 256 });
    app.setViewport({ height: 499 });
    expect(log.scrollTop).toBe(2000);
    app.setViewport({ height: 844 });
    expect(app.rootStyle).toEqual({});
  });

  test("iOS schiebt hoch (offsetTop): Rahmen beginnt am sichtbaren Bereich", async () => {
    const app = setup({ viewport: { height: 844 }, layoutHeight: 844 });
    await settle();
    app.setViewport({ height: 480, offsetTop: 300 });
    expect(app.rootStyle).toEqual({ "--app-height": "480px", "--app-top": "300px" });
    // Zoom mit zwei Fingern: nichts anfassen
    app.setViewport({ height: 422, offsetTop: 100, scale: 2 });
    expect(app.rootStyle).toEqual({});
  });

  test("hochgescrollt gelesen: die Leseposition bleibt, wenn die Tastatur aufgeht", async () => {
    const app = setup({ viewport: { height: 844 }, layoutHeight: 844 });
    await settle();
    const log = app.elements["chat-log"];
    Object.assign(log, { scrollHeight: 2000, clientHeight: 600, scrollTop: 300 });
    log.dispatch("scroll");
    app.setViewport({ height: 500 });
    expect(log.scrollTop).toBe(300);
  });

  test("Viewport und CSS: interactive-widget, Rahmen aus den Variablen, sichere Bereiche links und rechts", async () => {
    expect(html).toContain('content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content"');
    const rule = (selector: string) => {
      const start = css.indexOf(`${selector} {`);
      expect(start).toBeGreaterThanOrEqual(0);
      return css.slice(start, css.indexOf("}", start));
    };
    const frame = rule("body.app");
    expect(frame).toContain("position: fixed;");
    expect(frame).toContain("top: var(--app-top, 0px);");
    expect(frame).toContain("height: var(--app-height, 100dvh);");
    for (const selector of [".sidebar", ".topbar", ".chat-log", ".composer", "body.login", ".settings-scroll"]) {
      expect({ selector, left: rule(selector).includes("env(safe-area-inset-left)") }).toEqual({ selector, left: true });
    }
    for (const selector of [".topbar", ".chat-log", ".composer", "body.login", ".settings-scroll"]) {
      expect({ selector, right: rule(selector).includes("env(safe-area-inset-right)") }).toEqual({ selector, right: true });
    }
    expect(rule(".actions-panel")).toContain("right: max(0.75rem, env(safe-area-inset-right));");
    for (const page of ["login.html", "offline.html"]) {
      const text = await Bun.file(new URL(`../src/web/public/${page}`, import.meta.url)).text();
      expect({ page, ok: text.includes("interactive-widget=resizes-content") }).toEqual({ page, ok: true });
    }
  });
});
