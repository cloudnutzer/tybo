import type { RecipeTemplateId } from "../recipe";
import { ANRUFANNAHME } from "./anrufannahme";
import type { VoiceTemplate } from "./base";
import { EXPERTE } from "./experte";
import { JARVIS } from "./jarvis";

export type { VoiceTemplate } from "./base";

export const TEMPLATES: Readonly<Record<RecipeTemplateId, VoiceTemplate>> = {
  anrufannahme: ANRUFANNAHME,
  jarvis: JARVIS,
  experte: EXPERTE,
};
