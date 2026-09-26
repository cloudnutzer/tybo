/**
 * Hilfen für die Tests von `tybo setup` im Terminal (Issue #65): simulierte
 * Eingaben und eine PM2-Attrappe, die sich merkt, was gestartet und
 * gespeichert wurde. Nichts startet echte Befehle, nichts geht ins Netz.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { CommandResult, CommandRunner, SetupContext } from "../src/setup/context";
import { SetupAbort, type AskOptions, type Prompter } from "../src/setup/prompt";
import { runSetup, type SetupArgs, type SetupUiOptions } from "../src/setup/terminal";
import { makeCtx } from "./setup-fixture";

/** Simuliertes Strg+C an dieser Stelle der Eingaben */
export const CTRL_C = Symbol("Strg+C");

export interface Asked {
  question: string;
  secret: boolean;
}

export type Scripted = Prompter & { asked: Asked[]; left(): number };

/** Beantwortet Fragen der Reihe nach; sind die Antworten aus, bricht er ab wie Strg+C */
export function scripted(answers: Array<string | typeof CTRL_C | (() => string | typeof CTRL_C)>): Scripted {
  const queue = [...answers];
  const asked: Asked[] = [];
  return {
    asked,
    left: () => queue.length,
    async ask(question: string, options: AskOptions = {}) {
      asked.push({ question, secret: !!options.secret });
      let next = queue.shift();
      if (typeof next === "function") next = next();
      if (next === undefined || next === CTRL_C) throw new SetupAbort();
      return next;
    },
  };
}

/**
 * PM2-Attrappe (Linux): pm2 start merkt sich den Dienst, pm2 save schreibt
 * dump.pm2 in den Testordner. So gilt Autostart danach als erledigt.
 */
export function pm2Run(ctx: { pm2DumpPath: string }): CommandRunner & { calls: string[][] } {
  const calls: string[][] = [];
  let started = false;
  const ok = (stdout = ""): CommandResult => ({ code: 0, stdout, stderr: "" });
  const run = (async (cmd: string[]) => {
    calls.push(cmd);
    const line = cmd.join(" ");
    if (line.startsWith("git --version")) return ok("git version 2.50.0");
    if (line === "pm2 --version") return ok("6.0.0");
    if (line === "pm2 jlist") return ok(JSON.stringify(started ? [{ name: "tybo-telegram-relay" }] : []));
    if (line.startsWith("pm2 delete")) return { code: 1, stdout: "", stderr: "not found" };
    if (line.startsWith("pm2 start")) {
      started = true;
      return ok();
    }
    if (line === "pm2 save") {
      await mkdir(dirname(ctx.pm2DumpPath), { recursive: true });
      await writeFile(ctx.pm2DumpPath, JSON.stringify([{ name: "tybo-telegram-relay" }]));
      return ok();
    }
    return { code: -1, stdout: "", stderr: "Befehl nicht gefunden" };
  }) as CommandRunner & { calls: string[][] };
  run.calls = calls;
  return run;
}

/** Kontext auf Linux mit PM2-Attrappe; env: Inhalt der .env (undefined: keine Datei) */
export async function linuxCtx(options: { env?: string; profile?: string; overrides?: Partial<SetupContext> } = {}) {
  const ctx = await makeCtx({ env: options.env, profile: options.profile, overrides: { platform: "linux", ...options.overrides } });
  const run = pm2Run(ctx);
  ctx.run = run as any;
  return Object.assign(ctx, { run });
}

export interface RunResult {
  code: number;
  out: string;
  lines: string[];
}

/** Führt tybo setup mit simulierten Eingaben aus */
export async function runWith(
  args: SetupArgs,
  ctx: SetupContext,
  prompter: Prompter,
  extra: Pick<SetupUiOptions, "onInterrupt" | "steps"> = {},
): Promise<RunResult> {
  const lines: string[] = [];
  const code = await runSetup(args, { ctx, prompter, out: l => lines.push(l), lanAddresses: () => ["192.168.1.50"], ...extra });
  return { code, out: lines.join("\n"), lines };
}
