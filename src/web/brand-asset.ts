/**
 * BRAND (src/brand.ts) für die Browser-Seiten ohne Build-Schritt (Issue #100).
 *
 * - /brand.js setzt window.TYBO_BRAND; die Skripte der WebUI und der
 *   Einrichtung lesen den Namen dort. Ohne Anmeldung erreichbar, weil Login
 *   und Code-Seite der Einrichtung ihn schon brauchen. Eine Datei vom eigenen
 *   Ursprung, die CSP (script-src 'self') bleibt unverändert.
 * - HTML-Seiten enthalten {{brand.name}} (auch cli, domain); beide Server
 *   ersetzen das beim Ausliefern, damit Titel und Wortmarke ohne JavaScript
 *   stimmen.
 * - {{ui.version}} (Issue #111) wird durch die Oberflächen-Version des
 *   Servers ersetzt, ohne Version durch einen leeren Text.
 */

import { BRAND } from "../brand";

export const BRAND_SCRIPT_PATH = "/brand.js";

const PLACEHOLDER = /\{\{brand\.(name|cli|domain)\}\}/g;
const UI_VERSION = /\{\{ui\.version\}\}/g;

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
}

export function brandScript(): string {
  return `// Erzeugt aus src/brand.ts (Issue #100)\nwindow.TYBO_BRAND = Object.freeze(${JSON.stringify(BRAND)});\n`;
}

export function renderBrandHtml(html: string, uiVersion = ""): string {
  return html
    .replace(PLACEHOLDER, (_, key: keyof typeof BRAND) => escapeHtml(BRAND[key]))
    .replace(UI_VERSION, () => escapeHtml(uiVersion));
}

export function brandScriptResponse(): Response {
  return new Response(brandScript(), { headers: { "Content-Type": "text/javascript; charset=utf-8" } });
}

/** HTML-Datei mit ersetzten Platzhaltern */
export async function brandHtmlResponse(file: string, uiVersion?: string): Promise<Response> {
  return new Response(renderBrandHtml(await Bun.file(file).text(), uiVersion), { headers: { "Content-Type": "text/html; charset=utf-8" } });
}
