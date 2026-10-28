/**
 * Befehls-Attrappe für Demo, web:dev und Browser-Durchlauf (Issue #77):
 * Liste wie das echte Register, /api/commands antwortet statt 503,
 * Rückmeldung von /new als Meldung „befehl", /board als Fehler.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { COMMAND_TEXT, commandRegistry } from "../src/lib/commands/builtin";
import { COMMANDS_TEXT } from "../src/web/commands";
import { createDemoCommands, DEMO_COMMANDS, DEMO_VOICE_SENT_TEXT, startDemoServer, type DemoServer } from "../src/web/demo";
import { DEMO_HOST } from "../src/web/server";

let demos: DemoServer[] = [];
afterEach(async () => {
  for (const d of demos.splice(0)) await d.stop();
});

async function waitFor(check: () => Promise<boolean>, timeoutMs = 2000) {
  const end = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("Zeitüberschreitung beim Warten");
    await Bun.sleep(10);
  }
}

async function start() {
  const demo = await startDemoServer({ host: DEMO_HOST, port: 0, password: "demo-passwort-lang", allowedHosts: [] }, { log: () => {} });
  demos.push(demo);
  return demo;
}

describe("Befehls-Attrappe", () => {
  test("Liste stimmt mit dem echten Register für Browser und Terminal überein", () => {
    expect(DEMO_COMMANDS).toEqual(commandRegistry.list("web"));
    expect(DEMO_COMMANDS).toEqual(commandRegistry.list("terminal"));
  });

  test("erkennt Namen und Aliase wie das Register, /stop auch während einer Antwort", () => {
    const port = createDemoCommands();
    for (const text of ["/new", "/reset", "/Hilfe", "/board Preise", "/stop", "/goal pause", "/xyz", "Hallo /new", "//new"]) {
      const real = commandRegistry.match(text, "web");
      expect(port.match(text, "web")?.name ?? null).toBe(real ? real.command.name : null);
    }
    expect(port.match("/stop", "web")!.whileBusy).toBe(true);
    expect(port.match("/new", "web")!.whileBusy).toBe(false);
  });

  test("Demo-Server: GET /api/commands liefert die Liste, /new antwortet als Meldung „befehl“, /board als Fehler", async () => {
    const demo = await start();
    const res = await fetch(`${demo.server.url}/api/commands`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).commands.map((c: any) => c.name)).toContain("board");

    const origin = demo.server.url;
    const list = (await (await fetch(`${origin}/api/conversations`)).json()) as any;
    const id = list.conversations[0].id as string;
    const post = (text: string) =>
      fetch(`${origin}/api/conversations/${id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", origin },
        body: JSON.stringify({ text }),
      });
    const messages = async () => ((await (await fetch(`${origin}/api/conversations/${id}/messages`)).json()) as any).messages as any[];
    // Die Beispiel-Unterhaltung hat schon Nachrichten; nur neue zählen
    const before = new Set((await messages()).map(m => m.id));
    const fresh = async () => (await messages()).filter(m => !before.has(m.id));
    expect((await post("/new")).status).toBe(202);
    await waitFor(async () => (await fresh()).some(m => m.kind === "notice"));
    const notice = (await fresh()).find(m => m.kind === "notice");
    expect(notice.source).toBe("befehl");
    expect(notice.text).toBe("Neue Session gestartet. Der Verlauf bleibt stehen.");
    expect((await post("/board Preise")).status).toBe(202);
    await waitFor(async () => (await fresh()).some(m => m.role === "error"));
    expect((await fresh()).find(m => m.role === "error").text).toBe(COMMANDS_TEXT.boardUnavailable);
  });

  test("run: /new als Meldung, /board scheitert mit dem Text ohne Board, nichts wird ausgeführt", async () => {
    const port = createDemoCommands();
    const notices: string[] = [];
    const req = (text: string) => ({ text, notice: async (t: string) => void notices.push(t) }) as any;
    expect(await port.run(req("/new"))).toEqual({});
    expect(await port.run(req("/board Preise"))).toEqual({ failed: COMMANDS_TEXT.boardUnavailable });
    expect(await port.run(req("/topics"))).toEqual({});
    expect(notices).toEqual(["Neue Session gestartet. Der Verlauf bleibt stehen.", "/topics ist in der Demo nur nachgestellt, es passiert nichts."]);
  });

  test("/voice (Issue #78): Antwort, dann die Meldung wie im Bot", async () => {
    expect(DEMO_VOICE_SENT_TEXT).toBe(COMMAND_TEXT.voiceSent);
    const demo = await start();
    const origin = demo.server.url;
    const id = ((await (await fetch(`${origin}/api/conversations`)).json()) as any).conversations[0].id as string;
    const messages = async () => ((await (await fetch(`${origin}/api/conversations/${id}/messages`)).json()) as any).messages as any[];
    const before = new Set((await messages()).map(m => m.id));
    const res = await fetch(`${origin}/api/conversations/${id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", origin },
      body: JSON.stringify({ text: "/voice Wie wird das Wetter?" }),
    });
    expect(((await res.json()) as any).command).toBe("voice");
    await waitFor(async () => (await messages()).some(m => m.kind === "notice" && !before.has(m.id)));
    const fresh = (await messages()).filter(m => !before.has(m.id));
    expect(fresh.map(m => [m.role, m.kind ?? null])).toEqual([
      ["user", null],
      ["assistant", null],
      ["assistant", "notice"],
    ]);
    expect(fresh[1].text).toContain("Wie wird das Wetter?");
    expect(fresh[2].text).toBe(COMMAND_TEXT.voiceSent);
  });
});
