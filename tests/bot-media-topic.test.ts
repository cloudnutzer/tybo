// Issue #20: Die vier Medien-Handler in src/bot.ts speichern Nutzernachricht
// und Antwort mit metadata.topicId wie handleTextMessage. Statische Prüfung
// des Quelltexts: src/bot.ts wird nur als Text gelesen, nie importiert.
import { expect, test } from "bun:test";
import { join } from "node:path";

const bot = await Bun.file(join(import.meta.dir, "..", "src", "bot.ts")).text();

/** Quelltext einer Funktion bis zur nächsten Funktion auf oberster Ebene */
function body(name: string): string {
  const start = bot.indexOf(`async function ${name}(`);
  expect(start).toBeGreaterThan(0);
  const next = bot.indexOf("\nasync function ", start + 10);
  return bot.slice(start, next < 0 ? undefined : next);
}

// Vorher stand hier dieselbe Liste ohne "topicId, ": nur dieses Feld kommt dazu.
// Issue #22: Antworten tragen zusätzlich Agent, Modell und Dauer des Turns.
// Issue #71: Foto, Dokument und Sprache bauen ihre Metadaten im Medien-Kern
// (src/lib/media-turn.ts, Verhalten in tests/media-turn.test.ts); die Handler
// speichern prepared.userMetadata und ergänzen die Antwort um Agent und Turn.
const MEDIA_CORE = [
  `prepared.userMetadata`,
  `{ ...prepared.replyMetadata, agent: agentName, ...turn.metadata() }`,
];
const EXPECTED: Record<string, string[]> = {
  handleVoiceMessage: MEDIA_CORE,
  handlePhotoMessage: MEDIA_CORE,
  handleDocumentMessage: MEDIA_CORE,
  handleVideoMessage: [
    `{ topicId, type: "video", filePath: localPath, fileName }`,
    `{ topicId, type: "video_reply", agent: agentName, ...turn.metadata() }`,
  ],
};

const MEDIA_KIND: Record<string, string> = {
  handleVoiceMessage: "audio",
  handlePhotoMessage: "image",
  handleDocumentMessage: "document",
};

for (const [name, metadata] of Object.entries(EXPECTED)) {
  test(`${name}: beide saveMessage-Aufrufe mit topicId, sonst unverändert`, () => {
    const src = body(name);
    const saves = [...src.matchAll(/await saveMessage\(\{[\s\S]*?metadata: ([^\n]*),\n\s*\}\);/g)].map(m => m[1]);
    expect(saves).toEqual(metadata);
  });

  test(`${name}: topicId steht vor dem ersten saveMessage, genau einmal ermittelt`, () => {
    const src = body(name);
    const decl = "const topicId = (ctx.message as any)?.message_thread_id as number | undefined;";
    expect(src.split(decl)).toHaveLength(2);
    expect(src.indexOf(decl)).toBeLessThan(src.indexOf("await saveMessage("));
  });
}

for (const [name, kind] of Object.entries(MEDIA_KIND)) {
  test(`${name}: Medien-Kern mit topicId, Telegram-Herkunft und foreignInput aus prepared`, () => {
    const src = body(name);
    const prepare = src.indexOf("const prepared = await prepareMedia(");
    expect(prepare).toBeGreaterThan(0);
    expect(prepare).toBeLessThan(src.indexOf("await saveMessage("));
    const call = src.slice(prepare, src.indexOf("});", prepare) + 3);
    expect(call).toContain(`kind: "${kind}"`);
    expect(call).toContain("topicId");
    expect(call).toContain('channel: "telegram"');
    expect(src).toContain("content: prepared.userContent,");
    expect(src).toContain("classifyComplexity(prepared.classifyText)");
    expect(src).toContain('{ chatId, topicId, origin: "Telegram", foreignInput: prepared.foreignInput }');
    // Nachverarbeitung nach dem Turn, Aufräumen erst nach dem Senden (nicht im Fehlerfall)
    expect(src).toContain("finishMedia(prepared, claudeResponse)");
    const send = src.lastIndexOf("await sendResponse(");
    const cleanup = src.indexOf("await cleanupMedia(prepared);");
    expect(cleanup).toBeGreaterThan(send);
    expect(src.indexOf("} catch (error) {")).toBeGreaterThan(cleanup);
    // Keine eigene Ablage mehr im Handler
    expect(src).not.toContain("writeFile(");
    expect(src).not.toContain("unlink(");
  });
}
