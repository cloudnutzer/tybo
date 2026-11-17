/**
 * Issue #526: Bot-Tokens nie ins Log. Reine Teile der Maskierung, alle
 * Tokens sind erfunden.
 */
import { describe, expect, test } from "bun:test";
import {
  applyMaskRanges,
  containsTelegramToken,
  formatLogArgs,
  maskDeep,
  maskRanges,
  maskTelegramTokens,
  safeErrorMessage,
  telegramTokensFromEnv,
  TOKEN_MASK,
  tokenSafeSplit,
} from "../src/lib/telegram-token-mask";

// Erfunden, nach dem Muster eines Bot-Tokens
const MAIN = "123456789:AAFakeHauptTokenNurFuerTests_abcdefgh";
const AGENT = "987654321:AAFakeAgentTokenNurFuerTests-ijklmnop";
// Erfunden, weicht vom Muster ab (zu kurz): nur als bekannter Wert erkennbar
const ODD = "42:kurzesFakeToken";

describe("maskTelegramTokens", () => {
  test("Pfad bleibt lesbar, nur das Token wird ersetzt", () => {
    expect(maskTelegramTokens(`https://api.telegram.org/bot${MAIN}/sendMessage`)).toBe(
      `https://api.telegram.org/bot${TOKEN_MASK}/sendMessage`,
    );
  });

  test("Dateipfad /file/bot… und URL-kodierter Doppelpunkt", () => {
    expect(maskTelegramTokens(`https://api.telegram.org/file/bot${MAIN}/photos/a.jpg`)).toBe(
      `https://api.telegram.org/file/bot${TOKEN_MASK}/photos/a.jpg`,
    );
    const encoded = encodeURIComponent(MAIN);
    expect(encoded).toContain("%3A");
    expect(maskTelegramTokens(`url=https%3A%2F%2Fapi.telegram.org%2Fbot${encoded}%2FgetMe`)).not.toContain("AAFakeHaupt");
    expect(maskTelegramTokens(`bot${encoded.replace("%3A", "%3a")}/x`)).toBe(`bot${TOKEN_MASK}/x`);
  });

  test("bekannte Tokens auch abseits des Musters, wörtlich und kodiert", () => {
    const tokens = [ODD];
    expect(maskTelegramTokens(`bot${ODD}/getMe`, tokens)).toBe(`bot${TOKEN_MASK}/getMe`);
    expect(maskTelegramTokens(`bot${encodeURIComponent(ODD)}/getMe`, tokens)).toBe(`bot${TOKEN_MASK}/getMe`);
    expect(maskTelegramTokens(`bot${ODD}/getMe`)).toContain(ODD);
  });

  test("harmlose Zahlen und Zeiten bleiben", () => {
    const text = "Update 123456789 um 12:34:56, Chat -100123456789, Thema 4366";
    expect(maskTelegramTokens(text)).toBe(text);
    expect(containsTelegramToken(text)).toBe(false);
    expect(containsTelegramToken(`bot${TOKEN_MASK}/sendMessage`)).toBe(false);
    expect(containsTelegramToken(`x ${AGENT} y`)).toBe(true);
  });
});

describe("telegramTokensFromEnv", () => {
  test("Haupt- und alle Agenten-Tokens, nichts anderes", () => {
    const env = {
      TELEGRAM_BOT_TOKEN: ` ${MAIN} `,
      TELEGRAM_BOT_TOKEN_RESEARCH: AGENT,
      TELEGRAM_BOT_TOKEN_GENERAL: ODD,
      TELEGRAM_BOT_TOKEN_LEER: "x",
      TELEGRAM_USER_ID: "123456",
      OTHER_TOKEN: "geheimer-anderer-wert",
    };
    expect(telegramTokensFromEnv(env).sort()).toEqual([MAIN, AGENT, ODD].sort());
  });
});

describe("formatLogArgs", () => {
  test("verschachtelter Fehler mit path, message, stack und cause", () => {
    const inner = Object.assign(new Error(`Unable to connect bot${AGENT}`), {
      code: "ConnectionRefused",
      path: `https://api.telegram.org/bot${MAIN}/sendMessage`,
    });
    (inner as Error).cause = new Error(`cause https://api.telegram.org/bot${MAIN}/getUpdates`);
    const outer = Object.assign(new Error("Network request for 'sendMessage' failed!"), { error: inner });
    outer.stack = `Error: at https://api.telegram.org/bot${AGENT}/getMe`;
    const line = formatLogArgs(["Text handler error:", outer]);
    expect(line).not.toContain("AAFake");
    expect(line).toContain(`bot${TOKEN_MASK}/sendMessage`);
    expect(line).toContain(`bot${TOKEN_MASK}/getUpdates`);
    expect(line).toContain("ConnectionRefused");
    // Original unverändert
    expect((inner as unknown as { path: string }).path).toContain(MAIN);
  });

  test("zyklische Objekte brechen nichts", () => {
    const cyc: Record<string, unknown> = { url: `bot${MAIN}/x` };
    cyc.self = cyc;
    const line = formatLogArgs([cyc]);
    expect(line).not.toContain(MAIN);
    expect(line).toContain("Circular");
  });
});

describe("maskDeep", () => {
  test("Fehler mit nicht aufzählbaren Eigenschaften und Zyklen, Original bleibt", () => {
    const err = new Error(`fail bot${MAIN}/sendMessage`);
    Object.defineProperty(err, "path", { value: `bot${AGENT}/getMe`, enumerable: false });
    const meta: Record<string, unknown> = { stack: err.stack, error: err, list: [`bot${ODD}/x`] };
    meta.loop = meta;
    const out = JSON.stringify(maskDeep(meta, [ODD]));
    expect(out).not.toContain("AAFake");
    expect(out).not.toContain(ODD);
    expect(out).toContain(`bot${TOKEN_MASK}/getMe`);
    expect(out).toContain("[Zyklus]");
    expect(err.message).toContain(MAIN);
  });

  test("Zahlen, null und Datumswerte bleiben", () => {
    const date = new Date(0);
    expect(maskDeep({ n: 1, b: true, x: null, d: date })).toEqual({ n: 1, b: true, x: null, d: date });
  });
});

test("safeErrorMessage nimmt nur die Meldung, maskiert", () => {
  expect(safeErrorMessage(new Error(`kaputt bot${MAIN}/x`), [])).toBe(`kaputt bot${TOKEN_MASK}/x`);
  expect(safeErrorMessage(`roh ${ODD}`, [ODD])).toBe(`roh ${TOKEN_MASK}`);
});

describe("tokenSafeSplit", () => {
  const MAX_TAIL = 16 * 1024;

  test("Fundstellen wie maskTelegramTokens, ohne Überlappung", () => {
    const samples = [
      `bot${MAIN}/sendMessage und bot${encodeURIComponent(AGENT)}/getMe`,
      MAIN + "x".repeat(200) + AGENT + "y".repeat(10),
      `${MAIN}${AGENT}${ODD}`,
      `alt 555555555:${"q".repeat(40)} und ${ODD}`,
    ];
    for (const text of samples) {
      for (const tokens of [[], [MAIN, AGENT, ODD]]) {
        const ranges = maskRanges(text, tokens);
        expect(applyMaskRanges(text, ranges)).toBe(maskTelegramTokens(text, tokens));
        for (let i = 1; i < ranges.length; i++) expect(ranges[i]![0]).toBeGreaterThanOrEqual(ranges[i - 1]![1]);
      }
    }
  });

  test("überlappende Treffer im langen Lauf: das zweite Token kommt ganz nach hinten", () => {
    // Das Muster reicht vom ersten Token über die x bis in die Kennung des
    // zweiten; früher schob das die Grenze an den Anfang, und der Rückfall
    // teilte das zweite Token
    for (const [first, second] of [
      [MAIN, AGENT],
      [AGENT, MAIN],
    ]) {
      const text = first + "x".repeat(20_000) + second + "y".repeat(1000);
      const { cut, ranges } = tokenSafeSplit(text, [MAIN, AGENT], MAX_TAIL);
      expect(cut).toBe(first.length + 20_000);
      expect(applyMaskRanges(text, ranges, cut)).toBe(TOKEN_MASK + "x".repeat(20_000));
      expect(text.slice(cut)).toStartWith(second);
    }
  });

  test("Fundstelle am Anfang des Laufs, die vor dem Ende aufhört, kommt ganz nach vorne", () => {
    // Ein ungewöhnlich langer bekannter Wert: die Grenze fiele in ihn, er
    // beginnt am Anfang des Laufs und endet vor dem Ende des Textes
    const known = "123456789:" + "z".repeat(MAX_TAIL);
    const long = known + "%" + "y".repeat(1500);
    const { cut, ranges } = tokenSafeSplit(long, [known], 100);
    expect(cut).toBe(known.length);
    expect(applyMaskRanges(long, ranges, cut)).toBe(TOKEN_MASK);
  });

  test("Muster über den ganzen Lauf bis ans Ende: geteilt, vorne maskiert, der Rest bleibt begrenzt", () => {
    const text = "12345:" + "a".repeat(50_000);
    const { cut, ranges } = tokenSafeSplit(text, [], MAX_TAIL);
    expect(cut).toBe(text.length - 1024);
    expect(applyMaskRanges(text, ranges, cut)).toBe(TOKEN_MASK);
    expect(containsTelegramToken(text.slice(cut))).toBe(false);
  });
});
