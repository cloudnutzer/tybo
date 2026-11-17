/**
 * Issue #525, Eskalation 2: Klammergrenzen mit einer echten Bash prüfen.
 * gh ist eine reine Ausgabeattrappe in einem Temp-Ordner. Ein separates
 * Protokoll zeigt auch Aufrufe, deren Ausgabe eine Substitution verschluckt.
 * Keine Installation, kein Netzabruf, kein Import von src/bot.ts.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bashNetworkReason, GH_REASON, lexShell } from "../src/lib/bash-network";
import { NESTED_SUBSTITUTION_CASES } from "./fixtures/bash-network-cases";

const owners = ["cloudnutzer"];
const base = mkdtempSync(join(tmpdir(), "bash-network-nesting-"));
const bin = join(base, "bin");
const trace = join(base, "calls");
mkdirSync(bin);
writeFileSync(join(bin, "gh"), `#!/bin/sh
printf '%s\\0' gh "$@" >> "$TYBO_TEST_TRACE"
printf '\\n' >> "$TYBO_TEST_TRACE"
printf 'Inhalt\\n'
`, { mode: 0o700 });
afterAll(() => rmSync(base, { recursive: true, force: true }));

function shellCalls(command: string): string[][] {
  writeFileSync(trace, "");
  const result = Bun.spawnSync(["/bin/bash", "--noprofile", "--norc", "-c", command], {
    cwd: base,
    env: { PATH: `${bin}:/usr/bin:/bin`, LC_ALL: "C", TYBO_TEST_TRACE: trace },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 5_000,
  });
  expect(result.exitCode).toBe(0);
  expect(result.stderr.toString()).toBe("");
  return readFileSync(trace, "utf8").split("\n").filter(Boolean).map(call => call.split("\0").slice(0, -1));
}

describe("Eskalation 2: vollständige Grenzen verschachtelter Shell-Befehle", () => {
  for (const { command, nested } of NESTED_SUBSTITUTION_CASES) {
    test(`fremd oder unbekannt bleibt fremd: ${command}`, () => {
      expect(bashNetworkReason(command, owners)).toBe(GH_REASON);
    });

    test(`Bash führt den inneren Abruf aus: ${command}`, () => {
      expect(shellCalls(command)).toContainEqual(nested);
      expect(bashNetworkReason(command, owners)).toBe(GH_REASON);
    });
  }

  test.each([
    'gh issue list -R cloudnutzer/y --search "$( (true)"',
    'gh issue list -R cloudnutzer/y --search "$( (true); (true)"',
    '(gh issue list -R cloudnutzer/y',
    'gh issue list -R cloudnutzer/y)',
    'gh issue list -R cloudnutzer/y --search "$( ( ( ( (true) ) ) ) )"',
  ])("unvollständig oder zu tief: %s", command => {
    expect(bashNetworkReason(command, owners)).toBe(GH_REASON);
    expect(lexShell(command).broken).toBe(true);
  });

  test.each([
    'gh issue list -R cloudnutzer/y --search "$( (true); gh api repos/cloudnutzer/y )"',
    'gh issue list -R cloudnutzer/y --search "$( ( (true) ); gh api repos/cloudnutzer/y )"',
    'gh issue comment 1 -R cloudnutzer/y --body "$( (echo Inhalt) )"',
    'gh api repos/cloudnutzer/y -f x="$( (true); echo Inhalt )"',
    'gh issue list -R cloudnutzer/y --search "$( (true) # ) bleibt im Kommentar\n echo Inhalt\n)"',
    `gh issue list -R cloudnutzer/y --search "$( (echo ')') )"`,
    String.raw`gh issue list -R cloudnutzer/y --search "$( (echo \)) )"`,
    "gh issue list -R cloudnutzer/y --search '$( (true); gh api repos/fremd/x )'",
  ])("eigene Abrufe, lokale Werte und wörtlicher Text bleiben eigen: %s", command => {
    expect(bashNetworkReason(command, owners)).toBeNull();
  });
});
