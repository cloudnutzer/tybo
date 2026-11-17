/**
 * Zustand der SIP-Vermittlung prüfen und einen Ausfall einmal melden (Issue #511).
 *
 *   bun run sip-zustand            prüfen, bei Bedarf melden, Zustand speichern
 *   bun run sip-zustand --no-send  nur anzeigen, nichts senden, nichts speichern
 *
 * Gedacht als Routine alle zehn Minuten über src/routine-run.ts
 * (deploy/sip-vermittlung/README.md, "Zustand und Meldung"). Die Meldung
 * kommt über die Outbox (Absender sip-vermittlung), in Telegram und in der
 * WebUI. Exit 0, wenn der Lauf seinen Zustand bewertet hat, auch bei Ausfall
 * der Vermittlung: Den meldet dieses Skript selbst, der Wrapper soll nicht
 * zusätzlich melden. Exit 1, wenn der Zustand nicht gespeichert oder die
 * Meldung nicht zugestellt werden konnte.
 */
import { atomicWriteFile } from "./lib/atomic-file";
import { loadEnv, PROJECT_ROOT } from "./lib/env";
import { describeStatus, fetchRelayStatus, type CommandRunner, type RelayStatus } from "./lib/sip-relay/status";
import { evaluateWatch, readWatchState, statePath, type WatchState } from "./lib/sip-relay/watch";

type Env = Record<string, string | undefined>;

export interface SipWatchDeps {
  env: Env;
  now: () => Date;
  statePath: string;
  run?: CommandRunner;
  /** Meldung zustellen; true heißt zugestellt */
  send(text: string): Promise<boolean>;
  write(path: string, content: string): Promise<void>;
  log(line: string): void;
}

export interface SipWatchResult {
  status: RelayStatus;
  sent: string | null;
  state: WatchState;
  exitCode: number;
}

/** Ein Lauf: abfragen, bewerten, ggf. melden, speichern */
export async function runSipWatch(deps: SipWatchDeps, options: { send: boolean }): Promise<SipWatchResult> {
  const now = deps.now();
  const status = await fetchRelayStatus(deps.env, deps.run);
  deps.log(`SIP-Vermittlung: ${describeStatus(status, now.getTime())}`);
  const prev = readWatchState(deps.statePath);
  const decision = evaluateWatch(prev, status, now);
  if (!options.send) {
    if (decision.message) deps.log(`Würde melden: ${decision.message}`);
    return { status, sent: null, state: prev, exitCode: 0 };
  }
  let state = decision.next;
  let sent: string | null = null;
  let exitCode = 0;
  if (decision.message) {
    const delivered = await deps.send(decision.message).catch(() => false);
    if (delivered) sent = decision.message;
    else {
      state = decision.ifUndelivered;
      exitCode = 1;
      deps.log("Meldung nicht zugestellt, nächster Lauf versucht es erneut");
    }
  }
  try {
    await deps.write(deps.statePath, `${JSON.stringify(state, null, 2)}\n`);
  } catch {
    deps.log("Zustand nicht gespeichert");
    exitCode = 1;
  }
  return { status, sent, state, exitCode };
}

if (import.meta.main) {
  await loadEnv();
  const send = !process.argv.includes("--no-send");
  const result = await runSipWatch(
    {
      env: process.env,
      now: () => new Date(),
      statePath: statePath(PROJECT_ROOT),
      async send(text) {
        const { defaultOutboxDeps, outboxDelivered, sendAndRecord } = await import("./lib/outbox");
        const sent = await sendAndRecord({ source: "sip-vermittlung", text, format: "plain" }, defaultOutboxDeps());
        return !sent.error && outboxDelivered(sent);
      },
      write: atomicWriteFile,
      log: line => console.log(line),
    },
    { send }
  );
  process.exit(result.exitCode);
}
