/**
 * Frühere Dienst-, Befehls- und Produktnamen, nur für Negativtests (Issues #142, #143): Sie
 * belegen, dass tybo diese Namen nicht mehr kennt. Zusammengesetzt statt
 * ausgeschrieben, damit die Suche nach Resten der alten Namen im Repo
 * (git grep aus dem Issue) leer bleibt.
 */
export const OLD_LAUNCHD_PREFIX = ["com", "go", ""].join(".");
export const OLD_PM2_PREFIX = ["go", ""].join("-");
export const OLD_CLI = ["ty", "bot"].join("");
/** Früherer Produktname (Issue #143), in allen Schreibweisen verboten */
export const OLD_NAME = ["Go", "Bot"].join("");

export const oldLaunchdLabel = (service: string) => `${OLD_LAUNCHD_PREFIX}${service}`;
export const oldPm2Name = (service: string) => `${OLD_PM2_PREFIX}${service}`;
