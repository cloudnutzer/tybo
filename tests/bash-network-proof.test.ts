/**
 * Issue #525, Eskalation: Gegenproben mit echten Shell-Wörtern, aber nur
 * Ausgabeattrappen in einem Temp-Ordner. Kein gh, curl oder wget aus der
 * Installation und kein Netzabruf. Anschließend dieselbe Herkunftsprüfung.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bashNetworkReason } from "../src/lib/bash-network";
import { UNPROVEN_GH_COMMANDS } from "./fixtures/bash-network-cases";

const owners = ["cloudnutzer"];
const base = mkdtempSync(join(tmpdir(), "bash-network-proof-"));
const bin = join(base, "bin");
mkdirSync(bin);
for (const program of ["gh", "curl", "wget"]) {
  writeFileSync(join(bin, program), `#!/bin/sh\nprintf '%s\\n' '${program}' "$@"\n`, { mode: 0o700 });
}
writeFileSync(join(base, "--hostname=enterprise.example"), "");
mkdirSync(join(base, "--repo=fremd"));
writeFileSync(join(base, "--repo=fremd", "x"), "");
afterAll(() => rmSync(base, { recursive: true, force: true }));

function shellArguments(command: string): string[] {
  const result = Bun.spawnSync(["/bin/bash", "--noprofile", "--norc", "-c", command], {
    cwd: base,
    env: { PATH: `${bin}:/usr/bin:/bin`, LC_ALL: "C" },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 5_000,
  });
  expect(result.exitCode).toBe(0);
  expect(result.stderr.toString()).toBe("");
  return result.stdout.toString().trim().split("\n");
}

describe("Eskalation: vollständiger Nachweis für die gh-Ausnahme", () => {
  test.each(UNPROVEN_GH_COMMANDS)("unklar bleibt fremd: %s", command => {
    expect(bashNetworkReason(command, owners)).not.toBeNull();
  });

  test.each([
    ["env -S 'gh issue list -R cloudnutzer/y' '-Rfremd/x'", ["gh", "issue", "list", "-R", "cloudnutzer/y", "-Rfremd/x"]],
    ["env -S 'gh pr list -R cloudnutzer/y' '--repo=fremd/x'", ["gh", "pr", "list", "-R", "cloudnutzer/y", "--repo=fremd/x"]],
    ["env -S 'gh api repos/cloudnutzer/y' '--hostname=enterprise.example'", ["gh", "api", "repos/cloudnutzer/y", "--hostname=enterprise.example"]],
    ["gh issue list -R cloudnutzer/y; env -S 'gh api repos/cloudnutzer/y' '--hostname=enterprise.example'", ["gh", "issue", "list", "-R", "cloudnutzer/y", "gh", "api", "repos/cloudnutzer/y", "--hostname=enterprise.example"]],
    ["gh issue list -R cloudnutzer/y; cu''rl example.com", ["gh", "issue", "list", "-R", "cloudnutzer/y", "curl", "example.com"]],
    ["gh issue list -R cloudnutzer/y; wge''t example.com", ["gh", "issue", "list", "-R", "cloudnutzer/y", "wget", "example.com"]],
    ["gh api repos/cloudnutzer/y --[h]ostname=enterprise.example", ["gh", "api", "repos/cloudnutzer/y", "--hostname=enterprise.example"]],
    ...["issue", "pr", "release"].map(sub => [
      `gh ${sub} list -R cloudnutzer/y --[r]epo=fremd/x`,
      ["gh", sub, "list", "-R", "cloudnutzer/y", "--repo=fremd/x"],
    ]),
  ] as [string, string[]][])("Shell bildet den fremden Abruf: %s", (command, args) => {
    expect(shellArguments(command)).toEqual(args);
    expect(bashNetworkReason(command, owners)).not.toBeNull();
  });

  test.each([
    "gh issue list --search '--[r]epo=fremd/x' -R cloudnutzer/y",
    "gh pr list --search '--[r]epo=fremd/x' -R cloudnutzer/y",
    "gh api repos/cloudnutzer/y --jq '--[h]ostname=enterprise.example'",
    "gh issue list --search \\* -R cloudnutzer/y",
    "env NO_COLOR=1 gh issue list -R cloudnutzer/y | head -5",
    "command gh issue list -R cloudnutzer/y && gh api repos/cloudnutzer/y",
  ])("feste Argumente bleiben eigen: %s", command => {
    expect(bashNetworkReason(command, owners)).toBeNull();
  });

  test("Anführungszeichen und Backslash verhindern die Dateinamenerweiterung", () => {
    expect(shellArguments("gh issue list --search '--[r]epo=fremd/x' -R cloudnutzer/y"))
      .toEqual(["gh", "issue", "list", "--search", "--[r]epo=fremd/x", "-R", "cloudnutzer/y"]);
    expect(shellArguments("gh api repos/cloudnutzer/y --jq '--[h]ostname=enterprise.example'"))
      .toEqual(["gh", "api", "repos/cloudnutzer/y", "--jq", "--[h]ostname=enterprise.example"]);
  });
});
