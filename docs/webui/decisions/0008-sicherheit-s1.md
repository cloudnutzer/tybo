# 0008 Sicherheit S1: Sicherheitsideen aus einer Durchsicht früherer Änderungen, an unseren Aufbau angepasst

Datum: 24.09.2026. Entschieden von: Maintainer.

Durchsicht von 37 früheren Änderungen aus der Zeit vom 2.6. bis 17.9.2026. Kein Zusammenführen (zu weit auseinander, Convex-lastig),
sondern drei Ideen, umgesetzt in unserem Ablauf:

1. **Link-Vorschau aus, Markdown-Bilder entschärft** auf allen Wegen, über die
   Modelltext nach Telegram geht. Sonst ruft der
   Vorschau-Dienst von Telegram eine vom Modell erzeugte Adresse auf, in der
   Daten versteckt sein können.
2. **Herkunft von Merk-Tags**: Hat ein Turn fremde Inhalte
   gelesen (Web, Mail, andere Lese-Werkzeuge), werden seine
   `[REMEMBER:]`/`[GOAL:]`/`[FORGET:]`/`[DONE:]`/`[CANCEL:]` nicht still
   übernommen, sondern wie beim Session-Review per Knopf vorgeschlagen.
3. **Schlüssel nur bei Bedarf, abgeschwächt**: Claude-
   Subprozesse erben nicht mehr alle Geheimnisse aus der Umgebung, sondern nur
   eine Freigabeliste. Netzzugang, Bash und Werkzeuge bleiben unverändert, weil
   die übliche Arbeitsweise (curl, Deploys, APIs) davon lebt. Ehrliche Grenze: Die
   `.env` bleibt lesbar; der Schutz hält vor allem die übliche Injection
   `env | curl …` ab.

## Nachtrag 05.11.2026: nur noch Inhalte aus dem Netz (Issue #525)

Entschieden von: Maintainer. Punkt 2 fragte zu oft nach, vor allem wegen
`gh` gegen die eigenen Repos. Seitdem gilt als fremd nur, was aus dem Netz
kommt: Web-Werkzeuge und Suche, Mail und andere lesende MCP-Werkzeuge,
`curl`, `wget` und Co., `gh` gegen fremde oder nicht erkennbare Repos sowie
hochgeladene Dateien und Fotos. Dateien auf diesem Rechner zählen nicht mehr,
auch außerhalb des Projekts, und `gh` gegen ein Repo der Konten aus
`TYBO_TRUSTED_GITHUB_OWNERS` (ohne Wert: keines) ebenfalls nicht. Im Zweifel
bleibt es ein Vorschlag; ein Befehl mit mehreren Teilen zählt als fremd,
sobald ein Teil fremd ist. Das Tor selbst bleibt unverändert, auch dass eine
unbekannte Werkzeugliste direkt angewendet wird.
