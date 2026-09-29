/**
 * Issue #211: puppeteer gehört nicht zu den Abhängigkeiten. Sein Postinstall
 * lädt bei jeder Installation einen Chrome nach ~/.cache/puppeteer (auf dem
 * Raspberry Pi 652 MB x86-64, der dort nicht startet), und tybo nutzt es nicht.
 * Auch devDependencies reichen nicht: install.sh und setup/upgrade.ts
 * installieren ohne --production.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");
const pkg = JSON.parse(read("package.json"));

describe("keine Browser-Abhängigkeit", () => {
  test("package.json nennt puppeteer in keinem Abhängigkeitsfeld", () => {
    for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
      const names = Object.keys(pkg[field] ?? {});
      expect(names.filter(n => /puppeteer/i.test(n))).toEqual([]);
    }
  });

  test("bun.lock und supabase/deno.lock enthalten puppeteer nicht", () => {
    expect(read("bun.lock")).not.toMatch(/puppeteer/i);
    expect(read("supabase/deno.lock")).not.toMatch(/puppeteer/i);
  });
});
