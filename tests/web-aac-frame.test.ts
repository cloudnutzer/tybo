/**
 * Issue #249: ein AAC-LC-Frame aus dem Bitstrom lesen (src/web/aac-frame.ts).
 * Ein MP4-Sample zählt nur, wenn es genau ein Frame ist; weiter geht nur sein
 * Kanal-Element mit der Ende-Kennung. Die Frames hier sind von Hand aus Bits
 * gebaut, echte Aufnahmen prüft tests/web-audio-duration.test.ts.
 */

import { describe, expect, test } from "bun:test";
import { aacFrame, type AacConfig } from "../src/web/aac-frame";
import { AAC_SILENT_FRAME } from "./speech-fixture";

const clean = (...parts: string[]) => parts.join("").replace(/\s/g, "");
/** Bits als Text ("0" und "1", Leerzeichen nur zur Gliederung) zu Bytes, am Ende mit Nullen aufgefüllt */
function bits(...parts: string[]): Uint8Array {
  const text = clean(...parts);
  const out = new Uint8Array(Math.ceil(text.length / 8));
  [...text].forEach((c, i) => {
    if (c === "1") out[i >> 3] |= 0x80 >> (i & 7);
  });
  return out;
}
const bin = (value: number, width: number) => value.toString(2).padStart(width, "0");

/** 48 kHz: Bänder im langen Fenster ab 0, 4, 8, 12, im kurzen ebenso */
const MONO: AacConfig = { rateIndex: 3, channels: 1 };
const STEREO: AacConfig = { rateIndex: 3, channels: 2 };

/** Kennung und element_instance_tag */
const SCE = "000 0000";
const CPE = "001 0000";
const END = "111";
const GAIN = "10001100";
/** ics_info im langen Fenster: reserviertes Bit, Fensterfolge, Fensterform, max_sfb, Vorhersage */
const LONG = (maxSfb: number) => `0 00 0 ${bin(maxSfb, 6)} 0`;
/** ics_info im kurzen Fenster: max_sfb und Gruppierung (lauter Einsen: eine Gruppe aus acht Fenstern) */
const SHORT = (maxSfb: number, grouping = "1111111") => `0 10 0 ${bin(maxSfb, 4)} ${grouping}`;
/** Pulse, TNS, Verstärkungsregelung: alle aus */
const OFF = "0 0 0";
/** Füllelement mit so vielen Bytes (Bitmuster 10100101) */
const FIL = (count: number, payload = "10100101".repeat(count)) => (count < 15 ? `110 ${bin(count, 4)}` : `110 1111 ${bin(count - 14, 8)}`) + payload;

/** Zwei Bänder mit Codebuch 1 (je ein Vierer aus Nullen), Skalenfaktoren ohne Änderung */
const TWO_BANDS = clean(GAIN, LONG(2), "0001 00010", "0 0", OFF, "0 0");
const PLAIN = clean(SCE, TWO_BANDS);

const read = (sample: Uint8Array, config: AacConfig = MONO) => aacFrame(sample, 0, sample.length, config);
const hex = (b: Uint8Array | null) => (b ? Buffer.from(b).toString("hex") : null);

describe("aacFrame: ein Sample ist genau ein Frame", () => {
  test("Stille und ein Frame mit Spektralwerten: heraus kommt das Kanal-Element mit der Ende-Kennung", () => {
    const silent = new Uint8Array(AAC_SILENT_FRAME);
    expect(hex(read(silent))).toBe(hex(silent));
    expect(hex(read(bits(PLAIN, END)))).toBe(hex(bits(PLAIN, END)));
    // Was hinter der Ende-Kennung im letzten Byte steht, geht nicht weiter
    expect(hex(read(bits(PLAIN, END, "1")))).toBe(hex(bits(PLAIN, END)));
  });

  test("zwei Frames in einem Sample: kein einzelner Frame (Regression Runde 5)", () => {
    const silent = new Uint8Array(AAC_SILENT_FRAME);
    expect(read(new Uint8Array([...silent, ...silent]))).toBeNull();
    expect(read(new Uint8Array([...bits(PLAIN, END), ...silent]))).toBeNull();
    // Auch ein einzelnes Byte hinter dem Frame, Null oder nicht
    expect(read(new Uint8Array([...silent, 0]))).toBeNull();
    expect(read(new Uint8Array([...silent, 0xff]))).toBeNull();
  });

  test("gelesen wird nur das Sample: was dahinter in der Datei steht, gehört nicht dazu", () => {
    const frame = bits(PLAIN, END);
    const file = new Uint8Array([0xff, 0xff, ...frame, 0xff, 0xff]);
    expect(hex(aacFrame(file, 2, frame.length, MONO))).toBe(hex(frame));
    // Ein Byte zu kurz: die Ende-Kennung läge hinter dem Sample
    expect(aacFrame(file, 2, frame.length - 1, MONO)).toBeNull();
    expect(aacFrame(file, 2, 0, MONO)).toBeNull();
  });

  test("Füll- und Datenelemente bleiben zurück, auch wenn ein ganzer zweiter Frame darin steckt", () => {
    const expected = hex(bits(PLAIN, END));
    expect(hex(read(bits(FIL(2), PLAIN, END)))).toBe(expected);
    expect(hex(read(bits(PLAIN, FIL(3), END)))).toBe(expected);
    expect(hex(read(bits(FIL(0), PLAIN, FIL(14), FIL(15), FIL(40), END)))).toBe(expected);
    // Ein Füllelement, dessen vier Bytes ein vollständiger Frame sind: gezählt und weitergereicht wird einer
    const hidden = [...AAC_SILENT_FRAME].map(b => bin(b, 8)).join("");
    expect(hex(read(bits(PLAIN, FIL(4, hidden), END)))).toBe(expected);
    // Datenelement: Kennung, Ausrichtung auf die Byte-Grenze, Anzahl, Bytes
    const dse = (before: string, count: number) => {
      const head = clean(before, "100 0000 1", count < 255 ? bin(count, 8) : bin(255, 8) + bin(count - 255, 8));
      return head + "0".repeat((8 - (head.length % 8)) % 8) + "11000011".repeat(count);
    };
    expect(hex(read(bits(dse(PLAIN, 3), END)))).toBe(expected);
    expect(hex(read(bits(dse(PLAIN, 300), END)))).toBe(expected);
    expect(hex(read(bits(dse("", 5), PLAIN, END)))).toBe(expected);
    // Ohne Ausrichtung folgen die Bytes unmittelbar
    expect(hex(read(bits(PLAIN, "100 0000 0", bin(2, 8), "11000011".repeat(2), END)))).toBe(expected);
    // Ein Füllelement, das über das Sample hinausreicht
    expect(read(bits(PLAIN, "110 0101", "10100101".repeat(2)))).toBeNull();
  });

  test("Werkzeuge im langen Fenster: Pulse, TNS, Vorzeichen-Bits, Escape-Folgen, Rauschen und Intensität", () => {
    const accept = (...element: string[]) => expect(hex(read(bits(...element, END)))).toBe(hex(bits(...element, END)));
    // Pulse: zwei Pulse ab Band 0, je Versatz (5 Bit) und Betrag (4 Bit)
    accept(SCE, GAIN, LONG(2), "0001 00010", "0 0", "1 01 000000 00001 0001 00010 0001", "0 0", "0 0");
    // TNS: ein Filter der Ordnung 2 mit Koeffizienten zu 4 Bit, und einer der Ordnung 0 (ohne Richtung und Koeffizienten)
    accept(SCE, GAIN, LONG(2), "0001 00010", "0 0", "0", "1 01 1 000100 00010 0 0 0001 0010", "0", "0 0");
    accept(SCE, GAIN, LONG(2), "0001 00010", "0 0", "0", "1 01 1 000100 00000", "0", "0 0");
    // Codebuch 3 (ohne Vorzeichen): der Vierer 0, 0, 0, 1 trägt ein Vorzeichen-Bit
    accept(SCE, GAIN, LONG(1), "0011 00001", "0", OFF, "1001 1");
    // Codebuch 11: das Paar 16, 16 trägt zwei Vorzeichen-Bits und zwei Escape-Folgen (N Einsen, Null, N + 4 Bit)
    accept(SCE, GAIN, LONG(1), "1011 00001", "0", OFF, "00100 0 1", "0 0000", "110 000001", "0000");
    // Acht Einsen sind die längste Escape-Folge, neun sind ungültig
    accept(SCE, GAIN, LONG(1), "1011 00001", "0", OFF, "00100 0 1", "111111110 000000000001", "0 0000", "0000");
    expect(read(bits(SCE, GAIN, LONG(1), "1011 00001", "0", OFF, "00100 0 1", "1111111110 0000000000001", "0 0000", "0000", END))).toBeNull();
    // Rauschen (Codebuch 13): die erste Energie mit 9 Bit im Klartext, die zweite als Codewort; Intensität (14 und 15): ein Codewort, keine Spektralwerte
    accept(SCE, GAIN, LONG(4), "1101 00010", "1110 00001", "1111 00001", "100000000 0", "100", "1010", OFF);
    // Ein Abschnitt, dessen Länge über die Escape-Stufe (31) geht: 31 + 9 Bänder ohne Werte
    accept(SCE, GAIN, LONG(40), "0000 11111 01001", OFF);
    // Skalenfaktor mit dem längsten Codewort (19 Bit)
    accept(SCE, GAIN, LONG(1), "0001 00001", "1111111111111110011", OFF, "0");
  });

  test("kurze Fenster: Abschnitte mit 3 Bit Länge je Gruppe, Spektralwerte über alle Fenster der Gruppe", () => {
    const accept = (...element: string[]) => expect(hex(read(bits(...element, END)))).toBe(hex(bits(...element, END)));
    // Eine Gruppe aus acht Fenstern: ein Band von 4 Werten mal 8 Fenster sind acht Vierer
    accept(SCE, GAIN, SHORT(1), "0001 001", "0", OFF, "0".repeat(8));
    // Acht Gruppen: je Gruppe ein Abschnitt, ein Skalenfaktor, ein Vierer
    accept(SCE, GAIN, SHORT(1, "0000000"), "0001 001".repeat(8), "0".repeat(8), OFF, "0".repeat(8));
    // Gruppen aus 3, 1 und 4 Fenstern: 3 + 1 + 4 Vierer
    accept(SCE, GAIN, SHORT(1, "1100111"), "0001 001".repeat(3), "000", OFF, "0".repeat(8));
    // TNS im kurzen Fenster: je Fenster ein Bit für die Filterzahl; ein Filter der Ordnung 1 im ersten Fenster
    accept(SCE, GAIN, SHORT(1), "0001 001", "0", "0", "1 1 1 0100 001 0 0 0001 0000000", "0", "0".repeat(8));
    // Pulse gibt es im kurzen Fenster nicht
    expect(read(bits(SCE, GAIN, SHORT(1), "0001 001", "0", "1 00 000000 00001 0001", "0 0", "0".repeat(8), END))).toBeNull();
    // Mehr Bänder, als das kurze Fenster bei 48 kHz hat (14)
    expect(read(bits(SCE, GAIN, SHORT(15), "0000 111 111 001", OFF, END))).toBeNull();
    expect(hex(read(bits(SCE, GAIN, SHORT(14), "0000 111 111 000", OFF, END)))).not.toBeNull();
  });

  test("zwei Kanäle: Kanalpaar mit gemeinsamem Fensteraufbau und Mitte/Seite-Maske, oder mit eigenem je Kanal", () => {
    const channel = clean(GAIN, "0001 00010", "0 0", OFF, "0 0");
    const accept = (...element: string[]) => expect(hex(read(bits(...element, END), STEREO))).toBe(hex(bits(...element, END)));
    // Maske 1: ein Bit je Band; Maske 0 und 2: keine Bits
    accept(CPE, "1", LONG(2), "01", "1 0", channel, channel);
    accept(CPE, "1", LONG(2), "00", channel, channel);
    accept(CPE, "1", LONG(2), "10", channel, channel);
    // Im kurzen Fenster mit acht Gruppen: acht mal ein Band
    const short = clean(GAIN, "0001 001".repeat(8), "0".repeat(8), OFF, "0".repeat(8));
    accept(CPE, "1", SHORT(1, "0000000"), "01", "10101010", short, short);
    // Ohne gemeinsames Fenster bringt jeder Kanal seinen Aufbau mit
    accept(CPE, "0", TWO_BANDS, clean(GAIN, SHORT(1), "0001 001", "0", OFF, "0".repeat(8)));
    // Maske 3 ist reserviert
    expect(read(bits(CPE, "1", LONG(2), "11", channel, channel, END), STEREO)).toBeNull();
    // Das Element muss zur Kanalzahl passen
    expect(read(bits(CPE, "1", LONG(2), "00", channel, channel, END), MONO)).toBeNull();
    expect(read(bits(PLAIN, END), STEREO)).toBeNull();
  });

  test("nicht bestimmbar: alles außerhalb der engen AAC-LC-Syntax", () => {
    const reject = (...parts: string[]) => expect(read(bits(...parts))).toBeNull();
    // Kein Kanal-Element, zwei Kanal-Elemente
    reject(END);
    reject(FIL(3), END);
    reject(PLAIN, PLAIN, END);
    // Koppel-, LFE- und Programm-Element
    for (const id of ["010", "011", "101"]) reject(PLAIN, id, "0000", "0".repeat(64), END);
    reject("011 0000", TWO_BANDS, END);
    // Reserviertes Bit gesetzt, Vorhersage, Verstärkungsregelung
    reject(SCE, GAIN, "1 00 0 000010 0", "0001 00010", "0 0", OFF, "0 0", END);
    reject(SCE, GAIN, "0 00 0 000010 1", "0001 00010", "0 0", OFF, "0 0", END);
    reject(SCE, GAIN, LONG(2), "0001 00010", "0 0", "0 0 1", "0 0", END);
    // Codebuch 12 ist reserviert
    reject(SCE, GAIN, LONG(2), "1100 00010", "0 0", OFF, END);
    // Ein Abschnitt reicht über die Bänder hinaus; mehr Bänder, als das lange Fenster bei 48 kHz hat (49)
    reject(SCE, GAIN, LONG(2), "0001 00011", "0 0 0", OFF, "0 0 0", END);
    reject(SCE, GAIN, LONG(50), "0000 11111 10011", OFF, END);
    expect(read(bits(SCE, GAIN, LONG(49), "0000 11111 10010", OFF, END))).not.toBeNull();
    // Ohne Ende-Kennung: das Sample hört mitten im Frame auf
    reject(PLAIN);
    reject(SCE, GAIN, LONG(2), "0001 00010", "0 0", OFF, "0");
    // Die Ende-Kennung steht nicht im letzten Byte
    reject(PLAIN, END, "00000000 00000000");
  });

  test("die Bänder hängen von der Abtastrate ab: dieselben Bits sind bei 8 kHz ein anderer Frame", () => {
    // Bei 48 kHz ist das erste Band 4 Werte breit (ein Vierer), bei 8 kHz 12 (drei Vierer)
    const one = clean(SCE, GAIN, LONG(1), "0001 00001", "0", OFF, "0");
    const three = clean(SCE, GAIN, LONG(1), "0001 00001", "0", OFF, "000");
    expect(read(bits(one, END))).not.toBeNull();
    expect(read(bits(three, END))).toBeNull();
    expect(read(bits(three, END), { rateIndex: 11, channels: 1 })).not.toBeNull();
    expect(read(bits(one, END), { rateIndex: 11, channels: 1 })).toBeNull();
  });
});
