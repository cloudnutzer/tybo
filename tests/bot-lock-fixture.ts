/**
 * Hilfen für Tests rund um bot.lock (Issue #564), ohne src/bot.ts dieses
 * Repos: Sperre im neuen Format für einen eigenen Prozess und ein
 * Platzhalter-Bot, der in einem temporären Projektordner als src/bot.ts
 * liegt, nur schläft und dem Test gehört (er beendet ihn selbst).
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { formatLockContent } from "../src/app/lifecycle";
import { stableProcessInfo } from "../src/lib/jobs/process";

/** Sperre im neuen Format mit der echten Startzeit von pid */
export function currentLockOf(pid: number): string {
  const info = stableProcessInfo(pid);
  if (!info) throw new Error(`ps kennt ${pid} nicht`);
  return formatLockContent({ pid, started: info.started });
}

export interface FakeBot {
  pid: number;
  stop(): Promise<void>;
}

/**
 * Startet `bun run src/bot.ts` (relativ, Arbeitsordner root) bzw.
 * `bun <root>/src/bot.ts` (absolut). Die Datei ist ein Platzhalter, der nur
 * wartet; sie entsteht hier in root.
 */
export async function spawnFakeBot(root: string, call: "relative" | "absolute", cwd = root): Promise<FakeBot> {
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "bot.ts"), 'console.log("bereit");\nsetInterval(() => {}, 60_000);\n');
  const cmd = call === "relative" ? ["bun", "--no-env-file", "run", "src/bot.ts"] : ["bun", "--no-env-file", join(root, "src", "bot.ts")];
  const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "ignore", env: { PATH: process.env.PATH ?? "" } });
  const reader = proc.stdout.getReader();
  let out = "";
  while (!out.includes("bereit")) {
    const { value, done } = await reader.read();
    if (done) throw new Error("Platzhalter-Bot startet nicht");
    out += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  return {
    pid: proc.pid,
    async stop() {
      // Eigener Kindprozess dieses Tests, kein fremder
      proc.kill("SIGKILL");
      await proc.exited;
    },
  };
}
