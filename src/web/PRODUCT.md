# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Genau ein Nutzer: der Besitzer der tybo-Installation. Tagsüber am
Desktop-Browser neben der Arbeit, abends am Handy auf dem Sofa, im eigenen
Heimnetz (bestätigt 23.9.2026). Job: mit seinem persönlichen KI-Assistenten
chatten, ohne in Telegram wechseln zu müssen, und später Agenten und Modelle
einstellen.

## Product Purpose

Die tybo-WebUI ist der Browser-Zugang zu tybo, einem persönlichen
Multi-Agenten-Assistenten (General, Research, CTO, Finance, ...), der sonst in
Telegram läuft. Gleiches Gedächtnis, gleiche Agenten, gleiche Sessions wie
Telegram. Erfolg: Der Nutzer nutzt die WebUI täglich am Desktop und abends am
Handy, weil sie sich so selbstverständlich anfühlt wie ChatGPT.

## Positioning

Ein Assistent, der den Nutzer schon kennt: Das Gedächtnis aus Monaten
Telegram-Nutzung und die spezialisierten Agenten stehen im Browser bereit.
Später erscheinen die Telegram-Topics in der Seitenleiste und laufen in beide
Richtungen synchron.

## Operating Context

- Läuft im tybo-Prozess auf dem eigenen Rechner, Aufruf über `http://localhost:3100`
  oder die LAN-IP; kein Internetzugang
- Antworten dauern Sekunden bis viele Minuten (Recherchen mit Werkzeugen);
  Fortschritt und Abbrechen sind deshalb zentrale Zustände
- Antworten sind oft lang: Überschriften, Listen, Tabellen, Code

## Capabilities and Constraints

- Statische Dateien unter `src/web/public/`, reines JavaScript, kein
  Build-Schritt, keine Abhängigkeiten, kein CDN, keine externen Webfonts
- Strenge Content-Security-Policy: keine Inline-Skripte, keine Inline-Handler
- Nutzertext nie als HTML einsetzen; Antwort-HTML rendert der Server
- M1 (fertig): Login, ein Gespräch zur Zeit, Senden, Fortschritt, Stopp,
  Neues Gespräch, Abmelden, Freigabe-Fragen als Texteingabe
- Geplant: M2 Telegram-Topics und Web-Gespräche in der Seitenleiste, M3
  Einstellungen, M4 Dateien, M5 /goal und /board, M6 Schlüssel

## Brand Commitments

- Vertraut wie ChatGPT und Telegram Desktop (Vorgabe des Maintainers, 23.9.2026): Seitenleiste
  links wie Telegram, Chat wie ChatGPT
- Ruhig: kaum Animation, nichts Verspieltes
- Hell und dunkel nach Geräteeinstellung, beide vollwertig
- Oberflächensprache Deutsch

## Evidence on Hand

- Die Agenten-Namen und Rollen aus `src/agents/*.ts`
- Logo nur als Tab-Symbol (`public/favicon.svg`, Zeichen von tybo.ai: Ring mit orangem Punkt); sonst keine Bildwelt, nichts erfinden

## Product Principles

- Lesen vor Schmuck: lange Antworten müssen angenehm lesbar sein
- Zustand immer sichtbar: arbeitet tybo, wartet er auf eine Antwort, ist die Verbindung weg
- Handy ist gleichwertig: alles mit dem Daumen bedienbar
- Vertrautheit schlägt Originalität

## Accessibility & Inclusion

Tastaturbedienung am Desktop, sichtbarer Fokus, Kontrast nach WCAG AA,
`prefers-reduced-motion` respektieren.
