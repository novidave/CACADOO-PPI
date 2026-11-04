import type { MenuKey } from "@/lib/dashboardPages";

/**
 * The owner menu's icons (back-end layout, 2026-11-03): one SVG path each, drawn 22 px with a 2 px outline in the
 * text's colour (`currentColor`), the shapes of the canvas's Nav component. No icon library.
 */
export const NAV_ICONS: Record<MenuKey | "signout" | "menu" | "close" | "open" | "chevron" | "group_page" | "group_account" | "collapse", string> = {
  sklad: "M3 8l9-5 9 5v8l-9 5-9-5zM3 8l9 5 9-5M12 13v8",
  food: "M6 8h12l-1 12H7zM9 8a3 3 0 0 1 6 0",
  bookings: "M5 5h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zM3 10h18M8 3v4M16 3v4",
  crm: "M9 11a4 4 0 1 0 0-8a4 4 0 1 0 0 8zM2 21a7 7 0 0 1 14 0M16 3.5a4 4 0 0 1 0 7M18 14a6 6 0 0 1 4 7",
  shop: "M4 10h16v10H4zM3 10l2-6h14l2 6",
  content: "M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM3 16l5-5 5 5 3-3 5 5",
  blog: "M5 5h14M5 10h14M5 15h9",
  assistant: "M4 5h16v11H9l-5 4z",
  translations: "M3 12a9 9 0 1 0 18 0a9 9 0 1 0-18 0M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18",
  export: "M3 6h6l2 2h10v11H3z",
  plan: "M5 6h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2zM3 10h18",
  legal: "M6 3h9l4 4v14H6zM9 12h7M9 16h7",
  password: "M7 11h10a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2zM8 11V8a4 4 0 0 1 8 0v3",
  hours_sms: "M3 12a9 9 0 1 0 18 0a9 9 0 1 0-18 0M12 7v5l3 2",
  // not on the canvas: the AI assistants and Telegram (a paper plane), the admin pages (a shield)
  ai: "M22 2L11 13M22 2l-7 20-4-9-9-4z",
  admin_domains: "M12 3l8 3v6c0 5-3.5 8-8 9c-4.5-1-8-4-8-9V6z",
  admin_translations: "M12 3l8 3v6c0 5-3.5 8-8 9c-4.5-1-8-4-8-9V6zM9 12h6",
  signout: "M15 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4M10 17l5-5-5-5M15 12H3",
  menu: "M4 6h16M4 12h16M4 18h16",
  close: "M6 6l12 12M18 6L6 18",
  open: "M14 4h6v6M20 4l-9 9M18 14v6H4V6h6",
  chevron: "M6 9l6 6 6-6",
  // the menu's group heads (a page, a gear) and "Zbaliť menu" (two chevrons; turned round when the menu is collapsed)
  group_page: "M4 4h16v16H4zM4 9h16M9 9v11",
  group_account: "M12 15a3 3 0 1 0 0-6a3 3 0 1 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z",
  collapse: "M11 17l-5-5 5-5M18 17l-5-5 5-5",
};
