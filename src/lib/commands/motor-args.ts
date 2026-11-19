/** Gleiche Argumente und Sofortfreigabe im Register und im Terminal. */
export function normalizeMotorArgs(args: string): string {
  return args.trim().toLowerCase().normalize("NFC").replace(/\s+/g, " ");
}

export function motorUnscoped(args: string): boolean {
  const arg = normalizeMotorArgs(args);
  return !arg || arg === "werkzeuge" || arg === "pruefen" || arg === "prüfen" || arg === "auto" || arg.startsWith("auto ");
}
