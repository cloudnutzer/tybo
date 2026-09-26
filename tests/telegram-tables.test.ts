import { test, expect } from "bun:test";
import {
  convertTablesToLists,
  asciiTableToList,
  markdownToTelegramHTML,
  TELEGRAM_FORMAT_RULES,
} from "../src/lib/telegram";

const powerbankTable = `Ich habe den Bestand geprüft.

| Händler | Preis | Bestand | Rückgabe |
|---|---|---|---|
| **amble & strut** (NL, EU-Shop) | 64,95 € | alle Farben lieferbar | 30 Tage |
| **Galaxus.de** | 69,90 € | mehr als 10 Stück | 30 Tage |

Meine Empfehlung: amble & strut.`;

test("multi-column table becomes bold heading + label lines", () => {
  const out = convertTablesToLists(powerbankTable);
  expect(out).toBe(`Ich habe den Bestand geprüft.

**amble & strut (NL, EU-Shop)**
- Preis: 64,95 €
- Bestand: alle Farben lieferbar
- Rückgabe: 30 Tage

**Galaxus.de**
- Preis: 69,90 €
- Bestand: mehr als 10 Stück
- Rückgabe: 30 Tage

Meine Empfehlung: amble & strut.`);
});

test("two-column table becomes bold key: value bullets", () => {
  const out = convertTablesToLists(`| Merkmal | Wert |\n| :--- | ---: |\n| Gewicht | 41 kg |\n| Rollen | keine |`);
  expect(out).toBe(`- **Gewicht**: 41 kg\n- **Rollen**: keine`);
});

test("tables without outer pipes, escaped pipes and empty cells", () => {
  const out = convertTablesToLists(`Modell | Kabellos | Kabel\n--|--|--\nBPD004 | 7,5 W | a \\| b\nBPD006 | 15 W |`);
  expect(out).toBe(`**BPD004**\n- Kabellos: 7,5 W\n- Kabel: a | b\n\n**BPD006**\n- Kabellos: 15 W`);
});

test("empty first header (comparison matrix) still labels columns", () => {
  const out = convertTablesToLists(`| | Belkin | BMX |\n|---|---|---|\n| Leistung | 15 W | 15 W |`);
  expect(out).toBe(`**Leistung**\n- Belkin: 15 W\n- BMX: 15 W`);
});

test("prose with a pipe but no separator row is left alone", () => {
  const text = "Entweder A | oder B\nund weiter im Text";
  expect(convertTablesToLists(text)).toBe(text);
});

test("ascii and box-drawn tables in plain code fences are converted", () => {
  const ascii = `+--------+-------+\n| Name   | Preis |\n+--------+-------+\n| Alpha  | 10 €  |\n| Beta   | 20 €  |\n+--------+-------+`;
  expect(asciiTableToList(ascii)).toBe(`- **Alpha**: 10 €\n- **Beta**: 20 €`);

  const box = `┌───────┬──────┬───────┐\n│ Modell │ Watt │ Preis │\n├───────┼──────┼───────┤\n│ BPD004 │ 7,5  │ 30 €  │\n└───────┴──────┴───────┘`;
  expect(asciiTableToList(box)).toBe(`**BPD004**\n- Watt: 7,5\n- Preis: 30 €`);
});

test("real code in fences is never mistaken for a table", () => {
  expect(asciiTableToList(`cat foo.txt | grep bar\necho done`)).toBeNull();
  expect(asciiTableToList(`a | b`)).toBeNull();
  const html = markdownToTelegramHTML("```ts\nconst x = a | b;\n// ---\n```");
  expect(html).toContain("<pre><code");
  expect(html).toContain("a | b");
});

test("full pipeline: no raw pipes reach Telegram, headings are bold", () => {
  const html = markdownToTelegramHTML(powerbankTable);
  expect(html).not.toContain("|");
  expect(html).toContain("<b>amble &amp; strut (NL, EU-Shop)</b>");
  expect(html).toContain("- Preis: 64,95 €");

  const fenced = markdownToTelegramHTML("Vergleich:\n```\n| A | B |\n|---|---|\n| 1 | 2 |\n```\nEnde");
  expect(fenced).toBe("Vergleich:\n- <b>1</b>: 2\nEnde");
});

test("inline code containing a pipe is protected before table detection", () => {
  const html = markdownToTelegramHTML("Nutze `a | b` hier\n---\nfertig");
  expect(html).toContain("<code>a | b</code>");
});

test("format rule is part of every system prompt source", async () => {
  const { BASE_CONTEXT } = await import("../src/agents/base");
  expect(BASE_CONTEXT).toContain(TELEGRAM_FORMAT_RULES);
  expect(TELEGRAM_FORMAT_RULES).toMatch(/NEVER use tables/);
});
