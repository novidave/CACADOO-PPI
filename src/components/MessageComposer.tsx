"use client";

import { useActionState, useState } from "react";
import { previewMessage, sendMessage, type ComposeState } from "@/app/[lang]/(account)/dashboard/contacts/actions";
import { SMS_MAX, smsParts, TEMPLATE_VARIABLES, variableToken } from "@/lib/crm";

export interface ComposerTemplate {
  id: string;
  name: string;
  subject: string;
  body: string;
}

/** Every text it shows (the page passes `dict.contacts`). */
export type ComposerTexts = Record<string, string>;

const fill = (text: string, values: Record<string, string | number>) =>
  text.replace(/\{(\w+)\}/g, (all, key: string) => (key in values ? String(values[key]) : all));

/**
 * "Poslať správu" on a contact card: SMS or e-mail, an e-mail template (its subject and text are copied in to edit),
 * the variables to use, the SMS length in parts. "Náhľad" shows the message exactly as the database fills it in
 * (owner_message_preview); only then "Odoslať" sends it through crm-messages (written down first, then sent).
 */
export function MessageComposer({
  lang,
  contactId,
  hasPhone,
  hasEmail,
  emailReady,
  smsLive,
  templates,
  texts,
}: {
  lang: string;
  contactId: string;
  hasPhone: boolean;
  hasEmail: boolean;
  emailReady: boolean;
  smsLive: boolean;
  templates: ComposerTemplate[];
  texts: ComposerTexts;
}) {
  const [channel, setChannel] = useState<"sms" | "email">(hasPhone ? "sms" : "email");
  const [template, setTemplate] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
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
  const input = "rounded border border-line px-3 py-2 outline-none focus:border-foreground";
  const button = "min-h-11 rounded border px-4 font-medium disabled:text-muted";
  const hidden = (
    <>
      <input type="hidden" name="lang" value={lang} />
      <input type="hidden" name="contact_id" value={contactId} />
      <input type="hidden" name="channel" value={channel} />
      <input type="hidden" name="template_id" value={channel === "email" ? template : ""} />
    </>
  );

  if (state.step === "done") {
    return (
      <form action={dispatch} className="flex flex-col gap-3 border border-line p-3" data-composer="done">
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
      <form action={dispatch} className="flex flex-col gap-3 border border-foreground p-3" data-composer="preview">
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
    <form action={dispatch} className="flex flex-col gap-3 border border-line p-3" data-composer="edit">
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
      {channel === "email" && templates.length > 0 && (
        <label className="flex flex-col gap-1">
          <span className="text-sm">{texts.template}</span>
          <select
            value={template}
            onChange={(e) => {
              const picked = templates.find((t) => t.id === e.target.value);
              setTemplate(e.target.value);
              if (picked) {
                setSubject(picked.subject);
                setBody(picked.body);
              }
            }}
            className={`${input} bg-white`}
            data-template-pick
          >
            <option value="">{texts.no_template}</option>
            {templates.map((t) => (
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
          <input name="subject" value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={200} className={input} />
        </label>
      )}
      <label className="flex flex-col gap-1">
        <span className="text-sm">{texts.body}</span>
        <textarea
          name="body"
          value={body}
          onChange={(e) => setBody(e.target.value)}
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
      <details className="text-xs">
        <summary className="cursor-pointer text-muted">{texts.variables}</summary>
        <ul className="mt-1 flex flex-col gap-0.5">
          {TEMPLATE_VARIABLES.map((v) => (
            <li key={v}>
              <code className="font-mono">{variableToken(v)}</code> <span className="text-muted">– {texts[`var_${v}`]}</span>
            </li>
          ))}
        </ul>
      </details>
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
