/**
 * Issue #137: Angaben in package.json, die im öffentlichen Repo und bei npm
 * sichtbar sind, passen zu BRAND (src/brand.ts).
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { BRAND } from "../src/brand";
import { OLD_NAME } from "./old-names";

const pkg = await Bun.file(join(import.meta.dir, "..", "package.json")).json();

describe("package.json", () => {
  test("Name und Lizenz", () => {
    expect(pkg.name).toBe(BRAND.name);
    expect(pkg.license).toBe("MIT");
  });

  test("repository, homepage und bugs aus BRAND.repo und BRAND.domain", () => {
    expect(pkg.repository).toEqual({ type: "git", url: `git+https://github.com/${BRAND.repo}.git` });
    expect(pkg.homepage).toBe(`https://${BRAND.domain}`);
    expect(pkg.bugs).toBe(`https://github.com/${BRAND.repo}/issues`);
  });

  test("Beschreibung ohne Hinweis auf Fork oder Ursprung", () => {
    expect(typeof pkg.description).toBe("string");
    expect(pkg.description).not.toMatch(new RegExp(`fork|${OLD_NAME}|upstream|origin`, "i"));
  });
});
