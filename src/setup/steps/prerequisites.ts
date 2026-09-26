/**
 * Schritt „voraussetzungen“: Bun, Claude CLI (vorhanden und angemeldet), Git.
 * Installiert nichts selbst; fehlt etwas, steht der Befehl zum Nachholen da.
 *
 * status() prüft nur die Versionen (schnell). Ob die Claude CLI angemeldet
 * ist, zeigt erst test(): ein kurzer Probeaufruf mit Zeitlimit und
 * gefilterter Umgebung. Mit ctx.noModelCalls (Einrichtung im Browser)
 * entfällt der Probeaufruf, die Meldung sagt das.
 */

import type { SetupContext } from "../context";
import { stateFromCount, type SetupStep, type StatusItem } from "../model";
import { versionOnly } from "../providers";
import { envValues } from "./common";

/** Mindestversion wie in package.json (engines.bun) */
export const MIN_BUN_VERSION = "1.3.10";

/** Vergleicht x.y.z; true, wenn version mindestens min ist */
export function versionAtLeast(version: string, min: string): boolean {
  const parse = (v: string) => (v.match(/\d+/g) ?? []).slice(0, 3).map(Number);
  const a = parse(version);
  const b = parse(min);
  for (let i = 0; i < 3; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

function gitFix(platform: NodeJS.Platform): string {
  if (platform === "darwin") return "xcode-select --install";
  if (platform === "win32") return "winget install Git.Git";
  return "sudo apt install git";
}

export const CLAUDE_INSTALL = "npm install -g @anthropic-ai/claude-code";
/** Einrichtungsmodus im Browser: kein Probeaufruf, ehrlich gesagt */
export const CLAUDE_LOGIN_NOT_CHECKED =
  "Ob die Claude CLI angemeldet ist, prüft die Einrichtung im Browser nicht (kein Modellaufruf). Im Terminal mit „claude“ prüfen.";

async function claudePath(ctx: SetupContext): Promise<string> {
  return (await envValues(ctx, ["CLAUDE_PATH"])).CLAUDE_PATH ?? "claude";
}

async function checks(ctx: SetupContext): Promise<StatusItem[]> {
  const bunOk = versionAtLeast(ctx.bunVersion, MIN_BUN_VERSION);
  const claude = await ctx.providers.claudeVersion(await claudePath(ctx));
  const git = await ctx.run(["git", "--version"], { timeoutMs: 10_000 });
  const gitOk = git.code === 0;
  // Nur die Versionsnummer, nie die rohe Ausgabe
  const gitVersion = gitOk ? versionOnly(git.stdout) : null;
  return [
    {
      label: "Bun",
      ok: bunOk,
      detail: bunOk ? `Bun ${ctx.bunVersion}` : `Bun ${ctx.bunVersion} ist zu alt, nötig ist ${MIN_BUN_VERSION} oder neuer.`,
      fix: bunOk ? undefined : "bun upgrade",
    },
    {
      label: "Claude CLI",
      ok: claude.ok,
      detail: claude.message,
      fix: claude.ok ? undefined : CLAUDE_INSTALL,
    },
    {
      label: "Git",
      ok: gitOk,
      detail: gitOk ? (gitVersion ? `Git ${gitVersion}` : "Git gefunden.") : "Git nicht gefunden.",
      fix: gitOk ? undefined : gitFix(ctx.platform),
    },
  ];
}

export const prerequisitesStep: SetupStep = {
  id: "voraussetzungen",
  title: "Voraussetzungen",
  description: "Programme, die auf dem Rechner sein müssen. Die Einrichtung installiert sie nicht selbst.",
  optional: false,
  fields: [],

  async status(ctx) {
    const items = await checks(ctx);
    const state = stateFromCount(items.filter(i => i.ok).length, items.length);
    const missing = items.filter(i => !i.ok).map(i => i.label);
    return {
      state,
      detail: missing.length ? `Fehlt oder zu alt: ${missing.join(", ")}.` : "Bun, Claude CLI und Git sind da.",
      fields: [],
      items,
    };
  },

  async test(_values, ctx) {
    const items = await checks(ctx);
    const claude = items.find(i => i.label === "Claude CLI")!;
    if (ctx.noModelCalls) {
      const failed = items.filter(i => !i.ok);
      return {
        ok: failed.length === 0,
        message: failed.length ? failed.map(i => i.detail).join(" ") : `Bun, Claude CLI und Git sind da. ${CLAUDE_LOGIN_NOT_CHECKED}`,
        items,
      };
    }
    if (claude.ok) {
      const probe = await ctx.providers.claudeProbe(await claudePath(ctx));
      items.push({
        label: "Claude-Anmeldung",
        ok: probe.ok,
        detail: probe.message,
        fix: probe.ok ? undefined : "claude  (dann /login)",
      });
    }
    const failed = items.filter(i => !i.ok);
    return {
      ok: failed.length === 0,
      message: failed.length ? failed.map(i => i.detail).join(" ") : "Alles da, Claude CLI ist angemeldet.",
      items,
    };
  },
};
