/** Reine Zeit- und Fensternamen, gemeinsam für Meldungen und Motoranzeige. */
import type { UsageWindowId } from "./engines/usage";

/** Nutzerzeit mit stabilen deutschen Kurzformen, unabhängig von der ICU-Version. */
export function formatSwitchTime(iso: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(iso));
  const value = (type: string) => parts.find(part => part.type === type)!.value;
  const day = new Date(`${value("year")}-${value("month")}-${value("day")}T00:00:00Z`).getUTCDay();
  const weekday = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"][day];
  return `${weekday}, ${value("day")}.${value("month")}., ${value("hour")}:${value("minute")}`;
}

export function switchWindowLabel(window: UsageWindowId): string {
  if (window === "weekly_all") return "Woche, alle Modelle";
  if (window === "session") return "5 Stunden";
  if (window.startsWith("weekly_scoped:")) {
    const family = window.slice("weekly_scoped:".length);
    return `Woche, ${family.charAt(0).toUpperCase()}${family.slice(1)}`;
  }
  const minutes = Number(window.slice("window_".length));
  // Ab zwei Stunden in Stunden, ab zwei Tagen in Tagen; höchstens zwei Nachkommastellen.
  const value = minutes < 120 ? minutes : minutes < 2880 ? minutes / 60 : minutes / 1440;
  const unit = minutes < 120 ? (value === 1 ? "Minute" : "Minuten") : minutes < 2880 ? "Stunden" : "Tage";
  return `Fenster, ${String(Math.round(value * 100) / 100).replace(".", ",")} ${unit}`;
}


export function formatShortSwitchTime(iso: string, timeZone: string, withDay = true): string {
  const full = formatSwitchTime(iso, timeZone);
  return withDay ? `${full.slice(0, 2)} ${full.slice(-5)}` : full.slice(-5);
}
