/**
 * Issue #286, Checkbox 3: tybo routinen verteilt auf Liste, einbinden und
 * ausbinden. Alles Äußere aus der Attrappe; kein echter launchctl- oder
 * plutil-Aufruf.
 */

import { describe, expect, test } from "bun:test";
import { runTybo, parseWrapArgs } from "../scripts/tybo";
import { listRoutines } from "../src/lib/routines/catalog";
import { EINBINDEN_TEXT } from "../src/lib/routines/einbinden";
import { formatRoutineList } from "../src/lib/routines/format";
import { WRAP_TEXT } from "../src/lib/routines/wrap";
import { ROOT } from "./routines-fixture";
import { fake, LABEL, PATH } from "./routines-wrap-fixture";

async function tybo(args: string[], fk = fake()) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runTybo({
    args,
    env: {},
    root: ROOT,
    out: l => out.push(l),
    err: l => err.push(l),
    routines: { ...fk.deps, out: l => out.push(l), err: l => err.push(l) },
  });
  return { code, out, err, fk };
}

describe("tybo routinen", () => {
  test("ohne Unterbefehl: dieselbe Liste wie /routinen", async () => {
    const fk = fake();
    const { code, out } = await tybo(["routinen"], fk);
    expect(code).toBe(0);
    expect(out).toEqual([formatRoutineList(await listRoutines(fk.deps))]);
    expect(out[0]).toContain("watch");
    // nur lesend
    expect(fk.events.filter(e => e.startsWith("launchctl boot") || e.startsWith("copy") || e.startsWith("plutil -replace"))).toEqual([]);
  });

  test("einbinden <label> --ja: ohne Rückfrage eingebunden", async () => {
    const { code, out, fk } = await tybo(["routinen", "einbinden", LABEL, "--ja"]);
    expect(code).toBe(0);
    expect(fk.asked).toEqual([]);
    expect(out).toContain(EINBINDEN_TEXT.done(LABEL, "einbinden"));
    expect((fk.files.get(PATH)!.ProgramArguments as string[])[2]).toBe(`${ROOT}/src/routine-run.ts`);
  });

  test("einbinden ohne --ja fragt; Eingabeende heißt nein", async () => {
    const { code, out, fk } = await tybo(["routinen", "einbinden", LABEL]);
    expect(code).toBe(1);
    expect(fk.asked).toEqual(["Einbinden? [j/N] "]);
    expect(out).toContain(EINBINDEN_TEXT.aborted);
    expect(fk.files.get(PATH)).toEqual(fk.original!);
  });

  test("ausbinden <label>: Plist ohne Wrapper bleibt unberührt", async () => {
    const { code, out } = await tybo(["routinen", "ausbinden", LABEL, "--ja"]);
    expect(code).toBe(0);
    expect(out).toEqual([WRAP_TEXT.notWrapped(LABEL)]);
  });

  test("help nennt einbinden und ausbinden", async () => {
    const { code, out } = await tybo(["routinen", "help"]);
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("routinen einbinden <Label>");
    expect(out.join("\n")).toContain("routinen ausbinden <Label>");
  });

  test("tybo help nennt tybo routinen", async () => {
    const { out } = await tybo(["help"]);
    expect(out.join("\n")).toContain("routinen");
  });

  for (const args of [["routinen", "einbinden"], ["routinen", "einbinden", "a", "b"], ["routinen", "einbinden", "--x"], ["routinen", "pausieren", LABEL]]) {
    test(`ungültig: ${args.join(" ")} → Exit 2, nichts angefasst`, async () => {
      const { code, err, fk } = await tybo(args);
      expect(code).toBe(2);
      expect(err[0]).toStartWith("Unbekannter Aufruf: tybo routinen");
      expect(fk.events).toEqual([]);
    });
  }

  test("unter Linux: Liste sagt nicht verfügbar, einbinden lehnt ab", async () => {
    const list = await tybo(["routinen"], fake({ platform: "linux" }));
    expect(list.out[0]).toContain("nicht verfügbar");
    const wrap = await tybo(["routinen", "einbinden", LABEL, "--ja"], fake({ platform: "linux" }));
    expect(wrap.code).toBe(1);
    expect(wrap.err).toEqual([EINBINDEN_TEXT.macOnly]);
    expect(wrap.fk.events).toEqual([]);
  });
});

describe("parseWrapArgs", () => {
  test("Label und --ja in beliebiger Reihenfolge", () => {
    expect(parseWrapArgs([LABEL])).toEqual({ label: LABEL, yes: false });
    expect(parseWrapArgs(["--ja", LABEL])).toEqual({ label: LABEL, yes: true });
    expect(parseWrapArgs([LABEL, "--ja"])).toEqual({ label: LABEL, yes: true });
  });

  test("kein, zwei oder Flag statt Label: null", () => {
    expect(parseWrapArgs([])).toBeNull();
    expect(parseWrapArgs(["a", "b"])).toBeNull();
    expect(parseWrapArgs(["--yes"])).toBeNull();
  });
});
