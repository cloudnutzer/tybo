/**
 * Issue #354: Quellen-Lauf. Nicht bereite Quellen werden übersprungen,
 * Fehler und Zeitlimit einer Quelle halten die anderen nicht auf, ein
 * hängendes collect() wird nach dem Zeitlimit abgebrochen und sein spätes
 * Ergebnis verworfen. Ergebnis sind Abschnitte mit Einträgen, kein Markdown.
 */
import { describe, expect, test } from "bun:test";
import { checkedList, readySources, SOURCES } from "../src/lib/sources/list";
import { runSource, runSources, userTimeZone } from "../src/lib/sources/run";
import type { Section, Source, SourceContext } from "../src/lib/sources/types";

function source(id: string, collect: (ctx: SourceContext) => Promise<Section>, extra: Partial<Source> = {}): Source {
  return { id, label: id, ready: () => true, collect, ...extra };
}

const section = (...texts: string[]): Section => ({ items: texts.map(text => ({ text })) });

describe("runSources", () => {
  test("Ausgänge in Listen-Reihenfolge, nicht bereite übersprungen", async () => {
    const list = [
      source("a", async () => section("eins")),
      source("aus", async () => section("nie"), { ready: () => false }),
      source("b", async () => section("zwei", "drei")),
    ];
    const outcomes = await runSources(list, { env: {} });
    expect(outcomes.map(o => [o.source.id, o.status])).toEqual([
      ["a", "ok"],
      ["aus", "skipped"],
      ["b", "ok"],
    ]);
    const b = outcomes[2];
    expect(b.status === "ok" && b.section).toEqual({ items: [{ text: "zwei" }, { text: "drei" }] });
  });

  test("werfende Bereitschaftsprüfung gilt als nicht bereit, collect läuft nicht", async () => {
    let called = false;
    const odd = source("odd", async () => ((called = true), section("x")), {
      ready: () => {
        throw new Error("kaputt");
      },
    });
    expect((await runSource(odd, { env: {} })).status).toBe("skipped");
    expect(called).toBe(false);
  });

  test("Fehler einer Quelle: andere liefern trotzdem", async () => {
    const outcomes = await runSources(
      [
        source("kaputt", async () => {
          throw new Error("HTTP 401");
        }),
        source("sync-kaputt", (() => {
          throw new Error("sofort");
        }) as never),
        source("gut", async () => section("da")),
      ],
      { env: {} },
    );
    expect(outcomes[0]).toMatchObject({ status: "failed", error: "HTTP 401" });
    expect(outcomes[1]).toMatchObject({ status: "failed", error: "sofort" });
    expect(outcomes[2]).toMatchObject({ status: "ok", section: section("da") });
  });

  test("Zeitlimit: hängende Quelle bricht ab, Signal ausgelöst, späte Antwort verworfen", async () => {
    let signal: AbortSignal | undefined;
    let finishLate: (s: Section) => void = () => {};
    const hanging = source("haengt", ctx => {
      signal = ctx.signal;
      return new Promise<Section>(resolve => (finishLate = resolve));
    });
    const started = Date.now();
    const outcomes = await runSources([hanging, source("schnell", async () => section("ok"))], { env: {}, timeoutMs: 30 });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(outcomes[0].status).toBe("timeout");
    expect(outcomes[1].status).toBe("ok");
    expect(signal?.aborted).toBe(true);
    finishLate(section("zu spät"));
    await Bun.sleep(5);
    expect(outcomes[0].status).toBe("timeout");
  });

  test("Fehler nach dem Zeitlimit bleibt still", async () => {
    let failLate: (err: Error) => void = () => {};
    const outcome = await runSource(
      source("spaet", () => new Promise<Section>((_, reject) => (failLate = reject))),
      { env: {}, timeoutMs: 10 },
    );
    expect(outcome.status).toBe("timeout");
    failLate(new Error("danach"));
    await Bun.sleep(5);
  });

  test("eigenes Zeitlimit der Quelle geht vor dem des Laufs", async () => {
    const slow = source("langsam", () => Bun.sleep(40).then(() => section("fertig")), { timeoutMs: 500 });
    expect((await runSource(slow, { env: {}, timeoutMs: 5 })).status).toBe("ok");
    const strict = source("streng", () => Bun.sleep(200).then(() => section("fertig")), { timeoutMs: 10 });
    expect((await runSource(strict, { env: {}, timeoutMs: 5000 })).status).toBe("timeout");
  });

  test("Kontext: env, now, Zeitzone und fetch kommen an", async () => {
    const fakeFetch = (async () => new Response("x")) as unknown as typeof fetch;
    const now = new Date("2026-10-18T22:30:00Z");
    let seen: SourceContext | undefined;
    await runSource(
      source("ctx", async ctx => ((seen = ctx), section())),
      { env: { USER_TIMEZONE: "Europe/Berlin", X: "1" }, now, fetch: fakeFetch },
    );
    expect(seen?.env.X).toBe("1");
    expect(seen?.now).toBe(now);
    expect(seen?.timeZone).toBe("Europe/Berlin");
    expect(seen?.fetch).toBe(fakeFetch);
    expect(seen?.signal.aborted).toBe(false);
  });
});

describe("userTimeZone", () => {
  test("USER_TIMEZONE, leer oder unbekannt: UTC", () => {
    expect(userTimeZone({ USER_TIMEZONE: "America/New_York" })).toBe("America/New_York");
    expect(userTimeZone({})).toBe("UTC");
    expect(userTimeZone({ USER_TIMEZONE: "Mond/Krater" })).toBe("UTC");
  });
});

describe("Liste", () => {
  test("doppelte Kennung wirft", () => {
    expect(() => checkedList([source("a", async () => section()), source("a", async () => section())])).toThrow("doppelt");
  });

  test("readySources hält die Reihenfolge und filtert", () => {
    const list = [
      source("x", async () => section(), { ready: env => env.X === "1" }),
      source("y", async () => section()),
      source("z", async () => section(), { ready: env => env.Z === "1" }),
    ];
    expect(readySources(list, { Z: "1" }).map(s => s.id)).toEqual(["y", "z"]);
  });

  test("SOURCES hat eindeutige Kennungen und Namen", () => {
    expect(() => checkedList(SOURCES)).not.toThrow();
    for (const s of SOURCES) expect(s.label.length).toBeGreaterThan(0);
  });
});
