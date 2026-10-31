import type { StatusState } from "./hours";

/**
 * Colours of the status dots (the one colour exception besides the logo; always with the text). Their own small file:
 * a page whose status line only refreshes later (`@/components/ShopStatusLine`) does not load the hours rules for them.
 */
export const STATUS_COLORS: Record<StatusState, string> = {
  open: "#1E9E5A",
  break: "#2F6FED",
  closed: "#D64545",
  holiday: "#F2B705",
  no_hours: "#9AA5B1",
};

/**
 * The status pill of the shop page's opening hours (Screen 11, 2026-10-31): a pale background and dark text of the
 * status's hue; the dot inside it stays the status dot above. Always with the status in words.
 */
export const STATUS_PILLS: Record<StatusState, { bg: string; fg: string }> = {
  open: { bg: "#E3F1EC", fg: "#1F6150" },
  break: { bg: "#E6EEFD", fg: "#1E4BB0" },
  closed: { bg: "#FBE7E7", fg: "#9B2C2C" },
  holiday: { bg: "#FDF3D3", fg: "#6B5310" },
  no_hours: { bg: "#EEF1F4", fg: "#4A5560" },
};
