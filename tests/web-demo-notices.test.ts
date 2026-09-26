// Demo mit Meldungen und Dateien (Issue #47, Schritt 5): Topic „Pipeline"
// mit Pipeline-Meldung, Bild (Vorschau) und HTML-Report (nur Download), alles
// in der temporären Demo-Ablage, nie in data/outbox.
import { expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { DEMO_FILES, startDemoServer } from "../src/web/demo";

const config = { host: "127.0.0.1", port: 0, password: "demo-passwort-lang", allowedHosts: [] };

test("Demo: Meldungen im Verlauf, Bild als Vorschau, HTML nur als Anhang", async () => {
  const demo = await startDemoServer(config, { log: () => {} });
  const origin = demo.server.url;
  try {
    expect(demo.filesDir.startsWith(demo.dir)).toBe(true);
    const history = await (await fetch(`${origin}/api/conversations/topic-60/messages`)).json();
    const notices = history.messages.filter((m: { kind?: string }) => m.kind === "notice");
    expect(notices.map((m: { source: string }) => m.source)).toEqual(["pipeline", "datei", "datei"]);
    expect(notices[0].html).toContain("<strong>Issue #47</strong>");
    expect(notices[1].file).toMatchObject({ id: DEMO_FILES.image.id, name: DEMO_FILES.image.name, mime: "image/png" });
    expect(notices[2].file).toMatchObject({ id: DEMO_FILES.report.id, mime: "text/html" });

    const image = await fetch(`${origin}/api/files/${DEMO_FILES.image.id}?inline=1`);
    expect(image.status).toBe(200);
    expect(image.headers.get("content-type")).toBe("image/png");
    expect(image.headers.get("content-disposition")).toStartWith("inline;");
    expect((await image.arrayBuffer()).byteLength).toBe(notices[1].file.size);

    const report = await fetch(`${origin}/api/files/${DEMO_FILES.report.id}?inline=1`);
    expect(report.status).toBe(200);
    expect(report.headers.get("content-type")).toBe("application/octet-stream");
    expect(report.headers.get("content-disposition")).toStartWith("attachment;");

    // Live wie aus einem anderen Prozess
    expect(demo.receiveNotice("topic-60", "watchdog", "Alles ruhig")).toBe(true);
    const again = await (await fetch(`${origin}/api/conversations/topic-60/messages`)).json();
    expect(again.messages.at(-1)).toMatchObject({ kind: "notice", source: "watchdog", text: "Alles ruhig" });
  } finally {
    await demo.stop();
  }
  await expect(readdir(join(demo.filesDir))).rejects.toThrow();
});
