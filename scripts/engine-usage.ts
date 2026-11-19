#!/usr/bin/env -S bun --no-env-file
/** Externe Limit-Messwerte: Aufruf und Prüfung in src/lib/engines/usage-cli.ts. */
import { runUsageCli } from "../src/lib/engines/usage-cli";

if (import.meta.main) process.exitCode = await runUsageCli(process.argv.slice(2));
