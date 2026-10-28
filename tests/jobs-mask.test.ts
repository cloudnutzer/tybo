/**
 * Issue #103, Checkbox 4: Werte aus der .env erscheinen nie in einer
 * Job-Meldung (Log-Auszug, Bericht, Titel, Grund). Nur synthetische Werte
 * in einer Temp-.env, nie echte.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, closeSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Parser, parseDocument } from "htmlparser2";
import { textContent } from "domutils";
import { createJobDeps, pumpMasked } from "../src/lib/jobs/default-deps";
import { createStreamMasker, MASK, maskSecrets, projectSecrets, secretValues } from "../src/lib/jobs/mask";
import { composeNotice, logTail } from "../src/lib/jobs/notice";
import { sendAndRecord, type OutboxDeps } from "../src/lib/outbox";
import { stripHtmlTags } from "../src/lib/telegram";
import { renderMarkdown, stripControlTags } from "../src/web/markdown";
import { runWatcher, startJob } from "../src/lib/jobs/runner";
import { jobFile, readStatus, writeStatus, type JobOutcome } from "../src/lib/jobs/store";
import { fakeChild, fakeDeps, tempRoot } from "./jobs-fixture";

const { root, cleanup } = tempRoot("jobs-mask-");
afterAll(cleanup);

const SYNTH = {
  TELEGRAM_BOT_TOKEN: "111111:SYNTH-bot-token-Abc",
  OPENROUTER_API_KEY: "sk-or-synth-0123456789",
  SUPABASE_URL: "https://synth-projekt.supabase.co",
  WEB_PASSWORD: "synth-passwort-lang",
  SHORT_KEY: "q7z",
  TELEGRAM_USER_ID: "987654321",
  // Ein- und zweistellige Geheimnisse: auch sie nie unverändert
  ONE_TOKEN: "Q",
  TWO_SECRET: "Zj",
};
const PLAIN = { WEB_ENABLED: "true", WEB_PORT: "3100", USER_LANG: "vx" };

writeFileSync(
  join(root, ".env"),
  [...Object.entries(SYNTH), ...Object.entries(PLAIN)].map(([k, v]) => `${k}=${v}`).join("\n") + "\n# Kommentar\n",
);

const secrets = () => projectSecrets(root, {});
const allSecrets = Object.values(SYNTH);

describe("secretValues und maskSecrets", () => {
  test(".env: jeder Wert in jeder Länge", () => {
    const values = secrets();
    for (const v of [...allSecrets, ...Object.values(PLAIN)]) expect(values).toContain(v);
  });

  test("ein- und zweistellige Geheimnisse werden überall ersetzt, auch mitten im Wort", () => {
    const values = secretValues({ ONE_TOKEN: "Q", TWO_SECRET: "Zj" }, { X_KEY: "7" });
    expect(maskSecrets("Q und xZjx und 1789", values)).toBe(`${MASK} und x${MASK}x und 1${MASK}89`);
  });

  test("kurze übrige .env-Werte: auch innerhalb längerer Zeichenfolgen ersetzt", () => {
    const values = secretValues({ WEB_ENABLED: "true", WEB_PORT: "3100", USER_LANG: "de", ACCESS_CODE: "Zj" });
    expect(maskSecrets("läuft: true, Port 3100, Sprache de; oder 31000 und untrue, code=xZjx", values)).toBe(
      `läuft: ${MASK}, Port ${MASK}, Sprache ${MASK}; o${MASK}r ${MASK}0 und un${MASK}, co${MASK}=x${MASK}x`,
    );
  });

  test("unsichtbare Zeichen fallen vor dem Maskieren weg: ein durch U+200B und Co. getrennter Wert bleibt verborgen", () => {
    const values = secretValues({ SOME_TOKEN: "synth-token-123456", ACCESS_CODE: "Zj" });
    const text = "a synth-token-\u200b123456 b Z\u2060j c s\uFEFFynth-token-12345\u{E0100}6";
    expect(maskSecrets(text, values)).toBe(`a ${MASK} b ${MASK} c ${MASK}`);
  });

  test("Prozess-Umgebung: nur geheim benannte Variablen, auch einstellige", () => {
    const values = secretValues({}, { ANTHROPIC_API_KEY: "sk-ant-synth", HOME: "/Users/synth-home", MY_PASS: "abc", Z_TOKEN: "k" });
    expect(values).toContain("sk-ant-synth");
    expect(values).toContain("abc");
    expect(values).toContain("k");
    expect(values).not.toContain("/Users/synth-home");
  });

  test("Sonderzeichen in Werten gelten wörtlich", () => {
    const values = secretValues({ A_KEY: "a.b*c(d)[e]$" });
    expect(maskSecrets("x a.b*c(d)[e]$ y aXbbc", values)).toBe(`x ${MASK} y aXbbc`);
  });

  test("längster Wert zuerst: ein Wert, der einen anderen enthält, verschwindet ganz", () => {
    const values = secretValues({ A_KEY: "abcdef", B_KEY: "abcdef-ghijkl" });
    expect(maskSecrets("x abcdef-ghijkl y abcdef", values)).toBe(`x ${MASK} y ${MASK}`);
  });

  test("Log-Auszug: erst maskiert, dann gekürzt; ein am Zeilenende abgeschnittenes Geheimnis bleibt verborgen", () => {
    const secret = SYNTH.OPENROUTER_API_KEY;
    const line = `${"x".repeat(295)}${secret}`;
    const tail = logTail(line, secrets());
    expect(tail).not.toContain(secret.slice(0, 5));
  });
});

describe("Maskierung in Stücken (job.log)", () => {
  const values = secretValues({ LONG_TOKEN: "synth-geheim-0123456789", ONE_KEY: "Q", WEB_PORT: "3100" });
  const text = "Start Q\nToken synth-geheim-0123456789 und Port 3100, nicht 31000\nsynth-geheim-0123456789Q3100\nEnde 3100";

  test("jede Aufteilung ergibt dasselbe wie maskSecrets am Stück", () => {
    const expected = maskSecrets(text, values);
    expect(expected).not.toContain("synth-geheim");
    for (let seed = 1; seed <= 200; seed++) {
      const masker = createStreamMasker(values);
      let out = "";
      let rest = text;
      let r = seed;
      while (rest) {
        r = (r * 1103515245 + 12345) % 2147483648;
        const size = 1 + (r % 7);
        out += masker.push(rest.slice(0, size));
        rest = rest.slice(size);
      }
      out += masker.end();
      expect(out).toBe(expected);
    }
  });

  test("ein Geheimnis über zwei Stücke verteilt wird nie teilweise herausgegeben", () => {
    const masker = createStreamMasker(values);
    const first = masker.push("Token synth-geheim-");
    expect(first).not.toContain("synth");
    expect(first + masker.push("0123456789 fertig") + masker.end()).toBe(`Token ${MASK} fertig`);
  });
});

describe("Gespeicherte Logs ohne Werte aus .env", () => {
  test("job.log: Ausgabe von Claude (stdout und stderr, in Stücken) wird vor dem Schreiben maskiert", async () => {
    const deps = createJobDeps({ root, env: { PATH: process.env.PATH }, log: () => {} });
    // Geheimnisse in mehreren write-Aufrufen mit Pausen, damit sie in getrennten Stücken ankommen
    const scripts: [string, string[]][] = [
      [
        "printf 'A 111111:SYNTH-bot'; sleep 0.2; printf '%s ende\\n' '-token-Abc'; echo 'Nutzer 987654321 Port 3100'",
        [`A ${MASK} ende\nNutzer ${MASK} Port ${MASK}\n`],
      ],
      ["printf 'fehler sk-or-synth-01' >&2; sleep 0.2; printf '23456789 und Q und Zj\\n' >&2", [`fehler ${MASK} und ${MASK} und ${MASK}\n`]],
    ];
    let n = 1;
    for (const [script, expected] of scripts) {
      const id = `20260925-151000-00010${n++}`;
      await Bun.write(jobFile(root, id, "log"), "");
      const child = deps.spawnClaude({ id, cmd: ["sh", "-c", script], cwd: root, env: { PATH: process.env.PATH ?? "" }, prompt: "", logPath: jobFile(root, id, "log") });
      child.release();
      expect(await child.exited).toEqual({ code: 0, signal: null });
      await child.drained;
      const log = readFileSync(jobFile(root, id, "log"), "utf8");
      for (const secret of allSecrets) expect(log).not.toContain(secret);
      expect(log).toBe(expected.join(""));
    }
  }, 10_000);

  test("job.log: Teile eines Geheimnisses abwechselnd aus stdout und stderr setzen sich nicht zusammen", async () => {
    const values = secretValues({ SOME_TOKEN: "synth-token-123456" });
    const id = "20260925-151000-000201";
    await Bun.write(jobFile(root, id, "log"), "");
    // Ströme mit fester Reihenfolge: jeder Schritt wartet, bis das Stück gelesen und geschrieben ist
    const controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
    const streams = [0, 1].map(() => new ReadableStream<Uint8Array>({ start: c => void controllers.push(c) }));
    const [out, err] = controllers;
    const bytes = (text: string) => new TextEncoder().encode(text);
    const tick = () => new Promise(res => setTimeout(res, 5));
    const fd = openSync(jobFile(root, id, "log"), "a");
    const pumped = pumpMasked(streams, fd, values);
    const steps: [ReadableStreamDefaultController<Uint8Array>, string][] = [
      [out, `${"x".repeat(40)} synth-`],
      [err, "tok"],
      [out, "en-"],
      [out, ""],
      [err, "123456 Ende\n"],
    ];
    for (const [c, text] of steps) {
      if (text) c.enqueue(bytes(text));
      await tick();
    }
    out.close();
    await tick();
    err.close();
    await pumped;
    closeSync(fd);
    const log = readFileSync(jobFile(root, id, "log"), "utf8");
    expect(log).not.toContain("synth-token-123456");
    expect(log).toBe(`${"x".repeat(40)} ${MASK} Ende\n`);
  });

  test("job.log: stdout endet mitten im Geheimnis, stderr schreibt den Rest", async () => {
    const values = secretValues({ SOME_TOKEN: "synth-token-123456" });
    const id = "20260925-151000-000202";
    await Bun.write(jobFile(root, id, "log"), "");
    const controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
    const streams = [0, 1].map(() => new ReadableStream<Uint8Array>({ start: c => void controllers.push(c) }));
    const [out, err] = controllers;
    const tick = () => new Promise(res => setTimeout(res, 5));
    const fd = openSync(jobFile(root, id, "log"), "a");
    const pumped = pumpMasked(streams, fd, values);
    out.enqueue(new TextEncoder().encode("Wert synth-token-"));
    await tick();
    out.close();
    await tick();
    err.enqueue(new TextEncoder().encode("123456\n"));
    await tick();
    err.close();
    await pumped;
    closeSync(fd);
    const log = readFileSync(jobFile(root, id, "log"), "utf8");
    expect(log).not.toContain("synth-token-123456");
    expect(log).toBe(`Wert ${MASK}\n`);
  });

  test("Log-Zeilen des Wächters (createJobDeps) werden maskiert", () => {
    const lines: string[] = [];
    const deps = createJobDeps({ root, env: { PATH: process.env.PATH }, log: line => lines.push(line) });
    deps.log(`Fehler mit ${SYNTH.OPENROUTER_API_KEY} und Q`);
    expect(lines).toEqual([`Fehler mit ${MASK} und ${MASK}`]);
  });

  test("Claude-Startfehler: Grund in status.json, Meldung und Log ohne Werte aus .env", async () => {
    const id = "20260925-151000-000002";
    await writeStatus(root, {
      version: 1, id, title: "t", createdAt: new Date().toISOString(), phase: "starting",
      maxHours: 1, model: "m", fullAccess: false, target: {},
    });
    await Bun.write(jobFile(root, id, "brief"), "Auftrag");
    await Bun.write(jobFile(root, id, "log"), "");
    const deps = fakeDeps(root, {
      secrets: secrets(),
      spawnClaude: () => {
        throw new Error(`spawn ${SYNTH.WEB_PASSWORD} ENOENT`);
      },
      notify: async () => ({ sent: false, recorded: false, error: { kind: "send", message: `HTTP mit ${SYNTH.TELEGRAM_BOT_TOKEN}` } }),
    });
    await runWatcher(id, deps);
    const stored = readFileSync(jobFile(root, id, "status"), "utf8");
    expect((await readStatus(root, id))!.detail).toContain("Claude ließ sich nicht starten");
    for (const secret of allSecrets.filter(s => s.length > 2)) {
      expect(stored).not.toContain(secret);
      expect(deps.logs.join("\n")).not.toContain(secret);
    }
    expect(deps.logs.some(l => l.includes("Meldung nicht zugestellt"))).toBe(true);
  });

  test("Meldung: ein- und zweistellige Geheimnisse auch in Titel, Bericht und Log-Auszug verborgen", async () => {
    const id = "20260925-151000-000003";
    const status = {
      version: 1 as const, id, title: "Titel Zj", createdAt: new Date().toISOString(), phase: "ended" as const, outcome: "failed" as const,
      exitCode: 1, maxHours: 1, model: "m", fullAccess: false, target: {},
    };
    await Bun.write(jobFile(root, id, "log"), "Zeile mit Q\nZeile mit Zj\n");
    const text = await composeNotice(root, status, secrets(), new Date());
    expect(text).not.toContain("Zj");
    expect(text).not.toMatch(/Q(?!\w)/);
    expect(text).toContain(`Titel ${MASK}`);
  });
});

describe("Meldungen aller Ausgänge ohne Werte aus .env", () => {
  const logLines = [
    "Starte mit Token 111111:SYNTH-bot-token-Abc",
    `curl -H "Authorization: Bearer sk-or-synth-0123456789" https://synth-projekt.supabase.co/rest`,
    "Passwort war synth-passwort-lang, Schlüssel q7z, Nutzer 987654321",
    `ENV-Dump: WEB_PASSWORD=synth-passwort-lang TELEGRAM_BOT_TOKEN="111111:SYNTH-bot-token-Abc"`,
  ];
  const title = "Auswertung für 987654321 mit sk-or-synth-0123456789";

  const cases: { outcome: JobOutcome; code: number | null; report?: string; throws?: boolean }[] = [
    { outcome: "success", code: 0, report: `Fertig. Genutzt: ${SYNTH.OPENROUTER_API_KEY} und ${SYNTH.SUPABASE_URL}` },
    { outcome: "failed", code: 2 },
    { outcome: "no_report", code: 0 },
    { outcome: "start_failed", code: 0, throws: true },
  ];

  let n = 0;
  for (const c of cases) {
    test(`${c.outcome}: Titel, Bericht und Log-Auszug maskiert`, async () => {
      const id = `20260925-150000-${(n++).toString(16).padStart(6, "0")}`;
      await writeStatus(root, {
        version: 1, id, title, createdAt: new Date().toISOString(), phase: "starting",
        maxHours: 6, model: "m", fullAccess: false, target: { topicId: 5 },
      });
      await Bun.write(jobFile(root, id, "brief"), "Auftrag");
      await Bun.write(jobFile(root, id, "log"), "");
      const deps = fakeDeps(root, {
        secrets: secrets(),
        spawnClaude: spec => {
          if (c.throws) throw new Error(`claude nicht gefunden (Token ${SYNTH.TELEGRAM_BOT_TOKEN})`);
          appendFileSync(spec.logPath, logLines.join("\n") + "\n");
          if (c.report) writeFileSync(jobFile(root, spec.id, "report"), c.report);
          return fakeChild(12_345, Promise.resolve({ code: c.code, signal: null }));
        },
      });
      await runWatcher(id, deps);
      expect(deps.sent).toHaveLength(1);
      const text = deps.sent[0].text!;
      expect(text).toContain(MASK);
      for (const secret of allSecrets) expect(text).not.toContain(secret);
    });
  }

  test("Zeitüberschreitung und Abbruch: Log-Auszug maskiert", async () => {
    for (const outcome of ["timeout", "aborted", "stopped"] as const) {
      const id = `20260925-150000-${(n++).toString(16).padStart(6, "0")}`;
      await writeStatus(root, {
        version: 1, id, title, createdAt: new Date().toISOString(), phase: "ended", outcome, maxHours: 1,
        model: "m", fullAccess: false, target: {}, detail: `Grund mit ${SYNTH.WEB_PASSWORD}`,
        notice: { state: "pending", attempts: 0, owner: { pid: 1, identity: "x", token: "tok" } },
      });
      await Bun.write(jobFile(root, id, "log"), logLines.join("\n"));
      const deps = fakeDeps(root, { secrets: secrets() });
      const { deliverNotice } = await import("../src/lib/jobs/notice");
      expect(await deliverNotice(id, "tok", deps)).toBe("sent");
      const text = deps.sent[0].text!;
      for (const secret of allSecrets) expect(text).not.toContain(secret);
    }
  });

  test("Start gescheitert (Wächter): Grund ohne Werte aus .env", async () => {
    const deps = fakeDeps(root, { secrets: secrets() });
    deps.spawnWatcher = () => {
      throw new Error(`EACCES ${SYNTH.OPENROUTER_API_KEY}`);
    };
    const result = await startJob({ title, brief: "x", target: {}, maxHours: 1, model: "m", fullAccess: false }, deps);
    expect(result.ok).toBe(false);
    expect(deps.sent).toHaveLength(1);
    for (const secret of allSecrets) expect(deps.sent[0].text).not.toContain(secret);
  });
});

describe("Tatsächlich versendeter Text (echtes sendAndRecord, HTTP abgefangen)", () => {
  const { root: r, cleanup: done } = tempRoot("jobs-mask-http-");
  afterAll(done);
  const TOKEN = "synth-token-123456";
  const SIGN = "synth+key/123=456";
  writeFileSync(join(r, ".env"), `SOME_TOKEN=${TOKEN}\nACCESS_CODE=Zj\nWEB_PORT=3100\nSIGN_KEY=${SIGN}\n`);
  const values = () => projectSecrets(r, {});
  const shown = [TOKEN, "Zj", "3100", SIGN];

  /** Führt einen Job bis zur Meldung aus; Rückgabe: Text der sendMessage-Aufrufe und was Telegram davon zeigt */
  async function sendJob(title: string, behavior: { code: number; report?: string; log?: string }) {
    const id = `20260925-152000-${(n++).toString(16).padStart(6, "0")}`;
    await writeStatus(r, {
      version: 1, id, title, createdAt: new Date().toISOString(), phase: "starting",
      maxHours: 1, model: "m", fullAccess: false, target: { chatId: "-100200", topicId: 7 },
    });
    await Bun.write(jobFile(r, id, "brief"), "Auftrag");
    await Bun.write(jobFile(r, id, "log"), "");
    const bodies: string[] = [];
    const recorded: string[] = [];
    const outbox: OutboxDeps = {
      botToken: "synth-bot",
      userId: "4242",
      groupId: "-100200",
      outboxDir: join(r, "outbox"),
      fetch: async (_url, init) => {
        bodies.push(JSON.parse(String(init.body)).text);
        return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
      },
      record: async row => (recorded.push(row.content), true),
      log: () => {},
      newId: () => crypto.randomUUID(),
    };
    const deps = fakeDeps(r, {
      secrets: values(),
      notify: input => sendAndRecord(input, outbox),
      spawnClaude: spec => {
        if (behavior.log) appendFileSync(spec.logPath, behavior.log);
        if (behavior.report) writeFileSync(jobFile(r, spec.id, "report"), behavior.report);
        return fakeChild(12_346, Promise.resolve({ code: behavior.code, signal: null }));
      },
    });
    await runWatcher(id, deps);
    expect(bodies).toHaveLength(1);
    expect(recorded).toHaveLength(1);
    // WebUI: festgehaltener Text, wie chat.ts ihn zeigt (HTML aus renderMarkdown, Kopiertext)
    const html = renderMarkdown(recorded[0]);
    const web = { html, text: textContent(parseDocument(html)), copy: stripControlTags(recorded[0]) };
    return { raw: bodies[0], visible: stripHtmlTags(bodies[0]), recorded: recorded[0], web };
  }
  let n = 0;

  test("kurze Werte innerhalb längerer Zeichenfolgen: weder im HTTP-Text noch in der Anzeige", async () => {
    const { raw, visible } = await sendJob("Titel xZjx", { code: 1, log: "code=xZjx Port 31000\nfertig\n" });
    for (const v of shown) {
      expect(raw).not.toContain(v);
      expect(visible).not.toContain(v);
    }
    expect(visible).toContain(`x${MASK}x`);
    expect(visible).toContain(`${MASK}0`);
  });

  test("durch unsichtbare Zeichen getrennte Werte: die Telegram-Bereinigung setzt sie nicht wieder zusammen", async () => {
    const { raw, visible } = await sendJob("s​ynth-token-123456", {
      code: 0,
      report: "Bericht mit synth-token-​123456 und Z⁠j und 31﻿00",
    });
    for (const v of shown) {
      expect(raw).not.toContain(v);
      expect(visible).not.toContain(v);
    }
    expect(visible).toContain(`Job fertig: ${MASK}`);
    expect(visible).toContain(`Bericht mit ${MASK} und ${MASK} und ${MASK}`);

    const log = await sendJob("Log", { code: 2, log: "Zeile synth-token‌-123456\nZ​j\n" });
    for (const v of shown) expect(log.visible).not.toContain(v);
  });

  test("Markdown-Umwandlung würde Werte zusammensetzen: der Teil wird ganz verborgen", async () => {
    const { raw, visible } = await sendJob("synth-**token**-123456", {
      code: 0,
      report: "Ergebnis: synth-token-**123456** und [synth-token-](https://example.com/x)123456",
    });
    for (const v of shown) {
      expect(raw).not.toContain(v);
      expect(visible).not.toContain(v);
    }
    expect(visible).toContain(`Job fertig: ${MASK}`);
    expect(visible).toContain("Bericht verborgen");
    expect(visible).not.toContain("Ergebnis");
  });

  /** Weder Telegram noch die WebUI (HTML-Text, Attribute, Kopiertext) zeigen einen Wert */
  function expectNowhere(result: Awaited<ReturnType<typeof sendJob>>) {
    for (const v of shown) {
      for (const view of [result.raw, result.visible, result.recorded, result.web.text, result.web.html, result.web.copy]) {
        expect(view).not.toContain(v);
      }
    }
  }

  test("WebUI-Darstellung würde Werte zusammensetzen (__ im Bericht): der Bericht wird verborgen", async () => {
    const result = await sendJob("Bericht", { code: 0, report: "Ergebnis: synth-token-__123456__ fertig" });
    expectNowhere(result);
    expect(result.web.text).toContain("Bericht verborgen");
    expect(result.web.text).not.toContain("Ergebnis");
  });

  test("Steuer-Tag im Log-Auszug würde in der WebUI Werte zusammensetzen: der Auszug wird verborgen", async () => {
    const result = await sendJob("Log", { code: 2, log: "Zeile synth-token-[REMEMBER:x]123456\nnoch eine\n" });
    expectNowhere(result);
    expect(result.web.text).toContain("Log-Auszug verborgen");
    expect(result.web.text).not.toContain("noch eine");
  });

  test("Zeichenreferenzen und Titel neben Fettschrift: auch dort kein Wert in der WebUI", async () => {
    const result = await sendJob("synth-token-__123456__", { code: 0, report: "A synth-token-&#49;23456 und [x](https://example.com/synth-token-&#49;23456)" });
    expectNowhere(result);
    expect(result.web.text).toContain(`Job fertig: ${MASK}`);
    expect(result.web.text).toContain("Bericht verborgen");
  });

  test("benannte Zeichenreferenzen (&plus;, &sol;, &equals;) im sichtbaren Text: der Browser zeigt sie dekodiert, also verborgen", async () => {
    const result = await sendJob("synth&plus;key&sol;123&equals;456", { code: 0, report: "Ergebnis: synth&plus;key&sol;123&equals;456 fertig" });
    expectNowhere(result);
    expect(result.web.text).toContain(`Job fertig: ${MASK}`);
    expect(result.web.text).toContain("Bericht verborgen");
    expect(result.web.text).not.toContain("Ergebnis");

    const log = await sendJob("Log", { code: 2, log: "Zeile synth&plus;key&sol;123&equals;456\n" });
    expectNowhere(log);
  });

  test("benannte Zeichenreferenzen in Attributen (Link-Adresse, Link-Titel, Bildbeschreibung): kein Wert in der WebUI", async () => {
    const ref = "synth&plus;key&sol;123&equals;456";
    const result = await sendJob(`[t](https://example.com/?k=${ref} "${ref}")`, {
      code: 0,
      report: `[Link](https://example.com/${ref} "${ref}") und ![${ref}](https://example.com/a.png)`,
    });
    expectNowhere(result);
    const attributes: string[] = [];
    new Parser({ onattribute: (_name, value) => void attributes.push(value) }).end(result.web.html);
    for (const value of attributes) for (const v of shown) expect(value).not.toContain(v);
  });

  test("gewöhnlicher Markdown-Bericht bleibt sichtbar", async () => {
    const report = "## Ergebnis\n\n| Anbieter | Preis |\n|---|---|\n| A | 12 € |\n\n**fett** und [Link](https://example.com)\n\n> Zitat\n\n- Punkt";
    const { visible } = await sendJob("Vergleich", { code: 0, report });
    expect(visible).toContain("Job fertig: Vergleich");
    expect(visible).not.toContain("verborgen");
    for (const word of ["Ergebnis", "A: 12 €", "fett", "Link", "Zitat", "Punkt"]) expect(visible).toContain(word);
  });
});
