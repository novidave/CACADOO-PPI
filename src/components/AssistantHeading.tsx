import Link from "next/link";

/**
 * The shop assistant's heading with the blue "GDPR" link in its right corner (at the owner's request, 2026-10-27):
 * the small print — what is stored for the shop, the file limits, "Answers are written by AI" — opens under the
 * heading only when the shopper taps it. Plain `<details>`, so it works without JavaScript and in both the first view
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
      <h2 id="assistant-heading" className="p-3 pr-20 font-semibold">
        {title}
      </h2>
      <details data-chat-gdpr>
        <summary
          className="absolute top-1 right-1 flex min-h-11 cursor-pointer list-none items-center px-2 text-sm text-blue-700 underline underline-offset-4 hover:text-blue-900 [&::-webkit-details-marker]:hidden"
          aria-label={labels.gdpr_label}
        >
          {labels.gdpr}
        </summary>
        <div className="flex flex-col gap-1 border-t border-line p-3 text-xs text-muted" data-chat-privacy>
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
