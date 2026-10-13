/**
 * Page sections from PDFs (database update 28): the rules the browser and the server share
 * (the database and the page-sections function check them again).
 */
export const POSITIONS = ["after_details", "after_map", "before_items", "end"] as const;
export type SectionPosition = (typeof POSITIONS)[number];
export const MAX_SECTIONS = 10;
export const MAX_PDF_BYTES = 10 * 1024 * 1024;
export const MAX_PDF_PAGES = 20;
