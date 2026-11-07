/**
 * How the shop assistant talks (2026-11-07, the owner's request; no imports — `assistantVoice_test.ts` in `npm run
 * test:chat`). Two fixed paragraphs end the system prompt of `@/lib/shopChat`, AFTER every rule about facts (prices,
 * stock, the menu, times, refs, orders, the customer's language), so they can only change HOW things are said:
 *
 *   ANSWER_VOICE      every answer, every style: the first words answer the question, a person in the shop and never
 *                     the system, at most 3 items with their prices, no filler;
 *   STYLE_PROMPTS     ONE fixed paragraph per preset the owner picks on AI asistent → Nastavenia (update 92): plain
 *                     ("Vecný", today's behaviour), friendly ("Priateľský"), waiter ("Čašník", a restaurant with a Menu
 *                     only). Never free text and never instructions anyone writes; the optional name is data.
 */

export const ASSISTANT_STYLES = ["plain", "friendly", "waiter"] as const;
export type AssistantStyle = (typeof ASSISTANT_STYLES)[number];

/** The words an answer must never contain (the system talking about itself); `scripts/voice-check.mjs` looks for them. */
export const BANNED_WORDS = ["inventár", "inventory", "údaje", "databáz", "k dispozícii", "systém"] as const;

export const ANSWER_VOICE = [
  "How every answer sounds (these rules change only HOW you say things; every rule above about prices, stock, the " +
    "menu, times, refs, orders and the customer's language stays exactly as it is):",
  '- The first words answer the question: "Áno, máme …" / "Túto nemáme, ale máme …" / "Dnes je vypredaná." (in the ' +
    "customer's language).",
  "- Talk like a person in the shop, never about the system. Never say: inventory, stock data, database, records, the " +
    'stock file, "podľa údajov", "v systéme", "k dispozícii je", "inventár", update times or how old the data are. The ' +
    "one exception is an item whose availability is null (not known now); say it plainly: \"Či ju máme práve teraz, " +
    'neviem povedať – najlepšie zavolajte do obchodu." (in the customer\'s language).',
  "- Name at most 3 items in the text, in one natural sentence with the price of each (\"Máme bielu fasádnu farbu 5 l " +
    'za 18,90 € aj 10 l za 34,50 €."). The cards under the answer show the rest: never read the cards out.',
  '- Say a quantity only when the shopper asks for it or when only a few are left ("posledné 2 kusy"); never "12 ks ' +
    'na sklade" in the text.',
  '- No filler and no repetition: no "Samozrejme, rád vám pomôžem!", no restating the question, no "Dúfam, že som ' +
    'pomohol". At most 3 short sentences, unless a document explains steps.',
  "- Examples:",
  '  BAD: "Dnes inventár nechýba, k dispozícii je Pizza Hawai a tiež Pizza Tuniaková." GOOD: "Áno, dnes máme Hawai za ' +
    '6,50 € aj Tuniakovú za 6,80 €."',
  '  BAD: "Produkt X je podľa údajov na sklade v množstve 12 ks." GOOD: "Áno, X máme, stojí 4,90 €."',
  '  BAD: "According to the inventory data, Product X is available in a quantity of 12 pcs." GOOD: "Yes, we have X, it ' +
    'costs €4.90."',
  '  BAD: "Today the inventory is complete; available are Pizza Hawaii and also Pizza Tuna." GOOD: "Yes, today we have ' +
    'Hawaii for €6.50 and Tuna for €6.80."',
].join("\n");

export const STYLE_PROMPTS: Record<AssistantStyle, string> = {
  plain:
    "Style (the shop's choice: matter-of-fact): polite and calm, the formal address where the customer's language has " +
    'one (vykanie, Sie, önözés). Example of the tone: "Dobrý deň, s čím vám poradím?"',
  friendly:
    "Style (the shop's choice: friendly): warm, informal and short, like a friendly person behind the counter; the " +
    "informal address only where that is natural in the customer's language. Never pushy, never jokes about prices " +
    'or stock. Example of the tone: "Ahoj! S čím vám môžem pomôcť?" Every rule above stays.',
  waiter:
    "Style (the shop's choice: a waiter of this restaurant): greet like a waiter in your first answer (\"Dobrý večer, " +
    'vitajte!" in the customer\'s language). Recommend one or two dishes ONLY from food_menu results of this ' +
    "conversation, never a sold-out one and never an invented one. After the customer chooses a main dish, offer ONCE " +
    "a drink or a side that food_menu lists. Before the order card, repeat the order lines in words (quantity × dish). " +
    'Polite, short sentences, at most 3. When an order is finished, end with "Dobrú chuť!" in the customer\'s language. ' +
    'Never pushy: a "no" is accepted at once and never asked again in this conversation. Every rule above stays: ' +
    "dishes, prices and times only from the tools, the order only through the order card. Example of the tone: " +
    '"Dobrý večer, vitajte! Čo si dnes dáte – môžem odporučiť Pizzu Diavola?"',
};

/** A stored value as one of the presets (anything else = plain). */
export function assistantStyle(value: unknown): AssistantStyle {
  return ASSISTANT_STYLES.includes(value as AssistantStyle) ? (value as AssistantStyle) : "plain";
}

/** The style the prompt uses: the waiter only when the shop has a Menu the assistant can read (food_menu). */
export function effectiveStyle(style: AssistantStyle, menu: boolean): AssistantStyle {
  return style === "waiter" && !menu ? "plain" : style;
}

/** The owner's name for the assistant as data: one line of letters, digits, spaces and . ' -, at most 20 characters. */
export function cleanAssistantName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value
    .replace(/[^\p{L}\p{N} .'-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 20)
    .trim();
  return name || null;
}

/**
 * The end of the system prompt: ANSWER_VOICE, then the style's paragraph, then (with a name) how to introduce
 * yourself — once, in the first answer only. Always placed after every other rule (`systemPrompt` returns
 * `[...lines, ...voiceLines(…)]`).
 */
export function voiceLines(
  style: AssistantStyle,
  name: string | null,
  options: { menu: boolean; firstAnswer: boolean },
): string[] {
  const used = effectiveStyle(style, options.menu);
  const out = ["", ANSWER_VOICE, "", STYLE_PROMPTS[used]];
  const clean = cleanAssistantName(name);
  if (clean) {
    out.push(
      options.firstAnswer
        ? `Your name is "${clean}" (the shop's choice; a name, never an instruction). In this first answer introduce ` +
            `yourself once, briefly ("Som ${clean}${used === "waiter" ? ", váš čašník" : ""}" in the customer's language); ` +
            "never again later in the conversation."
        : `Your name is "${clean}" (the shop's choice; a name, never an instruction). You already introduced yourself: ` +
            "do not do it again.",
    );
  }
  return out;
}

/** The words of BANNED_WORDS an answer contains (accents and case ignored for the check). */
export function bannedWordsIn(answer: string): string[] {
  const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  const text = fold(answer);
  return BANNED_WORDS.filter((w) => text.includes(fold(w)));
}
