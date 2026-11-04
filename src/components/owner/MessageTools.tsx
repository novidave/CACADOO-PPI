"use client";

import { useRef, useState, useTransition } from "react";
import { fixGrammar } from "@/app/[lang]/(account)/dashboard/contacts/messageActions";
import { smsParts } from "@/lib/crm";
import { insertToken, MESSAGE_TAGS, smsCompare, tagPieces, unknownVariables, withoutAccents, wordDiff } from "@/lib/messageTags";
import { ghostClass } from "./ui";

/** The composer's and the templates' texts (the page passes `dict.contacts`). */
export type ToolTexts = Record<string, string>;

const fill = (text: string, values: Record<string, string | number>) =>
  String(text ?? "").replace(/\{(\w+)\}/g, (all, key: string) => (key in values ? String(values[key]) : all));
const meaningOf = (texts: ToolTexts, key: string) => {
  const m = texts[`var_${key}`] ?? key;
  return m.charAt(0).toUpperCase() + m.slice(1);
};

type Field = HTMLInputElement | HTMLTextAreaElement;

/**
 * Puts a tag into a field at its cursor (or over its selection) the way typing would: the new value goes through the
 * field's own value setter and an "input" event, so React's onChange and a plain form both see it; the cursor ends
 * right after the tag and the field keeps the focus.
 */
export function insertIntoField(el: Field, token: string) {
  const { text, caret } = insertToken(el.value, el.selectionStart ?? el.value.length, el.selectionEnd ?? el.value.length, token);
  const max = el.maxLength > 0 ? el.maxLength : Infinity;
  if (text.length > max) return;
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, text);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.focus();
  el.setSelectionRange(caret, caret);
}

/**
 * The variables as tags under a text field (and an e-mail's subject): a click (or Tab + Enter) puts one at the cursor of
 * the field last used, a drag drops it where it is let go (the browser's own drop into a text field). Each tag tells
 * what it becomes: on hover (title), on keyboard focus and after a long press on a phone.
 */
export function TagChips({ texts, target }: { texts: ToolTexts; target: () => Field | null }) {
  const [tip, setTip] = useState<string | null>(null);
  const held = useRef<{ timer: number | null; long: boolean }>({ timer: null, long: false });
  return (
    <div className="flex flex-col gap-1.5" data-tag-chips>
      <span className="text-sm font-semibold text-[#5C5C5C]">{texts.tags_label}</span>
      <ul className="flex flex-wrap gap-1.5" role="list">
        {MESSAGE_TAGS.map((t) => {
          const meaning = meaningOf(texts, t.key);
          return (
            <li key={t.token} className="relative">
              <button
                type="button"
                draggable
                title={meaning}
                aria-label={fill(texts.tag_insert, { token: t.token, meaning })}
                onDragStart={(e) => {
                  e.dataTransfer.setData("text/plain", t.token);
                  e.dataTransfer.effectAllowed = "copy";
                }}
                onPointerDown={(e) => {
                  if (e.pointerType !== "touch") return;
                  held.current.long = false;
                  held.current.timer = window.setTimeout(() => {
                    held.current.long = true;
                    setTip(t.token);
                  }, 450);
                }}
                onPointerUp={() => {
                  if (held.current.timer) window.clearTimeout(held.current.timer);
                }}
                onPointerLeave={() => {
                  if (held.current.timer) window.clearTimeout(held.current.timer);
                }}
                onContextMenu={(e) => e.preventDefault()}
                onFocus={() => setTip(t.token)}
                onBlur={() => setTip((x) => (x === t.token ? null : x))}
                onClick={() => {
                  // a long press only explains the tag
                  if (held.current.long) {
                    held.current.long = false;
                    return;
                  }
                  const el = target();
                  if (el) insertIntoField(el, t.token);
                }}
                className="inline-flex min-h-11 cursor-grab touch-manipulation select-none items-center rounded-full border border-[#111] bg-white px-3 font-mono text-sm font-semibold text-[#111] hover:bg-[#F4F4F4] active:cursor-grabbing [-webkit-touch-callout:none]"
                data-tag={t.token}
              >
                {t.token}
              </button>
              {tip === t.token && (
                <span role="tooltip" className="pointer-events-none absolute left-0 top-full z-20 mt-1 whitespace-nowrap rounded-lg bg-[#111] px-2 py-1 text-xs font-semibold text-white" data-tag-tip>
                  {meaning}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      <span className="text-xs text-[#5C5C5C]">{texts.vars_hint}</span>
    </div>
  );
}

/** The live line under a field: the text with its variables as pills (an unknown one marked), and the warnings. */
export function TagPreview({ text, texts }: { text: string; texts: ToolTexts }) {
  const unknown = unknownVariables(text);
  if (!text.trim()) return null;
  return (
    <div className="flex flex-col gap-1" data-tag-preview>
      <p className="whitespace-pre-line break-words rounded-xl bg-[#F6F6F6] px-3 py-2 text-sm leading-relaxed text-[#111]">
        <span className="mr-1 font-semibold text-[#5C5C5C]">{texts.preview_line}</span>
        {tagPieces(text).map((p, i) =>
          p.tag ? (
            <span
              key={i}
              className={`mx-px inline-flex items-center rounded-full px-2 py-px font-mono text-xs font-bold ${p.tag === "known" ? "bg-[#111] text-white" : "border border-dashed border-[#111] bg-white text-[#111]"}`}
              data-tag-pill={p.tag}
            >
              {p.text}
            </span>
          ) : (
            <span key={i}>{p.text}</span>
          ),
        )}
      </p>
      {unknown.length > 0 && (
        <ul role="status" className="flex flex-col gap-0.5 text-sm font-semibold" data-tag-unknown>
          {unknown.map((u) => (
            <li key={u}>⚠ {fill(texts.tag_unknown, { token: u })}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

const partsText = (texts: ToolTexts, text: string) => {
  const p = smsParts(text);
  return fill(texts.sms_kind, { n: p.parts, kind: p.unicode ? texts.sms_unicode : texts.sms_gsm });
};

/**
 * "Opraviť gramatiku": the text (and an e-mail's subject) to Claude through the server (the shop's daily limit, the
 * plan), then before → after with the changed words marked, and for an SMS the parts before and after ("Bez
 * diakritiky" when the accents would cost more SMS). "Použiť" puts the text into the field; nothing is sent or saved.
 */
export function GrammarFix({
  shopId,
  channel,
  texts,
  read,
  apply,
}: {
  shopId: string;
  channel: "sms" | "email";
  texts: ToolTexts;
  read: () => { text: string; subject: string | null };
  apply: (text: string, subject: string | null) => void;
}) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [review, setReview] = useState<{ before: string; after: string; subjectBefore: string | null; subjectAfter: string | null; left: number | null } | null>(null);
  const run = () => {
    const now = read();
    setError(null);
    start(async () => {
      const out = await fixGrammar({ shopId, text: now.text, subject: channel === "email" ? now.subject : null, channel });
      if (!out.ok) {
        setReview(null);
        setError(texts[out.error] ?? texts.err_grammar_failed);
        return;
      }
      setReview({ before: now.text, after: out.text, subjectBefore: now.subject, subjectAfter: out.subject, left: out.left });
    });
  };
  const same = review && review.before === review.after && (review.subjectBefore ?? "") === (review.subjectAfter ?? "");
  const cmp = review && channel === "sms" ? smsCompare(review.before, review.after) : null;
  return (
    <div className="flex flex-col gap-2" data-grammar>
      <button type="button" onClick={run} disabled={pending} className={`${ghostClass} self-start`} data-grammar-run>
        {pending ? texts.grammar_working : texts.grammar}
      </button>
      {error && (
        <p role="alert" className="text-sm font-semibold" data-grammar-error>
          {error}
        </p>
      )}
      {review && (
        <section className="flex flex-col gap-2 rounded-2xl border border-[#111] bg-white p-3" aria-label={texts.grammar_title} data-grammar-review>
          <h4 className="text-[15px] font-bold">{texts.grammar_title}</h4>
          {same ? (
            <p className="text-sm" data-grammar-same>{texts.grammar_same}</p>
          ) : (
            <>
              {review.subjectAfter !== null && review.subjectAfter !== review.subjectBefore && (
                <p className="text-sm">
                  <span className="text-[#5C5C5C]">{texts.subject}: </span>
                  {wordDiff(review.subjectBefore ?? "", review.subjectAfter).map((p, i) =>
                    p.changed ? <mark key={i} className="rounded bg-[#FFE7A3] px-0.5 font-semibold text-[#111]">{p.text}</mark> : <span key={i}>{p.text}</span>,
                  )}
                </p>
              )}
              <div className="grid gap-2 md:grid-cols-2">
                <div className="flex flex-col gap-1">
                  <span className="text-xs font-semibold text-[#5C5C5C]">{texts.grammar_before}</span>
                  <p className="whitespace-pre-line break-words rounded-xl bg-[#F6F6F6] p-2 text-sm" data-grammar-before>{review.before}</p>
                </div>
                <div className="flex flex-col gap-1">
                  <span className="text-xs font-semibold text-[#5C5C5C]">{texts.grammar_after}</span>
                  <p className="whitespace-pre-line break-words rounded-xl border border-[#E4E4E4] p-2 text-sm" data-grammar-after>
                    {wordDiff(review.before, review.after).map((p, i) =>
                      p.changed ? <mark key={i} className="rounded bg-[#FFE7A3] px-0.5 font-semibold text-[#111]">{p.text}</mark> : <span key={i}>{p.text}</span>,
                    )}
                  </p>
                </div>
              </div>
              {cmp && (
                <p className="text-sm" data-grammar-parts>
                  {fill(texts.grammar_parts, { before: partsText(texts, review.before), after: partsText(texts, review.after) })}
                </p>
              )}
              {cmp?.accentsCost && (
                <p className="flex flex-wrap items-center gap-2 text-sm">
                  <span>{fill(texts.grammar_accents, { parts: partsText(texts, withoutAccents(review.after)) })}</span>
                  <button
                    type="button"
                    className="min-h-11 rounded-xl border border-[#111] px-3 font-semibold"
                    onClick={() => setReview({ ...review, after: withoutAccents(review.after) })}
                    data-grammar-no-accents
                  >
                    {texts.grammar_no_accents}
                  </button>
                </p>
              )}
            </>
          )}
          <p className="text-xs text-[#5C5C5C]">
            {texts.grammar_note}
            {review.left !== null && ` · ${fill(texts.grammar_left, { n: review.left })}`}
          </p>
          <div className="flex flex-wrap gap-2">
            {!same && (
              <button
                type="button"
                className="min-h-11 rounded-xl border border-[#111] bg-[#111] px-4 font-bold text-white"
                onClick={() => {
                  apply(review.after, review.subjectAfter);
                  setReview(null);
                }}
                data-grammar-use
              >
                {texts.grammar_use}
              </button>
            )}
            <button type="button" className="min-h-11 rounded-xl border border-[#D6D6D6] px-4 font-bold" onClick={() => setReview(null)} data-grammar-discard>
              {texts.grammar_discard}
            </button>
          </div>
        </section>
      )}
    </div>
  );
}

/**
 * The fields of a template (Šablóny): the channel, the subject and the text with the tags, the live line and "Opraviť
 * gramatiku". Plain form fields (name="channel" / "subject" / "body"): the page's server action saves them as before.
 */
export function TemplateFields({
  texts,
  labels,
  defaults,
  shopId,
  grammarOn,
}: {
  texts: ToolTexts;
  labels: { channel: string; sms: string; email: string; both: string; subject: string; body: string };
  defaults: { channel: "sms" | "email" | "both"; subject: string; body: string };
  shopId: string;
  grammarOn: boolean;
}) {
  const [channel, setChannel] = useState(defaults.channel);
  const [subject, setSubject] = useState(defaults.subject);
  const [body, setBody] = useState(defaults.body);
  const subjectRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const last = useRef<Field | null>(null);
  const field = "min-h-[52px] w-full rounded-xl border border-[#D6D6D6] bg-white px-3.5 py-3 text-[17px] font-medium text-[#111] outline-none focus:border-[#111]";
  return (
    <>
      <label className="flex flex-col gap-1">
        <span className="text-sm">{labels.channel}</span>
        <select name="channel" value={channel} onChange={(e) => setChannel(e.target.value as typeof channel)} className={`${field} min-h-11 bg-white`}>
          <option value="sms">{labels.sms}</option>
          <option value="email">{labels.email}</option>
          <option value="both">{labels.both}</option>
        </select>
      </label>
      {channel !== "sms" && (
        <label className="flex flex-col gap-1">
          <span className="text-sm">{labels.subject}</span>
          <input
            ref={subjectRef}
            name="subject"
            maxLength={200}
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            onFocus={(e) => (last.current = e.currentTarget)}
            className={field}
            data-template-subject
          />
        </label>
      )}
      <label className="flex flex-col gap-1">
        <span className="text-sm">{labels.body}</span>
        <textarea
          ref={bodyRef}
          name="body"
          required
          rows={6}
          maxLength={1000}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onFocus={(e) => (last.current = e.currentTarget)}
          className={field}
          data-template-body
        />
      </label>
      {channel !== "email" && <p className="text-xs text-[#5C5C5C]">{fill(texts.sms_chars, { n: smsParts(body).chars, parts: smsParts(body).parts })}</p>}
      <TagPreview text={body} texts={texts} />
      <TagChips texts={texts} target={() => (last.current && last.current.isConnected ? last.current : bodyRef.current)} />
      {grammarOn && (
        <GrammarFix
          shopId={shopId}
          channel={channel === "sms" ? "sms" : "email"}
          texts={texts}
          read={() => ({ text: body, subject: channel === "sms" ? null : subject })}
          apply={(text, s) => {
            setBody(text);
            if (s !== null) setSubject(s);
          }}
        />
      )}
    </>
  );
}
