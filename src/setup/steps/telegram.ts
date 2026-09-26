/**
 * Schritte „telegram“ (Token, Nutzer-ID, Testnachricht) und „gruppe“
 * (optionale Forum-Gruppe für Topics).
 */

import { BRAND } from "../../brand";
import { fieldStates, mergeValues, stateFromCount, type SetupField, type SetupStep } from "../model";
import { enteredChanges, envValues, invalid, writeEnv } from "./common";

const TOKEN_PATTERN = /^\d{5,15}:[A-Za-z0-9_-]{30,}$/;
const USER_ID_PATTERN = /^\d{1,20}$/;
const GROUP_ID_PATTERN = /^-\d{1,20}$/;

export const TELEGRAM_FIELDS: SetupField[] = [
  {
    name: "TELEGRAM_BOT_TOKEN",
    label: "Bot-Token",
    kind: "secret",
    required: true,
    help: "In Telegram @BotFather öffnen, /newbot senden und das Token kopieren (Zahl, Doppelpunkt, lange Zeichenfolge).",
    link: "https://t.me/BotFather",
    validate: v => (TOKEN_PATTERN.test(v) ? null : "Bot-Token hat nicht das erwartete Format (Zahl:Zeichenfolge)"),
  },
  {
    name: "TELEGRAM_USER_ID",
    label: "Deine Telegram-Nutzer-ID",
    kind: "text",
    required: true,
    help: "Eine Zahl, nicht der Benutzername. @userinfobot anschreiben, er antwortet sofort mit der ID.",
    link: "https://t.me/userinfobot",
    validate: v => (USER_ID_PATTERN.test(v) ? null : "Nutzer-ID besteht nur aus Ziffern"),
  },
];

const TELEGRAM_NAMES = TELEGRAM_FIELDS.map(f => f.name);

export const telegramStep: SetupStep = {
  id: "telegram",
  title: "Telegram",
  description: `Der Bot, über den ${BRAND.name} mit dir spricht.`,
  optional: false,
  fields: TELEGRAM_FIELDS,

  async status(ctx) {
    const existing = await envValues(ctx, TELEGRAM_NAMES);
    const done = TELEGRAM_NAMES.filter(n => existing[n]).length;
    const state = stateFromCount(done, TELEGRAM_NAMES.length);
    const detail =
      state === "erledigt"
        ? "Token und Nutzer-ID sind gesetzt."
        : state === "teilweise"
          ? existing.TELEGRAM_BOT_TOKEN
            ? "Token gesetzt, Nutzer-ID fehlt."
            : "Nutzer-ID gesetzt, Token fehlt."
          : "Noch kein Telegram-Bot eingerichtet.";
    return { state, detail, fields: fieldStates(TELEGRAM_FIELDS, existing) };
  },

  async test(values, ctx) {
    const existing = await envValues(ctx, TELEGRAM_NAMES);
    const problem = invalid(TELEGRAM_FIELDS, values, existing);
    if (problem) return problem;
    const merged = mergeValues(existing, values);
    const token = merged.TELEGRAM_BOT_TOKEN;
    const me = await ctx.providers.telegramGetMe(token);
    if (!me.ok) return { ok: false, message: me.message, items: [{ label: "Bot", ok: false, detail: me.message }] };
    const sent = await ctx.providers.telegramSendTest(token, merged.TELEGRAM_USER_ID, `${BRAND.name} ist verbunden. Diese Nachricht kommt aus der Einrichtung.`);
    return {
      ok: sent.ok,
      message: sent.ok ? `${me.message}. ${sent.message}` : sent.message,
      items: [
        { label: "Bot", ok: true, detail: me.message },
        { label: "Testnachricht", ok: sent.ok, detail: sent.message },
      ],
    };
  },

  async apply(values, ctx) {
    const existing = await envValues(ctx, TELEGRAM_NAMES);
    const problem = invalid(TELEGRAM_FIELDS, values, existing);
    if (problem) return { ...problem, changed: [] };
    return writeEnv(ctx, enteredChanges(TELEGRAM_FIELDS, values, mergeValues(existing, values)));
  },
};

export const GROUP_FIELDS: SetupField[] = [
  {
    name: "TELEGRAM_GROUP_ID",
    label: "Gruppen-ID der Forum-Gruppe",
    kind: "text",
    required: true,
    help: "Telegram-Gruppe mit eingeschalteten Themen anlegen, den Bot als Admin hinzufügen. Die ID beginnt mit -100.",
    link: "https://telegram.org/blog/topics-in-groups-collectible-usernames",
    validate: v => (GROUP_ID_PATTERN.test(v) ? null : "Gruppen-ID beginnt mit einem Minus, danach nur Ziffern"),
  },
];

export const groupStep: SetupStep = {
  id: "gruppe",
  title: "Forum-Gruppe",
  description: "Optional: eine Telegram-Gruppe mit Themen, ein Thema pro Agent oder Gespräch.",
  optional: true,
  fields: GROUP_FIELDS,

  async status(ctx) {
    const existing = await envValues(ctx, ["TELEGRAM_GROUP_ID"]);
    const set = !!existing.TELEGRAM_GROUP_ID;
    return {
      state: set ? "erledigt" : "fehlt",
      detail: set ? "Forum-Gruppe ist eingetragen." : "Keine Forum-Gruppe eingetragen, es gibt nur den Direktchat.",
      fields: fieldStates(GROUP_FIELDS, existing),
    };
  },

  async test(values, ctx) {
    const existing = await envValues(ctx, ["TELEGRAM_GROUP_ID", "TELEGRAM_BOT_TOKEN"]);
    const problem = invalid(GROUP_FIELDS, values, existing);
    if (problem) return problem;
    const token = existing.TELEGRAM_BOT_TOKEN;
    if (!token) return { ok: false, message: "Erst den Schritt Telegram einrichten, dann die Gruppe testen." };
    const merged = mergeValues(existing, values);
    return ctx.providers.telegramCheckGroup(token, merged.TELEGRAM_GROUP_ID);
  },

  async apply(values, ctx) {
    const existing = await envValues(ctx, ["TELEGRAM_GROUP_ID"]);
    const problem = invalid(GROUP_FIELDS, values, existing);
    if (problem) return { ...problem, changed: [] };
    return writeEnv(ctx, enteredChanges(GROUP_FIELDS, values, mergeValues(existing, values)));
  },
};
