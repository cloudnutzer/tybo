/**
 * Issue #231, Checkbox 1: Schritt „zugang“ (Zugang vom Handy) mit Auswahl
 * und dem Weg „Nur auf diesem Rechner“. Temporäre Ordner, Attrappen; nichts
 * geht ins Netz, nichts startet tailscale oder cloudflared.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { fieldDefinitionProblems, resolveValues, validateValues } from "../src/setup/model";
import { existingFieldValues, getStep } from "../src/setup/steps";
import { ACCESS_FIELDS, accessStep, currentAccessPath, LOCAL_ONLY_TEXT } from "../src/setup/steps/access";
import { backupsOf, cleanup, FAKE, leakedSecrets, makeCtx } from "./setup-fixture";
import { linuxCtx, runWith, scripted } from "./setup-terminal-fixture";

afterAll(cleanup);

const WEB_ON = `WEB_ENABLED=true\nWEB_PASSWORD=${FAKE.webPassword}\n`;
const TS_ORIGIN = "https://rechner.tailnet-beispiel.ts.net";
const CF_ORIGIN = "https://tybo.example.org";
const CF_ACCESS = "WEB_ACCESS_TEAM=meinteam\nWEB_ACCESS_AUD=0123456789abcdef0123456789abcdef\n";

describe("Schritt zugang: Aufbau", () => {
  test("steht nach webui und vor autostart, optional, mit drei Wegen, Standard Tailscale", () => {
    expect(getStep("zugang")).toBe(accessStep);
    expect(accessStep.optional).toBe(true);
    const path = ACCESS_FIELDS[0];
    expect(path.choices!.map(c => c.value)).toEqual(["tailscale", "cloudflare", "lokal"]);
    expect(path.default).toBe("tailscale");
    expect(fieldDefinitionProblems(ACCESS_FIELDS)).toEqual([]);
  });

  test("eingerichteter Weg aus WEB_PUBLIC_ORIGIN: ts.net ist Tailscale, sonst Cloudflare", () => {
    expect(currentAccessPath({})).toBeNull();
    expect(currentAccessPath({ WEB_PUBLIC_ORIGIN: TS_ORIGIN })).toBe("tailscale");
    expect(currentAccessPath({ WEB_PUBLIC_ORIGIN: CF_ORIGIN })).toBe("cloudflare");
    // Nur die Endung zählt, nicht ein ts.net mitten im Namen
    expect(currentAccessPath({ WEB_PUBLIC_ORIGIN: "https://ts.net.example.org" })).toBe("cloudflare");
  });
});

describe("Schritt zugang: Status", () => {
  test("WebUI aus: fehlt, mit Hinweis auf den Schritt WebUI", async () => {
    const s = await accessStep.status(await makeCtx({ env: "" }));
    expect(s.state).toBe("fehlt");
    expect(s.detail).toContain("Die WebUI ist aus.");
  });

  test("WebUI an, ohne Adresse: fehlt, nur Heimnetz", async () => {
    const s = await accessStep.status(await makeCtx({ env: WEB_ON }));
    expect(s.state).toBe("fehlt");
    expect(s.detail).toContain("Für die App auf dem Handy fehlt eine HTTPS-Adresse.");
  });

  test("Tailscale und Cloudflare mit Access: erledigt; Status nennt keine Adresse", async () => {
    const ts = await accessStep.status(await makeCtx({ env: `${WEB_ON}WEB_PUBLIC_ORIGIN=${TS_ORIGIN}\n` }));
    expect(ts).toMatchObject({ state: "erledigt", detail: "Zugang über Tailscale ist eingerichtet." });
    const cf = await accessStep.status(await makeCtx({ env: `${WEB_ON}WEB_PUBLIC_ORIGIN=${CF_ORIGIN}\n${CF_ACCESS}` }));
    expect(cf.state).toBe("erledigt");
    for (const s of [ts, cf]) {
      const text = JSON.stringify(s);
      expect(text).not.toContain("tailnet-beispiel");
      expect(text).not.toContain("example.org");
      expect(text).not.toContain("meinteam");
    }
  });

  test("Cloudflare-Adresse ohne Access und Tailscale-Adresse mit Access: teilweise", async () => {
    const cf = await accessStep.status(await makeCtx({ env: `${WEB_ON}WEB_PUBLIC_ORIGIN=${CF_ORIGIN}\n` }));
    expect(cf.state).toBe("teilweise");
    expect(cf.detail).toContain("Cloudflare Access fehlt");
    const mixed = await accessStep.status(await makeCtx({ env: `${WEB_ON}WEB_PUBLIC_ORIGIN=${TS_ORIGIN}\n${CF_ACCESS}` }));
    expect(mixed.state).toBe("teilweise");
    expect(mixed.detail).toContain("abgelehnt");
  });
});

describe("Schritt zugang: Vorauswahl und Wegwechsel", () => {
  test("ohne Zugang greift der Standard Tailscale, keine Rückfrage zum Ersetzen", async () => {
    const ctx = await makeCtx({ env: WEB_ON });
    const existing = await existingFieldValues(accessStep, ctx);
    expect(existing).toEqual({});
    const resolved = resolveValues(ACCESS_FIELDS, {}, existing);
    expect(resolved.ZUGANG_WEG).toBe("tailscale");
    expect(ACCESS_FIELDS[1].visible!({ ...existing, ...resolved })).toBe(false);
  });

  test("eingerichteter Weg ist vorausgewählt; ein anderer Weg verlangt die Bestätigung, lokal nie", async () => {
    const ctx = await makeCtx({ env: `${WEB_ON}WEB_PUBLIC_ORIGIN=${CF_ORIGIN}\n${CF_ACCESS}` });
    const existing = await existingFieldValues(accessStep, ctx);
    expect(existing.ZUGANG_WEG).toBe("cloudflare");
    const replace = ACCESS_FIELDS[1];
    expect(replace.visible!({ ...existing })).toBe(false);
    expect(replace.visible!({ ...existing, ZUGANG_WEG: "lokal" })).toBe(false);
    expect(replace.visible!({ ...existing, ZUGANG_WEG: "tailscale" })).toBe(true);
    // Pflicht, wenn sichtbar
    expect(validateValues(ACCESS_FIELDS, { ZUGANG_WEG: "tailscale" }, existing).ZUGANG_ERSETZEN).toBe("Vorhandenen Zugang ersetzen fehlt");
    expect(validateValues(ACCESS_FIELDS, { ZUGANG_WEG: "tailscale", ZUGANG_ERSETZEN: "false" }, existing)).toEqual({});
  });
});

describe("Schritt zugang: Nur auf diesem Rechner", () => {
  test("ändert nichts: .env Byte für Byte gleich, keine Sicherung, klare Erklärung", async () => {
    const env = `${WEB_ON}WEB_HOST=0.0.0.0\n`;
    const ctx = await makeCtx({ env });
    const test = await accessStep.test!({ ZUGANG_WEG: "lokal" }, ctx);
    expect(test.ok).toBe(true);
    const r = await accessStep.apply!({ ZUGANG_WEG: "lokal" }, ctx);
    expect(r).toEqual({ ok: true, message: LOCAL_ONLY_TEXT, changed: [] });
    expect(r.message).toContain("Als App aufs Handy legen und Benachrichtigungen gehen damit nicht");
    expect(await readFile(ctx.envPath, "utf8")).toBe(env);
    expect(await backupsOf(ctx)).toEqual([]);
    expect(ctx.run.calls.filter(c => c[0].includes("tailscale") || c[0].includes("cloudflared"))).toEqual([]);
  });

  test("vorhandener Zugang bleibt unverändert und wird so genannt", async () => {
    const env = `${WEB_ON}WEB_PUBLIC_ORIGIN=${TS_ORIGIN}\n`;
    const ctx = await makeCtx({ env });
    const r = await accessStep.apply!({ ZUGANG_WEG: "lokal" }, ctx);
    expect(r.ok).toBe(true);
    expect(r.changed).toEqual([]);
    expect(r.message).toContain("Der vorhandene Zugang über Tailscale bleibt unverändert.");
    expect(await readFile(ctx.envPath, "utf8")).toBe(env);
  });

  test("ungültige Auswahl: Fehler ohne Schreiben", async () => {
    const ctx = await makeCtx({ env: WEB_ON });
    const r = await accessStep.apply!({ ZUGANG_WEG: "vpn" }, ctx);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("keine gültige Auswahl");
    expect(await backupsOf(ctx)).toEqual([]);
  });
});

describe("tybo setup zugang im Terminal", () => {
  test("Weg 3 gewählt: Stand, Auswahl, nichts geschrieben, keine Geheimnisse in der Ausgabe", async () => {
    const env = `${WEB_ON}`;
    const ctx = await linuxCtx({ env });
    const prompter = scripted(["3", ""]);
    const r = await runWith({ mode: "step", step: "zugang" }, ctx, prompter);
    expect(r.code).toBe(0);
    expect(prompter.left()).toBe(0);
    expect(r.out).toContain("Zugang vom Handy");
    expect(r.out).toContain("1) Tailscale, privates Netz nur für deine Geräte (empfohlen)");
    expect(r.out).toContain("Kein zusätzlicher Zugang eingerichtet.");
    expect(await readFile(ctx.envPath, "utf8")).toBe(env);
    expect(leakedSecrets(r.out)).toEqual([]);
  });
});
