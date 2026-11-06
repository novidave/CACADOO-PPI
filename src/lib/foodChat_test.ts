// A restaurant's assistant when no order is possible (2026-11-06): the menu tool open or closed, the sentence for the
// reason with the next opening, prices as information only, no cart, "Vypredané dnes", the call link only for a valid
// E.164 number. Run: npm run test:food
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import en from "../i18n/messages/en.json" with { type: "json" };
import hu from "../i18n/messages/hu.json" with { type: "json" };
import sk from "../i18n/messages/sk.json" with { type: "json" };
import {
  closedSentence,
  type FoodChatTexts,
  foodChatMode,
  menuToolLines,
  menuToolResult,
  nextOpening,
  notOrderingPrompt,
  phoneE164,
  stockSearchNote,
  whenText,
} from "./foodChat.ts";
import type { OpeningHours, StatusInput } from "./hours.ts";
import { readMenu } from "./menuRules.ts";

const root = new URL("../../", import.meta.url);
const read = (path: string) => Deno.readTextFile(new URL(path, root));
const TZ = "Europe/Bratislava";
const HOURS: OpeningHours = {
  mon: [["11:00", "22:00"]], tue: [["11:00", "22:00"]], wed: [["11:00", "22:00"]], thu: [["11:00", "22:00"]],
  fri: [["11:00", "22:00"]], sat: [["12:00", "22:00"]], sun: [],
};
const input = (hours: OpeningHours = HOURS): StatusInput => ({ hours, timeZone: TZ, days: [] });
const texts = (m: { chat: Record<string, string> }) => m.chat as unknown as FoodChatTexts;
const SK = texts(sk);

const HAWAII = "0f8fad5b-d9cb-469f-a165-70867728950e";
const H32 = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const H45 = "16fd2706-8baf-433b-82eb-8c7fada847da";
const SOUP = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
const MENU = readMenu({
  today: "2026-11-06",
  currency: "EUR",
  categories: [{ id: "c1", name: "Pizza" }, { id: "c2", name: "Polievky" }],
  items: [
    {
      id: HAWAII, name: "Pizza Hawaii", category_id: "c1", price_cents: null, tracked: false, sold_out: false,
      allergens: [1, 7], tags: [], description: "šunka, ananás",
      variants: [
        { id: H32, label: "32 cm", price_cents: 890, tracked: false, sold_out: false },
        { id: H45, label: "45 cm", price_cents: 1290, tracked: false, sold_out: false },
      ],
    },
    { id: SOUP, name: "Gulášová polievka", category_id: "c2", price_cents: 390, tracked: false, sold_out: true, allergens: [], tags: [], variants: [] },
  ],
})!;
const price = (cents: number) => `${(cents / 100).toFixed(2).replace(".", ",")} €`;
/** The refs shopChat gives: f… only for lines food_menu can sell now, m… otherwise. */
const refs = (orderable: boolean) => {
  const map = new Map<string, string>();
  return (id: string) => {
    if (!map.has(id)) map.set(id, `${orderable ? "f" : "m"}${map.size + 1}`);
    return map.get(id)!;
  };
};

/** What the AI receives from food_menu for "HAWAI" (shop_menu_search found the dish). */
function hawai(mode: ReturnType<typeof foodChatMode>, sentence: string | null) {
  const items = menuToolLines(MENU, [HAWAII], refs(mode.order), price);
  return menuToolResult("HAWAI", mode, items, { sentence, soldOut: SK.food_sold_out });
}

Deno.test("closed restaurant + \"HAWAI\": food_menu with the price and the next opening, no cart, never \"not in stock\"", () => {
  // Friday 23:00 in Bratislava: closed; Saturday opens at 12:00
  const now = new Date("2026-11-06T22:00:00Z");
  const mode = foodChatMode(true, { enabled: true, accepting: false, reason: "closed" }, true);
  assertEquals(mode, { menu: true, order: false, reason: "closed" });
  const next = nextOpening(input(), now);
  assertEquals(next, { time: "12:00", inDays: 1, day: "sat" });
  const sentence = closedSentence("closed", next, SK);
  assertEquals(sentence, "Teraz máme zatvorené, objednávky prijímame znova zajtra od 12:00.");
  const result = hawai(mode, sentence);
  assertEquals(result.accepting, false);
  assertEquals(result.not_accepting, "closed");
  assertEquals(result.say_first, sentence);
  assert(!("times" in result) && !("payment" in result), "no order fields while closed");
  const items = result.items as { ref: string; name: string; price: string; sold_out: boolean; allergens?: string[] }[];
  assertEquals(items.map((i) => [i.name, i.price]), [["Pizza Hawaii 32 cm", "8,90 €"], ["Pizza Hawaii 45 cm", "12,90 €"]]);
  assert(items.every((i) => i.ref.startsWith("m")), "information only: no ref the cart accepts");
  assertEquals(items[0].allergens, ["1 cereals containing gluten", "7 milk"]);
  const json = JSON.stringify(result);
  assertStringIncludes(json, "never say \\\"not in stock\\\"");
  // the prompt: the sentence first, the menu tool for dishes, an empty order
  const prompt = notOrderingPrompt("closed", sentence, SK.food_sold_out, true).join("\n");
  assertStringIncludes(prompt, sentence);
  assertStringIncludes(prompt, "call food_menu");
  assertStringIncludes(prompt, "never search_items");
  assertStringIncludes(prompt, "Leave order_lines empty");
  // search_items finds no dish in the stock: the AI is sent back to the menu
  assertStringIncludes(stockSearchNote(true, [])!, "call food_menu");
  assertStringIncludes(stockSearchNote(true, ["similar", "similar"])!, "never say a dish is not in stock");
  assertEquals(stockSearchNote(false, []), undefined);
});

Deno.test("the chat offers food_menu whenever the mode has the menu, food_quote and the cart only while an order is possible", async () => {
  const chat = await read("src/lib/shopChat.ts");
  assertStringIncludes(chat, "...(mode.menu ? [FOOD_TOOLS[0]] : []),");
  assertStringIncludes(chat, "...(mode.order ? [FOOD_TOOLS[1]] : []),");
  assertStringIncludes(chat, "if (mode.menu && call.name === \"food_menu\")");
  assertStringIncludes(chat, "if (mode.order && call.name === \"food_quote\")");
  assertStringIncludes(chat, "const cart = mode.order ? cartOf(");
  assertStringIncludes(chat, "if (mode.order && ordered.length)");
  // the restaurant is known from shop_menu (kind food), with or without a conversation
  assertStringIncludes(chat, "const menu: ShopMenu | null = await getShopMenu(shop.slug)");
  assertStringIncludes(chat, "foodChatMode(Boolean(menu), food, Boolean(conversation))");
});

Deno.test("modes: every reason keeps the menu; an order only while accepting with a conversation", () => {
  assertEquals(foodChatMode(true, { enabled: true, accepting: true, reason: null }, true), { menu: true, order: true, reason: null });
  assertEquals(foodChatMode(true, { enabled: true, accepting: false, reason: "paused" }, true), { menu: true, order: false, reason: "paused" });
  assertEquals(foodChatMode(true, { enabled: true, accepting: false, reason: "cutoff" }, true), { menu: true, order: false, reason: "cutoff" });
  assertEquals(foodChatMode(true, { enabled: true, accepting: false, reason: "sms_quota" }, true), { menu: true, order: false, reason: "sms_quota" });
  // ordering switched off (or no plan): food_state says enabled false — the menu only
  assertEquals(foodChatMode(true, { enabled: false }, true), { menu: true, order: false, reason: "off" });
  assertEquals(foodChatMode(true, null, false), { menu: true, order: false, reason: "off" });
  // accepting, but no conversation for the SMS code: the menu only
  assertEquals(foodChatMode(true, { enabled: true, accepting: true }, false), { menu: true, order: false, reason: "off" });
  // a shop that is not a restaurant and takes no food orders: nothing
  assertEquals(foodChatMode(false, { enabled: false }, true), { menu: false, order: false, reason: null });
  // an open restaurant: f-refs the cart accepts
  const open = hawai(foodChatMode(true, { enabled: true, accepting: true }, true), null);
  assertEquals(open.accepting, true);
  assert((open.items as { ref: string }[]).every((i) => i.ref.startsWith("f")));
});

Deno.test("paused: \"Momentálne neprijímame objednávky\" without a time; the dishes still with their prices", () => {
  const mode = foodChatMode(true, { enabled: true, accepting: false, reason: "paused" }, true);
  const sentence = closedSentence("paused", { time: "12:00", inDays: 1, day: "sat" }, SK);
  assertEquals(sentence, "Momentálne neprijímame objednávky.");
  assertEquals(closedSentence("sms_quota", null, SK), sentence);
  const result = hawai(mode, sentence);
  assertEquals(result.say_first, "Momentálne neprijímame objednávky.");
  assertEquals((result.items as { price: string }[])[0].price, "8,90 €");
});

Deno.test("cutoff: \"Dnes už objednávky neprijímame, znova <deň> od <čas>.\" — the opening after today's closing", () => {
  // Saturday 21:50: open until 22:00, the last order time passed; Sunday closed → Monday 11:00
  const next = nextOpening(input(), new Date("2026-11-07T20:50:00Z"));
  assertEquals(next, { time: "11:00", inDays: 2, day: "mon" });
  assertEquals(closedSentence("cutoff", next, SK), "Dnes už objednávky neprijímame, znova v pondelok od 11:00.");
  // a lunch break: today again
  const split: OpeningHours = { fri: [["11:00", "14:00"], ["16:00", "22:00"]] };
  const lunch = nextOpening(input(split), new Date("2026-11-06T13:30:00Z")); // 14:30 in Bratislava
  assertEquals(lunch, { time: "16:00", inDays: 0, day: "fri" });
  assertEquals(closedSentence("closed", lunch, SK), "Teraz máme zatvorené, objednávky prijímame znova dnes od 16:00.");
  // unknown (no hours): the sentence without a time
  assertEquals(nextOpening(input({}), new Date("2026-11-06T22:00:00Z")), null);
  assertEquals(closedSentence("closed", null, SK), "Teraz máme zatvorené.");
  assertEquals(closedSentence("cutoff", null, SK), "Dnes už objednávky neprijímame.");
});

Deno.test("off: the menu only, never an order", () => {
  const mode = foodChatMode(true, { enabled: false }, true);
  const sentence = closedSentence("off", null, SK);
  assertEquals(sentence, "Objednávky tu neprijímame, ale menu vám rád ukážem.");
  const prompt = notOrderingPrompt("off", sentence, SK.food_sold_out, false).join("\n");
  assertStringIncludes(prompt, "Never offer or take an order: show the menu only.");
  const result = hawai(mode, sentence);
  assertEquals(result.not_accepting, "off");
  assert((result.items as { ref: string }[]).every((i) => i.ref.startsWith("m")));
});

Deno.test("a dish sold out today is \"Vypredané dnes\"", () => {
  const items = menuToolLines(MENU, [SOUP], refs(false), price);
  assertEquals(items, [{ ref: "m1", name: "Gulášová polievka", category: "Polievky", price: "3,90 €", sold_out: true }]);
  const result = menuToolResult("gulas", foodChatMode(true, { enabled: false }, true), items, { soldOut: SK.food_sold_out });
  assertEquals(result.sold_out_means, "Vypredané dnes");
  assertStringIncludes(notOrderingPrompt("closed", "x", SK.food_sold_out, true).join("\n"), "\"Vypredané dnes\": say so");
  // food_menu's own mark wins over the page's
  assertEquals(menuToolLines(MENU, [HAWAII], refs(true), price, (id) => id === H45)[1].sold_out, true);
});

Deno.test("the call link only for a valid E.164 number (crm_phone's rule)", () => {
  assertEquals(phoneE164("0905 123 456", "SK"), "+421905123456");
  assertEquals(phoneE164("+421 905 123 456", "SK"), "+421905123456");
  assertEquals(phoneE164("00421905123456", "CZ"), "+421905123456");
  assertEquals(phoneE164("06 30 123 4567", "HU"), "+36301234567");
  assertEquals(phoneE164("06 123 4567", "IT"), "+39061234567");
  assertEquals(phoneE164("(055) 123-45/67", "SK"), "+421551234567");
  // invalid: no number, letters, too short, a national number without a known country
  for (const [raw, country] of [[null, "SK"], ["", "SK"], ["zavolajte nám", "SK"], ["0905", "SK"], ["0905123456", null], ["0905123456", "US"], ["+0123456789", "SK"]] as const) {
    assertEquals(phoneE164(raw, country), null, `${raw} ${country}`);
  }
  // without a phone the prompt never offers a call
  assertStringIncludes(notOrderingPrompt("closed", "x", "y", false).join("\n"), "Never offer a phone number or a call");
  assertStringIncludes(notOrderingPrompt("closed", "x", "y", true).join("\n"), "offer to call the shop (call_shop)");
});

Deno.test("the chat shows the call link only with the E.164 number", async () => {
  const chat = await read("src/lib/shopChat.ts");
  assertStringIncludes(chat, "callShop: answer.call_shop ? phoneE164(shop.phone, shop.country) : null");
  assert(!chat.includes("callShop: answer.call_shop && shop.phone"), "the raw phone is never the link");
  assertStringIncludes(chat, "set call_shop to true${phone ? ` (the page shows the shop's phone: ${phone})` : \"\"}");
});

Deno.test("texts: the same keys and placeholders in sk, hu and en", () => {
  const keys = Object.keys(sk.chat).filter((k) => k.startsWith("food_"));
  assertEquals(keys.length, 17);
  for (const m of [hu, en] as { chat: Record<string, string> }[]) {
    for (const k of keys) {
      const marks = (t: string) => (t.match(/\{\w+\}/g) ?? []).sort().join();
      assert(m.chat[k], k);
      assertEquals(marks(m.chat[k]), marks((sk.chat as Record<string, string>)[k]), k);
    }
  }
  const next = { time: "12:00", inDays: 3, day: "sat" as const };
  assertEquals(whenText(next, texts(hu)), "szombaton 12:00 órától");
  assertEquals(whenText(next, texts(en)), "on Saturday from 12:00");
  assertEquals(closedSentence("closed", next, texts(en)), "We're closed right now; we take orders again on Saturday from 12:00.");
});
