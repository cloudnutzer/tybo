/**
 * Issue #60: die Terminal-Anwendung (src/terminal/app.ts) mit einem
 * nachgebildeten TTY gegen einen echten Web-Server nur im Test. Tasten gehen
 * als Bytes hinein wie aus einem Terminal im Raw-Modus, die Ausgabe wird
 * mitgeschrieben. Prüft Strg+C (Stopp, zweimal beenden), Statuszeile,
 * Telegram-Nachrichten live, Entwurf bei Fehlern und NO_COLOR.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { ApiClient, tokenFromFile } from "../src/terminal/api";
import { runChatApp } from "../src/terminal/app";
import { SYNC_ATTEMPTS } from "../src/terminal/session";
import { FakeStdin, FakeStdout, startTyboServer, waitFor, type TyboServerOptions, type TerminalTestServer } from "./terminal-fixture";

let servers: TerminalTestServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop();
});

interface StartOptions {
  now?: () => number;
  /** Eingabe aus einer Pipe statt aus dem Terminal */
  pipe?: boolean;
  client?: (s: TerminalTestServer) => ApiClient;
  server?: TyboServerOptions;
}

async function start(id: string, env: Record<string, string> = {}, options: StartOptions = {}) {
  const s = await startTyboServer(options.server);
  servers.push(s);
  const conversation = (await s.client().listConversations()).find(c => c.id === id)!;
  const stdin = new FakeStdin();
  if (options.pipe) stdin.isTTY = false;
  const stdout = new FakeStdout();
  const signals = new Map<string, () => void>();
  const exit = runChatApp({
    client: options.client ? options.client(s) : s.client(),
    conversation,
    stdin,
    stdout,
    env,
    onSignal: (signal, handler) => {
      signals.set(signal, handler);
      return () => signals.delete(signal);
    },
    live: { retryMinMs: 100, retryMaxMs: 200 },
    now: options.now,
    tickMs: 50,
  });
  await waitFor(() => s.server.eventStreamCount() >= 1, 3000, "Live-Verbindung");
  return { s, stdin, stdout, exit, signals };
}

describe("Vollmodus (TTY mit Farbe)", () => {
  test("Kopfzeile, Hinweiszeile, Raw-Modus und Bracketed Paste an", async () => {
    const { stdin, stdout, exit } = await start("topic-443");
    expect(stdout.text.split("\n")[0]).toBe("tybo · Recherche · Agent Research");
    expect(stdout.text).toContain("Enter sendet");
    expect(stdin.rawModes).toEqual([true]);
    expect(stdout.all).toContain("\u001b[?2004h");
    stdin.type("\u0004");
    expect(await exit).toBe(0);
    expect(stdin.rawModes).toEqual([true, false]);
    expect(stdout.all).toContain("\u001b[?2004l");
  });

  test("Enter sendet, Alt+Enter und \\ am Zeilenende machen mehrzeilig", async () => {
    const { s, stdin, exit } = await start("dm");
    stdin.type("erste\u001b\rzweite\\");
    stdin.type("\r");
    stdin.type("dritte\r");
    const turn = await s.telegramChat.turn("dm");
    expect(turn.opts.text).toBe("erste\nzweite\ndritte");
    expect(turn.opts.source).toBe("terminal");
    s.telegramChat.finish("dm", "ok");
    stdin.type("\u0004");
    await exit;
  });

  test("Fortschritt in der Statuszeile, danach verschwindet sie", async () => {
    const { s, stdin, stdout, exit } = await start("dm");
    stdin.type("recherchiere bitte\r");
    const turn = await s.telegramChat.turn("dm");
    await turn.opts.sink.progress({ kind: "tool", text: "WebSearch" });
    await waitFor(() => stdout.text.includes("Durchsucht das Web …"), 3000, "Statuszeile");
    s.telegramChat.finish("dm", "**Ergebnis** da");
    await waitFor(() => stdout.text.includes("Ergebnis da"), 3000, "Antwort");
    // Fett als Farbe, nicht als Sternchen
    expect(stdout.all).toContain("\u001b[1mErgebnis\u001b[22m");
    stdin.type("\u0004");
    await exit;
  });

  test("Strg+C während der Antwort ruft Stopp, zweites Strg+C beendet tybo", async () => {
    const { s, stdin, stdout, exit } = await start("dm");
    stdin.type("lange Aufgabe\r");
    await s.telegramChat.turn("dm");
    await waitFor(() => stdout.text.includes("Denkt nach …"), 3000, "Statuszeile");
    stdin.type("\u0003");
    await waitFor(() => s.telegramChat.stops.length === 1, 3000, "Stopp");
    expect(s.telegramChat.stops).toEqual(["dm"]);
    await waitFor(() => stdout.text.includes("Abgebrochen."), 3000, "Abbruchmeldung");
    stdin.type("\u0003");
    expect(await exit).toBe(0);
    expect(stdin.rawModes.at(-1)).toBe(false);
  });

  test("Strg+C ohne laufende Antwort: erst Hinweis, Entwurf bleibt; zweimal im Zeitfenster beendet", async () => {
    let now = 1_000_000;
    const { stdin, stdout, exit } = await start("dm", {}, { now: () => now });
    let exited = false;
    void exit.then(() => (exited = true));
    stdin.type("Entwurf");
    stdin.type("\u0003");
    await new Promise(r => setTimeout(r, 30));
    expect(exited).toBe(false);
    expect(stdout.text).toContain("Noch einmal Strg+C (oder Strg+D) beendet tybo.");
    // Nach dem Zeitfenster zählt der Druck wieder als erster
    now += 2500;
    stdin.type("\u0003");
    await new Promise(r => setTimeout(r, 30));
    expect(exited).toBe(false);
    expect(stdout.text.slice(stdout.text.lastIndexOf("›"))).toContain("Entwurf");
    now += 500;
    stdin.type("\u0003");
    expect(await exit).toBe(0);
  });

  test("Telegram-Nachricht im Gespräch erscheint live, die Eingabe bleibt stehen", async () => {
    const { s, stdin, stdout, exit } = await start("topic-443");
    stdin.type("halb getippt");
    s.receiveFromTelegram("topic-443", "user", "Nachricht vom Handy");
    await waitFor(() => stdout.text.includes("Nachricht vom Handy"), 3000, "Live-Nachricht");
    const tail = stdout.text.slice(stdout.text.indexOf("Nachricht vom Handy"));
    expect(tail).toContain("› halb getippt");
    stdin.type("\u0015\u0004");
    await exit;
  });

  test("Senden scheitert (Bot weg): Fehlermeldung, Entwurf bleibt in der Eingabe", async () => {
    const { s, stdin, stdout, exit } = await start("dm");
    await s.server.stop({ graceMs: 50 });
    stdin.type("wichtiger Text\r");
    await waitFor(() => stdout.text.includes("Keine Verbindung zum Bot, die Nachricht wurde nicht gesendet."), 3000, "Fehler");
    await waitFor(() => stdout.text.slice(stdout.text.lastIndexOf("›")).includes("wichtiger Text"), 3000, "Entwurf");
    stdin.type("\u0003\u0003");
    expect(await exit).toBe(0);
  });

  test("Steuerzeichen aus Nachrichten und Topic-Namen erreichen das Terminal nicht", async () => {
    const { s, stdin, stdout, exit } = await start("topic-443");
    s.receiveFromTelegram("topic-443", "assistant", "Hallo \u001b]0;Fenstertitel\u0007\u001b]52;c;Ym9lc2U=\u0007\u001b[2J\u009b31mWelt");
    await waitFor(() => stdout.text.includes("Hallo Welt"), 3000, "Nachricht");
    stdin.type("\u0004");
    await exit;
    expect(stdout.all).not.toContain("\u001b]");
    expect(stdout.all).not.toContain("\u001b[2J");
    expect(stdout.all).not.toContain("\u009b");
  });

  test("Neuzeichnen löscht nur den eigenen Bereich, auch bei unbekannter Breite und langer Eingabe", async () => {
    const { s, stdin, stdout, exit } = await start("topic-443");
    (stdout as { columns?: number }).columns = 0;
    stdin.type("Entwurf, der stehen bleibt");
    s.receiveFromTelegram("topic-443", "user", "live dazwischen");
    await waitFor(() => stdout.text.includes("live dazwischen"), 3000, "Live-Nachricht");
    // Eine Zeile Eingabe ohne Statuszeile: nie eine Zeile nach oben löschen
    expect(stdout.all).not.toContain("\u001b[1A\u001b[J");
    (stdout as { columns?: number }).columns = 20;
    stdin.type(" und noch mehr Text");
    // 47 Zeichen bei 20 Spalten: drei Zeilen, der Cursor am Ende, also zwei Zeilen zurück
    s.receiveFromTelegram("topic-443", "user", "zweite");
    await waitFor(() => stdout.text.includes("zweite"), 3000, "zweite Live-Nachricht");
    expect(stdout.all).toContain("\r\u001b[2A\u001b[J");
    stdin.type("\u0015\u0004");
    await exit;
  });

  test("/tasten zeigt die Tasten lokal und sendet nichts", async () => {
    const { s, stdin, stdout, exit } = await start("dm");
    stdin.type("/tasten\r");
    await waitFor(() => stdout.text.includes("Tasten im Chat:"), 3000, "Hilfe");
    expect(s.telegramChat.calls).toHaveLength(0);
    stdin.type("\u0004");
    await exit;
  });
});

describe("NO_COLOR", () => {
  test("keine einzige Escape-Sequenz, auch nicht im Status; Strg+C als Signal", async () => {
    const { s, stdin, stdout, exit, signals } = await start("dm", { NO_COLOR: "1" });
    expect(stdin.rawModes).toEqual([]);
    stdin.type("Frage\n");
    const turn = await s.telegramChat.turn("dm");
    await turn.opts.sink.progress({ kind: "tool", text: "WebFetch" });
    await waitFor(() => stdout.all.includes("… Ruft eine Seite ab …"), 3000, "Status als Zeile");
    signals.get("SIGINT")!();
    await waitFor(() => s.telegramChat.stops.length === 1, 3000, "Stopp per Signal");
    await waitFor(() => stdout.all.includes("Abgebrochen."), 3000, "Abbruch");
    s.receiveFromTelegram("dm", "assistant", "# Titel\n\n**fett** `code`");
    await waitFor(() => stdout.all.includes("Titel\n====="), 3000, "Markdown schlicht");
    stdin.emit("end");
    expect(await exit).toBe(0);
    expect(stdout.all).not.toContain("\u001b");
    expect(stdout.all).toContain("fett `code`");
  });
});

describe("Pipe: Ende erst nach dem Abgleich einer Wiederverbindung", () => {
  test("Eingabe beendet, Verbindung weg, Antwort in der Lücke, verzögerter Abgleich: Antwort genau einmal vor dem Exit", async () => {
    let eventCalls = 0;
    let cut: (() => void) | null = null;
    let reconnect: () => void = () => {};
    const gate = new Promise<void>(r => (reconnect = r));
    let delayMessages = false;
    let delayedGets = 0;
    const { s, stdin, stdout, exit } = await start("dm", {}, {
      pipe: true,
      client: srv =>
        new ApiClient({
          base: srv.base,
          getToken: tokenFromFile(srv.tokenFile),
          fetch: (async (url: string, init: RequestInit) => {
            const path = new URL(String(url)).pathname;
            if (path.endsWith("/messages") && (init.method ?? "GET") === "GET" && delayMessages) {
              delayedGets++;
              await new Promise(r => setTimeout(r, 300));
            }
            if (!path.endsWith("/events")) return fetch(url, init);
            // Zweite Live-Verbindung erst, wenn der Test das Tor öffnet
            if (++eventCalls > 1) {
              await gate;
              return fetch(url, init);
            }
            // Erste Live-Verbindung reicht durch, bis der Test sie kappt (wie ein Netzausfall)
            const reader = (await fetch(url, init)).body!.getReader();
            return new Response(
              new ReadableStream<Uint8Array>({
                start(c) {
                  let open = true;
                  cut = () => {
                    if (!open) return;
                    open = false;
                    void reader.cancel();
                    c.close();
                  };
                  void (async () => {
                    for (;;) {
                      const r = await reader.read().catch(() => ({ done: true as const, value: undefined }));
                      if (r.done || !open) break;
                      c.enqueue(r.value);
                    }
                  })();
                },
              }),
              { status: 200 }
            );
          }) as typeof fetch,
        }),
    });
    let exited = false;
    void exit.then(() => (exited = true));
    stdin.type("Frage aus der Pipe\n");
    stdin.emit("end");
    await s.telegramChat.turn("dm");
    // Die erste Live-Verbindung kann nach dem Turn noch im Aufbau sein: erst kappen, wenn sie steht
    await waitFor(() => cut !== null, 3000, "Live-Verbindung");
    cut!();
    await waitFor(() => stdout.all.includes("Verbindung zum Bot unterbrochen"), 3000, "Abbruch");
    // Der echte Turn speichert die Antwort in Supabase; hier legt der Test sie im Verlauf der Attrappe ab
    s.telegram.receive("dm", "assistant", "Antwort aus der Lücke", "general");
    s.telegramChat.finish("dm", "Antwort aus der Lücke");
    delayMessages = true;
    reconnect();
    await waitFor(() => stdout.all.includes("Wieder verbunden."), 3000, "Wiederverbindung");
    // status(running:false) ist da, der Abgleich hängt noch: tybo darf nicht enden
    await new Promise(r => setTimeout(r, 150));
    expect(exited).toBe(false);
    expect(await exit).toBe(0);
    expect(delayedGets).toBeGreaterThanOrEqual(1);
    expect(stdout.all.split("Antwort aus der Lücke")).toHaveLength(2);
  });

  /**
   * Pipe mit gekappter erster Live-Verbindung; nach der Wiederverbindung
   * scheitern die ersten failGets Verlaufs-GETs: mit künstlichem HTTP 500
   * oder (source) als Lesefehler der Telegram-Verlaufsquelle hinter dem Server
   */
  async function pipeWithFailingSync(failGets: number, via: "http" | "source" = "http") {
    let eventCalls = 0;
    let cut: (() => void) | null = null;
    let reconnect: () => void = () => {};
    const gate = new Promise<void>(r => (reconnect = r));
    let failing = false;
    let failed = 0;
    const started = await start("dm", {}, {
      pipe: true,
      server: {
        historyFails: () => {
          if (via !== "source" || !failing || failed >= failGets) return false;
          failed++;
          return true;
        },
      },
      client: srv =>
        new ApiClient({
          base: srv.base,
          getToken: tokenFromFile(srv.tokenFile),
          fetch: (async (url: string, init: RequestInit) => {
            const path = new URL(String(url)).pathname;
            if (via === "http" && failing && path.endsWith("/messages") && (init.method ?? "GET") === "GET" && failed < failGets) {
              failed++;
              return new Response("kaputt", { status: 500 });
            }
            if (!path.endsWith("/events")) return fetch(url, init);
            if (++eventCalls > 1) {
              await gate;
              return fetch(url, init);
            }
            const reader = (await fetch(url, init)).body!.getReader();
            return new Response(
              new ReadableStream<Uint8Array>({
                start(c) {
                  let open = true;
                  cut = () => {
                    if (!open) return;
                    open = false;
                    void reader.cancel();
                    c.close();
                  };
                  void (async () => {
                    for (;;) {
                      const r = await reader.read().catch(() => ({ done: true as const, value: undefined }));
                      if (r.done || !open) break;
                      c.enqueue(r.value);
                    }
                  })();
                },
              }),
              { status: 200 }
            );
          }) as typeof fetch,
        }),
    });
    const { s, stdin, stdout } = started;
    stdin.type("Frage aus der Pipe\n");
    stdin.emit("end");
    await s.telegramChat.turn("dm");
    // Die erste Live-Verbindung kann nach dem Turn noch im Aufbau sein: erst kappen, wenn sie steht
    await waitFor(() => cut !== null, 3000, "Live-Verbindung");
    cut!();
    await waitFor(() => stdout.all.includes("Verbindung zum Bot unterbrochen"), 3000, "Abbruch");
    s.telegram.receive("dm", "assistant", "Antwort aus der Lücke", "general");
    s.telegramChat.finish("dm", "Antwort aus der Lücke");
    failing = true;
    reconnect();
    return { ...started, failedGets: () => failed };
  }

  test("erster Verlaufs-GET nach der Wiederverbindung scheitert, der nächste gelingt: Antwort genau einmal, Exit 0 (PR #83)", async () => {
    const { stdout, exit, failedGets } = await pipeWithFailingSync(1);
    expect(await exit).toBe(0);
    expect(failedGets()).toBe(1);
    expect(stdout.all.split("Antwort aus der Lücke")).toHaveLength(2);
  });

  test("Verlaufsabgleich scheitert endgültig: Fehlermeldung und Exit 1 statt Erfolg ohne Antwort (PR #83)", async () => {
    const { stdout, exit, failedGets } = await pipeWithFailingSync(SYNC_ATTEMPTS);
    expect(await exit).toBe(1);
    expect(failedGets()).toBe(SYNC_ATTEMPTS);
    expect(stdout.all).toContain("Nachrichten aus der Unterbrechung ließen sich nicht laden, es kann etwas fehlen.");
    expect(stdout.all).not.toContain("Antwort aus der Lücke");
  });

  test("Lesefehler der Telegram-Verlaufsquelle beim ersten Abgleich, danach gelingt der Abruf: Antwort genau einmal, Exit 0 (PR #83, Runde 4)", async () => {
    const { stdout, exit, failedGets } = await pipeWithFailingSync(1, "source");
    expect(await exit).toBe(0);
    expect(failedGets()).toBe(1);
    expect(stdout.all.split("Antwort aus der Lücke")).toHaveLength(2);
  });

  test("Telegram-Verlaufsquelle bleibt unlesbar: Fehlermeldung und Exit 1 statt Erfolg ohne Antwort (PR #83, Runde 4)", async () => {
    const { stdout, exit, failedGets } = await pipeWithFailingSync(SYNC_ATTEMPTS, "source");
    expect(await exit).toBe(1);
    expect(failedGets()).toBe(SYNC_ATTEMPTS);
    expect(stdout.all).toContain("Nachrichten aus der Unterbrechung ließen sich nicht laden, es kann etwas fehlen.");
    expect(stdout.all).not.toContain("Antwort aus der Lücke");
  });
});

describe("Pipe: verspäteter Anfangsstatus", () => {
  test("Anfangsstatus running:false kommt erst nach POST 202 und EOF: tybo wartet auf die Antwort und gibt sie genau einmal aus (PR #83, Runde 3)", async () => {
    let releaseStatus: () => void = () => {};
    const statusReleased = new Promise<void>(r => (releaseStatus = r));
    let releaseGet: () => void = () => {};
    const getReleased = new Promise<void>(r => (releaseGet = r));
    let releaseRest: () => void = () => {};
    const restReleased = new Promise<void>(r => (releaseRest = r));
    let firstRead = false;
    let postDone = false;
    let holdGet = false;
    let getHeld = false;
    let getDone = false;
    const { s, stdin, stdout, exit } = await start("dm", {}, {
      pipe: true,
      client: srv =>
        new ApiClient({
          base: srv.base,
          getToken: tokenFromFile(srv.tokenFile),
          fetch: (async (url: string, init: RequestInit) => {
            const u = new URL(String(url));
            const method = init.method ?? "GET";
            if (u.pathname.endsWith("/messages") && method === "POST") {
              const res = await fetch(url, init);
              postDone = true;
              return res;
            }
            if (u.pathname.endsWith("/messages") && method === "GET" && holdGet) {
              // Abgleichs-GET nach dem Anfangsstatus: erst auf Freigabe abschließen
              holdGet = false;
              getHeld = true;
              await getReleased;
              const res = await fetch(url, init);
              const body = await res.text();
              getDone = true;
              return new Response(body, { status: res.status, headers: res.headers });
            }
            if (!u.pathname.endsWith("/events")) return fetch(url, init);
            // Anfangsstatus zurückhalten, alle weiteren Ereignisse (auch status running:true des Turns) erst nach dem Abgleichs-GET
            const reader = (await fetch(url, init)).body!.getReader();
            const first = await reader.read();
            firstRead = true;
            return new Response(
              new ReadableStream<Uint8Array>({
                async start(c) {
                  init.signal?.addEventListener("abort", () => {
                    // Der innere Stream hängt am selben Signal: ab Bun 1.4 ist er beim
                    // Abbruch schon mit AbortError beendet, cancel() lehnt dann ab (Issue #210)
                    reader.cancel().catch(() => {});
                    c.error(new Error("abgebrochen"));
                  });
                  await statusReleased;
                  if (init.signal?.aborted) return;
                  c.enqueue(first.value!);
                  await restReleased;
                  for (;;) {
                    const r = await reader.read().catch(() => ({ done: true as const, value: undefined }));
                    if (r.done || init.signal?.aborted) break;
                    c.enqueue(r.value);
                  }
                },
              }),
              { status: 200 }
            );
          }) as typeof fetch,
        }),
    });
    let exited = false;
    void exit.then(() => (exited = true));
    await waitFor(() => firstRead, 3000, "Anfangsstatus zurückgehalten");
    stdin.type("Frage aus der Pipe\n");
    await s.telegramChat.turn("dm");
    await waitFor(() => postDone, 3000, "POST 202");
    stdin.emit("end");
    holdGet = true;
    releaseStatus();
    await waitFor(() => getHeld, 3000, "Abgleichs-GET");
    releaseGet();
    await waitFor(() => getDone, 3000, "Abgleichs-GET mit running:true");
    await new Promise(r => setTimeout(r, 200));
    expect(exited).toBe(false);
    expect(stdout.all).not.toContain("Die echte Antwort");
    releaseRest();
    s.telegramChat.finish("dm", "Die echte Antwort");
    expect(await exit).toBe(0);
    expect(stdout.all.split("Die echte Antwort")).toHaveLength(2);
  });
});

describe("UTF-8 über Blockgrenzen", () => {
  const TEXT = "Grüße aus Köln 😀 und 👩‍💻, Maß: 5 €";

  test("Vollmodus: Bytes mitten in Umlauten und Emoji geteilt, POST-Text unverändert", async () => {
    const { s, stdin, exit } = await start("dm");
    stdin.typeBytewise(`${TEXT}\r`);
    const turn = await s.telegramChat.turn("dm");
    expect(turn.opts.text).toBe(TEXT);
    s.telegramChat.finish("dm", "ok");
    stdin.type("\u0004");
    expect(await exit).toBe(0);
  });

  test("Pipe: geteilte Bytes, letzte Zeile ohne Zeilenende wird bei EOF abgeschlossen", async () => {
    const { s, stdin, exit } = await start("dm", {}, { pipe: true });
    stdin.typeBytewise(`${TEXT}\n`);
    const first = await s.telegramChat.turn("dm");
    expect(first.opts.text).toBe(TEXT);
    stdin.typeBytewise(`zweite ${TEXT}`);
    stdin.emit("end");
    s.telegramChat.finish("dm", "ok");
    await waitFor(() => s.telegramChat.calls.length === 2, 3000, "zweite Nachricht");
    expect(s.telegramChat.calls[1].text).toBe(`zweite ${TEXT}`);
    s.telegramChat.finish("dm", "ok");
    expect(await exit).toBe(0);
  });

  test("Pipe: Eingabe endet mitten in einem Zeichen, der Rest wird zum Ersatzzeichen statt zu verschwinden", async () => {
    const { s, stdin, exit } = await start("dm", {}, { pipe: true });
    const bytes = Buffer.from("Ende 😀", "utf8");
    for (const byte of bytes.subarray(0, bytes.length - 2)) stdin.emit("data", Buffer.from([byte]));
    stdin.emit("end");
    const turn = await s.telegramChat.turn("dm");
    expect(turn.opts.text).toBe("Ende \uFFFD");
    s.telegramChat.finish("dm", "ok");
    expect(await exit).toBe(0);
  });
});

describe("Rückfragen als nummerierte Auswahl (Issue #120)", () => {
  const withChoices = { server: { choices: true } };
  const messagePosts = (s: TerminalTestServer) => s.telegramChat.calls.map(c => c.text);

  test("offene Rückfrage mit Nummern; 1 wählt die erste Option mit genau einem POST, Erledigt-Zeile genau einmal", async () => {
    const { s, stdin, stdout, exit } = await start("topic-443", {}, withChoices);
    const id = s.ask("topic-443", "Research möchte `Write` ausführen");
    await waitFor(() => stdout.text.includes("[1] Erlauben  [2] Ablehnen"), 3000, "Optionen");
    stdin.type("1\r");
    await waitFor(() => stdout.text.includes("Erledigt: Erlauben · im Terminal"), 3000, "Erledigt");
    await new Promise(r => setTimeout(r, 150));
    expect(s.choices!.decisions).toEqual([{ id, key: "ok", via: "terminal" }]);
    expect(stdout.text.split("Erledigt: Erlauben · im Terminal")).toHaveLength(2);
    expect(messagePosts(s)).toEqual([]);
    // Danach ist 1 wieder eine normale Nachricht
    stdin.type("1\r");
    await waitFor(() => messagePosts(s).length === 1, 3000, "Nachricht 1");
    expect(messagePosts(s)).toEqual(["1"]);
    expect(s.choices!.decisions).toHaveLength(1);
    stdin.type("\u0003\u0003");
    await exit;
  });

  test("/2 wählt ebenso; ungültige Nummer: Hinweis, nichts gesendet, Entwurf bleibt", async () => {
    const { s, stdin, stdout, exit } = await start("topic-443", {}, withChoices);
    const id = s.ask("topic-443", "Freigabe?");
    await waitFor(() => stdout.text.includes("[2] Ablehnen"), 3000, "Optionen");
    stdin.type("/5\r");
    await waitFor(() => stdout.text.includes("Keine Option 5 bei dieser Rückfrage, möglich sind 1 bis 2."), 3000, "Hinweis");
    await waitFor(() => stdout.text.slice(stdout.text.lastIndexOf("›")).includes("/5"), 3000, "Entwurf");
    expect(s.choices!.decisions).toEqual([]);
    stdin.type("\u0015/2\r");
    await waitFor(() => stdout.text.includes("Erledigt: Ablehnen · im Terminal"), 3000, "Erledigt");
    expect(s.choices!.decisions).toEqual([{ id, key: "no", via: "terminal" }]);
    expect(messagePosts(s)).toEqual([]);
    stdin.type("\u0003\u0003");
    await exit;
  });

  test("in Telegram entschieden: Erledigt-Zeile erscheint live, 1 geht danach als Nachricht", async () => {
    const { s, stdin, stdout, exit } = await start("topic-443", {}, withChoices);
    const id = s.ask("topic-443", "Freigabe?");
    await waitFor(() => stdout.text.includes("[1] Erlauben"), 3000, "Optionen");
    await s.choices!.decideIn("telegram", id, "no");
    await waitFor(() => stdout.text.includes("Erledigt: Ablehnen · in Telegram"), 3000, "Erledigt aus Telegram");
    stdin.type("/1\r");
    await waitFor(() => messagePosts(s).length === 1, 3000, "Nachricht");
    expect(messagePosts(s)).toEqual(["/1"]);
    expect(s.choices!.decisions).toEqual([{ id, key: "no", via: "telegram" }]);
    stdin.type("\u0003\u0003");
    await exit;
  });

  test("Auswahl während einer laufenden Antwort geht sofort raus, eine Nachricht bliebe gesperrt", async () => {
    const { s, stdin, stdout, exit } = await start("topic-443", {}, withChoices);
    stdin.type("recherchiere\r");
    await s.telegramChat.turn("topic-443");
    const id = s.ask("topic-443", "Research möchte `Bash` ausführen");
    await waitFor(() => stdout.text.includes("[1] Erlauben"), 3000, "Optionen");
    stdin.type("1\r");
    await waitFor(() => stdout.text.includes("Erledigt: Erlauben · im Terminal"), 3000, "Erledigt");
    expect(s.choices!.get(id)!.result).toMatchObject({ key: "ok", via: "terminal" });
    expect(stdout.text).not.toContain("Es läuft noch eine Antwort");
    stdin.type("noch was\r");
    await waitFor(() => stdout.text.includes("Es läuft noch eine Antwort"), 3000, "Sperre für Nachrichten");
    s.telegramChat.finish("topic-443", "fertig");
    stdin.type("\u0015\u0003\u0003");
    await exit;
  });

  test("ohne offene Rückfrage: 1 und /1 nach /gespraeche sind Nachrichten, /wechsel 1 wechselt wie bisher", async () => {
    const { s, stdin, stdout, exit } = await start("topic-443", {}, withChoices);
    stdin.type("/gespraeche\r");
    await waitFor(() => stdout.text.includes("Wechseln mit /wechsel"), 3000, "Liste");
    stdin.type("1\r");
    const turn = await s.telegramChat.turn("topic-443");
    expect(turn.opts.text).toBe("1");
    s.telegramChat.finish("topic-443", "ok");
    await waitFor(() => stdout.text.includes("ok"), 3000, "Antwort");
    await new Promise(r => setTimeout(r, 50));
    stdin.type("/1\r");
    await waitFor(() => messagePosts(s).length === 2, 3000, "zweite Nachricht");
    expect(messagePosts(s)).toEqual(["1", "/1"]);
    s.telegramChat.finish("topic-443", "ok2");
    await new Promise(r => setTimeout(r, 50));
    stdin.type("/wechsel 1\r");
    await waitFor(() => stdout.text.includes("tybo · Direktchat"), 3000, "Wechsel in Nr. 1");
    expect(s.choices!.decisions).toEqual([]);
    stdin.type("\u0003\u0003");
    await exit;
  });

  test("nach dem Gesprächswechsel gilt die offene Frage des alten Gesprächs nicht mehr", async () => {
    const { s, stdin, stdout, exit } = await start("topic-443", {}, withChoices);
    s.ask("topic-443", "Freigabe im alten Topic");
    await waitFor(() => stdout.text.includes("[1] Erlauben"), 3000, "Optionen");
    stdin.type("/wechsel dm\r");
    await waitFor(() => stdout.text.includes("tybo · Direktchat"), 3000, "Wechsel");
    await waitFor(() => s.server.eventStreamCount() >= 1, 3000, "Live-Verbindung");
    stdin.type("1\r");
    const turn = await s.telegramChat.turn("dm");
    expect(turn.opts.text).toBe("1");
    expect(s.choices!.decisions).toEqual([]);
    s.telegramChat.finish("dm", "ok");
    stdin.type("\u0003\u0003");
    await exit;
  });

  test("Pipe: offene Frage aus dem Verlauf, Zeile 1 wählt sie, dann Ende mit 0", async () => {
    const s0 = await startTyboServer({ choices: true });
    servers.push(s0);
    const id = s0.ask("topic-443", "Freigabe aus dem Verlauf");
    const conversation = (await s0.client().listConversations()).find(c => c.id === "topic-443")!;
    const stdin = new FakeStdin();
    stdin.isTTY = false;
    const stdout = new FakeStdout();
    stdout.isTTY = false;
    const exit = runChatApp({ client: s0.client(), conversation, stdin, stdout, env: {}, onSignal: () => () => {}, live: { retryMinMs: 100, retryMaxMs: 200 }, tickMs: 50 });
    await waitFor(() => stdout.all.includes("[1] Erlauben  [2] Ablehnen"), 3000, "Optionen");
    stdin.type("1\n");
    stdin.emit("end");
    expect(await exit).toBe(0);
    expect(stdout.all).toContain("Erledigt: Erlauben · im Terminal");
    expect(stdout.all).not.toContain("\u001b");
    expect(s0.choices!.decisions).toEqual([{ id, key: "ok", via: "terminal" }]);
    expect(s0.telegramChat.calls).toEqual([]);
  });

  test("Zeilenmodus im Terminal (NO_COLOR): Zahl wählt sofort, auch während einer Antwort", async () => {
    const { s, stdin, stdout, exit } = await start("topic-443", { NO_COLOR: "1" }, withChoices);
    stdin.type("Frage\n");
    await s.telegramChat.turn("topic-443");
    const id = s.ask("topic-443", "Freigabe?");
    await waitFor(() => stdout.all.includes("[1] Erlauben"), 3000, "Optionen");
    stdin.type("2\n");
    await waitFor(() => stdout.all.includes("Erledigt: Ablehnen · im Terminal"), 3000, "Erledigt");
    expect(s.choices!.get(id)!.result).toMatchObject({ key: "no", via: "terminal" });
    expect(stdout.all).not.toContain("Wird gesendet, sobald");
    s.telegramChat.finish("topic-443", "fertig");
    stdin.emit("end");
    expect(await exit).toBe(0);
    expect(stdout.all).not.toContain("\u001b");
  });

  test("Zeilenmodus im Terminal (NO_COLOR): Eingabeende wartet auf eine laufende Auswahl und zeigt ihr Ergebnis", async () => {
    let release!: () => void;
    const held = new Promise<void>(r => (release = r));
    let posted = false;
    let answered = false;
    const { s, stdin, stdout, exit } = await start("topic-443", { NO_COLOR: "1" }, {
      ...withChoices,
      client: srv => {
        const client = srv.client();
        const decide = client.decideChoice.bind(client);
        // Antwort auf den POST zurückhalten, bis der Test sie freigibt
        client.decideChoice = async (...args) => {
          posted = true;
          const result = await decide(...args);
          await held;
          answered = true;
          return result;
        };
        return client;
      },
    });
    const id = s.ask("topic-443", "Freigabe?");
    await waitFor(() => stdout.all.includes("[1] Erlauben"), 3000, "Optionen");
    let finished = false;
    void exit.then(() => (finished = true));
    stdin.type("1\n");
    await waitFor(() => posted, 3000, "POST unterwegs");
    stdin.emit("end");
    await new Promise(r => setTimeout(r, 300));
    expect(finished).toBe(false);
    release();
    expect(await exit).toBe(0);
    expect(answered).toBe(true);
    expect(s.choices!.decisions).toEqual([{ id, key: "ok", via: "terminal" }]);
    expect(stdout.all).toContain("Erledigt: Erlauben · im Terminal");
    expect(stdout.all).not.toContain("\u001b");
    expect(s.telegramChat.calls).toEqual([]);
  });
});
