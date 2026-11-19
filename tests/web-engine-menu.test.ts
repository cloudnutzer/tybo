/** Motor-Menü: nur die serverseitigen Gesprächsdaten bestimmen die Zeilen. */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { ConversationEngineChoice } from "../src/web/engines";
import { TYBO_BRAND } from "./brand-fixture";
const source = readFileSync(new URL("../src/web/public/app.js", import.meta.url), "utf8");
const settings = readFileSync(new URL("../src/web/public/settings.js", import.meta.url), "utf8");
const { engineMenuView, engineMenuLock } = new Function("document", "window", `${settings}\n${source}\nreturn { engineMenuView, engineMenuLock };`)(
  { getElementById: () => null }, { TYBO_BRAND });
const until = "2026-11-22T15:00:00Z";
const choices: ConversationEngineChoice[] = [
  { engine: "claude", label: "Claude Code", model: "claude-fable-5-2", state: "blocked", blockedUntil: until, cause: "threshold", resetKnown: true },
  { engine: "codex", label: "Codex", state: "answering" },
  { engine: "opencode", label: "OpenCode", model: "openrouter/test/modell", state: "not_ready", installed: false, message: "OpenCode ist nicht installiert" },
  { engine: "api", label: "Anthropic API", state: "free" },
];
const view = (extra: Record<string, unknown> = {}) => engineMenuView({ conversationId: "dm", engineChoices: choices, overrides: [], timeZone: "Europe/Berlin",
  engineStage: { engine: "codex", label: "Codex", role: "backup" }, ...extra });

test("alle Motoren einschließlich API, frei für answering/free, gesperrt bleibt wählbar", () => {
  const menu = view();
  expect(menu.sentence).toBe("Codex springt ein.");
  expect(menu.rows.map((r: any) => r.label)).toEqual(["Standard (Automatik)", "Claude Code", "Codex", "OpenCode", "Anthropic API"]);
  expect(menu.rows.map((r: any) => r.status)).toEqual(["", "gesperrt bis So 16:00", "frei", "nicht installiert", "frei"]);
  expect(menu.rows.map((r: any) => r.disabled)).toEqual([false, false, false, true, false]);
  expect(menu.rows[1].note).toBe("bis dahin springt die nächste Stufe ein");
  expect(menu.rows[3].note).toBe("OpenCode ist nicht installiert");
  expect(menu.rows.map((r: any) => r.paid)).toEqual([false, false, false, true, true]);
});
for (const [cause, resetKnown, expected] of [["threshold", false, "pausiert bis"], ["limit", false, "pausiert bis"], ["outage", true, "pausiert bis"], ["outage", false, "pausiert bis"], ["limit", true, "gesperrt bis"]]) {
  test(`${cause}, resetKnown=${resetKnown}`, () => {
    const row = view({ engineChoices: [{ ...choices[0], cause, resetKnown }] }).rows[1];
    expect(row.status).toBe(expected + (expected === "pausiert bis" ? " 16:00" : " So 16:00"));
    expect(row.disabled).toBe(false);
  });
}
test("installierter, nicht bereiter Motor mit Prüfgrund; gewählte Zeile darf deaktiviert sein", () => {
  const menu = view({ engineChoices: [{ ...choices[2], installed: true, message: "Anmeldung ließ sich nicht prüfen" }], overrides: [{ conversationId: "dm", engine: "opencode" }] });
  expect(menu.rows[1]).toMatchObject({ checked: true, disabled: true, status: "nicht angemeldet", note: "Anmeldung ließ sich nicht prüfen" });
  expect(menu.rows[0]).toMatchObject({ checked: false, disabled: false });
});
test("Markierung ausschließlich nach overrides; fremdes Gespräch zählt nicht", () => {
  expect(view().rows.filter((r: any) => r.checked).map((r: any) => r.engine)).toEqual(["standard"]);
  expect(view({ overrides: [{ conversationId: "fremd", engine: "api" }, { conversationId: "dm", engine: "claude" }] }).rows.filter((r: any) => r.checked).map((r: any) => r.engine)).toEqual(["claude"]);
  expect(view({ overrides: null }).rows.some((r: any) => r.checked)).toBe(false);
});
test("OpenCode ohne OpenRouter trägt keinen Verbrauchshinweis; API immer", () => {
  expect(view({ engineChoices: [{ ...choices[2], model: "openai/test" }, choices[3]] }).rows.map((r: any) => r.paid)).toEqual([false, false, true]);
});
test("älterer Server: Namen aus engines ohne Zustand, alle wählbar; Fehler: bekannte Namen ohne Markierung", () => {
  const menu = view({ engineChoices: undefined, engines: [{ id: "api", label: "Anthropic API" }, { id: "codex", label: "Codex" }] });
  expect(menu.rows.map((r: any) => r.engine)).toEqual(["standard", "api", "codex"]);
  expect(menu.rows.every((r: any) => r.status === "" && !r.disabled)).toBe(true);
  const failed = view({ engineChoices: undefined, overrides: undefined });
  expect(failed.rows.map((r: any) => r.engine)).toEqual(["standard", "claude", "codex", "opencode", "api"]);
  expect(failed.rows.every((r: any) => !r.checked && !r.disabled && !r.status)).toBe(true);
});
test("Agentenmodell entscheidet am Server: gleicher Motor, verschiedene Zustände ohne order oder blocks", () => {
  const blocked = view();
  const free = view({ engineChoices: [{ ...choices[0], model: "claude-opus-5-5", state: "free" }] });
  expect(blocked.rows[1].status).toBe("gesperrt bis So 16:00");
  expect(free.rows[1].status).toBe("frei");
  const input = { conversationId: "dm", engineChoices: choices, overrides: [], get order() { throw Error("Allgemeine Reihenfolge gelesen"); }, get blocks() { throw Error("Sperrliste gelesen"); } };
  expect(() => engineMenuView(input)).not.toThrow();
});
test("Bot-Zeitzone statt Browser-Zeitzone", () => {
  expect(view({ timeZone: "Pacific/Honolulu" }).rows[1].status).toBe("gesperrt bis So 05:00");
  expect(view({ timeZone: "Asia/Tokyo" }).rows[1].status).toBe("gesperrt bis Mo 00:00");
});

for (const flag of ["running", "closed", "sending", "recording", "talking", "calling", "busy"]) test(`Motorwahl gesperrt bei ${flag}`, () => {
  expect(engineMenuLock({ [flag]: true })).not.toBe("");
});
test("Motorwahl im ruhenden, offenen Gespräch frei", () => { expect(engineMenuLock({})).toBe(""); });
