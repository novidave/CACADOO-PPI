import Link from "next/link";

/**
 * The shop assistant's heading (Screen 11): the orange sparkle, the title, and the blue "GDPR" pill in its right corner
 * (at the owner's request, 2026-10-27; a light shine sweeps across it, solid blue while open): the small print — what is
 * stored for the shop, the file limits, "Answers are written by AI" — opens under the heading only when tapped. Plain `<details>`, so it works without JavaScript and in both the first view
 * (`ShopAssistant`) and the chat (`ShopChat`). The section around it must be `relative`.
 */
export function AssistantHeading({
  title,
  lang,
  shopName,
  archive,
  labels,
}: {
  title: string;
  lang: string;
  shopName: string;
  archive: boolean;
  labels: Record<string, string>;
}) {
  return (
    <>
      <div className="ppi-ai-head">
        <span className="ppi-ai-spark" aria-hidden="true">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" focusable="false">
            <path d="M12 3l1.9 4.6L18.5 9.5l-4.6 1.9L12 16l-1.9-4.6L5.5 9.5l4.6-1.9z" />
            <path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z" />
          </svg>
        </span>
        <h2 id="assistant-heading" className="text-base leading-tight font-bold">
          {title}
        </h2>
      </div>
      <details data-chat-gdpr>
        <summary className="ppi-gdpr-btn" aria-label={labels.gdpr_label}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
            <path d="M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6z" />
            <path className="ppi-gdpr-check" d="M9 12l2 2 4-4" />
          </svg>
          {labels.gdpr}
        </summary>
        <div className="ppi-gdpr-panel flex flex-col gap-1" data-chat-privacy>
          {archive && (
            <p>
              {labels.privacy_notice.replace("{shop}", shopName)}{" "}
              <Link href={`/${lang}/sukromie-asistent`} className="underline underline-offset-4">
                {labels.privacy_more}
              </Link>
            </p>
          )}
          <p>
            {archive ? labels.files_note : labels.photo_note} {labels.note}
          </p>
        </div>
      </details>
    </>
  );
}
