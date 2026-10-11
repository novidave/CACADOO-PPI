/**
 * Môj obchod is three pages: "Môj obchod" (stock file columns, details, logo, items, plan,
 * delete), "AI asistent" (the assistant, its conversations, the cloud folder, documents)
 * and "Priečinok s exportom" (the export folder, files in private folders, the last stock
 * files). A form sends the owner back to the page and section ("at") it came from.
 */
export const ASSISTANT_SECTIONS = ["assistant", "conversations", "cloud", "docs"];
export const EXPORT_SECTIONS = ["export", "private", "imports"];

export function sectionPath(lang: string, at: string): string {
  if (ASSISTANT_SECTIONS.includes(at)) return `/${lang}/dashboard/assistant`;
  if (EXPORT_SECTIONS.includes(at)) return `/${lang}/sync`;
  return `/${lang}/dashboard`;
}

/** The page of a section with its query and anchor: "/sk/dashboard/assistant?shop=x&at=cloud#cloud". */
export function sectionUrl(lang: string, at: string, query: Record<string, string>): string {
  const params = new URLSearchParams({ ...query, ...(at ? { at } : {}) });
  return `${sectionPath(lang, at)}?${params}${at ? `#${at}` : ""}`;
}
