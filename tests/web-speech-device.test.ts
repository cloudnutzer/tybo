/**
 * Issue #250, Checkbox 5: Abschnitt „Sprechmodus auf diesem Gerät"
 * (createSpeechDeviceSettings in src/web/public/speech.js) ohne Browser,
 * mit den Bausteinen h und sectionNode als Attrappen wie in
 * web-push-app.test.ts. Der Abschnitt im echten Reiter „Sprechen" und dass
 * nichts in PATCH /api/settings landet, prüft web-app-settings.test.ts.
 */
import { describe, expect, test } from "bun:test";
import { speechHarness, type HarnessOptions } from "./speech-mode-fixture";

interface El {
  tag: string;
  props: Record<string, any>;
  children: El[];
  listeners: Record<string, (e?: any) => void>;
  attributes: Record<string, string>;
  addEventListener(type: string, fn: (e?: any) => void): void;
  appendChild(child: El): El;
  setAttribute(name: string, value: string): void;
  value?: string;
  selected?: boolean;
}

function h(tag: string, props: Record<string, any> = {}, children: (El | null)[] = []): El {
  return {
    tag,
    props,
    children: children.filter(Boolean) as El[],
    listeners: {},
    attributes: {},
    value: props.value,
    addEventListener(type, fn) { this.listeners[type] = fn; },
    appendChild(child) { this.children.push(child); return child; },
    setAttribute(name, value) { this.attributes[name] = value; },
  };
}

const sectionNode = (id: string, title: string, hints: string[], children: (El | null)[]) =>
  h("section", { id, title }, [...hints.map(text => h("p", { className: "actions-hint", text })), ...children]);

const all = (nodes: El[]): El[] => nodes.flatMap(n => [n, ...all(n.children)]);
const texts = (nodes: El[]) => all(nodes).map(n => n.props.text ?? "").filter(Boolean).join("\n");
const byKey = (nodes: El[], key: string) => all(nodes).find(n => n.props["data-focus-key"] === key)!;
const byId = (nodes: El[], id: string) => all(nodes).find(n => n.props.id === id)!;

function section(options: HarnessOptions & { place?: "browser" | "server" | null } = {}) {
  const fakes = speechHarness(options);
  let renders = 0;
  const device = fakes.api.createSpeechDeviceSettings({
    win: fakes.win,
    storage: fakes.storage,
    render: () => void renders++,
    h,
    sectionNode,
    tts: () => (options.place === undefined ? "browser" : options.place),
  });
  const read = () => (fakes.stored.has("tybo-speech-device") ? JSON.parse(fakes.stored.get("tybo-speech-device")!) : null);
  return { fakes, device, read, renders: () => renders, T: fakes.api.SPEECH_MODE_TEXT };
}

describe("Abschnitt „Sprechmodus auf diesem Gerät“", () => {
  test("Standardwerte: Pause normal, Vorauswahl der Stimme, Tempo 1, Kopfhörer aus; nichts wird beim Anzeigen gespeichert", () => {
    const s = section();
    const nodes = s.device.nodes();
    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.props.title).toBe("Sprechmodus auf diesem Gerät");
    expect(byKey(nodes, "speech-device-pause:normal").props["aria-checked"]).toBe("true");
    expect(byKey(nodes, "speech-device-pause:short").props.text).toBe("Kurz");
    expect(byKey(nodes, "speech-device-pause:long").props.text).toBe("Lang");
    expect(byId(nodes, "speech-device-voice").value).toBe("");
    expect(byId(nodes, "speech-device-rate").value).toBe("1");
    expect(byId(nodes, "speech-device-rate").children.map(o => o.props.text)).toEqual(["0,8-fach", "0,9-fach", "1-fach (normal)", "1,1-fach", "1,2-fach", "1,3-fach", "1,4-fach"]);
    expect(byKey(nodes, "speech-device-headphones:off").props["aria-checked"]).toBe("true");
    expect(s.read()).toBeNull();
    expect(texts(nodes)).not.toContain(s.T.noStorage);
  });

  test("jede Änderung geht sofort in localStorage unter einem Schlüssel und zeichnet neu", () => {
    const s = section();
    byKey(s.device.nodes(), "speech-device-pause:short").listeners.click!();
    expect(s.read()).toEqual({ pause: "short", voice: "", rate: 1, headphones: false });
    byKey(s.device.nodes(), "speech-device-headphones:on").listeners.click!();
    const rate = byId(s.device.nodes(), "speech-device-rate");
    rate.value = "1.4";
    rate.listeners.change!();
    const voice = byId(s.device.nodes(), "speech-device-voice");
    voice.value = "Anna";
    voice.listeners.change!();
    expect(s.read()).toEqual({ pause: "short", voice: "Anna", rate: 1.4, headphones: true });
    expect([...s.fakes.stored.keys()]).toEqual(["tybo-speech-device"]);
    expect(s.renders()).toBe(4);
    const again = s.device.nodes();
    expect(byKey(again, "speech-device-pause:short").props["aria-checked"]).toBe("true");
    expect(byKey(again, "speech-device-headphones:on").props["aria-checked"]).toBe("true");
    expect(byId(again, "speech-device-voice").value).toBe("Anna");
    // Pfeiltasten wählen wie bei den anderen Segment-Steuerungen
    byKey(again, "speech-device-pause:short").listeners.keydown!({ key: "ArrowRight", preventDefault() {} });
    expect(s.read().pause).toBe("normal");
    // Der Baustein kennt keinen Weg zum Server
    expect(s.fakes.calls).toEqual([]);
  });

  test("ohne localStorage: Standardwerte, der Abschnitt sagt, dass nichts gespeichert wird, die Wahl ist gesperrt", () => {
    const s = section({ storage: false });
    const nodes = s.device.nodes();
    expect(texts(nodes)).toContain("Dieser Browser speichert hier nichts. Es gelten die Standardwerte.");
    expect(byKey(nodes, "speech-device-pause:normal").props["aria-checked"]).toBe("true");
    for (const key of ["speech-device-pause:short", "speech-device-headphones:on"]) expect(byKey(nodes, key).props.disabled).toBe(true);
    expect(byId(nodes, "speech-device-voice").props.disabled).toBe(true);
    expect(byId(nodes, "speech-device-rate").props.disabled).toBe(true);
    // Die Probe geht trotzdem
    expect(byKey(nodes, "speech-device:probe").props.disabled).toBe(false);
  });

  test("localStorage, das beim Schreiben scheitert (voll, privater Modus): Hinweis nach dem ersten Versuch", () => {
    const s = section();
    s.fakes.storage!.setItem = () => {
      throw new Error("voll");
    };
    byKey(s.device.nodes(), "speech-device-pause:short").listeners.click!();
    const nodes = s.device.nodes();
    expect(texts(nodes)).toContain("Dieser Browser speichert hier nichts. Es gelten die Standardwerte.");
    expect(byKey(nodes, "speech-device-pause:normal").props["aria-checked"]).toBe("true");
  });

  test("Stimmenliste: deutsche, lokale zuerst; fehlt die gespeicherte Stimme, steht die Vorauswahl", () => {
    const s = section({
      device: { voice: "Gelöscht" },
      voices: [
        { voiceURI: "g", name: "Google Deutsch", lang: "de-DE", localService: false },
        { voiceURI: "s", name: "Samantha", lang: "en-US", localService: true },
        { voiceURI: "a", name: "Anna", lang: "de-DE", localService: true },
      ],
    });
    const select = byId(s.device.nodes(), "speech-device-voice");
    expect(select.children.map(o => o.props.text)).toEqual(["Vorauswahl: Anna (de-DE)", "Anna (de-DE)", "Google Deutsch (de-DE, online)"]);
    expect(select.value).toBe("");
    expect(texts(s.device.nodes())).toContain(s.T.voiceHint);
  });

  test("keine deutsche Stimme: alle Stimmen zur Wahl und ein Hinweis", () => {
    const s = section({ voices: [{ voiceURI: "s", name: "Samantha", lang: "en-US", localService: true }, { voiceURI: "t", name: "Thomas", lang: "fr-FR", localService: false }] });
    const nodes = s.device.nodes();
    expect(byId(nodes, "speech-device-voice").children.map(o => o.props.text)).toEqual(["Vorauswahl des Browsers", "Samantha (en-US)", "Thomas (fr-FR, online)"]);
    expect(texts(nodes)).toContain("Dieser Browser hat keine deutsche Stimme. Zur Wahl stehen alle Stimmen; gesprochen wird mit der Sprachangabe Deutsch.");
    expect(byId(nodes, "speech-device-voice-hint").props["data-speech-device"]).toBe("no-german");
  });

  test("noch keine Stimmen geladen, keine eingebaute Stimme, Server-Stimme: je ein Hinweis", () => {
    const loading = section({ voices: [] });
    expect(byId(loading.device.nodes(), "speech-device-voice-hint").props["data-speech-device"]).toBe("no-voices");
    expect(byId(loading.device.nodes(), "speech-device-voice").props.disabled).toBe(true);

    const none = section({ synth: false });
    const nodes = none.device.nodes();
    expect(texts(nodes)).toContain("Dieser Browser hat keine eingebaute Stimme.");
    expect(byKey(nodes, "speech-device:probe").props.disabled).toBe(true);
    // Probe ohne Stimme: kein Absturz
    none.device.probe();

    const server = section({ place: "server" });
    expect(texts(server.device.nodes())).toContain("Gerade liest eine Stimme des Servers vor. Stimme und Probe gelten für die Browser-Stimme.");
    expect(texts(section({ place: null }).device.nodes())).not.toContain("Stimme des Servers");
  });

  test("„Probe“: bricht Laufendes ab und spricht mit Stimme und Tempo dieses Geräts", () => {
    const s = section({ device: { rate: 1.3, voice: "Anna" } });
    const cancelled = s.fakes.synth.cancelled;
    byKey(s.device.nodes(), "speech-device:probe").listeners.click!();
    expect(s.fakes.synth.cancelled).toBe(cancelled + 1);
    expect(s.fakes.synth.spoken.map(u => [u.text, u.rate, u.voice.voiceURI, u.lang])).toEqual([["So klingt die Stimme für den Sprechmodus.", 1.3, "Anna", "de-DE"]]);
  });

  test("open() hört auf voiceschanged, genau einmal", () => {
    const s = section();
    s.device.open();
    s.device.open();
    expect(s.fakes.synth.listeners["voiceschanged"]).toHaveLength(1);
    s.fakes.synth.listeners["voiceschanged"]![0]!();
    expect(s.renders()).toBe(1);
  });
});
