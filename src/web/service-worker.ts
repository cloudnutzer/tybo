/**
 * Auslieferung des Service Workers (Issue #224): public/sw.js enthält die
 * Platzhalter {{ui.version}}, {{brand.cli}} und {{brand.name}} (Issue #225). Der Server setzt beim
 * Ausliefern die Oberflächen-Version (./ui-version) und den Befehlsnamen aus
 * src/brand.ts ein. Damit ändern sich die ausgelieferten Bytes bei jeder
 * Änderung in public/ (auch nur an style.css), der Browser installiert einen
 * neuen Worker, und dessen Cache trägt einen neuen Namen.
 */

import { BRAND } from "../brand";
import { isUiVersion } from "./ui-version";

export const SERVICE_WORKER_PATH = "/sw.js";
export const OFFLINE_PAGE_PATH = "/offline.html";

/** Nur Zeichen, die in einem JavaScript-Text und einem Cache-Namen harmlos sind */
const SAFE = /^[a-z0-9-]*$/;

/** Anzeigename in Benachrichtigungen (Issue #225): nur Buchstaben, Ziffern, Leerzeichen, - und . */
const SAFE_NAME = /^[\p{L}\p{N} .-]{1,40}$/u;

export function renderServiceWorker(source: string, uiVersion: string, cli: string = BRAND.cli, brandName: string = BRAND.name): string {
  const version = isUiVersion(uiVersion) ? uiVersion : "";
  const name = SAFE.test(cli) ? cli : "webui";
  const display = SAFE_NAME.test(brandName) ? brandName : name;
  return source
    .replace(/\{\{ui\.version\}\}/g, version)
    .replace(/\{\{brand\.cli\}\}/g, name)
    .replace(/\{\{brand\.name\}\}/g, display);
}

export async function serviceWorkerResponse(file: string, uiVersion: string): Promise<Response> {
  return new Response(renderServiceWorker(await Bun.file(file).text(), uiVersion), {
    headers: { "Content-Type": "text/javascript; charset=utf-8" },
  });
}
