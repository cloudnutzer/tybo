/**
 * Issue #494: CSP und Permissions-Policy nur auf der ausgelieferten
 * Gesprächsseite /sa/<kennung> erweitert. Alle übrigen Antworten, auch
 * Startseite (Sprechmodus, Telefonhörer), Anmeldung, API und die Fehlerseiten
 * unter /sa/, behalten SECURITY_HEADERS Byte für Byte.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SECURITY_HEADERS, securityHeadersFor, VOICE_AGENT_PAGE_HEADERS, type WebServer } from "../src/web/server";
import { VOICE_AGENT_CONNECT_HOSTS } from "../src/web/voice-agent-page";
import { readyAgent, removeSessionWorlds, sessionServer, sessionWorld } from "./voice-agent-session-fixture";

const root = await mkdtemp(join(tmpdir(), "voice-agent-headers-"));
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  removeSessionWorlds();
});
const servers: WebServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop({ graceMs: 50 });
});

const CSP = "content-security-policy";
const PP = "permissions-policy";
const directives = (csp: string) => new Map(csp.split(";").map((d) => d.trim()).filter(Boolean).map((d) => [d.split(" ")[0], d] as const));

describe("Köpfe der Gesprächsseite", () => {
  test("connect-src um genau die vier Hosts des Anbieters erweitert, alles andere gleich", () => {
    const page = directives(VOICE_AGENT_PAGE_HEADERS["Content-Security-Policy"]);
    const normal = directives(SECURITY_HEADERS["Content-Security-Policy"]);
    expect([...page.keys()]).toEqual([...normal.keys()]);
    for (const [name, value] of normal) if (name !== "connect-src") expect(page.get(name)).toBe(value);
    expect(page.get("connect-src")).toBe(`connect-src 'self' ${VOICE_AGENT_CONNECT_HOSTS.join(" ")}`);
    expect([...VOICE_AGENT_CONNECT_HOSTS]).toEqual(["https://api.elevenlabs.io", "wss://api.elevenlabs.io", "wss://livekit.rtc.elevenlabs.io", "https://livekit.rtc.elevenlabs.io"]);
    // script-src bleibt 'self': das SDK kommt selbst gehostet (SA1-7)
    expect(page.get("script-src")).toBe("script-src 'self'");
    expect(SECURITY_HEADERS["Content-Security-Policy"]).not.toContain("elevenlabs");
  });

  test("Permissions-Policy: Mikrofon für die eigene Seite, Kamera aus; übrige Köpfe gleich", () => {
    expect(VOICE_AGENT_PAGE_HEADERS["Permissions-Policy"]).toBe("microphone=(self), camera=(), geolocation=(), payment=(), autoplay=(self)");
    expect(SECURITY_HEADERS["Permissions-Policy"]).toBe("microphone=(self), camera=(self), geolocation=(), payment=()");
    for (const key of Object.keys(SECURITY_HEADERS)) {
      if (key !== "Content-Security-Policy" && key !== "Permissions-Policy") expect(VOICE_AGENT_PAGE_HEADERS[key]).toBe(SECURITY_HEADERS[key]);
    }
  });

  test("securityHeadersFor: nur 200 unter /sa/<kennung>", () => {
    expect(securityHeadersFor("/sa/experte", 200)).toBe(VOICE_AGENT_PAGE_HEADERS);
    for (const [path, status] of [
      ["/sa/experte", 401],
      ["/sa/experte", 404],
      ["/sa/experte/x", 200],
      ["/sa/", 200],
      ["/", 200],
      ["/api/voice-agents/experte/session", 200],
      ["/sprachagent.html", 200],
    ] as const) {
      expect(securityHeadersFor(path, status)).toBe(SECURITY_HEADERS);
    }
  });
});

describe("Köpfe über den Server", () => {
  test("Gesprächsseite erweitert, Startseite, Login, API und Fehlerseiten unverändert", async () => {
    const w = sessionWorld();
    await readyAgent(w, "experte");
    const ctx = await sessionServer(root, servers, w);
    const page = await ctx.api("/sa/experte");
    expect(page.status).toBe(200);
    expect(page.headers.get(CSP)).toBe(VOICE_AGENT_PAGE_HEADERS["Content-Security-Policy"]);
    expect(page.headers.get(PP)).toBe(VOICE_AGENT_PAGE_HEADERS["Permissions-Policy"]);
    expect(page.headers.get("x-frame-options")).toBe("DENY");

    const normal = [
      await ctx.api("/"),
      await fetch(`${ctx.origin}/login`),
      await ctx.api("/api/me"),
      await ctx.api("/api/voice-agents/experte"),
      await ctx.api("/api/voice-agents/experte/session", "POST", {}),
      await ctx.api("/sa/gibtsnicht"),
      await fetch(`${ctx.origin}/sa/experte`),
      await ctx.api("/sprachagent.js"),
    ];
    for (const res of normal) {
      expect(res.headers.get(CSP)).toBe(SECURITY_HEADERS["Content-Security-Policy"]);
      // Sprechmodus und Telefonhörer brauchen das Mikrofon auf der Startseite weiter
      expect(res.headers.get(PP)).toBe(SECURITY_HEADERS["Permissions-Policy"]);
    }
  });
});
