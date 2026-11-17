// Kindprozess für tests/app-lifecycle.test.ts (Issue #342): echter Lebenszyklus
// mit Sperre im übergebenen Ordner und echten Signal-Handlern, ohne src/bot.ts
import { join } from "path";
import { acquireLockOrExit, createLifecycle, createProcessLock, installSignalHandlers } from "../src/app/lifecycle";

const dir = process.argv[2]!;
const lockPath = join(dir, "bot.lock");
const lock = createProcessLock({ path: lockPath, pid: process.pid });
// Wie src/bot.ts: Grund auf stderr, dann Exit 1 (Issue #564)
await acquireLockOrExit(lock, {
  path: lockPath,
  exit: code => {
    console.log("gesperrt");
    process.exit(code);
  },
});
const lifecycle = createLifecycle({ lock, exit: code => process.exit(code), settleMs: 10 });
lifecycle.startHeartbeat();
lifecycle.onShutdown("Probe", () => console.log("closer"));
installSignalHandlers(lifecycle, { on: (event, handler) => void process.on(event, handler) });
console.log("bereit");
