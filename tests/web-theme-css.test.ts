// Hell/Dunkel in style.css (Issue #15): Die dunklen Werte stehen zweimal
// (gewählt „Dunkel" und System-Dunkel ohne Wahl „Hell"). Dieser Test sorgt
// dafür, dass beide Blöcke gleich bleiben und nichts dazwischen abweicht.
import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const css = await readFile(resolve(import.meta.dir, "..", "src", "web", "public", "style.css"), "utf8");
const code = css.replace(/\/\*[\s\S]*?\*\//g, "");

/** Inhalt des Blocks, der an Position `open` (auf der „{") beginnt. */
function blockAt(source: string, open: number): string {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) return source.slice(open + 1, i);
  }
  throw new Error("Block nicht geschlossen");
}

/** Alle Blöcke mit genau diesem Selektor bzw. dieser At-Regel. */
function blocks(source: string, selector: string): string[] {
  const out: string[] = [];
  const pattern = new RegExp(`(?:^|[}\\s;])${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{`, "g");
  for (const m of source.matchAll(pattern)) out.push(blockAt(source, m.index! + m[0].length - 1));
  return out;
}

/** Deklarationen als Liste "name: wert", Leerraum vereinheitlicht. */
function declarations(block: string): string[] {
  return block
    .split(";")
    .map(d => d.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

const asMap = (list: string[]) => Object.fromEntries(list.map(d => [d.slice(0, d.indexOf(":")).trim(), d.slice(d.indexOf(":") + 1).trim()]));

test("es gibt genau einen gewählten und einen System-Dunkel-Block, beide identisch", () => {
  const chosen = blocks(code, ':root[data-theme="dark"]');
  expect(chosen).toHaveLength(1);
  const media = blocks(code, "@media (prefers-color-scheme: dark)");
  expect(media).toHaveLength(1);
  const system = blocks(media[0], ':root:not([data-theme="light"])');
  expect(system).toHaveLength(1);
  // Im Media-Block steht nichts außer dieser einen Regel
  expect(media[0].replace(/:root:not\(\[data-theme="light"\]\)\s*\{[^}]*\}/, "").trim()).toBe("");

  const a = declarations(chosen[0]);
  const b = declarations(system[0]);
  expect(b).toEqual(a);
  expect(a.length).toBeGreaterThan(20);
});

test("dunkle Werte überschreiben nur vorhandene helle Variablen und setzen color-scheme dark", () => {
  const light = asMap(declarations(blocks(code, ":root")[0]));
  const dark = asMap(declarations(blocks(code, ':root[data-theme="dark"]')[0]));
  expect(light["color-scheme"]).toBe("light dark");
  expect(dark["color-scheme"]).toBe("dark");
  for (const name of Object.keys(dark)) {
    if (name === "color-scheme") continue;
    expect(name.startsWith("--")).toBe(true);
    expect(light[name]).toBeDefined();
    expect(dark[name]).not.toBe(light[name]);
  }
  // Jede Farbvariable des hellen Modus hat ein dunkles Gegenstück
  for (const [name, value] of Object.entries(light)) {
    if (/^(#|rgba?\()/.test(value) || name === "--shadow") expect(dark[name]).toBeDefined();
  }
});

test('Wahl „Hell" setzt color-scheme light und nimmt keine anderen Werte', () => {
  const chosen = blocks(code, ':root[data-theme="light"]');
  expect(chosen).toHaveLength(1);
  expect(declarations(chosen[0])).toEqual(["color-scheme: light"]);
});

test("keine weiteren Stellen fragen prefers-color-scheme ab", () => {
  expect(code.match(/prefers-color-scheme/g)).toHaveLength(1);
});
