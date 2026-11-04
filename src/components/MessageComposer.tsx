"use client";

import { useActionState, useRef, useState } from "react";
import { previewMessage, sendMessage, type ComposeState } from "@/app/[lang]/(account)/dashboard/contacts/actions";
import { SMS_MAX, smsParts } from "@/lib/crm";
import { fieldClass } from "@/components/owner/ui";
import { GrammarFix, TagChips, TagPreview } from "@/components/owner/MessageTools";

export interface ComposerTemplate {
  id: string;
  name: string;
  /** update 63: sms, email or both (older templates: e-mail) */
  channel?: "sms" | "email" | "both" | null;
  subject: string | null;
  body: string;
}

/** Every text it shows (the page passes `dict.contacts`). */
export type ComposerTexts = Record<string, string>;

const fill = (text: string, values: Record<string, string | number>) =>
  text.replace(/\{(\w+)\}/g, (all, key: string) => (key in values ? String(values[key]) : all));

/**
 * "Poslať správu" — one composer for CRM → Správy, a contact's Správy and a conversation's answer: SMS or e-mail, a
 * template (its subject and text are copied in to edit), the variables as tags (a click or Tab + Enter puts one at the
 * cursor, a drag drops it where it is let go; the live line under the text shows them as pills and names an unknown
 * one), "Opraviť gramatiku" (2026-11-04, paid), the SMS length in parts. "Náhľad" shows the message exactly as the
 * database fills it in (owner_message_preview); only then "Odoslať" sends it through crm-messages (written down first,
 * then sent).
 */
export function MessageComposer({
  lang,
  contactId,
  conversationId,
  hasPhone,
  hasEmail,
  emailReady,
  smsLive,
  templates,
  texts,
  shopId,
  grammarOn = false,
}: {
  lang: string;
  contactId: string;
  /** Update 63: an answer inside this conversation (crm-messages "reply": it becomes one of its messages). */
  conversationId?: string;
  hasPhone: boolean;
  hasEmail: boolean;
  emailReady: boolean;
  smsLive: boolean;
  templates: ComposerTemplate[];
  texts: ComposerTexts;
  /** the shop (for "Opraviť gramatiku": its daily limit and plan) */
  shopId?: string;
  /** the server has the AI key (the button is hidden without it) */
  grammarOn?: boolean;
}) {
  const [channel, setChannel] = useState<"sms" | "email">(hasPhone ? "sms" : "email");
  const [template, setTemplate] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const subjectRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const lastField = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const [state, dispatch, pending] = useActionState(async (previous: ComposeState, form: FormData): Promise<ComposeState> => {
    const intent = form.get("intent");
    if (intent === "edit") return { step: "edit" };
    if (intent === "new") {
      setTemplate("");
      setSubject("");
      setBody("");
      return { step: "edit" };
    }
    return intent === "send" ? await sendMessage(previous, form) : await previewMessage(previous, form);
  }, { step: "edit" });

  const parts = smsParts(body);
  // the templates for the chosen channel (an older template without a channel is an e-mail one)
  const usable = templates.filter((t) => t.channel === "both" || (t.channel ?? "email") === channel);
  const input = fieldClass;
  const button = "min-h-11 rounded border px-4 font-medium disabled:text-muted";
  const hidden = (
    <>
      <input type="hidden" name="lang" value={lang} />
      <input type="hidden" name="contact_id" value={contactId} />
      <input type="hidden" name="channel" value={channel} />
      <input type="hidden" name="template_id" value={usable.some((t) => t.id === template) ? template : ""} />
      {conversationId && <input type="hidden" name="conversation_id" value={conversationId} />}
    </>
  );

  // Each step is its own <form> (a key): the site's double-tap guard (TapFeedback) marks a sent form busy, and a reused
  // form would keep that mark, so "Odoslať" after "Náhľad" would wait 15 s.
  if (state.step === "done") {
    return (
      <form key="done" action={dispatch} className="flex flex-col gap-3 border border-line p-3" data-composer="done">
        <p role="status" className="font-medium" data-compose-result={state.message}>
          {texts[state.message ?? "sent"]}
        </p>
        <button type="submit" name="intent" value="new" className={`${button} self-start border-foreground`}>
          {texts.compose_title}
        </button>
      </form>
    );
  }

  if (state.step === "preview" && state.preview) {
    return (
      <form key="preview" action={dispatch} className="flex flex-col gap-3 border border-foreground p-3" data-composer="preview">
        {hidden}
        <input type="hidden" name="subject" value={subject} />
        <input type="hidden" name="body" value={body} />
        <h3 className="font-semibold">{texts.preview_title}</h3>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-muted">{texts.channel}</dt>
          <dd>{channel === "sms" ? texts.channel_sms : texts.channel_email}</dd>
          <dt className="text-muted">{texts.to}</dt>
          <dd className="break-all" data-preview-to>
            {state.preview.recipient}
          </dd>
          {state.preview.subject && (
            <>
              <dt className="text-muted">{texts.subject}</dt>
              <dd className="break-words" data-preview-subject>
                {state.preview.subject}
              </dd>
            </>
          )}
        </dl>
        <p className="whitespace-pre-line break-words border border-line p-3" data-preview-body>
          {state.preview.body}
        </p>
        {channel === "sms" && (
          <p className="text-xs text-muted">
            {fill(texts.sms_chars, { n: smsParts(state.preview.body).chars, parts: smsParts(state.preview.body).parts })}
            {!smsLive && ` · ${texts.sms_test_note}`}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <button type="submit" name="intent" value="send" disabled={pending} className={`${button} border-foreground`} data-send>
            {pending ? texts.sending : texts.send}
          </button>
          <button type="submit" name="intent" value="edit" disabled={pending} className={`${button} border-line`}>
            {texts.edit}
          </button>
        </div>
      </form>
    );
  }

  return (
    <form key="edit" action={dispatch} className="flex flex-col gap-3 border border-line p-3" data-composer="edit">
      {hidden}
      <h3 className="font-semibold">{texts.compose_title}</h3>
      {state.message && (
        <p role="alert" className="text-sm font-semibold" data-compose-error={state.message}>
          {texts[state.message] ?? texts.err_send_failed}
        </p>
      )}
      <fieldset className="flex flex-wrap gap-4">
        <legend className="mb-1 text-sm">{texts.channel}</legend>
        {(["sms", "email"] as const).map((c) => {
          const off = c === "sms" ? !hasPhone : !hasEmail;
          return (
            <label key={c} className={`flex min-h-11 items-center gap-2 text-sm ${off ? "text-muted" : ""}`}>
              <input
                type="radio"
                name="channel_pick"
                value={c}
                checked={channel === c}
                disabled={off}
                onChange={() => setChannel(c)}
                className="h-4 w-4 accent-foreground"
              />
              {c === "sms" ? texts.channel_sms : texts.channel_email}
              {off && <span className="text-xs">({c === "sms" ? texts.no_phone : texts.no_email})</span>}
            </label>
          );
        })}
      </fieldset>
      {channel === "email" && !emailReady && <p className="text-sm">{texts.email_off}</p>}
      {channel === "email" && emailReady && <p className="text-xs text-muted">{texts.email_from}</p>}
      {channel === "sms" && !smsLive && <p className="text-xs text-muted">{texts.sms_test_note}</p>}
      {usable.length > 0 && (
        <label className="flex flex-col gap-1">
          <span className="text-sm">{texts.template}</span>
          <select
            value={template}
            onChange={(e) => {
              const picked = usable.find((t) => t.id === e.target.value);
              setTemplate(e.target.value);
              if (picked) {
                setSubject(picked.subject ?? "");
                setBody(picked.body);
              }
            }}
            className={`${input} bg-white`}
            data-template-pick
          >
            <option value="">{texts.no_template}</option>
            {usable.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {channel === "email" && (
        <label className="flex flex-col gap-1">
          <span className="text-sm">{texts.subject}</span>
          <input
            ref={subjectRef}
            name="subject"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            onFocus={(e) => (lastField.current = e.currentTarget)}
            maxLength={200}
            className={input}
            data-compose-subject
          />
        </label>
      )}
      <label className="flex flex-col gap-1">
        <span className="text-sm">{texts.body}</span>
        <textarea
          ref={bodyRef}
          name="body"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onFocus={(e) => (lastField.current = e.currentTarget)}
          rows={channel === "sms" ? 4 : 8}
          maxLength={channel === "sms" ? SMS_MAX : 10000}
          className={input}
          data-compose-body
        />
      </label>
      {channel === "sms" && (
        <p className="text-xs text-muted" aria-live="polite">
          {fill(texts.sms_chars, { n: parts.chars, parts: parts.parts })}
        </p>
      )}
      <TagPreview text={body} texts={texts} />
      <TagChips texts={texts} target={() => (lastField.current?.isConnected ? lastField.current : bodyRef.current)} />
      {grammarOn && shopId && (
        <GrammarFix
          shopId={shopId}
          channel={channel}
          texts={texts}
          read={() => ({ text: body, subject: channel === "email" ? subject : null })}
          apply={(text, s) => {
            setBody(text);
            if (s !== null) setSubject(s);
          }}
        />
      )}
      <button
        type="submit"
        name="intent"
        value="preview"
        disabled={pending || (channel === "email" && !emailReady)}
        className={`${button} self-start border-foreground`}
        data-preview
      >
        {pending ? texts.sending : texts.preview}
      </button>
    </form>
  );
}
