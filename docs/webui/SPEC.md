# Spec: tybo WebUI

Stand: 23.09.2026 (Nachtrag 16:45: Dateien, Autonomie und Schlüssel als M4 bis M6
auf Wunsch des Maintainers; 17:15: Telegram-Topics gespiegelt in der Seitenleiste, Design-Vorgaben;
20:58: Schalter System/Hell/Dunkel; 24.09. 02:06: neue Gespräche als
Telegram-Topics, Topics aus dem Browser löschen).
Diese Datei beschreibt, was die WebUI können soll und für
wen. Wie es gebaut wird, steht in den Issues. Änderungen an dieser Datei
entscheidet der Maintainer, kein Agent.

## Problem

tybo ist nur über Telegram erreichbar. Wer am Rechner oder im Heimnetz sitzt,
muss trotzdem in Telegram wechseln. Einstellungen wie Agenten-Anweisungen,
Modelle pro Agent, Aux-Modelle oder die Fallback-Kette stehen in `.env`,
`src/agents/*.ts` und `config/*.json`. Ändern heißt Dateien editieren und oft
den Bot neu starten.

Die WebUI ist eine Chat-Seite im Browser, ähnlich ChatGPT oder dem Dashboard
von Hermes Agent, plus Einstellungsseiten. Sie läuft im selben Prozess wie der
Bot und nutzt denselben Chat-Kern: gleiches Gedächtnis, gleiche Agenten,
gleiche Sessions, gleicher Fallback.

## Für wen

Genau ein Nutzer: der Besitzer der tybo-Installation. Aufruf lokal
(`http://localhost:<port>`) oder im Heimnetz über die IP des Macs, auch vom
Handy. Kein Zugriff aus dem Internet.

## Was die WebUI am Ende kann

- Anmeldung mit Passwort, danach bleibt man 30 Tage angemeldet
- Chat mit tybo im Browser: Nachricht schicken, Fortschritt sehen (welches
  Werkzeug läuft gerade), Antwort als formatiertes Markdown, Abbrechen per
  Stopp-Knopf
- Seitenleiste wie in Telegram: oben Direktchat und Telegram-Topics (Name,
  Agent, letzte Aktivität), darunter reine Web-Gespräche
- Telegram-Topics im Browser: Verlauf lesen und weiterschreiben, mit derselben
  Session wie in Telegram. Gespiegelt: Die Web-Nachricht erscheint im Topic als
  „Du (Web): …", die Antwort kommt dort vom Agenten-Bot wie gewohnt; neue
  Nachrichten aus Telegram erscheinen im offenen Topic im Browser
- Neue Gespräche aus dem Browser sind echte Telegram-Topics (Entscheidung
  0005): „Neues Gespräch" legt in der Forum-Gruppe ein Topic mit dem gewählten
  Agenten an; Umbenennen im Browser benennt das Topic in Telegram um; Topics
  lassen sich im Browser schließen und nach Rückfrage endgültig löschen
- Ältere reine Web-Gespräche (vor 0005 angelegt) bleiben lesbar, umbenennbar
  und löschbar; jedes hat einen festen Agenten und eine eigene Claude-Session
- Gespräche überstehen Neustarts des Bots
- Was im Web-Chat gesagt wird, landet im selben Gedächtnis wie Telegram
  (Nachrichten-Speicher, [REMEMBER:]/[GOAL:]-Tags, semantische Suche)
- Einstellungen im Browser:
  - Agenten: Modell und Effort pro Agent, zusätzliche Anweisungen (dasselbe wie
    `/agent`), Zuordnung Telegram-Topic zu Agent
  - Agenten verwalten (M3c, Entscheidung 0007): System-Prompt ansehen und
    bearbeiten (zurücksetzbar), neue Agenten anlegen, Agenten außer General
    löschen, gelöschte mitgelieferte wiederherstellen
  - Modelle: Standardmodell, Standard-Effort, Aux-Modelle (Judge, Destillat,
    Review), Fallback-Kette (OpenRouter-Modell, Ollama-Modell, nur offline)
  - Status: welche Schlüssel gesetzt sind (nur ja/nein), Version, laufende
    Sessions, Knopf "Neustart anfordern"
- Meldungen und Dateien (M3b, Entscheidung 0006): Was tybo oder seine
  Hintergrunddienste an Telegram schicken (Pipeline, Briefing, Check-in,
  Watchdog, Watcher, gebaute Dateien), steht auch im passenden Gespräch der
  WebUI, als Meldung mit Absender und Dateien als Download; nie im
  Gesprächskontext von tybo
- Dateien im Web-Chat (ab M4): Bilder, PDFs und Sprachaufnahmen hochladen; sie
  laufen durch dieselbe Verarbeitung wie in Telegram (Bildbeschreibung und
  Speicher, PDF-Text, Transkription)
- Autonomie im Web-Chat (ab M5): `/goal` mit Weiter-Knöpfen, `/board` mit
  mehreren Sprechern in einem Gespräch, `[INVOKE:]`-Rückfragen an andere Agenten
- Schlüssel im Browser (ab M6): API-Schlüssel setzen, ersetzen und löschen,
  mit den Schutzregeln unten
- Chat im Terminal (M7, Entscheidung 0010): `tybo` als Client des laufenden
  Bots, gleiche Gespräche wie Telegram und Web
- Rückfragen mit Knöpfen (M10, Entscheidung 0017): Rückfragen aus dem
  gemeinsamen Register stehen im Browser als echte Knöpfe unter der Nachricht
  und wirken wie in Telegram; ein Klick entscheidet für alle Kanäle, eine
  Entscheidung aus Telegram erscheint im Browser ohne Neuladen als erledigt.
  Entscheidbar nur im eigenen Gespräch der Frage
- Einrichtung (M8, Entscheidung 0011): `tybo setup` im Terminal und ein
  Einrichtungsmodus im Browser führen auf einem frischen Rechner bis zur ersten
  Antwort
- Bedienbar auf dem Handy (390 px Breite) und am Desktop, heller und dunkler
  Modus; Standard nach Geräteeinstellung, in der Seitenleiste umschaltbar
  (System / Hell / Dunkel, pro Browser gemerkt). Aufbau vertraut wie ChatGPT
  und Telegram Desktop, ruhig, kaum Animation, nicht verspielt

## Schutzregeln für Schlüssel (M6)

- Werte gehen nur in eine Richtung: Der Browser kann sie schreiben, bekommt sie
  aber nie zurück. Angezeigt werden nur „gesetzt" und die letzten 4 Zeichen
- Nur mit `WEB_ALLOW_KEY_EDIT=true` in `.env`, sonst ist die Seite schreibgeschützt
- Nicht über die WebUI änderbar: `WEB_*`, `TELEGRAM_BOT_TOKEN`,
  `TELEGRAM_USER_ID` (sonst sperrt man sich aus)
- Vor jedem Schreiben eine Sicherung der `.env` (Rechte 0600), Schreiben atomar,
  Kommentare und Reihenfolge bleiben erhalten
- Im Log stehen nur Variablennamen, nie Werte

## Nicht im Umfang

Die Punkte „ab M4" bis „ab M6" oben werden erst in ihrem Meilenstein gebaut,
nicht vorher. Gar nicht gebaut wird:

- Zugriff aus dem Internet, HTTPS, OAuth oder mehrere Nutzer
- Passwörter und Schlüssel im Klartext anzeigen
- Video-Upload, Sprachausgabe
- Das Topic „General" der Gruppe und den Direktchat löschen oder umbenennen
- `/routine` im Web-Chat (Freigabe-Knöpfe kommen mit M10, Entscheidung 0017)
- Token-für-Token-Streaming der Antwort (Fortschritt ja, Text kommt am Stück)
- Änderungen am VPS-Gateway (`src/vps-gateway.ts`) oder an Convex

## Leitplanken

- Bun und TypeScript im bestehenden Repo, keine Build-Pipeline für das
  Frontend: statische Dateien unter `src/web/public/`, reines JavaScript
- Der Web-Server läuft im Bot-Prozess (`src/bot.ts`), auf einem eigenen Port
  neben dem Health-Server (siehe `docs/webui/decisions/0001-im-bot-prozess.md`)
- Standard ist `127.0.0.1`. Heimnetz nur, wenn es ausdrücklich eingestellt ist
- Ohne gesetztes Passwort startet die WebUI nicht (auch nicht auf localhost)
- Web-Chat und Telegram teilen einen Chat-Kern. Keine zweite Kopie der Logik
  für Prompt, Session, Claude-Aufruf und Fallback
- Das Telegram-Verhalten bleibt unverändert, solange ein Issue nichts anderes sagt
- Einstellungen aus der WebUI liegen in einer eigenen Datei unter `config/`
  und überschreiben die Voreinstellungen aus `.env` und Code. In `.env`
  schreibt die WebUI nur die Schlüssel aus M6, nach den Schutzregeln oben
- Keine Zugangsdaten in Logs, Antworten der API oder im Browser

## Woran erkennbar ist, dass es fertig ist

- `bun run check` grün, in CI bei jedem Pull Request
- Der Nutzer chattet eine Woche lang vom Handy im Heimnetz mit tybo über die WebUI,
  mindestens in zwei Gesprächen mit unterschiedlichen Agenten
- Der Nutzer führt ein Telegram-Topic abwechselnd in Telegram und im Browser weiter,
  und beide Seiten zeigen dasselbe Gespräch
- Der Nutzer ändert Modell und Anweisungen eines Agenten in der WebUI, und die
  nächste neue Session nutzt sie, ohne Dateien anzufassen

## Offene Fragen

- (geklärt 24.9.2026, Maintainer: Variante A) Einstellungen, die nur mit Neustart
  greifen, zeigen nach dem Speichern einen Hinweis mit Knopf „Jetzt neu
  starten"; der Neustart wird nie automatisch angefordert.
