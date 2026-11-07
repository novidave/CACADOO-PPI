"use client";

import { useRouter } from "next/navigation";
import { useActionState, useCallback, useEffect, useRef, useState } from "react";
import { previewMessage, sendMessage, type ComposeState } from "@/app/[lang]/(account)/dashboard/contacts/actions";
import { clearDraft, saveDraft } from "@/app/[lang]/(account)/dashboard/crm/draftActions";
import { SMS_MAX } from "@/lib/crm";
import { draftKey, hasVariable } from "@/lib/crmInbox";
import type { ComposerTemplate } from "@/components/MessageComposer";
import { GrammarVortex } from "./GrammarVortex";
import { TagChips, TagPreview, useGrammarFix } from "./MessageTools";

type Channel = "sms" | "email";
export interface ReplyDraft {
  channel: Channel;
  subject: string | null;
  body: string;
  updated_at: string;
}

const fill = (text: string, values: Record<string, string | number>) =>
  String(text ?? "").replace(/\{(\w+)\}/g, (all, key: string) => (key in values ? String(values[key]) : all));

const readLocal = (id: string): (ReplyDraft & { saved?: boolean }) | null => {
  try {
    const raw = localStorage.getItem(draftKey(id));
    return raw ? (JSON.parse(raw) as ReplyDraft) : null;
  } catch {
    return null;
  }
};
const writeLocal = (id: string, d: ReplyDraft | null) => {
  try {
    if (d) localStorage.setItem(draftKey(id), JSON.stringify(d));
    else localStorage.removeItem(draftKey(id));
  } catch {
    // blocked storage: the server copy is all there is
  }
};

/**
 * CRM → Konverzácie: the reply at the bottom of the open conversation (2026-11-07; artboards 8 = SMS, 8b = e-mail).
 * Row 1: "SMS | E-mail" (only the channels the contact has), the star-vortex grammar button (icon only, update 76's
 * GrammarFix as it is; its before → after panel opens above the text) and "Vybrať šablónu ▾" (a real <select>: a
 * template fills the text and subject, then the select shows "Vybrať šablónu" again; it never sends). SMS: the text
 * (3 rows, grows to 6) with "Odoslať SMS" at its bottom, then one line "✓ Koncept uložený HH:MM · SMS: 88/100".
 * E-mail: Predmet, Správa (260 px), then "Koncept uložený HH:MM" and "Odoslať e-mail". Switching keeps the text.
 * "Premenné" (the tags) behind a small toggle; "Náhľad" first only when the text holds a variable. The DRAFT (update
 * 90) is saved 1 s after typing stops and at once on blur, on leaving the conversation, when the page is hidden or left
 * (sendBeacon); offline it waits in localStorage and goes with the next save. A sent reply clears it (crm-messages
 * "reply": the conversation's own contact, its quotas and log), then the page is drawn again with the message.
 */
export function ReplyBox({
  lang,
  conversationId,
  contactId,
  hasPhone,
  hasEmail,
  emailReady,
  smsLive,
  templates,
  texts,
  shopId,
  grammarOn,
  draft,
  smsLeft,
  timeZone,
}: {
  lang: string;
  conversationId: string;
  contactId: string;
  hasPhone: boolean;
  hasEmail: boolean;
  emailReady: boolean;
  smsLive: boolean;
  templates: ComposerTemplate[];
  texts: Record<string, string>;
  shopId: string;
  grammarOn: boolean;
  draft: ReplyDraft | null;
  smsLeft: { left: number; limit: number } | null;
  timeZone: string;
}) {
  const router = useRouter();
  const allowed = (c: Channel | undefined | null): c is Channel => (c === "sms" ? hasPhone : c === "email" ? hasEmail : false);
  const [channel, setChannel] = useState<Channel>(allowed(draft?.channel) ? draft!.channel : hasPhone ? "sms" : "email");
  const [subject, setSubject] = useState(draft?.subject ?? "");
  const [body, setBody] = useState(draft?.body ?? "");
  const [savedAt, setSavedAt] = useState<string | null>(draft?.updated_at ?? null);
  const [saving, setSaving] = useState(false);
  const [vars, setVars] = useState(false);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const lastField = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const timer = useRef<number | null>(null);
  const dirty = useRef(false);
  const latest = useRef({ channel, subject, body });
  useEffect(() => {
    latest.current = { channel, subject, body };
  }, [channel, subject, body]);

  // a copy that could not reach the server (offline) wins when it is newer than the server's draft
  useEffect(() => {
    const local = readLocal(conversationId);
    if (local && (!draft || Date.parse(local.updated_at) > Date.parse(draft.updated_at))) {
      queueMicrotask(() => {
        if (allowed(local.channel)) setChannel(local.channel);
        setSubject(local.subject ?? "");
        setBody(local.body);
        dirty.current = true;
      });
    }
    // only on opening this conversation
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId]);

  const hm = (iso: string) => new Intl.DateTimeFormat(lang, { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));

  const save = useCallback(async () => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = null;
    if (!dirty.current) return;
    dirty.current = false;
    const now = latest.current;
    setSaving(true);
    const res = await saveDraft({ conversationId, channel: now.channel, subject: now.subject, body: now.body }).catch(() => ({ ok: false as const }));
    setSaving(false);
    if (res.ok) {
      writeLocal(conversationId, null);
      setSavedAt(res.at);
    } else {
      // offline or refused: kept here, sent with the next save
      writeLocal(conversationId, { ...now, updated_at: new Date().toISOString() });
      dirty.current = true;
    }
  }, [conversationId]);

  /** The page is hidden, left or another conversation opens: the draft goes at once (a beacon survives the unload). */
  const flush = useCallback(() => {
    if (!dirty.current) return;
    const now = latest.current;
    const payload = JSON.stringify({ conversation_id: conversationId, channel: now.channel, subject: now.subject, body: now.body });
    writeLocal(conversationId, { ...now, updated_at: new Date().toISOString() });
    let sent = false;
    try {
      sent = navigator.sendBeacon?.("/api/owner/drafts", new Blob([payload], { type: "application/json" })) ?? false;
    } catch {
      sent = false;
    }
    if (!sent) void fetch("/api/owner/drafts", { method: "POST", body: payload, keepalive: true, headers: { "Content-Type": "application/json" } }).catch(() => null);
    dirty.current = false;
  }, [conversationId]);

  useEffect(() => {
    const hidden = () => {
      if (document.visibilityState === "hidden") flush();
    };
    document.addEventListener("visibilitychange", hidden);
    window.addEventListener("pagehide", flush);
    return () => {
      document.removeEventListener("visibilitychange", hidden);
      window.removeEventListener("pagehide", flush);
      // another conversation, tab or menu item opened (client navigation): the draft goes now
      flush();
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [flush]);

  const changed = () => {
    dirty.current = true;
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void save(), 1000);
  };

  const [state, dispatch, pending] = useActionState(async (previous: ComposeState, form: FormData): Promise<ComposeState> => {
    const intent = form.get("intent");
    if (intent === "edit") return { step: "edit" };
    if (intent === "preview") return await previewMessage(previous, form);
    const out = await sendMessage(previous, form);
    if (out.step === "done") {
      // sent (or written down in test mode): the draft goes, the message shows in the conversation
      if (timer.current) window.clearTimeout(timer.current);
      dirty.current = false;
      writeLocal(conversationId, null);
      await clearDraft(conversationId);
      setBody("");
      setSubject("");
      setSavedAt(null);
      router.refresh();
      return { step: "edit", message: out.message };
    }
    return out;
  }, { step: "edit" });

  const grammar = useGrammarFix({
    shopId,
    channel,
    texts,
    read: () => ({ text: body, subject: channel === "email" ? subject : null }),
    apply: (text, s) => {
      setBody(text);
      if (s !== null) setSubject(s);
      changed();
    },
  });

  const usable = templates.filter((t) => t.channel === "both" || (t.channel ?? "email") === channel);
  const needsPreview = hasVariable(body) || (channel === "email" && hasVariable(subject));
  const sendLabel = channel === "sms" ? texts.send_sms : texts.send_email;
  const hidden = (
    <>
      <input type="hidden" name="lang" value={lang} />
      <input type="hidden" name="contact_id" value={contactId} />
      <input type="hidden" name="channel" value={channel} />
      <input type="hidden" name="template_id" value="" />
      <input type="hidden" name="conversation_id" value={conversationId} />
    </>
  );
  const statusLine = (
    <span className="flex min-w-0 items-center gap-1.5 text-[13px] text-[#5C5C5C]" aria-live="polite" data-draft-status={saving ? "saving" : savedAt ? "saved" : "none"}>
      {saving ? (
        texts.draft_saving
      ) : savedAt ? (
        <>
          <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 12l5 5L20 7" />
          </svg>
          {fill(texts.draft_saved, { time: hm(savedAt) })}
        </>
      ) : null}
    </span>
  );
  const sendButton = (extra: string) => (
    <button
      type="submit"
      name="intent"
      value={needsPreview ? "preview" : "send"}
      disabled={pending || !body.trim() || (channel === "email" && (!emailReady || !subject.trim()))}
      className={`inline-flex flex-none items-center justify-center whitespace-nowrap rounded-xl border border-[#111] bg-[#111] font-bold text-white disabled:border-[#EDEDED] disabled:bg-[#EDEDED] disabled:text-[#5C5C5C] ${extra}`}
      data-reply-send={channel}
    >
      {pending ? texts.sending : needsPreview ? texts.preview : sendLabel}
    </button>
  );

  // "Náhľad" when the text holds a variable: the message as the database fills it in, then "Odoslať"
  if (state.step === "preview" && state.preview) {
    return (
      <form key="preview" action={dispatch} className="flex flex-col gap-3 border-t border-[#E4E4E4] px-5 pb-4 pt-3" data-reply="preview">
        {hidden}
        <input type="hidden" name="subject" value={subject} />
        <input type="hidden" name="body" value={body} />
        <p className="text-[13px] font-bold text-[#5C5C5C]">{texts.preview_title}</p>
        {state.preview.subject && <p className="font-semibold" data-preview-subject>{state.preview.subject}</p>}
        <p className="max-h-48 overflow-y-auto whitespace-pre-line break-words rounded-xl border border-[#D6D6D6] p-3" data-preview-body>
          {state.preview.body}
        </p>
        <div className="flex flex-wrap justify-end gap-2">
          <button type="submit" name="intent" value="edit" disabled={pending} className="min-h-11 rounded-xl border border-[#D6D6D6] bg-white px-4 font-bold">
            {texts.edit}
          </button>
          <button type="submit" name="intent" value="send" disabled={pending} className="min-h-11 rounded-xl border border-[#111] bg-[#111] px-4 font-bold text-white" data-send>
            {pending ? texts.sending : sendLabel}
          </button>
        </div>
      </form>
    );
  }

  return (
    <form key="edit" action={dispatch} className="flex flex-none flex-col gap-2.5 border-t border-[#E4E4E4] px-5 pb-4 pt-3" id="reply" data-reply={channel}>
      {hidden}
      {state.message && (
        <p role={state.message.startsWith("sent") ? "status" : "alert"} className="text-sm font-semibold" data-compose-result={state.message}>
          {texts[state.message] ?? texts.err_send_failed}
        </p>
      )}
      {/* row 1: the channel, the grammar icon, the templates */}
      <div className="flex items-center gap-2.5">
        <div role="group" aria-label={texts.reply_via} className="flex w-[220px] flex-none gap-1 rounded-xl border border-[#D6D6D6] p-1">
          {(["sms", "email"] as const).map((c) => {
            const on = channel === c;
            const off = c === "sms" ? !hasPhone : !hasEmail;
            if (off) return null;
            return (
              <button
                key={c}
                type="button"
                aria-pressed={on}
                onClick={() => {
                  setChannel(c);
                  changed();
                }}
                className={`min-h-12 flex-1 rounded-[10px] text-[15px] font-bold ${on ? "bg-[#111] text-white" : "bg-transparent text-[#3D3D3D]"}`}
                data-reply-channel={c}
              >
                {c === "sms" ? texts.channel_sms : texts.channel_email}
              </button>
            );
          })}
        </div>
        {grammarOn && (
          <button
            type="button"
            onClick={grammar.run}
            disabled={grammar.pending || !body.trim()}
            aria-label={texts.grammar}
            title={texts.grammar}
            className="ppi-gv ppi-gv-btn flex size-12 flex-none items-center justify-center rounded-xl"
            {...grammar.marks}
            data-grammar-run
          >
            <GrammarVortex />
          </button>
        )}
        {usable.length > 0 && (
          <label className="relative flex min-w-0 flex-1">
            <span className="sr-only">{texts.template}</span>
            <select
              value=""
              onChange={(e) => {
                const picked = usable.find((t) => t.id === e.target.value);
                if (picked) {
                  setBody(picked.body);
                  if (picked.subject) setSubject(picked.subject);
                  changed();
                }
              }}
              className="h-12 w-full min-w-0 appearance-none rounded-xl border border-[#D6D6D6] bg-white py-0 pl-3.5 pr-10 text-[15px] font-semibold text-[#111]"
              data-template-pick
            >
              <option value="">{texts.pick_template}</option>
              {usable.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
            <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#111" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="pointer-events-none absolute right-3.5 top-[15px]">
              <path d="M6 9l6 6 6-6" />
            </svg>
          </label>
        )}
      </div>

      {/* the grammar's before → after opens above the text */}
      {grammar.open && <div data-grammar>{grammar.panel}</div>}
      {channel === "email" && !emailReady && <p className="text-sm">{texts.email_off}</p>}

      {channel === "sms" ? (
        <>
          <div className="flex items-end gap-2.5">
            <label className="flex min-w-0 flex-1">
              <span className="sr-only">{texts.body}</span>
              <textarea
                ref={bodyRef}
                name="body"
                value={body}
                rows={3}
                maxLength={SMS_MAX}
                onChange={(e) => {
                  setBody(e.target.value);
                  changed();
                }}
                onFocus={(e) => (lastField.current = e.currentTarget)}
                onBlur={() => void save()}
                className="min-h-[104px] w-full resize-none rounded-xl border border-[#D6D6D6] p-3 text-base font-medium [field-sizing:content] max-h-[168px]"
                data-compose-body
              />
            </label>
            {sendButton("h-11 px-4 text-[15px]")}
          </div>
          <div className="flex min-h-5 items-center gap-2">
            {statusLine}
            {smsLeft && (
              <>
                {savedAt || saving ? <span aria-hidden="true" className="text-[13px] text-[#5C5C5C]">·</span> : null}
                <span className="whitespace-nowrap text-[13px] font-semibold text-[#5C5C5C]" data-sms-left>
                  {fill(texts.sms_left, { left: smsLeft.left, limit: smsLeft.limit })}
                </span>
              </>
            )}
            {!smsLive && <span className="text-[13px] text-[#5C5C5C]">· {texts.sms_test_note}</span>}
          </div>
        </>
      ) : (
        <>
          <label className="flex flex-col gap-1">
            <span className="text-[13px] font-bold text-[#5C5C5C]">{texts.subject}</span>
            <input
              name="subject"
              value={subject}
              maxLength={200}
              onChange={(e) => {
                setSubject(e.target.value);
                changed();
              }}
              onFocus={(e) => (lastField.current = e.currentTarget)}
              onBlur={() => void save()}
              className="h-12 rounded-xl border border-[#D6D6D6] px-3 text-base font-semibold text-[#111]"
              data-compose-subject
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[13px] font-bold text-[#5C5C5C]">{texts.message}</span>
            <textarea
              ref={bodyRef}
              name="body"
              value={body}
              rows={10}
              maxLength={10000}
              onChange={(e) => {
                setBody(e.target.value);
                changed();
              }}
              onFocus={(e) => (lastField.current = e.currentTarget)}
              onBlur={() => void save()}
              className="h-[260px] resize-y rounded-xl border border-[#D6D6D6] px-3.5 py-3 text-base font-medium leading-normal text-[#111]"
              data-compose-body
            />
          </label>
          <div className="flex items-center justify-between gap-3">
            {statusLine}
            {sendButton("min-h-[52px] min-w-[170px] px-5 text-[17px]")}
          </div>
        </>
      )}

      <div className="flex flex-col gap-2">
        <button
          type="button"
          aria-expanded={vars}
          onClick={() => setVars((v) => !v)}
          className="self-start text-[13px] font-semibold text-[#5C5C5C] underline underline-offset-4"
          data-reply-vars
        >
          {texts.variables}
        </button>
        {vars && (
          <>
            <TagChips texts={texts} target={() => (lastField.current?.isConnected ? lastField.current : bodyRef.current)} />
            <TagPreview text={body} texts={texts} />
          </>
        )}
      </div>
    </form>
  );
}
