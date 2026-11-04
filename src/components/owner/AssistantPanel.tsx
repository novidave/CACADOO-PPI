"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useSyncExternalStore } from "react";
import { isBareScreen, withoutLang } from "@/lib/dashboardPages";
import { AssistantChat, type ChatTexts } from "./AssistantChat";
import { aiOpenNow, setAiOpen, subscribeAi } from "./OwnerNav";

/**
 * The AI pomocník on a computer (2026-11-04): a 380 px panel on the RIGHT of the owner shell, full height, the page
 * between the menu and it (it never covers the tabs). The menu's "AI pomocník" switch opens and closes it; the choice is
 * kept on this device and set before the first paint (globals.css `.ppi-ai-panel`). It lives in the account layout, so
 * the conversation stays while the owner moves between pages. Esc closes it and the focus goes back to the switch.
 * Not on phones and tablets (there it is the page /dashboard/pomocnik), the QR terminal or the pomocník's own page.
 */
export function AssistantPanel({ lang, shops, texts }: { lang: string; shops: string[]; texts: ChatTexts }) {
  const open = useSyncExternalStore(subscribeAi, aiOpenNow, () => false);
  const path = withoutLang(usePathname() ?? "");
  // Esc closes the open panel while the focus is in it or nowhere in particular (after moving to another page)
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const at = document.activeElement;
      if (at && at !== document.body && !at.closest("[data-ai-panel]")) return;
      setAiOpen(false);
      document.querySelector<HTMLButtonElement>("[data-ai-toggle]")?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);
  const param = useSearchParams()?.get("shop") ?? "";
  if (isBareScreen(path) || path === "/dashboard/pomocnik" || shops.length === 0) return null;
  const shop = shops.includes(param) ? param : shops[0];
  const close = () => {
    setAiOpen(false);
    document.querySelector<HTMLButtonElement>("[data-ai-toggle]")?.focus();
  };
  return (
    <aside
      className="ppi-ai-panel sticky top-0 h-svh w-[380px] flex-none flex-col border-l border-[#E4E4E4] bg-white"
      aria-labelledby="ai-panel-title"
      data-ai-panel
    >
      {open && <AssistantChat lang={lang} shop={shop} texts={texts} variant="panel" onClose={close} />}
    </aside>
  );
}
