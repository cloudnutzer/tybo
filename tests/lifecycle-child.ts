// Kindprozess für tests/app-lifecycle.test.ts (Issue #342): echter Lebenszyklus
// mit Sperre im übergebenen Ordner und echten Signal-Handlern, ohne src/bot.ts
import { join } from "path";
import { createLifecycle, createProcessLock, installSignalHandlers } from "../src/app/lifecycle";

const dir = process.argv[2]!;
const lock = createProcessLock({ path: join(dir, "bot.lock"), pid: process.pid });
if (!(await lock.acquire())) {
  console.log("gesperrt");
  process.exit(1);
}
const lifecycle = createLifecycle({ lock, exit: code => process.exit(code), settleMs: 10 });
lifecycle.startHeartbeat();
lifecycle.onShutdown("Probe", () => console.log("closer"));
installSignalHandlers(lifecycle, { on: (event, handler) => void process.on(event, handler) });
console.log("bereit");
