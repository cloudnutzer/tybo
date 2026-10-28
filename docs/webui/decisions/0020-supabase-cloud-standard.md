# 0020 Supabase in der Cloud als Standard-Datenbank

Datum: 26.09.2026. Entschieden von: Maintainer (Standardweg, Reihenfolge der Auswahl), Umsetzungsdetails Issue #163.

- Der Standardweg zur Datenbank ist Supabase in der Cloud. `tybo setup
  datenbank` richtet sie über die Management-API von Supabase ein; der Nutzer
  legt nur ein Konto an und erzeugt ein persönliches Zugangstoken (`sbp_…`).
- Auswahl im Schritt Datenbank: „Supabase in der Cloud“ (Standard),
  „Zugangsdaten selbst eintragen“ (vorhandenes Projekt, eigener Server),
  „Convex (für Fortgeschrittene)“. „Supabase auf diesem Rechner“ kommt mit
  #164 dazu und wird erst dann angeboten. Convex verliert das „empfohlen“.
- Das Zugangstoken gilt nur für den einen Lauf: nie in `.env`, `data/`, Logs,
  Fortschritt, Meldungen oder der Umgebung von Unterprozessen.
- Angelegt wird nur in Organisationen im kostenlosen Tarif (der Tarif gilt je
  Organisation). Ein gefundenes Projekt wird nie ersetzt; mehrdeutige oder
  unerreichbare Projekte führen zum Abbruch mit Hinweis.
- Ein vorhandener, öffentlicher Bilder-Ordner wird nicht still auf privat
  gestellt, sondern führt zum Abbruch mit Hinweis.
- Weg und Laufzeit sind getrennt: `activeBackend()` sagt weiter nur, welche
  Datenbank die Laufzeit nutzt; `setupPath()` wählt beim erneuten Einrichten
  „Supabase in der Cloud“ vor, wenn die Adresse auf `*.supabase.co` endet.
