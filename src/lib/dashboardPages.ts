/**
 * Môj obchod's pages: "Môj obchod" (stock file columns, details, logo, items, plan, delete), "Obsah stránky" (the
 * shop page's slider and its library of files, database update 38), "Asistent" (its settings, the conversations with their
 * cloud folder, the private folders), "Jazyky a inventár" (update 40: the shop's languages, the stock file's columns, the
 * items and their translations) and "Priečinok s exportom" (the export folder, the last stock files and, update 43, the
 * danger zone of the stock). A form
 * sends the owner back to the page and section ("at") it came from; a section that moved keeps working under its
 * old name (old links, e-mails, the cloud sign-in coming back with ?at=cloud).
 */
export const ASSISTANT_SECTIONS = ["assistant", "conversations", "cloud", "docs", "private"];
/** "Posledné nahrané súbory" lives with the stock file again since update 43, next to "Nebezpečná zóna – sklad". */
export const EXPORT_SECTIONS = ["export", "imports", "conversations-pc", "danger"];
export const CONTENT_SECTIONS = ["content", "library", "sections"];
/** "Jazyky a inventár" (update 40): the shop's languages, its stock file's columns, its items, every translation. */
export const TRANSLATION_SECTIONS = ["languages", "columns", "files", "items", "translations"];

/** Old names of sections that were merged into another one (the anchor and the open dropdown follow). */
const MERGED: Record<string, string> = { private: "docs", sections: "content" };

/** The section a name stands for now ("private" → "docs"; "cloud" is a part of "conversations" with its own anchor). */
export function sectionId(at: string): string {
  return MERGED[at] ?? at;
}

export function sectionPath(lang: string, at: string): string {
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
