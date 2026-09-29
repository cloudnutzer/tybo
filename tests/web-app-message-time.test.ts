// Zeitstempel an Nachrichten (Issue #186): Formatierung heute, gestern,
// dieses Jahr, anderes Jahr. Feste Uhr (now-Parameter) und feste Zeitzone
// (Europe/Berlin, mit Sommerzeit); app.js wird als klassisches Skript
// ausgewertet wie in web-app-notice.test.ts.
import { afterAll, afterEach, beforeAll, describe, expect, setSystemTime, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const publicDir = resolve(import.meta.dir, "..", "src", "web", "public");
const source = await readFile(resolve(publicDir, "app.js"), "utf8");
const css = await readFile(resolve(publicDir, "style.css"), "utf8");

interface FakeNode {
  tagName: string;
  children: FakeNode[];
  attributes: Record<string, string>;
  textContent: string;
  className: string;
  innerHTMLWrites: string[];
  [key: string]: any;
}

function fakeNode(tagName: string): FakeNode {
  const n: FakeNode = {
    tagName: tagName.toUpperCase(),
    children: [],
    attributes: {},
    textContent: "",
    className: "",
    innerHTMLWrites: [],
    appendChild(child: FakeNode) {
      this.children.push(child);
      return child;
    },
    setAttribute(name: string, value: string) {
      this.attributes[name] = String(value);
    },
    getAttribute(name: string) {
      return this.attributes[name];
    },
    addEventListener() {},
  };
  Object.defineProperty(n, "innerHTML", {
    set(v: string) {
      n.innerHTMLWrites.push(v);
    },
  });
  return n;
}

const document = {
  getElementById: () => null,
  createElement: (tag: string) => fakeNode(tag),
  createElementNS: (_ns: string, tag: string) => fakeNode(tag),
};
const app = new Function(
  "document",
  "window",
  `${source}\nreturn { messageTime, messageElement, localDay, msUntilNextDay };`
)(document, { TYBO_BRAND: { name: "tybo" } }) as {
  messageTime(value: unknown, now?: number): { short: string; full: string } | null;
  messageElement(m: object, agent?: string): FakeNode;
  localDay(ms: number): string;
  msUntilNextDay(now: number): number;
};

afterEach(() => setSystemTime());

let previousTz: string | undefined;
beforeAll(() => {
  previousTz = process.env.TZ;
  process.env.TZ = "Europe/Berlin";
});
afterAll(() => {
  if (previousTz === undefined) delete process.env.TZ;
  else process.env.TZ = previousTz;
});

/** Ortszeit Berlin als Millisekunden (TZ ist gesetzt) */
const local = (y: number, mo: number, d: number, h = 12, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();
/** Dieselbe Nachricht: 26.09.2026, 21:08 Uhr in Berlin (Sommerzeit, UTC+2) */
const AT = "2026-09-26T19:08:00.000Z";
const short = (value: unknown, now: number) => app.messageTime(value, now)?.short;

describe("messageTime", () => {
  test("gleiche Zeit je nach Tag: „21:08“, „gestern 21:08“, „26.09. 21:08“, „26.09.2025 21:08“", () => {
    expect(short(AT, local(2026, 9, 26, 23, 30))).toBe("21:08");
    expect(short(AT, local(2026, 9, 27, 9))).toBe("gestern 21:08");
    expect(short(AT, local(2026, 9, 28, 9))).toBe("26.09. 21:08");
    expect(short(AT, local(2027, 1, 5))).toBe("26.09.2026 21:08");
    expect(short("2025-09-26T19:08:00.000Z", local(2026, 9, 27))).toBe("26.09.2025 21:08");
  });

  test("Mitternacht: Kalendertage zählen, nicht 24 Stunden", () => {
    // 23:59 und 00:01 liegen zwei Minuten auseinander, aber an zwei Tagen
    const lateEvening = new Date(local(2026, 9, 26, 23, 59)).toISOString();
    expect(short(lateEvening, local(2026, 9, 26, 23, 59))).toBe("23:59");
    expect(short(lateEvening, local(2026, 9, 27, 0, 1))).toBe("gestern 23:59");
    // Kurz nach Mitternacht geschrieben, kurz vor Mitternacht gelesen: noch heute
    const earlyMorning = new Date(local(2026, 9, 27, 0, 1)).toISOString();
    expect(short(earlyMorning, local(2026, 9, 27, 23, 59))).toBe("00:01");
    // Vorgestern um 23:59 ist nicht gestern, auch wenn es keine 48 Stunden her ist
    expect(short(lateEvening, local(2026, 9, 28, 0, 1))).toBe("26.09. 23:59");
  });

  test("Jahreswechsel: der 31. Dezember ist am 1. Januar „gestern“, davor mit Jahr", () => {
    const newYearsEve = new Date(local(2026, 12, 31, 22, 15)).toISOString();
    expect(short(newYearsEve, local(2027, 1, 1, 0, 5))).toBe("gestern 22:15");
    expect(short(newYearsEve, local(2027, 1, 2, 10))).toBe("31.12.2026 22:15");
    expect(short(new Date(local(2026, 12, 30, 8)).toISOString(), local(2027, 1, 1, 10))).toBe("30.12.2026 08:00");
  });

  test("Sommerzeit-Umstellung: der Tag davor bleibt „gestern“", () => {
    // 25.10.2026 hat in Berlin 25 Stunden; 24.10. 23:30 ist am 25.10. 23:30 trotzdem gestern
    const before = new Date(local(2026, 10, 24, 23, 30)).toISOString();
    expect(short(before, local(2026, 10, 25, 23, 30))).toBe("gestern 23:30");
    // 29.03.2026 hat 23 Stunden
    const spring = new Date(local(2026, 3, 28, 0, 30)).toISOString();
    expect(short(spring, local(2026, 3, 29, 23, 45))).toBe("gestern 00:30");
  });

  test("volles Datum für Tooltip und Screenreader", () => {
    expect(app.messageTime(AT, local(2026, 9, 27))!.full).toBe("Samstag, 26. September 2026, 21:08 Uhr");
    expect(app.messageTime("2027-03-01T07:05:00.000Z", local(2027, 3, 1))!.full).toBe("Montag, 1. März 2027, 08:05 Uhr");
  });

  test("Postgres-Mikrosekunden werden gelesen", () => {
    expect(short("2026-09-26T19:08:00.123456Z", local(2026, 9, 26, 22))).toBe("21:08");
    expect(short("2026-09-26T19:08:00.123456+00:00", local(2026, 9, 26, 22))).toBe("21:08");
  });

  test("ohne gültigen Zeitpunkt: null, nie „Invalid Date“", () => {
    for (const value of [undefined, null, "", "kein Datum", 1_790_000_000_000, {}]) {
      expect(app.messageTime(value, local(2026, 9, 27))).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// Im Verlauf: Metazeile der Antwort, eigene Nachrichten
// ---------------------------------------------------------------------------

/** <time> einer Nachricht: in der Fußzeile der Antwort bzw. direkt unter der eigenen Nachricht */
function timeOf(node: FakeNode): FakeNode | undefined {
  const foot = node.children.find(c => c.className === "msg-foot");
  return (foot ?? node).children.find(c => String(c.className).split(" ").includes("msg-time"));
}
const shownText = (at: FakeNode) => at.children[0]!.textContent;

const REPLY = {
  id: "a1",
  role: "assistant",
  text: "fertig",
  html: "<p>fertig</p>",
  copyText: "fertig",
  createdAt: AT,
  agent: "general",
  model: "claude-opus-5-5",
  durationMs: 1_002_000,
};

describe("Zeitstempel im Verlauf", () => {
  test("Antwort: „21:08“ vorn in der Fußzeile, danach „General · claude-opus-5-5 · 16 min 42 s“", () => {
    setSystemTime(new Date(local(2026, 9, 26, 22)));
    const foot = app.messageElement(REPLY, "general").children.find(c => c.className === "msg-foot")!;
    expect(foot.children.map(c => c.className)).toEqual(["icon-button copy-button", "msg-time", "msg-meta", "copy-status"]);
    const at = timeOf(app.messageElement(REPLY, "general"))!;
    expect(at.tagName).toBe("TIME");
    expect(shownText(at)).toBe("21:08");
    expect(foot.children[2]!.textContent).toBe("General · claude-opus-5-5 · 16 min 42 s");
  });

  test("datetime, title und vorlesbarer Text; sichtbare Kurzform für Screenreader verborgen", () => {
    setSystemTime(new Date(local(2026, 9, 27, 9)));
    const at = timeOf(app.messageElement(REPLY))!;
    expect(at.attributes["datetime"]).toBe(AT);
    expect(at.attributes["title"]).toBe("Samstag, 26. September 2026, 21:08 Uhr");
    const [shown, spoken] = at.children;
    expect(shown!.attributes["aria-hidden"]).toBe("true");
    expect(shown!.textContent).toBe("gestern 21:08");
    expect(spoken!.className).toBe("visually-hidden");
    expect(spoken!.textContent).toBe("Samstag, 26. September 2026, 21:08 Uhr");
    // Nur Text, kein HTML
    for (const n of [at, shown!, spoken!]) expect(n.innerHTMLWrites).toEqual([]);
  });

  test("gleiche Nachricht an verschiedenen Tagen: „21:08“, „gestern 21:08“, „26.09. 21:08“, „26.09.2026 21:08“", () => {
    const cases: [number, string][] = [
      [local(2026, 9, 26, 23), "21:08"],
      [local(2026, 9, 27, 8), "gestern 21:08"],
      [local(2026, 10, 3), "26.09. 21:08"],
      [local(2027, 2, 1), "26.09.2026 21:08"],
    ];
    for (const [now, expected] of cases) {
      setSystemTime(new Date(now));
      expect(shownText(timeOf(app.messageElement(REPLY))!)).toBe(expected);
      expect(shownText(timeOf(app.messageElement({ id: "u1", role: "user", text: "Frage", createdAt: AT }))!)).toBe(expected);
    }
  });

  test("eigene Nachricht: Uhrzeit hinter der Blase, als eigenes Element (per CSS darunter, rechtsbündig)", () => {
    setSystemTime(new Date(local(2026, 9, 26, 22)));
    const node = app.messageElement({ id: "u1", role: "user", text: "Frage", createdAt: "2026-09-26T19:08:00.123456Z" });
    expect(node.className).toBe("msg msg-user");
    expect(node.children.map(c => c.className)).toEqual(["bubble", "msg-time msg-user-time"]);
    expect(node.children[0]!.textContent).toBe("Frage");
    expect(shownText(node.children[1]!)).toBe("21:08");
    expect(node.children[1]!.attributes["datetime"]).toBe("2026-09-26T19:08:00.123456Z");
    // Keine Fußzeile wie bei Antworten
    expect(node.children.some(c => c.className === "msg-foot")).toBe(false);
  });

  test("eigene Nachricht nur mit Anhang: Karten, dann Uhrzeit, keine leere Blase", () => {
    setSystemTime(new Date(local(2026, 9, 26, 22)));
    const node = app.messageElement({
      id: "u2", role: "user", text: "", createdAt: AT,
      attachments: [{ name: "plan.pdf", size: 1200, mime: "application/pdf", url: "/api/conversations/dm/attachments/0b6f3c1e-2a4d-4c8e-9f10-1a2b3c4d5e6f" }],
    });
    expect(node.className).toBe("msg msg-user msg-with-attachments");
    expect(node.children.map(c => c.className)).toEqual(["msg-attachments", "msg-time msg-user-time"]);
    expect(shownText(node.children[1]!)).toBe("21:08");
  });

  test("ohne gültiges createdAt: keine Zeit, kein „Invalid Date“", () => {
    setSystemTime(new Date(local(2026, 9, 26, 22)));
    for (const createdAt of [undefined, "", "kein Datum", null]) {
      const user = app.messageElement({ id: "u3", role: "user", text: "Frage", createdAt });
      expect(user.children.map(c => c.className)).toEqual(["bubble"]);
      const reply = app.messageElement({ ...REPLY, createdAt });
      expect(timeOf(reply)).toBeUndefined();
      expect(JSON.stringify(reply.children.map(c => c.textContent))).not.toContain("Invalid");
    }
  });

  test("Fehler, Stopp-Notiz und Meldungen bleiben wie bisher", () => {
    setSystemTime(new Date(local(2026, 9, 26, 22)));
    const error = app.messageElement({ id: "e1", role: "error", text: "kaputt", createdAt: AT });
    expect(timeOf(error)).toBeUndefined();
    // Meldungen behalten ihre Uhrzeit im Kopf (Issue #47), unverändert
    const notice = app.messageElement({ id: "n1", role: "assistant", kind: "notice", source: "pipeline", text: "läuft", html: "<p>läuft</p>", createdAt: AT });
    const head = notice.children[0]!;
    expect(head.children[1]!.className).toBe("notice-time");
    expect(head.children[1]!.textContent).toBe("21:08");
  });

  test("CSS: eigene Nachricht als Spalte rechtsbündig, Zeit leise, Trenner nicht vorgelesen, Kurzform bricht nicht", () => {
    expect(css).toContain(".msg-user { flex-direction: column; align-items: flex-end; }");
    expect(css).toMatch(/\.msg-user-time \{[^}]*color: var\(--muted\);[^}]*font-size: 0\.75rem;/);
    expect(css).toContain('.msg-time + .msg-meta::before { content: "·"; content: "·" / "";');
    expect(css).toMatch(/\.msg-time \{[^}]*white-space: nowrap;/);
    expect(css).toMatch(/\.visually-hidden \{[^}]*position: absolute;[^}]*clip-path: inset\(50%\);/);
    // Fußzeile bleibt eine Reihe, nur die Metazeile bricht um; Knopf, Zeit und Status schrumpfen nicht
    expect(css).toMatch(/\.msg-foot \{[^}]*flex-wrap: nowrap;[^}]*align-items: flex-start;/);
    expect(css).toContain(".msg-foot > .copy-button, .msg-time, .copy-status { flex: none; }");
  });
});

describe("Tageswechsel", () => {
  test("localDay trennt Kalendertage, msUntilNextDay zielt kurz hinter Mitternacht", () => {
    expect(app.localDay(local(2026, 9, 26, 23, 59))).not.toBe(app.localDay(local(2026, 9, 27, 0, 1)));
    expect(app.localDay(local(2026, 9, 27, 0, 1))).toBe(app.localDay(local(2026, 9, 27, 23, 59)));
    const now = local(2026, 9, 26, 21, 8);
    expect(now + app.msUntilNextDay(now)).toBe(local(2026, 9, 27, 0, 0) + 1000);
    // Tag mit 25 Stunden (Ende der Sommerzeit)
    const autumn = local(2026, 10, 25, 0, 30);
    expect(autumn + app.msUntilNextDay(autumn)).toBe(local(2026, 10, 26, 0, 0) + 1000);
  });
});
