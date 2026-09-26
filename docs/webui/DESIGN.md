# WebUI: Design

Das vollständige, verbindliche Design der WebUI steht in
[`src/web/DESIGN.md`](../../src/web/DESIGN.md): Farben (hell und dunkel),
Schrift, Abstände, Komponenten, Bewegung, Do's and Don'ts sowie Vorgaben für
M2 und M3. Es liegt neben dem Code, weil der Design-Skill (impeccable) es dort
erwartet; die Produktwahrheit dazu steht in
[`src/web/PRODUCT.md`](../../src/web/PRODUCT.md).

Diese Datei ist nur der Einstieg. Änderungen am Design gehören nach
`src/web/DESIGN.md`, nicht hierher.

Kurzfassung:

- Aufbau vertraut wie ChatGPT und Telegram Desktop: Seitenleiste links
  (am Handy Schublade), Chat als Lesespalte, Eingabe unten.
- Neutrales Grau, ein ruhiges Blau als einzige Akzentfarbe, Agentenfarben nur
  als Punkt neben dem Agentennamen. Hell und dunkel nach Geräteeinstellung, in der Seitenleiste umschaltbar (System / Hell / Dunkel).
- Bewegung nur zweimal: neue Nachrichten blenden ein, die Schublade gleitet.
  Bei `prefers-reduced-motion: reduce` keine Bewegung.
- Screenshots: `docs/webui/screenshots/`, erzeugt mit
  `bun run scripts/web-browser-check.ts --screenshots`.
