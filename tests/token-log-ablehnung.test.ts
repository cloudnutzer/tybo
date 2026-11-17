/**
 * Issue #526: unbehandelte Promise-Ablehnungen ohne Token. Bun gibt sie
 * nativ aus, an console und stdout/stderr.write vorbei; ohne eigene
 * Behandlung stand dort das volle Haupt- und Agenten-Token. Geprüft wird die
 * tatsächliche Ausgabe eines eigenen Bun-Prozesses (Fixture
 * token-log-ablehnung.ts): einmal mit Maskierung und Signal-Handlern wie im
 * Bot, einmal nur mit der Maskierung. bot.ts wird nie importiert.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { TOKEN_MASK } from "../src/lib/telegram-token-mask";

// Erfunden. Das Agenten-Token weicht vom Muster ab und ist nur über die Umgebung erkennbar
const MAIN = "123456789:AAFakeHauptTokenNurFuerTests_abcdefgh";
const AGENT = "777:FakeAgentTokenNurTest-ijkl";

async function run(mode: "lebenszyklus" | "nur-maske", variant: "void" | "throw" | "await" = "void") {
  const proc = Bun.spawn(["bun", join(import.meta.dir, "fixtures", "token-log-ablehnung.ts"), mode, variant], {
    cwd: join(import.meta.dir, ".."),
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", TELEGRAM_BOT_TOKEN: MAIN, TELEGRAM_BOT_TOKEN_RESEARCH: AGENT },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { out, err, code };
}

function expectClean(text: string) {
  // auch Bruchstücke: ein geteiltes Token darf in keinem Teil durchrutschen
  for (const piece of [MAIN, AGENT, "AAFake", "HauptToken", "NurFuerTests", "FakeAgent", "AgentToken", "NurTest", encodeURIComponent(MAIN)]) {
    expect(text).not.toContain(piece);
  }
}

function expectReadable(err: string, label = "Unhandled rejection:") {
  expect(err).toContain(`${label} HttpError: Network request for 'sendMessage' failed!`);
  expect(err).toContain(`bot${TOKEN_MASK}/sendMessage`);
  // verschachtelt: path und request im inneren Fehler, cause samt eigener Adresse
  expect(err).toContain(`https://api.telegram.org/bot${TOKEN_MASK}/sendMessage`);
  expect(err).toContain(`https://api.telegram.org/file/bot${TOKEN_MASK}/photos/a.jpg`);
  expect(err).toContain(`fetch failed bot${TOKEN_MASK}/getMe`);
  expect(err).toContain(`https://api.telegram.org/bot${TOKEN_MASK}/getUpdates`);
  expect(err).toContain("ConnectionRefused");
}

describe("unbehandelte Promise-Ablehnung in einem eigenen Bun-Prozess", () => {
  test("mit Signal-Handlern wie im Bot: maskiert, gemeldet, geordnet beendet mit Code 1", async () => {
    const { out, err, code } = await run("lebenszyklus");
    expectClean(out + err);
    expectReadable(err);
    expect(out).toContain("gemeldet: Network request for 'sendMessage' failed!");
    expect(out).toContain("Received unhandledRejection. Shutting down gracefully...");
    expect(out).toContain("closer gelaufen");
    expect(out).toContain("Sperre frei");
    expect(out).toContain("Shutdown complete.");
    expect(out).not.toContain("nicht abgebrochen");
    expect(code).toBe(1);
  });

  test("nur mit der Maskierung: maskiert auf stderr, Abbruch mit Code 1 wie bei Bun", async () => {
    const { out, err, code } = await run("nur-maske");
    expectClean(out + err);
    expectReadable(err);
    expect(out).not.toContain("nicht abgebrochen");
    expect(code).toBe(1);
  });
});

// Startfehler vor installSignalHandlers (im Bot zwischen installLogMask und
// den Signal-Handlern): Bun meldet throw und await auf oberster Ebene als
// uncaughtException und gäbe sie sonst nativ mit vollem Token aus
describe("unbehandelter Fehler vor den Signal-Handlern in einem eigenen Bun-Prozess", () => {
  for (const variant of ["throw", "await"] as const) {
    test(`${variant} auf oberster Ebene, nur mit der Maskierung: maskiert auf stderr, Abbruch mit Code 1`, async () => {
      const { out, err, code } = await run("nur-maske", variant);
      expectClean(out + err);
      expectReadable(err, "Uncaught exception:");
      expect(out).not.toContain("nicht abgebrochen");
      expect(code).toBe(1);
    });
  }
});
