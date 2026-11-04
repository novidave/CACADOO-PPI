/**
 * The shop assistant's product photo (database update 78, 2026-11-04): the assistant NEVER shows a product photo on its
 * own — its normal tools (search_items, get_item) carry names, prices and stock only, no picture. Only when the
 * shopper asks to see one ("ukáž fotku", "ako to vyzerá", "mutasd a képét", "show me a picture" — any language) does it
 * call show_product_photo with the item's ref: the page then shows that product's photo (800 px) with a link to the
 * product page, or says the product has no photo yet (with the link too). The photo's address never goes to the AI;
 * the card is built on the server from the database's answer (item_photo), only for an item a tool of this request
 * returned. No imports: shopChat.ts and `productPhotos_test.ts` (Deno).
 */

export const PHOTO_TOOL_NAME = "show_product_photo";

/** At most this many photos in one answer. */
export const MAX_CHAT_PHOTOS = 3;

export const PHOTO_TOOL = {
  name: PHOTO_TOOL_NAME,
  description:
    "Shows the shopper the photo of ONE item of this shop, from an earlier search_items or get_item result. Use it " +
    "ONLY when the shopper explicitly asks to see a picture or how the item looks (in any language, e.g. \"ukáž " +
    "fotku\", \"ako to vyzerá\", \"show me a picture\"); never on your own and never for a list of items. Returns " +
    "whether the item has a photo: the page then shows it with a link to the product page, or says it has none.",
  strict: true,
  input_schema: {
    type: "object" as const,
    properties: { ref: { type: "string", description: "The item's ref from search_items, e.g. r3." } },
    required: ["ref"],
    additionalProperties: false,
  },
};

/** The system prompt's line about photos. */
export const PHOTO_RULE =
  "Product photos: never show or mention pictures on your own. Only when the shopper asks to see a picture of an " +
  `item (or how it looks), call ${PHOTO_TOOL_NAME} with its ref (search for it first if needed); if it has no photo, ` +
  "say so briefly — the page links the product either way.";

export interface ChatProductPhoto {
  /** The item's name as the card shows it. */
  name: string;
  /** The product page. */
  href: string;
  /** The 800 px picture, or null: the product has no photo yet. */
  src: string | null;
  width: number | null;
  height: number | null;
}

/** item_photo's answer (paths in the bucket). */
export interface StoredPhoto {
  small: string;
  large: string;
  width: number;
  height: number;
}

/** The card for one asked-for photo: the 800 px file's address, its size as shown (≤ 800 wide), the link. */
export function photoCard(item: { name: string; href: string }, photo: StoredPhoto | null, url: (path: string) => string): ChatProductPhoto {
  if (!photo) return { name: item.name, href: item.href, src: null, width: null, height: null };
  const width = Math.min(800, photo.width);
  return { name: item.name, href: item.href, src: url(photo.small), width, height: Math.max(1, Math.round((photo.height * width) / photo.width)) };
}

/**
 * The photos an answer shows: only from show_product_photo calls of this request whose ref a tool returned, each
 * item once, at most MAX_CHAT_PHOTOS. `asked` = the calls' refs in their order; `cards` = ref → its card.
 */
export function shownPhotos(asked: string[], cards: Map<string, ChatProductPhoto>): ChatProductPhoto[] {
  const seen = new Set<string>();
  const out: ChatProductPhoto[] = [];
  for (const ref of asked) {
    const card = cards.get(ref);
    if (!card || seen.has(card.href)) continue;
    seen.add(card.href);
    out.push(card);
    if (out.length >= MAX_CHAT_PHOTOS) break;
  }
  return out;
}
