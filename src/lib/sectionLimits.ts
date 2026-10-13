/**
 * Page sections from PDFs (database updates 28–30): the rules the browser and the server share
 * (the database and the page-sections function check them again).
 */
export const POSITIONS = ["after_details", "after_map", "before_items", "end"] as const;
export type SectionPosition = (typeof POSITIONS)[number];

/**
 * A shop's limits: its plan's number of sections, pages and bytes per PDF. Since database update
 * 30 they are the admin's settings (section_limits, read through owner_section_limits()); free
 * shops have sections too.
 */
export interface SectionLimits {
  plan: "free" | "pro";
  maxSections: number;
  maxPages: number;
  maxBytes: number;
}

/** Pro's limits before database update 30 (the database then gives none; free shops have no sections). */
export const PRO_BEFORE_30: SectionLimits = { plan: "pro", maxSections: 10, maxPages: 20, maxBytes: 10 * 1024 * 1024 };

export const megabytes = (bytes: number) => Math.round(bytes / 1048576);
