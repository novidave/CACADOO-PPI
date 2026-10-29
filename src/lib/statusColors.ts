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
