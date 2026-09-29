/**
 * Schritt „voraussetzungen“: Bun, Claude CLI (vorhanden und angemeldet), Git.
 * Installiert nichts selbst; fehlt etwas, steht der Befehl zum Nachholen da.
 *
 * status() prüft nur die Versionen (schnell). Ob die Claude CLI angemeldet
 * ist, zeigt erst test(): ein kurzer Probeaufruf mit Zeitlimit und
 * gefilterter Umgebung. Mit ctx.noModelCalls (Einrichtung im Browser)
 * entfällt der Probeaufruf, die Meldung sagt das.
 */

import { stat } from "node:fs/promises";
import { join } from "node:path";
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

/**
 * Nativer Installer von Anthropic (Linux, macOS, WSL): braucht weder Node.js
 * noch sudo und legt claude in ~/.local/bin ab. Gleichlauf mit
 * CLAUDE_INSTALL_CMD in install.sh (tests/install-sh.test.ts).
 */
export const CLAUDE_INSTALL = "curl -fsSL https://claude.ai/install.sh | bash";
/** Windows ohne WSL: der bisherige Weg über npm */
export const CLAUDE_INSTALL_WINDOWS = "npm install -g @anthropic-ai/claude-code";
/** claude liegt in ~/.local/bin, der Ordner ist in dieser Sitzung nicht im PATH */
export const CLAUDE_NOT_IN_PATH =
  "Claude CLI liegt in ~/.local/bin, das ist noch nicht im PATH: neue Sitzung öffnen. Hilft das nicht, die Zeile darunter in ~/.bashrc bzw. ~/.zshrc eintragen.";
export const LOCAL_BIN_PATH_FIX = 'export PATH="$HOME/.local/bin:$PATH"';
/** Einrichtungsmodus im Browser: kein Probeaufruf, ehrlich gesagt */
export const CLAUDE_LOGIN_NOT_CHECKED =
  "Ob die Claude CLI angemeldet ist, prüft die Einrichtung im Browser nicht (kein Modellaufruf). Im Terminal mit „claude“ prüfen.";

function claudeInstall(platform: NodeJS.Platform): string {
  return platform === "win32" ? CLAUDE_INSTALL_WINDOWS : CLAUDE_INSTALL;
}

async function configuredClaudePath(ctx: SetupContext): Promise<string | undefined> {
  return (await envValues(ctx, ["CLAUDE_PATH"])).CLAUDE_PATH;
}

async function claudePath(ctx: SetupContext): Promise<string> {
  return (await configuredClaudePath(ctx)) ?? "claude";
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * Claude CLI prüfen. Sonderfall (Issue #212): claude ist im PATH nicht zu
 * finden, liegt aber in ~/.local/bin (nativer Installer, gleiche Sitzung).
 * Dann ein PATH-Hinweis statt einer Neuinstallation, aber nur, wenn
 * CLAUDE_PATH nicht gesetzt ist und die Datei dort selbst eine Version meldet.
 */
async function claudeItem(ctx: SetupContext): Promise<StatusItem> {
  const configured = await configuredClaudePath(ctx);
  const claude = await ctx.providers.claudeVersion(configured ?? "claude");
  const item: StatusItem = {
    label: "Claude CLI",
    ok: claude.ok,
    detail: claude.message,
    fix: claude.ok ? undefined : claudeInstall(ctx.platform),
  };
  if (claude.ok || !claude.notFound || configured || ctx.platform === "win32") return item;
  const local = join(ctx.home, ".local", "bin", "claude");
  if (!(await isFile(local))) return item;
  const direct = await ctx.providers.claudeVersion(local);
  if (!direct.ok) {
    return { ...item, detail: "Claude CLI liegt in ~/.local/bin, startet dort aber nicht. Neu installieren." };
  }
  return { ...item, detail: CLAUDE_NOT_IN_PATH, fix: LOCAL_BIN_PATH_FIX };
}

async function checks(ctx: SetupContext): Promise<StatusItem[]> {
  const bunOk = versionAtLeast(ctx.bunVersion, MIN_BUN_VERSION);
  const claude = await claudeItem(ctx);
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
    claude,
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
