import type { Ref } from "react";

/**
 * The shopping-list button in the assistant's header (2026-11-05, at the owner's request): left of the GDPR pill, 34 × 34
 * (the pill's height), the Zoznam tab's list icon, the round blue bubble with the pieces on its top-right corner. The
 * server's first view (`ShopAssistant`) draws it with an empty bubble (never a number: the list lives in the browser);
 * `ShopChat` draws the same box with the live count, so nothing moves when the chat takes over. No hooks: it is part of
 * the page's first HTML and of the chat.
 */
export function ListHeadButton({
  label,
  title,
  bubble = "",
  bubbleRef,
  onPress,
}: {
  label: string;
  title: string;
  bubble?: string;
  bubbleRef?: Ref<HTMLSpanElement>;
  onPress?: () => void;
}) {
  return (
    <button type="button" onClick={onPress} aria-label={label} title={title} className="ppi-ai-listhead" data-chat-list-button="head">
      <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" focusable="false">
        <path d="M9 6h11M9 12h11M9 18h11" />
        <circle cx="4.5" cy="6" r="1" fill="currentColor" />
        <circle cx="4.5" cy="12" r="1" fill="currentColor" />
        <circle cx="4.5" cy="18" r="1" fill="currentColor" />
      </svg>
      {/* empty = hidden (CSS :empty); the number only from the browser's list */}
      <span ref={bubbleRef} className="ppi-ai-bubble" aria-hidden="true" {...(bubble ? { "data-list-bubble": "" } : {})}>
        {bubble}
      </span>
    </button>
  );
}
