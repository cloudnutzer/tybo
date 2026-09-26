#!/usr/bin/env bun
/**
 * Request a bot restart that happens AFTER the current reply was delivered.
 *
 *   bun run restart:request "Tabellen-Fix aktivieren"
 *
 * Safe to call from inside a bot subprocess (unlike kill / launchctl
 * kickstart -k, which abort the very answer that is being written).
 * See src/lib/restart-request.ts.
 */

import { requestRestart, RESTART_MARKER } from "../src/lib/restart-request";

const note = process.argv.slice(2).join(" ").trim();
await requestRestart(note);
console.log(
  `Neustart angefordert (${RESTART_MARKER})${note ? `: ${note}` : ""}.\n` +
    "Der Bot startet neu, sobald keine Verarbeitung mehr laeuft (nach der laufenden Antwort)."
);
