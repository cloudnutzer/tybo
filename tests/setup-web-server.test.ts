/**
 * Issue #66, Checkbox 2: Server des Einrichtungsmodus mit Einmal-Code und
 * Bremse. Nur Loopback (Bindung und Host-Header), Code nötig, falsche Codes
 * gebremst, fremder Origin abgelehnt, nach „Fertig“ gelten weder Code noch
 * Sitzungen. Alles im temporären Projekt mit Attrappen, nie src/bot.ts.
 */

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { lanIPv4Addresses } from "../src/web/startup";
import { LoginLimiter } from "../src/web/auth";
import {
  CODE_ALPHABET,
  formatSetupCode,
  generateSetupCode,
  isSetupHost,
  normalizeSetupCode,
  SETUP_SESSION_TTL_MS,
} from "../src/setup/web-server";
import { cleanup, FAKE } from "./setup-fixture";
import { CODE, get, login, post, rawRequest, readyOptions, startSetup, type Started } from "./setup-web-fixture";

const running: Started[] = [];
async function start(options: Parameters<typeof startSetup>[0] = {}) {
  const s = await startSetup(options);
  running.push(s);
  return s;
}
afterEach(async () => {
  for (const s of running.splice(0)) await s.server.stop();
});
afterAll(cleanup);

function expectSecurityHeaders(res: Response) {
  const csp = res.headers.get("content-security-policy") ?? "";
  expect(csp).toContain("script-src 'self'");
  expect(csp).not.toContain("unsafe-inline");
  expect(res.headers.get("x-frame-options")).toBe("DENY");
  expect(res.headers.get("referrer-policy")).toBe("no-referrer");
}

describe("Einmal-Code", () => {
  test("8 Zeichen aus dem gut abtippbaren Alphabet, jedes Mal neu", () => {
    const codes = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const code = generateSetupCode();
      expect(code).toMatch(/^[A-Z2-9]{8}$/);
      for (const c of code) expect(CODE_ALPHABET).toContain(c);
      expect(code).not.toMatch(/[01OIL]/);
      codes.add(code);
    }
    expect(codes.size).toBe(200);
  });

  test("Anzeige mit Bindestrich, Eingabe ohne Rücksicht auf Groß, Leerzeichen, Bindestrich", () => {
    expect(formatSetupCode("K7MP2QXR")).toBe("K7MP-2QXR");
    expect(normalizeSetupCode(" k7mp-2qxr ")).toBe("K7MP2QXR");
    expect(normalizeSetupCode("k7 mp 2q xr")).toBe("K7MP2QXR");
  });
});

describe("Host und Bindung", () => {
  test("isSetupHost: nur 127.0.0.1 und localhost mit genau diesem Port", () => {
    expect(isSetupHost("127.0.0.1:3100", 3100)).toBe(true);
    expect(isSetupHost("localhost:3100", 3100)).toBe(true);
    expect(isSetupHost("LOCALHOST:3100", 3100)).toBe(true);
    for (const host of ["127.0.0.1", "127.0.0.1:3101", "[::1]:3100", "192.168.1.20:3100", "evil.example:3100", "localhost.evil:3100", "", null]) {
      expect(isSetupHost(host, 3100)).toBe(false);
    }
  });

  test("fremder Host, falscher Port, ::1 und LAN-Adresse: 421 mit Sicherheits-Kopfzeilen", async () => {
    const s = await start();
    const port = s.server.port;
    for (const host of ["evil.example", `evil.example:${port}`, "localhost:1", `[::1]:${port}`, `192.168.1.20:${port}`, "127.0.0.1"]) {
      const raw = await rawRequest(s.base, "/code", host);
      expect(raw).toMatch(/^HTTP\/1\.1 421/);
      expect(raw.toLowerCase()).toContain("content-security-policy:");
    }
    expect(await rawRequest(s.base, "/code", `localhost:${port}`)).toMatch(/^HTTP\/1\.1 200/);
  });

  test("bindet nur an 127.0.0.1: über eine LAN-Adresse nicht erreichbar", async () => {
    const s = await start();
    expect(s.server.url).toBe(`http://127.0.0.1:${s.server.port}`);
    for (const ip of lanIPv4Addresses()) {
      let reached = true;
      try {
        await fetch(`http://${ip}:${s.server.port}/code`, { signal: AbortSignal.timeout(2000) });
      } catch {
        reached = false;
      }
      expect(reached).toBe(false);
    }
  });
});

describe("Zugang", () => {
  test("ohne Code: Code-Seite erreichbar, / leitet dorthin, geschützte APIs 401", async () => {
    const s = await start();
    const page = await get(s, "/code");
    expect(page.status).toBe(200);
    expectSecurityHeaders(page);
    const html = await page.text();
    expect(html).toContain('<script src="/setup-code.js" defer></script>');
    expect(html).not.toMatch(/<script>(?!<)/);
    const root = await get(s, "/");
    expect(root.status).toBe(302);
    expect(root.headers.get("location")).toBe("/code");
    for (const path of ["/api/setup/overview", "/api/setup/steps/telegram"]) {
      const res = await get(s, path);
      expect(res.status).toBe(401);
      expectSecurityHeaders(res);
    }
    for (const path of ["/api/setup/steps/telegram/apply", "/api/setup/steps/telegram/test", "/api/setup/finish"]) {
      expect((await post(s, path, {})).status).toBe(401);
    }
    // Statische Dateien ohne Geheimnisse bleiben erreichbar
    for (const path of ["/style.css", "/theme.js", "/favicon.svg", "/apple-touch-icon.png", "/setup-code.js", "/setup.js"]) expect((await get(s, path)).status).toBe(200);
    expect((await get(s, "/favicon.svg")).headers.get("content-type")).toContain("image/svg+xml");
    expect((await get(s, "/index.html")).status).toBe(404);
    expect((await get(s, "/../.env")).status).toBe(404);
  });

  test("richtiger Code: eigenes Sitzungs-Cookie (HttpOnly, SameSite=Strict, ohne Max-Age), dann Zugriff", async () => {
    const s = await start();
    const res = await post(s, "/api/setup/code", { code: " k7mp-2qxr " });
    expect(res.status).toBe(200);
    const cookie = res.headers.get("set-cookie")!;
    expect(cookie).toMatch(/^tybo_setup=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Strict; Path=\/$/);
    expect(cookie).not.toContain("Max-Age");
    const session = cookie.split(";")[0];
    expect((await get(s, "/api/setup/overview", session)).status).toBe(200);
    const root = await get(s, "/", session);
    expect(root.status).toBe(200);
    expect(await root.text()).toContain('<script src="/setup.js" defer></script>');
    expect((await get(s, "/code", session)).headers.get("location")).toBe("/");
    // Das Cookie der normalen WebUI zählt hier nicht
    expect((await get(s, "/api/setup/overview", `tybo_web=${session.split("=")[1]}`)).status).toBe(401);
    expect(s.logs.join("\n")).not.toContain(CODE);
  });

  test("falscher Code 401; nach 10 Fehlversuchen 429, auch mit dem richtigen Code", async () => {
    const s = await start();
    for (let i = 0; i < 10; i++) {
      const res = await post(s, "/api/setup/code", { code: "AAAAAAAA" });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "Falscher Code" });
    }
    const blocked = await post(s, "/api/setup/code", { code: CODE });
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBe("900");
    expect(blocked.headers.get("set-cookie")).toBeNull();
  });

  test("Sperre endet nach 15 Minuten", async () => {
    let now = 1_000_000;
    const limiter = new LoginLimiter({ maxFailures: 2, now: () => now });
    const s = await start({ limiter });
    await post(s, "/api/setup/code", { code: "AAAAAAAA" });
    await post(s, "/api/setup/code", { code: "AAAAAAAA" });
    expect((await post(s, "/api/setup/code", { code: CODE })).status).toBe(429);
    now += 15 * 60 * 1000 + 1;
    expect((await post(s, "/api/setup/code", { code: CODE })).status).toBe(200);
  });

  test("ungültige Anfragen: 400 statt Absturz, kein Fehlversuch", async () => {
    const s = await start();
    for (const body of [{}, { code: 12345678 }, { code: null }]) {
      expect((await post(s, "/api/setup/code", body)).status).toBe(400);
    }
    const res = await fetch(`${s.base}/api/setup/code`, { method: "POST", headers: { Origin: s.origin }, body: "{kaputt" });
    expect(res.status).toBe(400);
    expect((await get(s, "/api/setup/code")).status).toBe(405);
  });

  test("fremder oder fehlender Origin: 403, auch mit gültiger Sitzung", async () => {
    const s = await start(readyOptions());
    const cookie = await login(s);
    const cases: Array<Record<string, string>> = [{}, { Origin: "http://evil.example" }, { Origin: "null" }, { Origin: `http://localhost:${s.server.port}` }];
    for (const headers of cases) {
      for (const path of ["/api/setup/code", "/api/setup/steps/telegram/apply", "/api/setup/finish"]) {
        const res = await fetch(`${s.base}${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: cookie, ...headers },
          body: JSON.stringify({ code: CODE }),
        });
        expect(res.status).toBe(403);
      }
    }
    expect(s.server.isFinished()).toBe(false);
  });

  test("Sitzung läuft nach 12 Stunden ab", async () => {
    let now = 5_000_000;
    const s = await start({ now: () => now });
    const cookie = await login(s);
    expect((await get(s, "/api/setup/overview", cookie)).status).toBe(200);
    now += SETUP_SESSION_TTL_MS + 1;
    expect((await get(s, "/api/setup/overview", cookie)).status).toBe(401);
  });

  test("zu großer Body: 413", async () => {
    const s = await start();
    const res = await fetch(`${s.base}/api/setup/code`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: s.origin },
      body: JSON.stringify({ code: "x".repeat(70 * 1024) }),
    });
    expect(res.status).toBe(413);
  });
});

describe("nach „Fertig“", () => {
  test("Code und bestehende Sitzungen sind ungültig, Code-Seite bleibt erreichbar", async () => {
    const s = await start(readyOptions());
    const first = await login(s);
    const second = await login(s);
    const done = await post(s, "/api/setup/finish", {}, first);
    expect(done.status).toBe(200);
    expect(done.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(s.server.isFinished()).toBe(true);

    for (const cookie of [first, second]) {
      const res = await get(s, "/api/setup/overview", cookie);
      expect(res.status).toBe(401);
      expect((await res.json()).finished).toBe(true);
      expect((await get(s, "/", cookie)).headers.get("location")).toBe("/code");
    }
    const again = await post(s, "/api/setup/code", { code: CODE });
    expect(again.status).toBe(401);
    expect(await again.json()).toEqual({ error: "Die Einrichtung ist abgeschlossen, der Code gilt nicht mehr", finished: true });
    expect(again.headers.get("set-cookie")).toBeNull();
    expect((await get(s, "/code")).status).toBe(200);
    expect(s.logs.some(l => l.includes("Einmal-Code und Sitzungen sind ungültig"))).toBe(true);
  });

  test("Fertig + Speichern/Testen gleichzeitig: dahinter eingereihte Anfragen ändern nichts mehr", async () => {
    // „Fertig“ hält beim Supervisor an, bis Speichern und Testen eingereiht sind
    let entered!: () => void;
    const inFinish = new Promise<void>(r => (entered = r));
    let release!: () => void;
    const gate = new Promise<void>(r => (release = r));
    const s = await start({
      ...readyOptions(),
      supervisorFn: async () => {
        entered();
        await gate;
        return null;
      },
    });
    const cookie = await login(s);
    const envBefore = await readFile(s.ctx.envPath, "utf8");
    const profileBefore = await readFile(s.ctx.profilePath, "utf8");

    const finishing = post(s, "/api/setup/finish", {}, cookie);
    await inFinish;
    const callsBefore = s.ctx.providers.calls.length;
    const values = { TELEGRAM_BOT_TOKEN: "987654321:AAAndererTokenNurFuerTests_zyxwvu", TELEGRAM_USER_ID: "515151" };
    const saving = post(s, "/api/setup/steps/telegram/apply", { values }, cookie);
    const testing = post(s, "/api/setup/steps/telegram/test", { values }, cookie);
    const profiling = post(s, "/api/setup/steps/profil/apply", { values: { USER_NAME: "Jemand Anderes" } }, cookie);
    // Alle drei sind angemeldet durch und stehen hinter „Fertig“ in der Warteschlange
    while (s.server.queued() < 4) await Bun.sleep(1);
    release();

    expect((await finishing).status).toBe(200);
    for (const res of [await saving, await testing, await profiling]) {
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "Die Einrichtung ist abgeschlossen", finished: true });
    }
    expect(await readFile(s.ctx.envPath, "utf8")).toBe(envBefore);
    expect(await readFile(s.ctx.profilePath, "utf8")).toBe(profileBefore);
    expect(s.ctx.providers.calls.length).toBe(callsBefore);
    expect(s.logs.some(l => l.includes("gespeichert"))).toBe(false);
    expect(envBefore).toContain(FAKE.token);
  });
});
