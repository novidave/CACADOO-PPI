import { AssistantBoot, type AssistantProps } from "./AssistantBoot";
import { AssistantHeading } from "./AssistantHeading";

/**
 * The shop assistant's first view (performance pass, Screen 11): the same box, texts and field as `ShopChat`, written
 * on the server as plain HTML, so the page looks the same at once and nothing moves; the assistant's own code (chat,
 * files, PDFs, access keys) is not part of the page's first JavaScript — `AssistantBoot` loads it and carries over
 * what was typed, the cursor, an opened key row and a tapped "Poslať".
 */
export function ShopAssistant(props: AssistantProps) {
  const { lang, shopName, keys, labels, buttonLabel, welcome, archive = false } = props;
  const title = buttonLabel?.trim() || labels.title;
  const intro = welcome?.trim() || labels.intro;
  return (
    <AssistantBoot props={props}>
      <section className="ppi-ai" data-pop aria-labelledby="assistant-heading" data-assistant>
        <AssistantHeading title={title} lang={lang} shopName={shopName} archive={archive} labels={labels} />
        <div className="flex flex-col px-[13px] py-[14px]">
          <p className="text-sm leading-normal text-[#5B6472]" data-chat-welcome>
            {intro}
          </p>
          <div className="flex max-h-[55vh] flex-col gap-3 overflow-y-auto overscroll-contain md:max-h-[65vh]" data-chat-log />
          <form className="flex flex-col">
            <label htmlFor="assistant-question" className="sr-only">
              {labels.placeholder}
            </label>
            <textarea
              id="assistant-question"
              rows={2}
              maxLength={1500}
              placeholder={labels.placeholder}
              aria-describedby="assistant-empty"
              className="ppi-ai-input mt-4"
            />
            <p id="assistant-empty" role="alert" hidden className="mt-1.5 text-[13px] font-semibold text-[#DC2626]" data-chat-empty>
              {labels.empty_question}
            </p>
            <div className="mt-2.5 flex flex-wrap items-center gap-[9px]">
              <button type="button" className="ppi-ai-attach" data-chat-attach>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#F57C20" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
                  <path d="M21.4 11.1l-9.2 9.2a6 6 0 01-8.5-8.5l9.2-9.2a4 4 0 015.7 5.7l-9.2 9.2a2 2 0 01-2.8-2.8l8.5-8.5" />
                </svg>
                {labels.photo}
              </button>
              <button type="submit" className="ppi-ai-send" data-chat-send>
                {labels.send}
                <svg className="ppi-ai-plane" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
                  <path d="M22 2L11 13" />
                  <path d="M22 2l-7 20-4-9-9-4z" />
                </svg>
              </button>
            </div>
          </form>
        </div>
      </section>
      {keys && (
        // The same row as `KeyRow`; the key field comes with the assistant's code (opening the row loads it).
        <div className="ppi-key" data-key-access>
          <button type="button" className="ppi-key-row" aria-expanded="false" aria-controls="key-body-first" data-key-toggle>
            <span className="ppi-key-icon" aria-hidden="true">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" focusable="false">
                <circle cx="8" cy="15" r="4.5" />
                <path d="M11.2 11.8L20 3M16.5 6.5l2.5 2.5M14.3 8.7l1.8 1.8" />
              </svg>
            </span>
            {labels.key_have}
            <span className="ppi-key-chev" aria-hidden="true">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#1A1A1A" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" focusable="false">
                <path d="M6 9l6 6 6-6" />
              </svg>
            </span>
          </button>
          <div id="key-body-first" className="ppi-key-body" />
        </div>
      )}
    </AssistantBoot>
  );
}
