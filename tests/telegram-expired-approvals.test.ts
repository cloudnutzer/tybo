/**
 * Issue #352: Knöpfe "toolapproval:" stammen aus der Zeit vor dem
 * Rückfragen-Register (Issue #116) und zuletzt vom früheren Gateway. Nach dem
 * Entfernen des Gateways gibt es keine Freigabe mehr dahinter. Ein Klick des
 * Besitzers bekommt „Freigabe abgelaufen“ und verliert die Knöpfe; fremde
 * Klicks enden still; alle anderen Knöpfe gehen unverändert an die nächste
 * Stufe der Kette.
 */
import { describe, expect, test } from "bun:test";
import type { Context } from "grammy";
import { EXPIRED_APPROVAL_TEXT, expiredApprovalButtons } from "../src/channels/telegram/expired-approvals";

const OWNER = "4711";
const BUTTON = "toolapproval:y:0f0e0d0c-0b0a-0908-0706-050403020100";

interface Click {
  answers: unknown[];
  markupEdits: unknown[];
  passedOn: boolean;
}

async function click(data: string | undefined, from = OWNER, failing = false): Promise<Click> {
  const result: Click = { answers: [], markupEdits: [], passedOn: false };
  const ctx = {
    from: { id: Number(from) },
    callbackQuery: data === undefined ? undefined : { data },
    answerCallbackQuery: async (options: unknown) => {
      result.answers.push(options);
      if (failing) throw new Error("query is too old");
    },
    editMessageReplyMarkup: async (options: unknown) => {
      result.markupEdits.push(options);
      if (failing) throw new Error("message is not modified");
    },
  } as unknown as Context;
  await expiredApprovalButtons(OWNER)(ctx, async () => {
    result.passedOn = true;
  });
  return result;
}

describe("alte Freigabe-Knöpfe", () => {
  test("Klick des Besitzers: „Freigabe abgelaufen“, Knöpfe weg, nichts weitergereicht", async () => {
    for (const data of [BUTTON, "toolapproval:n:0f0e0d0c-0b0a-0908-0706-050403020100", "toolapproval:y:abc123"]) {
      const result = await click(data);
      expect(result.answers).toEqual([{ text: EXPIRED_APPROVAL_TEXT }]);
      expect(result.markupEdits).toEqual([{ reply_markup: undefined }]);
      expect(result.passedOn).toBe(false);
    }
    expect(EXPIRED_APPROVAL_TEXT).toBe("Freigabe abgelaufen");
  });

  test("fremder Absender: keine Antwort, keine Änderung, nicht weitergereicht", async () => {
    const result = await click(BUTTON, "999");
    expect(result).toEqual({ answers: [], markupEdits: [], passedOn: false });
  });

  test("Fehler beim Antworten oder Entfernen der Knöpfe brechen nichts ab", async () => {
    const result = await click(BUTTON, OWNER, true);
    expect(result.answers).toHaveLength(1);
    expect(result.markupEdits).toHaveLength(1);
    expect(result.passedOn).toBe(false);
  });

  test("andere Knöpfe gehen an die nächste Stufe, ohne Antwort", async () => {
    const others = [
      "ch|abc|y",
      "atask:t-1:Ja",
      "topicmap:5:research",
      "toolapproval:x:abc",
      "toolapproval:y:",
      "toolapproval:y:XYZ",
      "Toolapproval:y:abc",
      "toolapproval:y:abc:mehr",
      "",
      undefined,
    ];
    for (const data of others) {
      const result = await click(data);
      expect(result).toEqual({ answers: [], markupEdits: [], passedOn: true });
    }
  });
});
