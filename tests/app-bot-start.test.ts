// Issue #344: Startbanner und Anzeigename aus dem Profil als Verhalten
// (ersetzt die Quelltext-Prüfungen des Banners und von extractUserName in bot.ts).
import { describe, expect, test } from "bun:test";
import { startBanner, type BannerInfo } from "../src/app/bot-start";
import { BRAND } from "../src/brand";
import { FALLBACK_USER_NAME, profileDisplayName } from "../src/lib/profile-name";

const info: BannerInfo = {
  pid: 123,
  root: "/srv/tybo",
  timezone: "Europe/Berlin",
  healthPort: 3000,
  telegram: true,
  web: false,
  claudePath: "claude",
  voice: false,
  phone: true,
  transcription: "gemini",
  mcp: undefined,
  sessionId: null,
  defaultModel: "claude-test-1",
};

const line = (lines: string[], label: string) => lines.filter(l => l.startsWith(`${label}:`));

describe("startBanner", () => {
  test("Rahmen, Name und ausgerichtete Spalten", () => {
    const lines = startBanner(info);
    expect(lines[0]).toBe("=".repeat(50));
    expect(lines[1]).toBe(`${BRAND.name} - Starting`);
    expect(lines.at(-1)).toBe("=".repeat(50));
    expect(line(lines, "PID")).toEqual(["PID:         123"]);
    expect(line(lines, "Transcribe")).toEqual(["Transcribe:  enabled (gemini)"]);
    expect(line(lines, "MCP tools")).toEqual(["MCP tools:   disabled"]);
  });

  test("Routing nennt das feste Standardmodell und den Vorrang der Einstellungen (Issue #304)", () => {
    const routing = line(startBanner(info), "Routing");
    expect(routing).toEqual(["Routing:     festes Standardmodell claude-test-1, Einstellungen je Agent haben Vorrang"]);
    expect(routing[0]).not.toContain("haiku");
  });

  test("HITL nennt das Rückfragen-Register für Telegram und WebUI", () => {
    expect(line(startBanner(info), "HITL")).toEqual(["HITL:        Rückfragen über das Rückfragen-Register (Telegram und WebUI)"]);
  });

  test("Kanäle, Session und Schalter", () => {
    const lines = startBanner(info);
    expect(line(lines, "Telegram")[0]).toEndWith("an");
    expect(line(lines, "WebUI")[0]).toEndWith("aus");
    expect(line(lines, "Session")[0]).toEndWith("new");
    expect(line(lines, "Voice")[0]).toEndWith("disabled");
    expect(line(lines, "Phone")[0]).toEndWith("enabled");
    expect(line(lines, "Health")[0]).toEndWith("http://localhost:3000/health");
    const webOnly = startBanner({ ...info, telegram: false, web: true, sessionId: "abc", mcp: "2 Server" });
    expect(line(webOnly, "Telegram")[0]).toEndWith("nicht eingerichtet (nur WebUI)");
    expect(line(webOnly, "WebUI")[0]).toEndWith("an (Adressen in der [web]-Zeile oben)");
    expect(line(webOnly, "Session")[0]).toEndWith("abc");
    expect(line(webOnly, "MCP tools")[0]).toEndWith("2 Server");
  });
});

describe("profileDisplayName", () => {
  test("Überschrift oder name:/Name:, was zuerst steht", () => {
    expect(profileDisplayName("# Alex Beispiel\n\nname: Mia")).toBe("Alex Beispiel");
    expect(profileDisplayName("Intro\nName: Mia \n# Alex")).toBe("Mia");
    expect(profileDisplayName("- name:   Sam")).toBe("Sam");
  });

  test("ohne Treffer oder ohne Profil: User", () => {
    expect(profileDisplayName("")).toBe(FALLBACK_USER_NAME);
    expect(profileDisplayName("## Ziele\n- laufen")).toBe("User");
  });
});
