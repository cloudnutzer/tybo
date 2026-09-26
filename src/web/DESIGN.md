---
name: tybo WebUI
description: Browser-Zugang zu tybo, vertraut wie ChatGPT und Telegram Desktop, ruhig, hell und dunkel nach Geräteeinstellung oder eigener Wahl.
colors:
  accent: "#1f6fd6"
  accent-ink: "#ffffff"
  bg: "#ffffff"
  sidebar: "#f5f6f8"
  raised: "#ffffff"
  ink: "#1a1c20"
  muted: "#5c626c"
  placeholder: "#6b717b"
  line: "#e4e6ea"
  hover: "#eceef1"
  active: "#e2e9f5"
  bubble: "#e8effb"
  bubble-ink: "#14233a"
  code: "#f4f5f7"
  error: "#b42318"
  error-bg: "#fdf1f0"
  error-line: "#f3c9c4"
  agent-general: "#cf6a2e"
  agent-research: "#0f8b7f"
  agent-cto: "#7357c6"
  agent-coo: "#9a7a14"
  agent-finance: "#3b8540"
  agent-strategy: "#b0409f"
  agent-content: "#0e7490"
  agent-critic: "#c0392b"
  accent-dark: "#5b9bf0"
  accent-ink-dark: "#0d1726"
  bg-dark: "#1f2023"
  sidebar-dark: "#18191b"
  raised-dark: "#27292d"
  ink-dark: "#e7e8eb"
  muted-dark: "#a2a7b0"
  placeholder-dark: "#8c929c"
  line-dark: "#303237"
  hover-dark: "#2a2c30"
  active-dark: "#25324a"
  bubble-dark: "#283548"
  bubble-ink-dark: "#e6eefb"
  code-dark: "#17181a"
  error-dark: "#f2877d"
  error-bg-dark: "#3a2220"
  error-line-dark: "#5a302c"
  agent-general-dark: "#f0a070"
  agent-research-dark: "#3cc2b3"
  agent-cto-dark: "#a28cf0"
  agent-coo-dark: "#d8b64a"
  agent-finance-dark: "#74c07a"
  agent-strategy-dark: "#e08ad4"
  agent-content-dark: "#4cc3dc"
  agent-critic-dark: "#ef7b6f"
typography:
  headline:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"SF Pro Text\", \"Segoe UI\", system-ui, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 600
    lineHeight: 1.5
    letterSpacing: "-0.01em"
  title:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"SF Pro Text\", \"Segoe UI\", system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 600
    lineHeight: 1.5
  content-h1:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"SF Pro Text\", \"Segoe UI\", system-ui, sans-serif"
    fontSize: "1.375rem"
    lineHeight: 1.3
    letterSpacing: "-0.01em"
  content-h2:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"SF Pro Text\", \"Segoe UI\", system-ui, sans-serif"
    fontSize: "1.1875rem"
    lineHeight: 1.3
    letterSpacing: "-0.01em"
  content-h3:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"SF Pro Text\", \"Segoe UI\", system-ui, sans-serif"
    fontSize: "1.0625rem"
    lineHeight: 1.3
    letterSpacing: "-0.01em"
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"SF Pro Text\", \"Segoe UI\", system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.5
  body-reading:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"SF Pro Text\", \"Segoe UI\", system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.65
  body-small:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"SF Pro Text\", \"Segoe UI\", system-ui, sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"SF Pro Text\", \"Segoe UI\", system-ui, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 600
    lineHeight: 1.5
  meta:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"SF Pro Text\", \"Segoe UI\", system-ui, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: 1.5
  wordmark:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"SF Pro Text\", \"Segoe UI\", system-ui, sans-serif"
    fontSize: "1.0625rem"
    fontWeight: 700
    letterSpacing: "-0.01em"
  mono:
    fontFamily: "ui-monospace, \"SF Mono\", SFMono-Regular, Menlo, Consolas, monospace"
    fontSize: "0.875em"
    lineHeight: 1.5
rounded:
  code: "0.3rem"
  sm: "0.6rem"
  md: "0.75rem"
  bubble: "1.15rem"
  composer: "1.5rem"
  pill: "999px"
  round: "50%"
spacing:
  xs: "0.25rem"
  sm: "0.5rem"
  md: "0.75rem"
  lg: "1rem"
  xl: "1.5rem"
  message-gap: "1.75rem"
  column: "47.5rem"
  sidebar-width: "17.5rem"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-ink}"
    typography: "{typography.title}"
    rounded: "{rounded.md}"
    padding: "0.75rem 1rem"
  button-send:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-ink}"
    rounded: "{rounded.round}"
    size: "2.25rem"
  button-send-disabled:
    backgroundColor: "{colors.hover}"
    textColor: "{colors.placeholder}"
    rounded: "{rounded.round}"
    size: "2.25rem"
  button-stop:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.bg}"
    rounded: "{rounded.round}"
    size: "2.25rem"
  button-new-chat:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.ink}"
    typography: "{typography.body-small}"
    rounded: "{rounded.sm}"
    padding: "0.6rem 0.65rem"
  button-quiet:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    typography: "{typography.body-small}"
    rounded: "{rounded.sm}"
    padding: "0.55rem 0.6rem"
  button-quiet-hover:
    backgroundColor: "{colors.hover}"
    textColor: "{colors.ink}"
  button-choice-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-ink}"
    typography: "{typography.body-small}"
    rounded: "{rounded.sm}"
    padding: "0.55rem 0.6rem"
  button-icon:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    rounded: "{rounded.sm}"
    size: "2.5rem"
  input-text:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "0.75rem 0.9rem"
  composer-box:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.composer}"
    padding: "0.35rem 0.35rem 0.35rem 1rem"
  conversation-item:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    typography: "{typography.body-small}"
    rounded: "{rounded.sm}"
    padding: "0.5rem 0.6rem"
  conversation-item-hover:
    backgroundColor: "{colors.hover}"
  conversation-item-active:
    backgroundColor: "{colors.active}"
  agent-chip:
    backgroundColor: "{colors.hover}"
    textColor: "{colors.muted}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "0.15rem 0.6rem 0.15rem 0.5rem"
  bubble-user:
    backgroundColor: "{colors.bubble}"
    textColor: "{colors.bubble-ink}"
    typography: "{typography.body}"
    rounded: "{rounded.bubble}"
    padding: "0.6rem 0.95rem"
  message-error:
    backgroundColor: "{colors.error-bg}"
    textColor: "{colors.error}"
    rounded: "{rounded.md}"
    padding: "0.6rem 0.9rem"
  message-note:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    rounded: "{rounded.pill}"
    padding: "0.3rem 0.75rem"
  activity-line:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    rounded: "{rounded.pill}"
    padding: "0.35rem 0.7rem 0.35rem 0.6rem"
  code-block:
    backgroundColor: "{colors.code}"
    textColor: "{colors.ink}"
    typography: "{typography.mono}"
    rounded: "{rounded.md}"
    padding: "0.8rem 1rem"
---

# Design System: tybo WebUI

## Overview

**Creative North Star: "Der vertraute Schreibtisch"**

Die WebUI sieht absichtlich aus wie ein Werkzeug, das man schon kennt: links die Gesprächsliste wie in Telegram Desktop, rechts der Chat wie in ChatGPT. Das System verweigert eine eigene Effekt-Welt. Es besteht aus neutralem Grau, einer einzigen ruhigen blauen Akzentfarbe, der Systemschrift des Geräts, feinen 1-px-Linien und einer runden Eingabebox. Der Dunkelmodus ist ein gleichwertiges Anthrazit, kein invertiertes Hell; standardmäßig folgen beide Modi `prefers-color-scheme`, der Schalter System / Hell / Dunkel in der Seitenleiste legt einen Modus pro Browser fest.

Charakter trägt nur, was Information trägt: die Agentenfarben (ein Punkt pro Agent), die einklappbare Statuszeile eines laufenden Turns und kleine Details wie der Senden-Knopf, der zum Stopp wird. Die Dichte ist die eines Chat-Werkzeugs, nicht die einer Landingpage: 16 px Grundschrift, eine Lesespalte von 760 px, großzügige 1.75rem Abstand zwischen Nachrichten, sonst kompakt.

Bewegung gibt es genau zweimal: Nachrichten blenden ein, die Schublade gleitet. Alles andere (Chevron, Hover, Senden/Stopp) wechselt sofort ohne Übergang. Unter `prefers-reduced-motion: reduce` entfallen auch die beiden Bewegungen.

**Key Characteristics:**
- Eine Akzentfarbe (ruhiges Blau), alles andere neutral grau bzw. anthrazit
- Agentenfarben als einziger Farbcharakter, immer als 0.5rem-Punkt neben dem Namen
- Systemschrift, keine Webfonts, kein Display-Schnitt
- Flach: Tiefe über Tonflächen und 1-px-Linien, nur zwei Schatten im ganzen System
- Hell und dunkel vollwertig, Standard nach Geräteeinstellung, im Seitenleisten-Fuß umschaltbar
- Zustand sichtbar: Statuszeile, Verbindungsbalken, Senden/Stopp am selben Ort

## Colors

Neutrales Grau mit einem einzigen ruhigen Blau als Handlungsfarbe; die acht Agentenfarben sind Kennzeichen, keine Dekoration. Jeder Farbtoken existiert zweimal (hell und `-dark`); im Code heißen sie gleich. Die dunklen Werte stehen in `style.css` zweimal: auf `:root[data-theme="dark"]` (Wahl „Dunkel") und im `@media (prefers-color-scheme: dark)`-Block auf `:root:not([data-theme="light"])` (System dunkel, solange nicht „Hell" gewählt ist). `tests/web-theme-css.test.ts` prüft, dass beide Blöcke gleich sind; neue dunkle Werte gehören in beide. `data-theme` setzt `public/theme.js` im `<head>` vor dem ersten Zeichnen, samt `color-scheme` und `theme-color`.

### Primary
- **Ruhiges Arbeitsblau** (accent / accent-dark): Primärknopf beim Login, Senden-Knopf, Fokusring (2 px, Abstand 2 px), Links, Textcursor, Punkt der Statuszeile, Textauswahl (24 % gemischt) und der Rahmen der Eingabebox bei Fokus (55 % in die Linienfarbe gemischt). Text darauf ist `accent-ink`: weiß im Hellen, fast schwarzes Blau im Dunkeln.

### Secondary
- **Agentenpalette** (agent-general Orange, agent-research Petrol, agent-cto Violett, agent-coo Ocker, agent-finance Grün, agent-strategy Magenta, agent-content Cyan, agent-critic Rot; jeweils mit aufgehellter `-dark`-Variante): kennzeichnet, welcher Agent spricht bzw. ein Gespräch besitzt. Zugeordnet über das Attribut `data-agent`, das die Variable `--agent` setzt; unbekannte Agenten fallen auf General zurück, fehlt `--agent` ganz, auf `muted`.

### Neutral
- **Papierweiß / Anthrazit** (bg / bg-dark): Hauptfläche mit Verlauf und Kopfzeile. Auch `theme-color` der Browserleiste (bei System je nach Media-Abfrage, bei fester Wahl beide Tags auf denselben Wert).
- **Leisegrau der Seitenleiste** (sidebar / sidebar-dark): eine Stufe vom Hauptbereich abgesetzt; im Dunkeln dunkler als der Hauptbereich.
- **Erhabene Fläche** (raised / raised-dark): Eingabebox, Passwortfeld, Knopf "Neues Gespräch".
- **Tinte** (ink / ink-dark): Fließtext, Titel; zugleich Fläche des Stopp-Knopfs.
- **Gedämpft** (muted / muted-dark): Agentennamen, Metazeilen, Gruppenlabels, Icons in Ruhe, Statuszeile, Fortschrittsliste, Tabellenkopf-Linie.
- **Platzhalter** (placeholder / placeholder-dark): nur Platzhaltertext und das Pfeil-Icon des deaktivierten Senden-Knopfs.
- **Haarlinie** (line / line-dark): alle Trennlinien und Rahmen, 1 px.
- **Schwebeton** (hover / hover-dark): Hover-Fläche, außerdem Hintergrund von Agent-Chip, Verbindungsbalken, Hinweis-Schritt und deaktiviertem Senden.
- **Auswahlblau** (active / active-dark): nur das aktuell geöffnete Gespräch in der Liste.
- **Blasenblau** (bubble, bubble-ink und ihre `-dark`-Varianten): ausschließlich die Nutzerblase.
- **Codegrau** (code / code-dark): Inline-Code, Codeblöcke, Zitate.
- **Fehlerrot** (error, error-bg, error-line und `-dark`): Fehlernachricht im Verlauf und Login-Fehlertext, Meldungen im Menü. Einzige Fläche in Rot: der Knopf „Endgültig löschen" für Topics (Issue #30). Einziger roter Punkt: die laufende Sprachaufnahme (Issue #109). Nie für den Stopp auf eigenen Wunsch.

### Named Rules
**Die Eine-Stimme-Regel.** Blau heißt "hier handelst du" oder "hier ist Fokus". Keine blauen Flächen, Überschriften oder Dekorationen; die einzige blaue Fläche in Ruhe ist der Senden-Knopf.

**Die Punkt-Regel.** Agentenfarben erscheinen nur als 0.5rem-Kreis neben einem Agentennamen (Antwortkopf, Gesprächsliste, Kopfzeilen-Chip). Der Name selbst bleibt `muted`; Agentenfarbe wird nie Textfarbe, Fläche oder Rahmen. So trägt die Farbe keine Lesbarkeitslast.

**Die Kein-Rot-für-Absicht-Regel.** Rot ist Fehlern vorbehalten. Ein vom Nutzer ausgelöster Stopp ("Abgebrochen.") wird als ruhige graue Pillen-Notiz gezeigt. Ausnahmen: das endgültige Löschen eines Telegram-Topics (Issue #30), weil es nicht umkehrbar ist, und der stehende 0.625rem-Punkt einer laufenden Sprachaufnahme (Issue #109). Rot zeigt dort ein offenes Mikrofon an, wie überall auf Geräten üblich; der Punkt steht still, er blinkt nicht und hat keine Bewegung, damit `prefers-reduced-motion` nichts abschalten muss.

## Typography

**Body Font:** Systemschrift (`-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", system-ui, sans-serif`)
**Mono Font:** `ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace`

**Character:** Die Schrift des Geräts, damit die Oberfläche sich wie eine native App anfühlt. Hierarchie entsteht über Gewicht (400, 500, 600, 650, 700) und wenige Größenstufen, nicht über eine zweite Familie.

### Hierarchy
- **Wortmarke** (700, 1.0625rem, -0.01em; auf dem Login 1.75rem): der Produktname (tybo, aus `src/brand.ts`) oben in der Seitenleiste und als Login-Überschrift. Reiner Text, kein Logo in der Oberfläche; das Zeichen von tybo.ai (dunkles Quadrat, heller Ring, oranger Punkt, im Dunkelmodus invertiert) erscheint nur als Tab-Symbol `/favicon.svg` und als Home-Bildschirm-Symbol `/apple-touch-icon.png` (180 px, randlos, exakt aus der Geometrie des Seitenkopfs von tybo.ai gerechnet).
- **Headline** (600, 1.5rem, -0.01em): nur der Leerzustand "Womit kann ich helfen?".
- **Title** (600, 1rem): Gesprächstitel in der Kopfzeile, einzeilig mit Auslassung.
- **Antwort-Überschriften** (h1 1.375rem, h2 1.1875rem, h3 1.0625rem, h4 1rem; Zeilenhöhe 1.3, -0.01em, `text-wrap: balance`): nur innerhalb gerenderter Antworten.
- **Body** (400, 1rem, 1.5): Grundschrift, Nutzerblase, Eingabe.
- **Lesetext** (400, 1rem, 1.65): Antwortinhalt; Absätze und Listen mit 0.9rem Abstand, `strong` in 650.
- **Body small** (0.9375rem): Gesprächstitel in der Liste, Seitenleisten-Knöpfe, Tabellen, Leerzustandstext.
- **Label** (600, 0.8125rem): Agentenname im Antwortkopf; der Agent-Chip nutzt dieselbe Größe in 500.
- **Meta** (0.75rem): Agentenzeile unter Gesprächstiteln; in 600 als Gruppenlabel ("Web-Gespräche").
- **Mono** (0.875em relativ): Inline-Code und Codeblöcke.

### Named Rules
**Die Lesespalten-Regel.** Lange Antworten stehen in 1.65 Zeilenhöhe in einer Spalte von höchstens 47.5rem. Tabellen nutzen `tabular-nums`; Codeblöcke und breite Tabellen scrollen in sich, nie die Seite.

## Layout

Zwei Spalten ab 56rem: feste Seitenleiste (17.5rem) links, Hauptbereich rechts mit Kopfzeile, Verlauf und Eingabe. Verlauf und Eingabebox sind auf dieselbe zentrierte Spalte (`--column`, 47.5rem) begrenzt, damit Text und Eingabe fluchten.

Unter 56rem wird die Seitenleiste zur Schublade (höchstens 86vw breit), die mit 220 ms von links gleitet und einen Scrim darüber legt. Geschlossen ist sie `visibility: hidden`, also für Tastatur und Screenreader unerreichbar. Das Menü-Icon in der Kopfzeile und das Schließen-Icon in der Schublade tragen `mobile-only` und verschwinden am Desktop.

Die Seite scrollt nie als Ganzes (`body.app` hat `100dvh` und `overflow: hidden`); nur der Verlauf und die Gesprächsliste scrollen. Safe-Area-Insets werden oben (Kopfzeile, Seitenleiste) und unten (Eingabe, Seitenleiste) respektiert.

Abstände laufen in rem auf einer lockeren Leiter: 0.25, 0.5, 0.75, 1, 1.5rem, dazu 1.75rem zwischen Nachrichten und 1.5rem vor der Statuszeile. Spaltenpolster: 1.25rem/1rem am Handy, 1.75rem/1.5rem am Desktop.

**Die Daumen-Regel.** Unter 56rem wachsen Senden, Stopp und Statuszeile auf 2.75rem Zielgröße; Icon-Knöpfe sind überall 2.5rem.

## Elevation & Depth

Das System ist flach. Tiefe entsteht über Tonflächen (Seitenleiste eine Stufe abgesetzt, `raised` für Bedienflächen) und 1-px-Haarlinien. Es gibt genau zwei Schatten: einen weichen unter der Eingabebox und einen breiten unter der geöffneten Schublade, der am Desktop entfällt.

### Shadow Vocabulary
- **Eingabe-Schwebe** (`box-shadow: 0 2px 10px rgba(20, 24, 31, 0.07)`; dunkel `0 2px 12px rgba(0, 0, 0, 0.35)`): nur die Eingabebox, als Token `--shadow`.
- **Schubladen-Schatten** (`box-shadow: 0 0 40px rgba(0, 0, 0, 0.2)`): nur die geöffnete Seitenleiste am Handy, zusammen mit dem Scrim (`--scrim`).

### Named Rules
**Die Linie-statt-Schatten-Regel.** Karten, Listen, Blasen und Knöpfe haben keinen Schatten. Wer eine Fläche absetzen will, nimmt `line`, `hover` oder `raised`.

## Shapes

Weich, aber nicht verspielt. Die Radien wachsen mit der Größe der Form: 0.3rem für Inline-Code, 0.6rem für Listeneinträge, Icon-Knöpfe, Zitate und Hinweise, 0.75rem für Felder, Primärknopf, Codeblöcke und Fehlerkästen, 1.15rem für die Nutzerblase, 1.5rem für die Eingabebox. Der Build streut diese Mittelstufe leicht (0.55rem Gesprächseintrag und leiser Knopf, 0.6rem Icon-Knopf, 0.65rem "Neues Gespräch"); normativ ist 0.6rem, neue Komponenten nehmen diesen Wert. Pillen (999px) für alles, was ein Zustand ist: Agent-Chip, Statuszeile, Stopp-Notiz. Kreise (50 %) für Senden, Stopp und alle Punkte.

Die Nutzerblase hat eine kleinere Ecke unten rechts (`1.15rem 1.15rem 0.35rem 1.15rem`), der Ansatz zeigt zum Absender. Antworten haben keine Blase und keinen Rahmen.

Icons sind inline SVG im 24er-Raster, Kontur 1.8 (in runden Knöpfen 2.2), runde Enden, 1.25rem Standardgröße, Farbe per `currentColor`. Das Stopp-Icon ist das einzige gefüllte.

## Components

### Buttons
Zurückhaltend und vertraut; nur der Handlungsknopf bekommt Farbe.
- **Primär** (Login "Anmelden"): Akzentfläche, Radius 0.75rem, 600. Hover hellt per `filter: brightness(1.08)` auf, sofort ohne Übergang; deaktiviert 60 % Deckkraft.
- **Senden / Stopp:** ein runder Knopf von 2.25rem (Handy 2.75rem) rechts in der Eingabebox. Während ein Turn läuft, wird Senden ausgeblendet und Stopp an derselben Stelle gezeigt: Tintenfläche mit gefülltem Quadrat. Wartet der Turn auf die Antwort zu einer Freigabe-Frage, stehen beide nebeneinander: Senden für die Antwort, Stopp zum Abbrechen. Senden ohne Text ist `hover`-grau mit Platzhalter-Icon.
- **Neues Gespräch:** Rahmen `line`, Fläche `raised`, Stift-Icon in `muted`, 500.
- **Leise Knöpfe** (Abmelden) und **Icon-Knöpfe** (Menü, Schließen): ohne Fläche, `muted`; Hover füllt `hover` und färbt auf `ink`.
- **Fokus:** überall derselbe 2-px-Akzentring mit 2 px Abstand (`:focus-visible`), im Passwortfeld 1 px Abstand.

### Chips
- **Agent-Chip** (Kopfzeile, neben dem Gesprächstitel): Pille in `hover`, Text `muted` 0.8125rem/500, davor der Agentenpunkt. Leer wird er ausgeblendet.

### Inputs / Fields
- **Passwortfeld:** Rahmen `line`, Fläche `raised`, Radius 0.75rem, 1rem Schrift; Fokus über den Akzentring.
- **Eingabebox:** Pillenform mit Radius 1.5rem, Rahmen `line`, Fläche `raised`, Eingabe-Schwebe. Die Textarea selbst ist randlos und wächst bis 8 Zeilen. Fokus färbt den Rahmen der Box leicht blau, kein Ring.
- **Sprachaufnahme** (Issue #109): Mikrofon als runder Knopf wie die Büroklammer (`muted`, Hover `hover`/`ink`), rechts vor Senden. Nur im sicheren Kontext (HTTPS, localhost) mit Mikrofon und MediaRecorder und nur, wo Anhänge gehen; sonst gibt es ihn nicht. Während der Aufnahme ersetzt eine Zeile Feld, Büroklammer, Mikrofon und Senden: stehender roter Punkt (0.625rem, `error`, siehe Kein-Rot-für-Absicht-Regel), „Aufnahme" in 0.875rem `muted`, die Zeit mm:ss in `ink` mit `tabular-nums`, rechts „Verwerfen" als leise Pille und „Stopp" als Pille in `ink` mit Text `bg` (wie der Stopp-Knopf). Am Handy alles 2.75rem hoch. Nach dem Stopp wird die Aufnahme ein Anhang-Chip mit Noten-Symbol, Dauer und Größe, dazu ein Icon-Knopf „Aufnahme abspielen"/„Pause" in der Größe von Entfernen. Keine Bewegung.

### Navigation
- **Seitenleiste:** Wortmarke, "Neues Gespräch", Gruppenlabel (0.75rem/600, `muted`), Gesprächsliste, unten durch eine Haarlinie abgetrennt der Darstellungs-Schalter und darunter "Abmelden".
- **Darstellungs-Schalter** (System / Hell / Dunkel): Segment-Steuerung aus drei gleich breiten Knöpfen mit Symbol (Monitor, Sonne, Mond, 1rem) und Text in 0.8125rem/500. Rahmen `line`, Radius 0.6rem, 0.125rem Innenabstand; Knöpfe Radius 0.45rem (innerer Radius passend zum Rahmen), in Ruhe `muted`, Hover `hover`/`ink`, gewählt Fläche `raised` mit Rahmen `line` und Text `ink`. Keine Akzentfarbe, keine Bewegung. `role="radiogroup"` mit Namen „Darstellung", Knöpfe `role="radio"` mit `aria-checked`; genau ein Tab-Stopp (der gewählte), Pfeiltasten wechseln Fokus und Wahl reihum, Pos1/Ende an den Rand, Leertaste wählt. Unter 56rem mindestens 2.75rem hoch. Die Wahl liegt in `localStorage["tybo-theme"]` und gilt auch auf der Login-Seite, die selbst keinen Schalter hat.
- **Gesprächseintrag:** zweizeilig, Titel 0.9375rem einzeilig mit Auslassung, darunter Agentenpunkt plus Name in 0.75rem `muted`. Hover `hover`, aktuelles Gespräch `active` mit `aria-current="true"`. 1 px Abstand zwischen Einträgen. Telegram-Einträge mit neuer Nachricht seit dem letzten Öffnen tragen `data-unread="true"` und am Ende der Meta-Zeile einen 0.5rem-Punkt in `ink` (Name „neu" für Screenreader); er verschwindet beim Öffnen. Keine Akzentfarbe, keine Zahl, keine Bewegung.
- **Kopfzeile:** min. 3.25rem, Haarlinie unten, Titel plus Agent-Chip; am Handy links das Menü-Icon.
- **Verbindungsbalken:** zentrierte 0.8125rem-Zeile in `hover` unter der Kopfzeile, nur sichtbar, wenn die Verbindung weg ist (`role="status"`).
- **Neue Version (Issue #111):** Zeile wie der Verbindungsbalken, direkt darunter bzw. unter der Kopfzeile der Einstellungen, Text in `ink`, daneben ein kleiner Knopf „Neu laden“ (0.8125rem/500, Radius 0.6rem, Fläche `accent`, Text `accent-ink`). Die Rückfrage vor dem Neuladen (Aufnahme, Upload, Anhänge, Einstellungen, nicht sicherbare Entwürfe) steht in derselben Zeile, dazu „Abbrechen“ als Knopf mit Haarlinie auf `raised`, Fokus dort. Leer unsichtbar, die `status`-Region bleibt im Dokument. Kein automatisches Neuladen, keine Animation.

### Web-Gespräche verwalten (Issue #21)
Nur aus vorhandenen Bausteinen, keine neuen Farben, keine Bewegung.
- **Agentenauswahl:** Klick auf "Neues Gespräch" klappt darunter eine Liste auf (Gruppenlabel "Mit welchem Agenten?", Einträge wie Gesprächseinträge mit Agentenpunkt und Name). Kein Dialog, am Handy in der Schublade. `role="listbox"`, Einträge `role="option"`; markiert ist General, markierter Eintrag in `hover` (nicht `active`, das bleibt dem offenen Gespräch). Pfeiltasten wandern reihum, Pos1/Ende, Enter legt an, Escape schließt.
- **Titel umbenennen:** Der Titel der Kopfzeile ist ein Knopf (Hover `hover`, Radius 0.6rem), bei Telegram-Gesprächen gesperrt und wie Text. Antippen ersetzt ihn durch ein Feld wie das Passwortfeld in Titelgröße (Rahmen `line`, `raised`); Enter speichert, Escape und Verlassen brechen ab. Ungültig: Rahmen `error-line`, Hinweis im Verbindungsbalken.
- **Menü:** Drei-Punkte-Icon-Knopf rechts in der Kopfzeile und rechts an jedem Web-Gesprächseintrag (am Desktop erst bei Hover/Fokus bzw. beim offenen Gespräch sichtbar, am Handy immer, dort 2.75rem). Das Menü der Kopfzeile ist eine flache Fläche `raised` mit Haarlinie und Radius 0.75rem rechts unter dem Knopf (kein Schatten); am Eintrag hängt es an einer Haarlinie links wie die Fortschrittsliste. Inhalt: leise Knöpfe "Umbenennen" und "Löschen".
- **Rückfrage:** "Löschen" ersetzt den Inhalt durch "Gespräch löschen?" (600, `ink`), "Löschen" (leiser Knopf in `ink`, 600) und "Abbrechen" mit Fokus. Kein Rot: Löschen ist eine Absicht, kein Fehler.

### Topics verwalten (Issue #30)
Neue Gespräche sind Telegram-Topics (Entscheidung 0005). Dafür gelten drei bewusste Ausnahmen von den übrigen Regeln, sonst nur vorhandene Bausteine, keine Bewegung.
- **Titel umbenennen** gilt auch für Topics; gesperrt und wie Text bleiben nur „General" und der Direktchat. Topic-Namen folgen Telegram (bis 128 Zeichen, Leerraum innen bleibt).
- **Menü** an Topics (Kopfzeile und Eintrag, gleiche Form wie bei Web-Gesprächen): „Umbenennen", „Schließen" bzw. „Wieder öffnen", „Löschen …". General und Direktchat haben kein Menü. Fehlt dem Bot das Recht „Nachrichten löschen" (oder ist es unbekannt), ist „Löschen …" gesperrt; darunter steht die Erklärung in 0.8125rem `muted` (`.actions-hint`, mit `aria-describedby`) und ein leiser Knopf „Rechte erneut prüfen". Meldungen des Servers stehen im Menü in 0.8125rem `error` (`.actions-error`, `role="alert"`). Die Kopfzeilen-Fläche ist höchstens 22rem breit, lange Texte brechen um.
- **Ausnahme Schloss:** Geschlossene Topics stehen unabhängig von ihrer Aktivität unter „Ältere Topics", Titel in `muted`, in der Meta-Zeile ein Schloss (0.75rem, Kontur 2.2, `role="img"`, Name „geschlossen"). Das ist das einzige Zustandssymbol an Einträgen; weitere Topic-Icons gibt es nicht. Im offenen geschlossenen Topic ist die Eingabe gesperrt, darüber ein Hinweis in 0.8125rem `muted` (`.composer-note`).
- **Ausnahme Rot:** Die Rückfrage vor dem endgültigen Löschen eines Topics nennt den Namen („Topic ‚…' in Telegram endgültig löschen?", 600), erklärt die Folgen in `muted`, hat ein Feld wie das Passwortfeld (Label „Zum Bestätigen Namen eintippen") und den Knopf „Endgültig löschen" in `error` mit Text in `bg`, Radius 0.75rem. Gesperrt (bis der Name exakt stimmt) sieht er aus wie Senden ohne Text (`hover`, `placeholder`). Das ist der einzige rote Knopf: Löschen in Telegram ist nicht umkehrbar. Die Rückfrage für ältere Web-Gespräche bleibt neutral wie oben.
- **Neue Topics** stehen, bis sie Aktivität haben, ganz oben unter „Topics" (auch nach einem Abgleich der Liste). Die Gruppe „Web-Gespräche" erscheint nur, wenn es welche gibt.
- **Leerzustand ohne Gespräch:** „Noch kein Gespräch", eine Zeile `muted`, darunter der Knopf „Neues Gespräch" (gleicher Baustein wie in der Seitenleiste, nur so breit wie sein Inhalt). Es wird nie von selbst ein Gespräch angelegt.

### Einstellungen (Issue #38)
Nur vorhandene Bausteine, keine neuen Farben, keine Bewegung.
- **Einstieg:** leiser Knopf „Einstellungen" mit Zahnrad im Seitenleisten-Fuß über dem Darstellungs-Schalter; offen mit `aria-current="page"` in `active`. Adresse `#/einstellungen/agenten`, Neuladen und Direktaufruf landen dort.
- **Ansicht:** ersetzt im Hauptbereich Kopfzeile, Verlauf und Eingabe (`.main[data-view="settings"]`), am Handy damit Vollbild. Eigene Kopfzeile mit Zurück-Pfeil (Icon-Knopf) und Titel, Inhalt in der Lesespalte.
- **Reiter:** dieselbe Segment-Steuerung wie System / Hell / Dunkel (`role="tablist"`, gewählt `raised` mit `line`). Noch nicht gebaute Reiter sind gesperrt (60 % Deckkraft).
- **Agentenzeile:** wie ein Gesprächseintrag, Punkt und Name, darunter Modell und Effort in Meta `muted`, rechts ein Chevron. Aufgeklappt hängt der Inhalt an einer Haarlinie links wie das Menü eines Eintrags.
- **Felder und Auswahl:** wie das Passwortfeld (Rahmen `line`, `raised`, Radius 0.75rem, 16 px); Auswahlfelder ohne Systempfeil, dafür ein Chevron in `muted`. Speichern ist der Primärknopf, danach „Gespeichert." in 0.8125rem `ink`. Anweisungen: nummerierte Liste, Feld, leise Knöpfe; „Alle entfernen" mit neutraler Rückfrage wie bei Web-Gesprächen.
- **Datei ungültig:** Hinweis oben im Stil der Fehlernachricht. Meldungen je Agent in `.actions-error`.
- **„Agent ändern …"** im Topic-Menü: Liste wie die Agentenauswahl beim Anlegen, der aktuelle Agent in `hover` mit „(aktuell)".

### Einstellungen: Modelle und Status (Issue #39)
Nur vorhandene Bausteine, keine neuen Farben, keine Bewegung.
- **Reiter** Modelle und Status sind frei; Pfeiltasten wechseln reihum, die Adresse folgt ohne neuen Verlaufseintrag.
- **Abschnitte** (Standard für alle Agenten, Nebenmodelle, Fallback) mit Haarlinie oben, Titel als Label, Erklärung in `.actions-hint`, eigener Primärknopf „Speichern" je Abschnitt.
- **Lange Modell-Listen** (ab 12 Einträgen): darüber ein Filterfeld im Stil des Passwortfelds, darunter die Trefferzahl in `.actions-hint`. Gefiltert wird im Browser.
- **„Nur offline (Ollama)"**: dieselbe Segment-Steuerung wie System / Hell / Dunkel mit Standard / An / Aus (`role="radiogroup"`), nur so breit wie nötig.
- **Status**: Begriff in `muted` links, Wert rechts (am Handy untereinander), Zahlen mit `tabular-nums`. Schlüssel als Liste mit Haarlinien, Name in Mono, rechts „gesetzt" in `ink` bzw. „fehlt" in `muted`; nie ein Wert.
- **„Jetzt neu starten"**: leiser Knopf, danach neutrale Rückfrage wie „Alle entfernen" (Fokus auf „Abbrechen"), kein Rot.

### Einstellungen: Agenten verwalten (Issue #51)
Nur vorhandene Farben, keine Bewegung.
- **System-Prompt** oben im aufgeklappten Agenten (über Modell und Anweisungen): Label „System-Prompt“ mit Kennzeichnung als Pille (0.75rem/500, Fläche `hover`; „Standard“ in `muted`, „Angepasst“ und „Eigener Agent“ in `ink`), darunter der Hinweis auf die frische Session. Der Text steht in einer Fläche `code` mit Haarlinie und Radius 0.6rem, höchstens 16rem hoch, scrollt in sich, Zeilenumbrüche bleiben. „Bearbeiten“ ersetzt sie durch ein Feld wie das Passwortfeld (mindestens 12rem hoch) mit Zeichenzahl, Primärknopf „Speichern“ und leisem „Abbrechen“. „Auf Standard zurücksetzen“ nur bei angepassten mitgelieferten Agenten, mit neutraler Rückfrage (Fokus auf „Abbrechen“).
- **„Bei /board dabei“**: Segment-Steuerung An/Aus wie „Nur offline“, speichert sofort; General zeigt nur einen Hinweis.
- **„Neuer Agent“**: leiser Knopf oben im Reiter, klappt ein Formular mit Kennung, Beschreibung, System-Prompt, Modell und Effort auf. Fehler stehen direkt unter dem Feld (`.actions-error`, `aria-invalid`).
- **„Agent löschen …“** unten im aufgeklappten Agenten (nicht bei General): Rückfrage nennt die Topics, die zu General wechseln, als Liste und verlangt die Kennung in einem Feld; der Knopf ist bis dahin gesperrt. Neutral wie „Alle entfernen“, kein Rot: Mitgelieferte lassen sich wiederherstellen.
- **„Gelöschte Agenten“** unter der Liste: Zeilen mit Punkt, Name und Beschreibung, rechts leiser Knopf „Wiederherstellen“.
- **Meldung nach Anlegen, Löschen, Wiederherstellen** oben im Reiter: Erfolg in 0.8125rem `ink`, Teilerfolg im Stil des Hinweises „Datei ungültig“.

### Nachrichten (Signaturkomponente)
- **Nutzer:** rechtsbündige Blase in `bubble`, höchstens 85 % bzw. 36rem breit, Text mit erhaltenen Zeilenumbrüchen.
- **Antwort:** volle Spaltenbreite, keine Blase. Darüber ein Kopf mit Agentenpunkt und Agentenname (0.8125rem/600, `muted`); im DOM steht der Kopf hinter dem Inhalt und wird per `order: -1` davor gezeigt. Inhalt ist das vom Server gerenderte Markdown im Lesetext-Stil: Codeblöcke mit Rahmen und `code`-Fläche, Zitate als `code`-Fläche in `muted`, Tabellen mit Haarlinien und dunklerer Kopflinie.
- **Fußzeile der Antwort** (Issue #22): unter dem Inhalt, im DOM hinter dem Kopf. Links ein Icon-Knopf „Antwort kopieren" (zwei Blätter, 2.5rem, am Handy 2.75rem; ein negativer Rand lässt das Symbol mit der Textkante fluchten), daneben die Metazeile „Agent · Modell · Dauer" in Meta-Größe 0.75rem und `muted`, mit `tabular-nums`. Nur was die Nachricht mitbringt; ältere Antworten ohne Angaben zeigen nur den Knopf. Nach dem Kopieren steht 2 s „Kopiert" in `ink` daneben (`role="status"`), bei Misserfolg „Kopieren nicht möglich" in `error`. Keine Bewegung, keine neue Farbe.
- **Fehler:** volle Breite, `error-bg`, Rahmen `error-line`, Text `error`, Radius 0.75rem.
- **Stopp-Notiz:** Pille mit Haarlinie, `muted`, 0.875rem.
- **Meldung** (Issue #47): Nachricht eines Dienstes (Pipeline, Briefing, Check-in, Watchdog, Watcher, Datei), keine Blase und kein Agentenkopf. Oben eine Zeile „Absender · Uhrzeit" in 0.75rem `muted`, Absender 600; unbekannte Absender erscheinen mit ihrer Kennung, ohne Angabe „Meldung". Darunter das Markdown des Servers in 0.9375rem `muted` an einer Haarlinie links (wie die Fortschrittsliste).
- **Rückfrage-Knöpfe** (Issue #115, Entscheidung 0017): unter einer Nachricht mit Rückfrage aus dem Register (Werkzeug-Freigabe, Merk-Vorschlag, „Weiter?", Topic-Zuordnung) eine umbrechende Reihe leiser Knöpfe (`button-quiet`, Abstand 0.35rem), Beschriftung aus dem Register nur als Text. Der erste Knopf trägt die Handlungsfarbe (`button-choice-primary`: Fläche `accent`, Text `accent-ink`, 500), die übrigen bleiben leise; kein Rot, auch nicht für „Ablehnen". Mindestens 2.25rem hoch, am Handy 2.75rem. Während ein Klick beim Server liegt, sind alle Knöpfe der Frage gesperrt (`aria-busy`), auch über Neuzeichnen und Gesprächswechsel hinweg. Nach der Entscheidung ersetzt eine Zeile in 0.8125rem `muted` mit `tabular-nums` die Knöpfe: „Erledigt: <Knopf> · im Browser/in Telegram/im Terminal · <Uhrzeit>" bzw. „Abgelaufen"; kommt 409, zeigt sie den gemeldeten Endzustand statt eines Fehlers. Andere Fehler stehen darunter in 0.8125rem `error` (`role="alert"`), die Knöpfe sind wieder frei. Steht die Frage in einem anderen Gespräch als ihrem eigenen (Kopie einer Web-Frage im Direktchat), gibt es keine Knöpfe, sondern die Zeile „Antwort im Gespräch, aus dem die Frage kommt." und einen leisen Knopf „Zum Gespräch". Keine Fläche um die Reihe, kein Schatten, keine Bewegung.
- **Dateikarte** (Issue #47): höchstens 28rem breit, Rahmen `line`, Fläche `raised`, Radius 0.6rem, kein Schatten. Blatt-Icon in `muted`, Name in `ink` 0.9375rem, Größe in 0.75rem `muted`, rechts ein leiser Knopf „Herunterladen" (am Handy 2.75rem hoch). PNG, JPEG, WebP und GIF zusätzlich als Vorschau darüber (höchstens 20rem hoch, Rahmen `line`, Radius 0.6rem). Steht in der Meldung nur der Dateiname, entfällt der Text über der Karte.
- **Einblenden:** neue Nachrichten (`data-fresh`) in 180 ms von 20 % Deckkraft und 4 px tiefer.

### Statuszeile (Signaturkomponente)
Solange ein Turn läuft, steht unter dem Verlauf eine Pille mit blauem Punkt, dem jüngsten Schritt ("Datei lesen …", "Formuliert die Antwort …") und einem Chevron. Klick klappt die Fortschrittsliste auf; der Chevron steht dann sofort um 180° gedreht, ohne Übergang. Die Liste hängt an einer Haarlinie links und zeigt drei Schrittarten: Werkzeug (normal), Snippet (kursiv), Hinweis (Fläche `hover`, Text `ink`, Radius 0.6rem).

### Login
Eine zentrierte Spalte von 21rem: Wortmarke 1.75rem, eine Zeile Einleitung in `muted`, Label 0.875rem/600, Passwortfeld, Primärknopf, Fehlertext in `error`.

### Künftige Meilensteine
- **M2 Telegram-Topics in der Seitenleiste:** Topics sind weitere Gruppen in derselben Liste. Gruppenlabel wie "Web-Gespräche" (Meta 600, `muted`), Einträge als Gesprächseintrag mit Agentenpunkt über `data-agent`, aktuelles Topic in `active` mit `aria-current`. Keine neuen Icons pro Topic, keine farbigen Flächen; ungelesene oder synchrone Zustände als leiser `muted`-Text oder mit dem bestehenden Punktformat. Die Schublade am Handy bleibt dieselbe.
- **M3 Einstellungen:** im Hauptbereich mit Kopfzeile und derselben Lesespalte (`--column`). Felder wie das Passwortfeld (Rahmen `line`, `raised`, Radius 0.75rem), Speichern als Primärknopf, Nebenaktionen als leise Knöpfe, Abschnittstrenner als Haarlinie, Fehler im Fehlerstil. Einstieg aus dem Seitenleisten-Fuß als leiser Knopf neben "Abmelden"; der Darstellungs-Schalter bleibt dort und wandert nicht in die Einstellungen. Agentenfarben nur als Punkt neben Agentennamen, keine neuen Akzentfarben.

## Do's and Don'ts

### Do:
- **Do** jede Farbe über die Custom Properties auf `:root` beziehen und für jeden neuen Token sofort einen Wert im Dunkel-Block setzen.
- **Do** Agentenzugehörigkeit über `data-agent` plus 0.5rem-Punkt zeigen und den Namen in `muted` daneben setzen.
- **Do** laufende Arbeit über die Statuszeile und Senden/Stopp am selben Ort sichtbar machen.
- **Do** neue Bedienziele am Handy auf mindestens 2.75rem bringen und Safe-Area-Insets respektieren.
- **Do** Zustandswechsel (Hover, Aufklappen, Senden/Stopp) sofort umschalten; die beiden Bewegungen liegen auf der Kurve `--ease` (`cubic-bezier(0.2, 0.7, 0.2, 1)`) und stehen im `prefers-reduced-motion`-Block.
- **Do** Icons als inline SVG mit `currentColor`, Kontur 1.8 und runden Enden zeichnen.
- **Do** Tabellen und Code in sich scrollen lassen, nie die Seite.

### Don't:
- **Don't** eine zweite Akzentfarbe oder farbige Flächen einführen; Blau bleibt Handlung und Fokus.
- **Don't** Agentenfarben als Textfarbe, Hintergrund oder Rahmen einsetzen.
- **Don't** Webfonts, eine Display-Schrift oder Icon-Fonts laden; die Oberfläche lädt nichts von außen.
- **Don't** Karten, Blasen oder Listeneinträge mit Schatten absetzen; nur Eingabebox und offene Schublade haben einen.
- **Don't** Antworten in Blasen oder Rahmen setzen; nur die Nutzerblase ist eine Blase.
- **Don't** einen vom Nutzer gewollten Stopp rot darstellen.
- **Don't** weitere Bewegung als Einblenden und Schublade hinzufügen, auch keine Übergänge an Knöpfen oder am Chevron.
