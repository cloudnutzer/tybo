// Issue #334: Telegram-Medien-Eingang (src/channels/telegram/media-inbox.ts).
// Früher prüfte diese Datei den Quelltext der vier Handler in src/bot.ts
// (Issue #20: topicId in beiden gespeicherten Nachrichten). Jetzt Verhalten:
// ein Ablauf für Sprache, Foto, Dokument, Video und Rundvideo mit dem echten
// Medien-Kern, Attrappen nur für Turn, Speicher und Telegram.
// src/bot.ts wird nie importiert.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MEDIA_INBOX_TEXT,
  TELEGRAM_FILE_LIMIT,
  TelegramDownloadError,
  downloadTelegramFile,
  handleTelegramMedia,
  incomingMedia,
  type MediaInboxDeps,
  type TelegramDownload,
} from "../src/channels/telegram/media-inbox";
import type { AskOfferOutcome } from "../src/lib/ask-choices";
import { ABORT_REPLY, SHUTDOWN_ABORT_REPLY, type TurnQuestion } from "../src/lib/chat-turn";
import { cleanupMedia, finishMedia, prepareMedia, type MediaDeps } from "../src/lib/media-turn";
import { createTurnFinish } from "../src/lib/turn-finish";

const TOKEN = "123456:SECRET-test-token";
const NOW = 1_700_000_000_000;

// ---------------------------------------------------------------------------
// downloadTelegramFile
// ---------------------------------------------------------------------------

function api(info: { file_path?: string; file_size?: number }) {
  const calls: string[] = [];
  return {
    calls,
    getFile: async (id: string) => {
      calls.push(id);
      return info;
    },
  };
}

/** Antwort, die beliebig viele Stücke liefert und mitzählt, wie viele gelesen wurden */
function streamingResponse(chunk: number, count: number, headers: Record<string, string> = {}) {
  const state = { pulled: 0, cancelled: false };
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (state.pulled >= count) return controller.close();
      state.pulled++;
      controller.enqueue(new Uint8Array(chunk).fill(7));
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { state, response: new Response(body, { headers }) };
}

describe("downloadTelegramFile", () => {
  test("Standardgrenze sind 20 MB", () => {
    expect(TELEGRAM_FILE_LIMIT).toBe(20 * 1024 * 1024);
  });

  test("lädt über die Datei-URL mit Token und liefert die Bytes", async () => {
    const a = api({ file_path: "voice/file_1.oga", file_size: 3 });
    const urls: string[] = [];
    const result = await downloadTelegramFile(a, "F1", {
      token: TOKEN,
      fetch: async url => {
        urls.push(url);
        return new Response(new Uint8Array([1, 2, 3]));
      },
    });
    expect(a.calls).toEqual(["F1"]);
    expect(urls).toEqual([`https://api.telegram.org/file/bot${TOKEN}/voice/file_1.oga`]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect([...result.bytes]).toEqual([1, 2, 3]);
      expect(result.filePath).toBe("voice/file_1.oga");
    }
  });

  test("genau an der Grenze geht, ein Byte mehr nicht", async () => {
    const at = await downloadTelegramFile(api({ file_path: "a" }), "F", {
      token: TOKEN,
      limit: 10,
      fetch: async () => new Response(new Uint8Array(10)),
    });
    expect(at.ok).toBe(true);
    const over = await downloadTelegramFile(api({ file_path: "a" }), "F", {
      token: TOKEN,
      limit: 10,
      fetch: async () => new Response(new Uint8Array(11)),
    });
    expect(over).toEqual({ ok: false, reason: "too_large" });
  });

  test("gemeldete Größe aus der Nachricht über der Grenze: kein getFile, kein Download", async () => {
    const a = api({ file_path: "a" });
    let fetched = false;
    const result = await downloadTelegramFile(a, "F", {
      token: TOKEN,
      declaredSize: TELEGRAM_FILE_LIMIT + 1,
      fetch: async () => {
        fetched = true;
        return new Response("x");
      },
    });
    expect(result).toEqual({ ok: false, reason: "too_large", size: TELEGRAM_FILE_LIMIT + 1 });
    expect(a.calls).toEqual([]);
    expect(fetched).toBe(false);
  });

  test("Größe aus getFile über der Grenze: kein Download", async () => {
    let fetched = false;
    const result = await downloadTelegramFile(api({ file_path: "a", file_size: 50 }), "F", {
      token: TOKEN,
      limit: 10,
      fetch: async () => {
        fetched = true;
        return new Response("x");
      },
    });
    expect(result).toEqual({ ok: false, reason: "too_large", size: 50 });
    expect(fetched).toBe(false);
  });

  test("Content-Length über der Grenze: nichts wird gelesen", async () => {
    const s = streamingResponse(4, 100, { "content-length": "400" });
    const result = await downloadTelegramFile(api({ file_path: "a" }), "F", {
      token: TOKEN,
      limit: 10,
      fetch: async () => s.response,
    });
    expect(result).toEqual({ ok: false, reason: "too_large", size: 400 });
    expect(s.state.pulled).toBeLessThanOrEqual(1);
  });

  for (const declared of [undefined, "5", Number.NaN, -1, 3]) {
    test(`fehlende oder falsche Größenangabe (${String(declared)}): die geladenen Bytes zählen, Abbruch an der Grenze`, async () => {
      const s = streamingResponse(4, 1000);
      const result = await downloadTelegramFile(api({ file_path: "a", file_size: 3 }), "F", {
        token: TOKEN,
        limit: 10,
        declaredSize: declared,
        fetch: async () => s.response,
      });
      expect(result).toEqual({ ok: false, reason: "too_large" });
      // 3 Stücke à 4 Bytes überschreiten 10; danach wird nicht weitergelesen
      expect(s.state.pulled).toBeLessThanOrEqual(4);
      expect(s.state.cancelled).toBe(true);
    });
  }

  test("ohne file_path: no_path, kein Download", async () => {
    let fetched = false;
    const result = await downloadTelegramFile(api({}), "F", {
      token: TOKEN,
      fetch: async () => {
        fetched = true;
        return new Response("x");
      },
    });
    expect(result).toEqual({ ok: false, reason: "no_path" });
    expect(fetched).toBe(false);
  });

  test("HTTP-Fehler wirft, ohne URL und Token in der Meldung", async () => {
    const err = await downloadTelegramFile(api({ file_path: "a" }), "F", {
      token: TOKEN,
      fetch: async () => new Response("nope", { status: 404 }),
    }).catch(e => e);
    expect(err).toBeInstanceOf(TelegramDownloadError);
    expect(err.message).toContain("HTTP 404");
    expect(err.message).not.toContain(TOKEN);
    expect(err.message).not.toContain("api.telegram.org");
  });

  test("Netzfehler mit URL in der Meldung: Token wird entfernt", async () => {
    const err = await downloadTelegramFile(api({ file_path: "a" }), "F", {
      token: TOKEN,
      fetch: async url => {
        throw new Error(`connect failed for ${url}`);
      },
    }).catch(e => e);
    expect(err).toBeInstanceOf(TelegramDownloadError);
    expect(err.message).not.toContain(TOKEN);
    expect(String(err.stack)).not.toContain(TOKEN);
  });
});

// ---------------------------------------------------------------------------
// incomingMedia
// ---------------------------------------------------------------------------

describe("incomingMedia", () => {
  test("Sprache", () => {
    expect(incomingMedia({ voice: { file_id: "V", file_size: 9, duration: 2 } })).toEqual({ kind: "audio", fileId: "V", size: 9 });
  });

  test("Foto: die größte Auflösung", () => {
    const item = incomingMedia({
      caption: "schau",
      photo: [
        { file_id: "small", file_size: 1 },
        { file_id: "mid", file_size: 2 },
        { file_id: "big", file_size: 3 },
      ],
    });
    expect(item).toEqual({ kind: "image", fileId: "big", size: 3, caption: "schau" });
  });

  test("als Dokument geschicktes Bild bleibt Dokument", () => {
    const item = incomingMedia({ document: { file_id: "D", file_name: "bild.png", mime_type: "image/png", file_size: 4 } });
    expect(item?.kind).toBe("document");
    expect(item?.fileName).toBe("bild.png");
  });

  test("Video mit Name und Dauer", () => {
    const item = incomingMedia({ caption: "c", video: { file_id: "X", file_name: "clip.mov", duration: 12, file_size: 5 } });
    expect(item).toEqual({ kind: "video", fileId: "X", size: 5, caption: "c", fileName: "clip.mov", durationSec: 12 });
  });

  test("Rundvideo (video_note) ist ein Video ohne Namen", () => {
    const item = incomingMedia({ video_note: { file_id: "N", duration: 7, length: 240 } });
    expect(item).toEqual({ kind: "video", fileId: "N", size: undefined, caption: undefined, fileName: undefined, durationSec: 7 });
  });

  test("Nachricht ohne Medien", () => {
    expect(incomingMedia({ text: "hallo" })).toBeNull();
    expect(incomingMedia(undefined)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// handleTelegramMedia
// ---------------------------------------------------------------------------

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "media-inbox-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

type Harness = {
  deps: MediaInboxDeps;
  log: string[];
  saved: { role: string; content: string; metadata: Record<string, unknown> }[];
  prompts: string[];
  intents: { response: string; target: Record<string, unknown> }[];
  sent: string[];
  threads: unknown[][];
  replies: string[];
  assetUploads: { path: string; options: Record<string, unknown> }[];
  assetDescs: unknown[][];
  downloads: string[];
  goals: string[];
  invoked: string[];
  offers: string[];
  ctx: any;
};

function harness(
  message: Record<string, unknown>,
  opts: {
    reply?: string;
    download?: TelegramDownload;
    turnFails?: boolean;
    chatId?: number;
    /** Der Chat-Kern meldet eine Rückfrage (onQuestion); offer() hält Gespräch fest */
    question?: boolean;
    /** Abbruch wie callClaudeWithProgress: ABORT_REPLY, oder als Ausnahme */
    abort?: "reply" | "error";
    shuttingDown?: boolean;
  } = {},
): Harness {
  const h: Harness = {
    log: [],
    saved: [],
    prompts: [],
    intents: [],
    sent: [],
    threads: [],
    replies: [],
    assetUploads: [],
    assetDescs: [],
    downloads: [],
    goals: [],
    invoked: [],
    offers: [],
    ctx: undefined,
    deps: undefined as never,
  };
  h.ctx = {
    chat: { id: opts.chatId ?? -100123 },
    message,
    reply: async (text: string) => {
      h.replies.push(text);
    },
  };
  const mediaDeps: Partial<MediaDeps> = {
    uploadsDir: dir,
    now: () => NOW,
    uuid: () => "uuid-1",
    transcribeAudio: async () => "hallo aus der Sprachnachricht",
    uploadAssetQuick: async (path, options) => {
      h.assetUploads.push({ path, options: options as Record<string, unknown> });
      return { id: "asset-9" } as never;
    },
    updateAssetDescription: async (...args) => {
      h.assetDescs.push(args);
    },
  };
  h.deps = {
    download: async item => {
      h.downloads.push(item.fileId);
      return opts.download ?? { ok: true, bytes: new Uint8Array([1, 2, 3, 4]), filePath: "files/file_7.mp4" };
    },
    prepare: input => prepareMedia(input, mediaDeps),
    finish: (prepared, response) => finishMedia(prepared, response, mediaDeps),
    cleanup: async prepared => {
      h.log.push("cleanup");
      await cleanupMedia(prepared, mediaDeps);
    },
    saveMessage: async m => {
      h.log.push(`save:${m.role}`);
      h.saved.push(m);
    },
    agentFor: (_chat, topic) => (topic === 42 ? "research" : "general"),
    turnHint: async () => "faden-hinweis",
    runTurn: async (_ctx, prompt, chat, _agent, topic, turn, hint, onQuestion) => {
      h.log.push("turn");
      h.prompts.push(prompt);
      expect(hint).toBe("faden-hinweis");
      if (opts.turnFails) throw new Error("Turn kaputt");
      if (opts.abort === "error") throw Object.assign(new Error("abgebrochen"), { name: "AbortError" });
      if (opts.abort === "reply") return ABORT_REPLY;
      turn.onInfo({ model: "m-1", engine: "claude", durationMs: 5 } as never);
      turn.onTools({ names: ["Read"] } as never);
      if (opts.question) {
        onQuestion({
          question: "Soll ich?",
          options: ["Ja", "Nein"],
          offer: async () => {
            h.log.push("offer");
            h.offers.push(`${chat}:${topic ?? "-"}`);
            return { status: "offered" } as unknown as AskOfferOutcome;
          },
        } as unknown as TurnQuestion);
      }
      return opts.reply ?? "Antwort";
    },
    newTurn: () => {
      let info: Record<string, unknown> = {};
      let tools: unknown;
      return {
        onInfo: (i: any) => {
          info = { model: i.model, durationMs: i.durationMs };
        },
        onTools: (t: any) => {
          tools = t;
        },
        tools: () => tools as never,
        metadata: () => info,
      };
    },
    // Der echte gemeinsame Abschluss (Issue #339), Attrappen für Speicher, Tor, Goal und Konsultation
    finishTurn: createTurnFinish({
      saveMessage: async m => {
        h.log.push(`save:${m.role}`);
        h.saved.push(m as never);
      },
      processIntents: async (response, _tools, target) => {
        h.log.push("intents");
        h.intents.push({ response, target: target as unknown as Record<string, unknown> });
      },
      onGoalTurn: (key, agent) => {
        h.log.push("goal");
        h.goals.push(`${key}:${agent}`);
      },
      invoke: async (from, invocation, chatId, topicId, delivered) => {
        h.log.push(`invoke:${invocation.targetAgent}`);
        h.invoked.push(`${from}->${invocation.targetAgent}@${chatId}:${topicId ?? "-"}`);
        await delivered(invocation.targetAgent, `Antwort von ${invocation.targetAgent}`);
      },
      invokeBudget: 2,
      noteThreads: (...args) => {
        h.log.push("threads");
        h.threads.push(args);
      },
      logError: () => {},
    }),
    send: async (_ctx, response) => {
      h.log.push("send");
      h.sent.push(response);
    },
    isShuttingDown: () => opts.shuttingDown ?? false,
    typing: () => ({
      start: () => h.log.push("typing:start"),
      stop: () => h.log.push("typing:stop"),
    }),
    now: () => NOW,
    logError: () => {},
  };
  return h;
}

const FULL_ORDER = ["typing:start", "save:user", "turn", "save:assistant", "intents", "goal", "send", "threads", "cleanup", "typing:stop"];

describe("handleTelegramMedia: je Art wie die bisherigen Handler", () => {
  test("Sprache im Topic: Transkript im Prompt, Metadaten mit topicId, Datei nach dem Senden gelöscht", async () => {
    const h = harness({ message_thread_id: 42, voice: { file_id: "V", file_size: 4 } });
    await handleTelegramMedia(h.ctx, h.deps);

    expect(h.log).toEqual(FULL_ORDER);
    const localPath = join(dir, `voice_${NOW}_uuid-1.ogg`);
    expect(h.saved[0]).toEqual({
      chat_id: "-100123",
      role: "user",
      content: "[Voice message] hallo aus der Sprachnachricht",
      metadata: { topicId: 42, type: "voice", originalFile: localPath },
    } as never);
    expect(h.prompts).toEqual(["[Voice message transcription]: hallo aus der Sprachnachricht"]);
    expect(h.saved[1]).toEqual({
      chat_id: "-100123",
      role: "assistant",
      content: "Antwort",
      metadata: { topicId: 42, type: "voice_reply", agent: "research", model: "m-1", durationMs: 5 },
    } as never);
    expect(h.intents[0].target).toEqual({ chatId: "-100123", topicId: 42, origin: "Telegram", foreignInput: undefined });
    expect(h.sent).toEqual(["Antwort"]);
    expect(h.threads[0]).toEqual(["-100123", 42, "[Voice message transcription]: hallo aus der Sprachnachricht", "Antwort", NOW]);
    expect(existsSync(localPath)).toBe(false);
  });

  test("Foto: größte Auflösung, Asset mit Telegram-ID, Beschreibung nachgetragen, Tag vor dem Senden entfernt", async () => {
    const h = harness(
      {
        message_thread_id: 42,
        caption: "Was ist das?",
        photo: [
          { file_id: "small", file_size: 1 },
          { file_id: "big", file_size: 4 },
        ],
      },
      {
        reply: "Ein Hund. [ASSET_DESC: Ein brauner Hund | hund, tier]",
        download: { ok: true, bytes: new Uint8Array([9]), filePath: "photos/file_3.jpg" },
      },
    );
    await handleTelegramMedia(h.ctx, h.deps);

    expect(h.downloads).toEqual(["big"]);
    const localPath = join(dir, `photo_${NOW}_uuid-1.jpg`);
    expect(await readFile(localPath)).toEqual(Buffer.from([9]));
    expect(h.assetUploads[0].options).toMatchObject({ channel: "telegram", telegramFileId: "big", userCaption: "Was ist das?" });
    expect(h.saved[0]).toMatchObject({
      content: "[Photo] Was ist das?",
      metadata: { topicId: 42, type: "photo", filePath: localPath, assetId: "asset-9" },
    });
    expect(h.prompts[0]).toBe(`[Image attached: ${localPath}]\n(asset: asset-9)\n\nUser says: Was ist das?`);
    expect(h.saved[1].content).toBe("Ein Hund.");
    expect(h.saved[1].metadata).toEqual({ topicId: 42, type: "photo_reply", assetId: "asset-9", agent: "research", model: "m-1", durationMs: 5 });
    expect(h.sent).toEqual(["Ein Hund."]);
    expect(h.assetDescs[0][0]).toBe("asset-9");
    expect(h.intents[0].target.foreignInput).toBe("Foto");
    expect(h.log).toEqual(FULL_ORDER);
    // Bilder bleiben liegen
    expect(existsSync(localPath)).toBe(true);
  });

  test("Dokument: Endung aus dem Dateinamen, Name im Verlauf, fremder Inhalt gemeldet", async () => {
    const h = harness({ caption: "Bitte zusammenfassen", document: { file_id: "D", file_name: "Vertrag.PDF", file_size: 4 } });
    await handleTelegramMedia(h.ctx, h.deps);

    const localPath = join(dir, "uuid-1.PDF");
    expect(h.saved[0]).toMatchObject({
      content: "[Document: Vertrag.PDF] Bitte zusammenfassen",
      metadata: { topicId: undefined, type: "document", filePath: localPath, fileName: "Vertrag.PDF" },
    });
    expect(h.prompts[0]).toBe(`[User sent a document saved at: ${localPath}, filename: Vertrag.PDF]\n\nBitte zusammenfassen`);
    expect(h.saved[1].metadata).toEqual({ topicId: undefined, type: "document_reply", agent: "general", model: "m-1", durationMs: 5 });
    expect(h.intents[0].target).toMatchObject({ topicId: undefined, foreignInput: "hochgeladene Datei" });
    expect(h.assetUploads).toEqual([]);
    expect(h.log).toEqual(FULL_ORDER);
  });

  test("Video über den Medien-Kern: Dauer im Prompt, Name aus Telegram, Endung aus dem Pfad", async () => {
    const h = harness(
      { message_thread_id: 42, caption: "Was passiert hier?", video: { file_id: "X", file_name: "clip.mov", duration: 12, file_size: 4 } },
      { download: { ok: true, bytes: new Uint8Array([5]), filePath: "videos/file_8.MOV" } },
    );
    await handleTelegramMedia(h.ctx, h.deps);

    const localPath = join(dir, `video_${NOW}_uuid-1.MOV`);
    expect(await readFile(localPath)).toEqual(Buffer.from([5]));
    expect(h.saved[0]).toEqual({
      chat_id: "-100123",
      role: "user",
      content: "[Video: clip.mov] Was passiert hier?",
      metadata: { topicId: 42, type: "video", filePath: localPath, fileName: "clip.mov" },
    } as never);
    expect(h.prompts[0]).toBe(
      `[User sent a video saved at: ${localPath}, duration: 12s. Use the watch skill (local path) or ffmpeg frame extraction to analyze it.]\n\nWas passiert hier?`,
    );
    expect(h.saved[1].metadata).toEqual({ topicId: 42, type: "video_reply", agent: "research", model: "m-1", durationMs: 5 });
    expect(h.intents[0].target.foreignInput).toBe("Video");
    expect(h.threads[0][2]).toBe("Was passiert hier?");
    expect(h.log).toEqual(FULL_ORDER);
    expect(existsSync(localPath)).toBe(true);
  });

  test("Rundvideo: Name video_<Zeit>.mp4 wie bisher, Standardtext, Dauer", async () => {
    const h = harness(
      { video_note: { file_id: "N", duration: 7, length: 240 } },
      { download: { ok: true, bytes: new Uint8Array([5]), filePath: "video_notes/file_2.mp4" } },
    );
    await handleTelegramMedia(h.ctx, h.deps);

    const localPath = join(dir, `video_${NOW}_uuid-1.mp4`);
    expect(h.saved[0].content).toBe(`[Video: video_${NOW}.mp4] User sent a video. Analyze it and respond.`);
    expect(h.saved[0].metadata).toEqual({ topicId: undefined, type: "video", filePath: localPath, fileName: `video_${NOW}.mp4` });
    expect(h.prompts[0]).toContain(", duration: 7s.");
  });

  test("Video ohne Dauer: keine Dauer im Prompt", async () => {
    const h = harness({ video: { file_id: "X", file_name: "a.mp4" } });
    await handleTelegramMedia(h.ctx, h.deps);
    expect(h.prompts[0]).not.toContain("duration");
  });
});

describe("handleTelegramMedia: Grenzen und Fehler", () => {
  for (const [label, message, kind] of [
    ["Foto", { photo: [{ file_id: "P" }] }, "image"],
    ["Sprache", { voice: { file_id: "V" } }, "audio"],
    ["Dokument", { document: { file_id: "D", file_name: "a.pdf" } }, "document"],
    ["Video", { video: { file_id: "X" } }, "video"],
  ] as const) {
    test(`${label} über 20 MB: Hinweis, nichts gespeichert, Tippanzeige endet`, async () => {
      const h = harness(message, { download: { ok: false, reason: "too_large", size: 25 * 1024 * 1024 } });
      await handleTelegramMedia(h.ctx, h.deps);
      expect(h.replies).toEqual([MEDIA_INBOX_TEXT.tooLarge(kind, 25 * 1024 * 1024)]);
      expect(h.replies[0]).toContain("25.0 MB");
      expect(h.replies[0]).toContain("20 MB");
      expect(h.replies[0]).not.toContain("—");
      expect(h.log).toEqual(["typing:start", "typing:stop"]);
    });
  }

  test("Größe unbekannt, beim Laden zu groß: Hinweis ohne Zahl", async () => {
    const h = harness({ document: { file_id: "D" } }, { download: { ok: false, reason: "too_large" } });
    await handleTelegramMedia(h.ctx, h.deps);
    expect(h.replies[0]).toContain("größer als 20 MB");
  });

  for (const [message, text] of [
    [{ voice: { file_id: "V" } }, "Could not download voice message."],
    [{ photo: [{ file_id: "P" }] }, "Could not download photo."],
    [{ document: { file_id: "D" } }, "Could not download document."],
    [{ video_note: { file_id: "N" } }, "Could not download video."],
  ] as const) {
    test(`ohne Dateipfad: "${text}"`, async () => {
      const h = harness(message, { download: { ok: false, reason: "no_path" } });
      await handleTelegramMedia(h.ctx, h.deps);
      expect(h.replies).toEqual([text]);
      expect(h.saved).toEqual([]);
    });
  }

  test("Fehler im Turn: Entschuldigung, Tippanzeige endet, Sprachdatei bleibt wie bisher liegen", async () => {
    const h = harness({ voice: { file_id: "V" } }, { turnFails: true });
    await handleTelegramMedia(h.ctx, h.deps);
    expect(h.replies).toEqual(["Sorry, I couldn't process that voice message. Please try again."]);
    expect(h.log).toEqual(["typing:start", "save:user", "turn", "typing:stop"]);
    expect(existsSync(join(dir, `voice_${NOW}_uuid-1.ogg`))).toBe(true);
  });

  test("Downloadfehler: Entschuldigung je Art", async () => {
    const h = harness({ photo: [{ file_id: "P" }] });
    h.deps.download = async () => {
      throw new TelegramDownloadError("Telegram-Download fehlgeschlagen: HTTP 500");
    };
    await handleTelegramMedia(h.ctx, h.deps);
    expect(h.replies).toEqual(["Sorry, I couldn't process that image. Please try again."]);
    expect(h.log).toEqual(["typing:start", "typing:stop"]);
  });

  /** Wie grammY: HttpError mit dem ursprünglichen fetch-Fehler unter error */
  function grammyHttpError(): Error {
    const url = `https://api.telegram.org/bot${TOKEN}/getFile`;
    const inner = new TypeError(`fetch failed: ${url}`);
    const outer = new Error(`Network request for 'getFile' failed!`) as Error & { error?: unknown };
    outer.name = "HttpError";
    outer.error = inner;
    outer.stack = `HttpError: Network request for 'getFile' failed!\n    at ${url}`;
    return outer;
  }

  /** Alles, was ein Log vom Fehler zeigen kann: Meldung, Stack, eigene Felder, verschachtelte Fehler */
  function everythingLogged(err: unknown): string {
    const parts: string[] = [Bun.inspect(err)];
    const seen = new Set<unknown>();
    const walk = (value: unknown) => {
      if (value === null || typeof value !== "object" || seen.has(value)) return;
      seen.add(value);
      if (value instanceof Error) parts.push(value.message, String(value.stack));
      for (const key of Object.getOwnPropertyNames(value)) {
        const field = (value as Record<string, unknown>)[key];
        if (typeof field === "string") parts.push(field);
        else walk(field);
      }
    };
    walk(err);
    return parts.join("\n");
  }

  for (const [label, failing] of [
    [
      "getFile",
      {
        api: {
          getFile: async () => {
            throw grammyHttpError();
          },
        },
        fetch: async () => new Response("x"),
      },
    ],
    [
      "Lesen des Antwortstroms",
      {
        api: api({ file_path: "photos/a.jpg" }),
        fetch: async (url: string) =>
          new Response(
            new ReadableStream<Uint8Array>({
              pull(controller) {
                controller.error(Object.assign(new Error(`stream reset: ${url}`), { cause: new Error(url) }));
              },
            }),
          ),
      },
    ],
  ] as const) {
    test(`Fehler bei ${label}: geloggter Fehler enthält den Token nirgends`, async () => {
      const h = harness({ photo: [{ file_id: "P" }] });
      const logged: unknown[] = [];
      h.deps.logError = (_message, err) => {
        logged.push(err);
      };
      h.deps.download = item =>
        downloadTelegramFile(failing.api, item.fileId, { token: TOKEN, declaredSize: item.size, fetch: failing.fetch });
      await handleTelegramMedia(h.ctx, h.deps);
      expect(h.replies).toEqual(["Sorry, I couldn't process that image. Please try again."]);
      expect(logged).toHaveLength(1);
      const err = logged[0] as Error & { error?: unknown };
      expect(err).toBeInstanceOf(TelegramDownloadError);
      expect(err.cause).toBeUndefined();
      expect(err.error).toBeUndefined();
      const text = everythingLogged(err);
      expect(text).toContain("Telegram-Download fehlgeschlagen");
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain("SECRET");
    });
  }

  test("Nachricht ohne Medien: nichts passiert", async () => {
    const h = harness({ text: "hallo" });
    await handleTelegramMedia(h.ctx, h.deps);
    expect(h.log).toEqual([]);
    expect(h.replies).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Gemeinsamer Abschluss (Issue #339): Medien wie Text
// ---------------------------------------------------------------------------

const KINDS = [
  ["Sprache", { voice: { file_id: "V", file_size: 4 } }, "files/file_1.oga"],
  ["Foto", { caption: "Was ist das?", photo: [{ file_id: "P", file_size: 4 }] }, "photos/file_3.jpg"],
  ["Dokument", { caption: "Lies", document: { file_id: "D", file_name: "a.pdf", file_size: 4 } }, "documents/file_4.pdf"],
  ["Video", { caption: "Schau", video: { file_id: "X", file_name: "clip.mp4", duration: 3, file_size: 4 } }, "videos/file_5.mp4"],
  ["Rundvideo", { video_note: { file_id: "N", duration: 7, length: 240 } }, "video_notes/file_2.mp4"],
] as const;

function mediaHarness(message: Record<string, unknown>, filePath: string, opts: Parameters<typeof harness>[1] = {}) {
  return harness({ message_thread_id: 42, ...message }, { download: { ok: true, bytes: new Uint8Array([1]), filePath }, ...opts });
}

describe("handleTelegramMedia: gemeinsamer Abschluss für jede Art", () => {
  for (const [label, message, filePath] of KINDS) {
    test(`${label}: einmal gespeichert, Goal-Hook mit Topic-Schlüssel, genau eine Rückfrage im Topic nach der Antwort`, async () => {
      const h = mediaHarness(message, filePath, { question: true });
      await handleTelegramMedia(h.ctx, h.deps);
      expect(h.log).toEqual(["typing:start", "save:user", "turn", "save:assistant", "intents", "goal", "send", "offer", "threads", "cleanup", "typing:stop"]);
      expect(h.saved.filter(m => m.role === "assistant")).toHaveLength(1);
      expect(h.saved[1].metadata).toMatchObject({ topicId: 42, agent: "research", model: "m-1" });
      expect(h.goals).toEqual(["topic:-100123:42:research"]);
      expect(h.offers).toEqual(["-100123:42"]);
      expect(h.intents[0].target).toMatchObject({ chatId: "-100123", topicId: 42, origin: "Telegram" });
    });

    test(`${label}: [INVOKE:] fragt höchstens invokeBudget Agenten im Topic, speichert ihre Antworten, keine Rückfrage`, async () => {
      const h = mediaHarness(message, filePath, {
        question: true,
        reply: "Ich hole Hilfe.\n[INVOKE:finance|Kosten?]\n[INVOKE:critic|Risiken?]\n[INVOKE:strategy|Optionen?]",
      });
      const warn = console.warn;
      console.warn = () => {};
      try {
        await handleTelegramMedia(h.ctx, h.deps);
      } finally {
        console.warn = warn;
      }
      expect(h.sent).toEqual(["Ich hole Hilfe."]);
      expect(h.invoked).toEqual(["research->finance@-100123:42", "research->critic@-100123:42"]);
      expect(h.offers).toEqual([]);
      expect(h.saved.slice(2).map(m => [m.content, m.metadata])).toEqual([
        ["Antwort von finance", { agent: "finance", topicId: 42, invokedBy: "research" }],
        ["Antwort von critic", { agent: "critic", topicId: 42, invokedBy: "research" }],
      ]);
      expect(h.log).toContain("threads");
      expect(h.log.at(-2)).toBe("cleanup");
    });

    test(`${label}: Abbruch vor Nachbereitung, nur die Abbruch-Meldung`, async () => {
      const h = mediaHarness(message, filePath, { question: true, abort: "reply", reply: "Foto. [ASSET_DESC: x | y]" });
      await handleTelegramMedia(h.ctx, h.deps);
      expect(h.replies).toEqual([ABORT_REPLY]);
      expect(h.log).toEqual(["typing:start", "save:user", "turn", "cleanup", "typing:stop"]);
      expect(h.saved.map(m => m.role)).toEqual(["user"]);
      expect(h.assetDescs).toEqual([]);
      expect(h.goals).toEqual([]);
      expect(h.offers).toEqual([]);
      expect(h.threads).toEqual([]);
    });
  }

  test("Direktchat: Goal-Schlüssel und Rückfrage ohne Topic", async () => {
    const h = harness(
      { photo: [{ file_id: "P", file_size: 4 }] },
      { chatId: 4711, question: true, download: { ok: true, bytes: new Uint8Array([1]), filePath: "photos/a.jpg" } },
    );
    await handleTelegramMedia(h.ctx, h.deps);
    expect(h.goals).toEqual(["dm:4711:general"]);
    expect(h.offers).toEqual(["4711:-"]);
  });

  test("Foto-Nachbereitung vor dem Abschluss: gespeichert, geprüft und gesendet wird die Antwort ohne ASSET_DESC", async () => {
    const h = mediaHarness(KINDS[1][1], KINDS[1][2], { reply: "Ein Hund. [ASSET_DESC: Hund | tier]" });
    await handleTelegramMedia(h.ctx, h.deps);
    expect(h.saved[1].content).toBe("Ein Hund.");
    expect(h.intents[0]).toMatchObject({ response: "Ein Hund.", target: { foreignInput: "Foto" } });
    expect(h.goals).toHaveLength(1);
    expect(h.sent).toEqual(["Ein Hund."]);
  });

  test("Abbruch als Ausnahme: Abbruch-Meldung statt Entschuldigung, nichts gespeichert, Sprachdatei weg", async () => {
    const h = mediaHarness(KINDS[0][1], KINDS[0][2], { abort: "error" });
    await handleTelegramMedia(h.ctx, h.deps);
    expect(h.replies).toEqual([ABORT_REPLY]);
    expect(h.saved.map(m => m.role)).toEqual(["user"]);
    expect(h.log.filter(entry => entry === "cleanup")).toHaveLength(1);
    expect(existsSync(join(dir, `voice_${NOW}_uuid-1.ogg`))).toBe(false);
    expect(h.log.at(-1)).toBe("typing:stop");
  });

  test("Abbruch durch Neustart: ehrliche Meldung", async () => {
    const h = mediaHarness(KINDS[2][1], KINDS[2][2], { abort: "reply", shuttingDown: true });
    await handleTelegramMedia(h.ctx, h.deps);
    expect(h.replies).toEqual([SHUTDOWN_ABORT_REPLY]);
  });

  test("Rückfrage scheitert: Antwort bleibt, Fäden und Aufräumen laufen", async () => {
    const h = mediaHarness(KINDS[0][1], KINDS[0][2]);
    const run = h.deps.runTurn;
    h.deps.runTurn = (ctx, prompt, chat, agent, topic, turn, hint, onQuestion) =>
      run(ctx, prompt, chat, agent, topic, turn, hint, onQuestion).then(text => {
        onQuestion({
          offer: async () => {
            h.log.push("offer");
            throw new Error("Register kaputt");
          },
        } as unknown as TurnQuestion);
        return text;
      });
    await handleTelegramMedia(h.ctx, h.deps);
    expect(h.replies).toEqual([]);
    expect(h.log).toEqual(["typing:start", "save:user", "turn", "save:assistant", "intents", "goal", "send", "offer", "threads", "cleanup", "typing:stop"]);
  });
});
