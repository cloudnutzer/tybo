/**
 * Kindprozess für tests/local-supabase-abort.test.ts (Issue #164): echtes
 * `tybo setup datenbank` bzw. `tybo setup --web` über main() aus
 * scripts/tybo.ts, also mit dem echten SIGINT-Handler und dem echten
 * process.exit am Ende. docker und die Supabase-CLI sind Attrappen
 * (tests/local-supabase-fixture.ts).
 *
 * Aufruf: bun tests/local-supabase-abort-child.ts <projektordner> setup datenbank|--web
 * bzw. <projektordner> datenbank start (Issue #165, auch über die Hülle
 * scripts/run-once-and-stay.ts, mit den echten SIGINT/SIGTERM-Handlern)
 * Jeder Schritt der Attrappen landet mit Zeitstempel in <projektordner>/trail.log,
 * die Adresse des Einrichtungsmodus in <projektordner>/url.txt.
 * Umgebung: CHILD_SLOW=0 (docker ps und supabase stop schnell, Schonfrist
 * FAST_GRACE_MS; sonst länger als die Schonfrist CHILD_GRACE_MS), CHILD_STOP=fehler (supabase stop scheitert) bzw.
 * bleibt (meldet Erfolg, die Container laufen aber weiter). CHILD_SLOW_MS=<ms>
 * setzt die Dauer der langsamen Schritte; CHILD_CLEANUP=1: der abgebrochene
 * supabase start braucht selbst so lange zum Aufräumen (start-abbruch,
 * start-bereinigt), wie beim echten CLI-Aufruf mit Schonfrist
 * (scripts/pm2-stop-proof.ts).
 */

import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../scripts/tybo";
import { createSetupContext } from "../src/setup/context";
import { fakeLocal, OPEN_CONTAINERS } from "./local-supabase-fixture";
import { scripted } from "./setup-terminal-fixture";
import { CODE } from "./setup-web-fixture";

export const CHILD_GRACE_MS = 500;
export const SLOW_MS = 1_500;
/** Schonfrist im schnellen Fall: nur Obergrenze, reicht auch bei ausgelasteter Maschine */
export const FAST_GRACE_MS = 10_000;

const root = process.argv[2];
process.argv.splice(2, 1);
const slowMs = process.env.CHILD_SLOW === "0" ? 0 : Number(process.env.CHILD_SLOW_MS) || SLOW_MS;
const cleanup = process.env.CHILD_CLEANUP === "1";
const graceMs = process.env.CHILD_SLOW === "0" ? FAST_GRACE_MS : CHILD_GRACE_MS;
const stopMode = process.env.CHILD_STOP ?? "ok";
const trail = (event: string) => appendFileSync(join(root, "trail.log"), `${Date.now()} ${event}\n`);

const f = fakeLocal({
  // Halb gestartet mit offenen Ports, dann hängen bis zum Abbruch
  "supabase start": (_cmd, options) =>
    new Promise(res => {
      f.containers = OPEN_CONTAINERS;
      trail("start");
      const done = async () => {
        if (cleanup) {
          trail("start-abbruch");
          await Bun.sleep(slowMs);
          trail("start-bereinigt");
        }
        res({ code: -1, aborted: true });
      };
      if (options.signal?.aborted) return done();
      options.signal?.addEventListener("abort", done, { once: true });
    }),
  "docker ps": async () => {
    trail("ps-anfang");
    await Bun.sleep(slowMs);
    trail("ps-ende");
    return { stdout: f.containers.map(c => `${c}\n`).join("") };
  },
  "supabase stop": async () => {
    trail("stop-anfang");
    await Bun.sleep(slowMs);
    trail("stop-ende");
    if (stopMode === "fehler") return { code: 1, stderr: "failed to stop containers" };
    return { stdout: "Stopped supabase local development setup." };
  },
});

f.stopKeeps = stopMode === "bleibt";

const ctx = createSetupContext({
  root,
  home: join(root, "home"),
  run: f.run,
  localSupabase: f.deps,
  fetch: async () => {
    throw new Error("Kein Netz in Tests");
  },
});

process.on("exit", code => trail(`exit ${code}`));
await main({
  setup: {
    ctx,
    prompter: scripted(["2", ""]),
    runGraceMs: graceMs,
    web: { code: CODE, port: 0, runGraceMs: graceMs, onReady: ({ url }) => writeFileSync(join(root, "url.txt"), url) },
  },
});
