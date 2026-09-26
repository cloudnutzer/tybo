# 0012 Dateien im Web-Chat: Büroklammer, Ziehen, Zwischenablage, /b64

Datum: 24.09.2026. Entschieden von: Maintainer.

- Bilder, PDFs und Sprachdateien kommen über Büroklammer, Drag-and-drop und
  **Einfügen aus der Zwischenablage** (Strg/Cmd+V mit einem Screenshot) in den
  Chat. Vor dem Senden stehen sie als kleine Vorschau über dem Eingabefeld und
  lassen sich wieder entfernen; dazu kann Text geschrieben werden.
- **`/b64`** für Geräte, auf denen Bild-Uploads blockiert sind (etwa verwaltete
  Firmengeräte, Konverter `docs/screenshot-to-base64.html`): `/b64` gefolgt vom
  Base64-Code, mit oder ohne `data:image/…;base64,`-Anfang. Der Browser wandelt
  den Code selbst in ein Bild um und behandelt es wie ein eingefügtes Bild. Der
  Base64-Text wird nie als Nachricht gesendet, deshalb gilt die Grenze von
  20.000 Zeichen pro Nachricht dafür nicht, sondern die Größengrenze für Bilder.
  Eingefügter Text, der mit `data:image/` beginnt, wird ebenso erkannt.
- Verarbeitung wie in Telegram (Bildbeschreibung und Asset-Speicher, PDF-Text,
  Transkription), herausgelöst aus den Telegram-Handlern. In Telegram erscheint
  der Anhang gespiegelt im selben Gespräch wie „Du (Web): …".
- Sprachaufnahme direkt im Browser braucht einen sicheren Kontext (HTTPS oder
  localhost). Im Heimnetz über `http://<IP>` geht das nicht; dort nur
  Sprachdateien hochladen. Aufnahme kommt, sobald ein HTTPS-Zugang existiert.

Nachtrag 25.09.2026: Seit Z1 (HTTPS über app.tybo.ai) wird die Aufnahme im Browser gebaut (M4b), mit Knopf nur im sicheren Kontext.

Nachtrag 25.09.2026 (M9): Anhänge und Aufnahme auch in reinen Web-Gesprächen, gleiche Verarbeitung, keine Spiegelung nach Telegram.
