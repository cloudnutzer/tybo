/**
 * Längste Dauer eines abgebrochenen `tybo datenbank start` (Issue #165):
 * Bereinigung des abgebrochenen CLI-Aufrufs, Anhalten für den Neustart,
 * docker ps, Heimnetz (je Port höchstens 1,5 s bei bis zu 8 Adressen),
 * Schutz-Stopp, Nachprüfung, jeweils mit Schonfrist. Die Fristen der
 * Dienstmanager (PM2 --kill-timeout, launchd ExitTimeOut) müssen darüber liegen.
 */

import { KILL_GRACE_MS } from "../src/setup/context";
import { DOCKER_TIMEOUT_MS, GUARDED_PORTS, STATUS_TIMEOUT_MS } from "../src/setup/local-supabase";

export const ABORT_WORST_CASE_MS =
  KILL_GRACE_MS + (STATUS_TIMEOUT_MS + KILL_GRACE_MS) * 2 + (DOCKER_TIMEOUT_MS + KILL_GRACE_MS) * 2 + GUARDED_PORTS.length * 8 * 1_500;
