/**
 * Shared rules of "Kontakty" (database update 56, CRM phase 2) for the pages and their tests (crm_test.ts,
 * `npm run test:crm`). The database decides everything that matters (phones as E.164, who may send, the variables);
 * these only help the owner see it before saving or sending.
 */

/** The variables of a template or message, as crm_render() fills them in (the `contacts.var_*` texts explain them). */
export const TEMPLATE_VARIABLES = ["name", "first_name", "shop", "shop_phone", "shop_email", "shop_address", "shop_web"] as const;
export type TemplateVariable = (typeof TEMPLATE_VARIABLES)[number];

/** "{{name}}" as the owner writes it in a template. */
export const variableToken = (v: TemplateVariable) => `{{${v}}}`;

/** SMS longer than this are refused by the database (owner_message_queue). */
export const SMS_MAX = 480;

// The GSM 03.38 basic alphabet (and its extension table, two characters each); anything else makes an SMS Unicode.
const GSM_BASIC =
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
const GSM_EXTENDED = "^{}\\[~]|€\f";

/**
 * How many SMS a text takes: GSM-7 160 characters (153 per part when longer, extension characters count twice),
 * otherwise Unicode 70 (67 per part). Slovak and Hungarian letters with accents (á, č, ő, …) make a text Unicode.
 */
export function smsParts(text: string): { chars: number; parts: number; unicode: boolean } {
  const chars = [...text];
  const gsm = chars.every((c) => GSM_BASIC.includes(c) || GSM_EXTENDED.includes(c));
  if (gsm) {
    const units = chars.reduce((n, c) => n + (GSM_EXTENDED.includes(c) ? 2 : 1), 0);
    return { chars: chars.length, parts: units === 0 ? 0 : units <= 160 ? 1 : Math.ceil(units / 153), unicode: false };
  }
  const units = chars.reduce((n, c) => n + (c.codePointAt(0)! > 0xffff ? 2 : 1), 0);
  return { chars: chars.length, parts: units <= 70 ? 1 : Math.ceil(units / 67), unicode: true };
}

/** Tags as typed in one field ("VIP, stály zákazník"): trimmed, ≤ 40 characters, each once (case ignored), ≤ 20. */
export function splitTags(value: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of value.split(/[,;\n]/)) {
    const tag = raw.trim().slice(0, 40);
    if (!tag || seen.has(tag.toLowerCase())) continue;
    seen.add(tag.toLowerCase());
    out.push(tag);
    if (out.length === 20) break;
  }
  return out;
}

/** A database refusal of a contact or template as the `contacts.err_*` key it is shown with. */
export function contactError(message: string | undefined): string {
  const known = ["phone", "phone_taken", "email", "empty", "no_plan", "template", "template_name", "template_limit"];
  return known.includes(message ?? "") ? `err_${message}` : "err_failed";
}

/** A refusal of a message (database or crm-messages) as its `contacts.err_*` key. */
export function messageError(reason: string | undefined): string {
  const map: Record<string, string> = {
    no_plan: "err_no_plan",
    no_recipient: "err_no_recipient",
    empty: "err_empty_msg",
    subject: "err_subject",
    too_long: "err_too_long",
    too_many: "err_too_many",
    forbidden: "err_forbidden",
  };
  return map[reason ?? ""] ?? "err_send_failed";
}
