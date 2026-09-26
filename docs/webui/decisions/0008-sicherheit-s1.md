# 0008 Sicherheit S1: Sicherheitsideen aus einer Durchsicht früherer Änderungen, an unseren Aufbau angepasst

Datum: 24.09.2026. Entschieden von: Maintainer.

Durchsicht von 37 früheren Änderungen aus der Zeit vom 2.6. bis 17.9.2026. Kein Zusammenführen (zu weit auseinander, Convex-lastig),
sondern drei Ideen, umgesetzt in unserem Ablauf:

1. **Link-Vorschau aus, Markdown-Bilder entschärft** auf allen Wegen, über die
   Modelltext nach Telegram geht (Vorbild ba2b913, dd348db). Sonst ruft der
   Vorschau-Dienst von Telegram eine vom Modell erzeugte Adresse auf, in der
   Daten versteckt sein können.
2. **Herkunft von Merk-Tags** (Vorbild c315890): Hat ein Turn fremde Inhalte
   gelesen (Web, Mail, andere Lese-Werkzeuge), werden seine
   `[REMEMBER:]`/`[GOAL:]`/`[FORGET:]`/`[DONE:]`/`[CANCEL:]` nicht still
   übernommen, sondern wie beim Session-Review per Knopf vorgeschlagen.
3. **Schlüssel nur bei Bedarf, abgeschwächt** (Vorbild 14dcd77): Claude-
   Subprozesse erben nicht mehr alle Geheimnisse aus der Umgebung, sondern nur
   eine Freigabeliste. Netzzugang, Bash und Werkzeuge bleiben unverändert, weil
   die übliche Arbeitsweise (curl, Deploys, APIs) davon lebt. Ehrliche Grenze: Die
   `.env` bleibt lesbar; der Schutz hält vor allem die übliche Injection
   `env | curl …` ab.
