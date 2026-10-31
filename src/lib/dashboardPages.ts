/**
 * Môj obchod's pages: "Môj obchod" (details, logo, plan, delete), "Obsah stránky" (the shop page's slider and its
 * library of files, database update 38), "Asistent" (its settings, the conversations with their cloud folder, the
 * private folders), "Jazyky a inventár" (update 40: "Tovar" with the products' translations, update 62: "Texty stránky") and "Priečinok s exportom" (the
 * stock folder, update 45's review after an upload with the languages and the columns, the translations folder, the
 * last stock files and, update 43, the danger zone of the stock). A form
 * sends the owner back to the page and section ("at") it came from; a section that moved keeps working under its
 * old name (old links, e-mails, the cloud sign-in coming back with ?at=cloud).
 */
export const ASSISTANT_SECTIONS = ["assistant", "conversations", "cloud", "docs", "private"];
/**
 * "Priečinok s exportom": the stock folder, "Po nahratí súboru" (update 45: the review card, the languages and the
 * stock file's columns), "Preklady v priečinku" (update 45: the translations folder and the stock files in other
 * languages), "Posledné nahrané súbory" (back here since update 43) and "Nebezpečná zóna – sklad".
 */
export const EXPORT_SECTIONS = ["source", "api", "pos", "export", "review", "trfolder", "imports", "conversations-pc", "danger"];
export const CONTENT_SECTIONS = ["content", "library", "sections"];
/**
 * "Jazyky a inventár" (update 40): "Tovar" = the products and every translation of them, "Texty stránky" = the
 * page's other texts in every language (update 62; it was "Preklady", which also listed the products). Languages,
 * columns and files moved to "Priečinok s exportom" in update 45.
 */
export const TRANSLATION_SECTIONS = ["items", "texts"];

/** Old names of sections that were merged into another one (the anchor and the open dropdown follow). */
const MERGED: Record<string, string> = {
  private: "docs",
  sections: "content",
  languages: "review",
  columns: "review",
  files: "trfolder",
  translations: "texts",
};

/** The section a name stands for now ("private" → "docs"; "cloud" is a part of "conversations" with its own anchor). */
export function sectionId(at: string): string {
  return MERGED[at] ?? at;
}

export function sectionPath(lang: string, name: string): string {
  const at = sectionId(name);
  if (ASSISTANT_SECTIONS.includes(at)) return `/${lang}/dashboard/assistant`;
  if (EXPORT_SECTIONS.includes(at)) return `/${lang}/sync`;
  if (CONTENT_SECTIONS.includes(at)) return `/${lang}/dashboard/content`;
  if (TRANSLATION_SECTIONS.includes(at)) return `/${lang}/dashboard/translations`;
  return `/${lang}/dashboard`;
}

/** The page of a section with its query and anchor: "/sk/dashboard/assistant?shop=x&at=cloud#cloud". */
export function sectionUrl(lang: string, at: string, query: Record<string, string>): string {
  const id = sectionId(at);
  const params = new URLSearchParams({ ...query, ...(id ? { at: id } : {}) });
  return `${sectionPath(lang, at)}?${params}${id ? `#${id}` : ""}`;
}

const PAGE_SECTIONS: Record<"dashboard" | "sync" | "assistant" | "content" | "translations", string[]> = {
  dashboard: [],
  sync: EXPORT_SECTIONS,
  assistant: ASSISTANT_SECTIONS,
  content: CONTENT_SECTIONS,
  translations: TRANSLATION_SECTIONS,
};

/** Whether an address asks a page for a section that is elsewhere now, or by its old name (then it is forwarded). */
export function movedFrom(page: keyof typeof PAGE_SECTIONS, at: string): boolean {
  if (!at) return false;
  if (MERGED[at]) return true;
  return [...ASSISTANT_SECTIONS, ...EXPORT_SECTIONS, ...CONTENT_SECTIONS, ...TRANSLATION_SECTIONS].includes(at) && !PAGE_SECTIONS[page].includes(at);
}

/** The same address on the section's page now (every query parameter kept, `at` and the anchor renamed). */
export function forwardUrl(lang: string, at: string, sp: Record<string, string | string[] | undefined>): string {
  const query = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    for (const one of [v].flat()) if (typeof one === "string") query.append(k, k === "at" ? sectionId(one) : one);
  }
  return `${sectionPath(lang, at)}?${query}#${sectionId(at)}`;
}
