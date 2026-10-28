/**
 * Issue #165, Checkbox 3: Am Ende der Einrichtung „Supabase auf diesem
 * Rechner“ sagt der Assistent einmal, ob Docker beim Anmelden startet.
 * Docker Desktop wird über seine Einstellungsdatei geprüft (im Temp-Ordner),
 * OrbStack und Colima bekommen einen Hinweis ohne Prüfung, Linux fragt
 * systemctl. Alle Befehle sind Attrappen.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { cp, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { CommandResult } from "../src/setup/context";
import { desktopAutoStart, dockerKind, dockerLoginHint, runSupabaseLocal } from "../src/setup/local-supabase";
import { cleanup, FAKE, makeCtx } from "./setup-fixture";
import { fakeLocal } from "./local-supabase-fixture";

afterAll(cleanup);

async function ctxWith(answers: Record<string, Partial<CommandResult>>, platform: NodeJS.Platform = "darwin") {
  const calls: string[][] = [];
  const run = async (cmd: string[]) => {
    calls.push(cmd);
    const a = answers[cmd.slice(0, 2).join(" ")];
    return a ? { code: 0, stdout: "", stderr: "", ...a } : { code: -1, stdout: "", stderr: "Befehl nicht gefunden" };
  };
  const ctx = await makeCtx({ overrides: { run, platform } });
  return { ctx, calls };
}

async function desktopSettings(home: string, file: string, content: unknown) {
  const dir = join(home, "Library", "Group Containers", "group.com.docker");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, file), JSON.stringify(content));
}

describe("dockerKind", () => {
  test("Docker Desktop, OrbStack, Colima, Linux-Engine", async () => {
    expect(await dockerKind((await ctxWith({ "docker info": { stdout: "Docker Desktop" } })).ctx)).toBe("desktop");
    expect(await dockerKind((await ctxWith({ "docker info": { stdout: "OrbStack" } })).ctx)).toBe("orbstack");
    expect(await dockerKind((await ctxWith({ "docker info": { stdout: "Ubuntu 24.04 LTS" }, "docker context": { stdout: "colima" } })).ctx)).toBe("colima");
    expect(await dockerKind((await ctxWith({ "docker info": { stdout: "Ubuntu 24.04 LTS" }, "docker context": { stdout: "default" } }, "linux")).ctx)).toBe("engine");
    expect(await dockerKind((await ctxWith({})).ctx)).toBe("unbekannt");
  });
});

describe("Docker Desktop: Einstellung lesen", () => {
  test("settings-store.json (AutoStart) geht vor settings.json (autoStart)", async () => {
    const { ctx } = await ctxWith({});
    expect(desktopAutoStart(ctx.home)).toBeNull();
    await desktopSettings(ctx.home, "settings.json", { autoStart: false });
    expect(desktopAutoStart(ctx.home)).toBe(false);
    await desktopSettings(ctx.home, "settings-store.json", { AutoStart: true });
    expect(desktopAutoStart(ctx.home)).toBe(true);
  });

  test("an: bestätigt; aus: Warnung mit Anleitung; unlesbar: Anleitung", async () => {
    const on = await ctxWith({ "docker info": { stdout: "Docker Desktop" } });
    await desktopSettings(on.ctx.home, "settings-store.json", { AutoStart: true });
    expect(await dockerLoginHint(on.ctx)).toContain("Docker Desktop startet beim Anmelden von selbst");

    const off = await ctxWith({ "docker info": { stdout: "Docker Desktop" } });
    await desktopSettings(off.ctx.home, "settings-store.json", { AutoStart: false });
    const offText = await dockerLoginHint(off.ctx);
    expect(offText).toContain("Achtung: Docker Desktop startet beim Anmelden nicht von selbst");
    expect(offText).toContain("Start Docker Desktop when you sign in");

    const unknown = await ctxWith({ "docker info": { stdout: "Docker Desktop" } });
    expect(await dockerLoginHint(unknown.ctx)).toContain("ließ sich nicht lesen");
  });
});

describe("Hinweise ohne Prüfung und Linux", () => {
  test("OrbStack: Start at login; Colima: brew services start colima; beide ohne Prüfung", async () => {
    const orb = await ctxWith({ "docker info": { stdout: "OrbStack" } });
    expect(await dockerLoginHint(orb.ctx)).toContain("„Start at login“");
    const colima = await ctxWith({ "docker info": { stdout: "Ubuntu" }, "docker context": { stdout: "colima" } });
    const text = await dockerLoginHint(colima.ctx);
    expect(text).toContain("brew services start colima");
    expect(colima.calls.some(c => c[0] === "brew")).toBe(false);
  });

  test("Linux: systemctl is-enabled docker", async () => {
    const on = await ctxWith({ "docker info": { stdout: "Ubuntu" }, "docker context": { stdout: "default" }, "systemctl is-enabled": { stdout: "enabled" } }, "linux");
    expect(await dockerLoginHint(on.ctx)).toContain("Docker startet mit dem Rechner (systemd)");
    const off = await ctxWith({ "docker info": { stdout: "Ubuntu" }, "docker context": { stdout: "default" }, "systemctl is-enabled": { code: 1, stdout: "disabled" } }, "linux");
    expect(await dockerLoginHint(off.ctx)).toContain("sudo systemctl enable docker");
  });

  test("jeder Hinweis nennt den Supabase-Autostart", async () => {
    for (const answers of [{ "docker info": { stdout: "OrbStack" } }, {}]) {
      expect(await dockerLoginHint((await ctxWith(answers)).ctx)).toContain("ai.tybo.supabase");
    }
  });
});

test("Einrichtung „Supabase auf diesem Rechner“: Hinweis genau einmal am Ende der Erfolgsmeldung", async () => {
  const f = fakeLocal({ "docker info": { stdout: "Docker Desktop" } });
  const ctx = await makeCtx({ env: `TELEGRAM_BOT_TOKEN=${FAKE.token}\n`, overrides: { run: f.run, localSupabase: f.deps } });
  await cp(join(resolve(import.meta.dir, ".."), "db"), join(ctx.root, "db"), { recursive: true });
  await desktopSettings(ctx.home, "settings-store.json", { AutoStart: false });
  const r = await runSupabaseLocal({ DB_BACKEND: "supabase-lokal" }, ctx, () => {}, new AbortController().signal);
  expect(r.ok).toBe(true);
  expect(r.message.split("startet beim Anmelden nicht von selbst").length - 1).toBe(1);
  expect(r.message.indexOf("Supabase läuft auf diesem Rechner")).toBeLessThan(r.message.indexOf("Docker Desktop"));
});
