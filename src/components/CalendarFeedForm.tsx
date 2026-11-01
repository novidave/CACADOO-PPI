"use client";

import { useActionState, useState } from "react";
import { newCalendarFeed, type FeedState } from "@/app/[lang]/(account)/dashboard/assistant/actions";

interface Labels {
  create: string;
  renew: string;
  busy: string;
  shown_once: string;
  copy: string;
  copied: string;
  failed: string;
}

/**
 * "Odkaz pre kalendár v telefóne" (update 63): a new secret link for iPhone, Android or Outlook (read only). The link is
 * shown once in this box — never in the address bar — and only its hash is kept; a new one stops the old one at once.
 */
export function CalendarFeedForm({ shopId, exists, labels }: { shopId: string; exists: boolean; labels: Labels }) {
  const [state, action, pending] = useActionState<FeedState, FormData>(newCalendarFeed, {});
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-col gap-2" data-calendar-feed>
      <form action={action}>
        <input type="hidden" name="shop_id" value={shopId} />
        <button
          type="submit"
          disabled={pending}
          className="min-h-11 rounded-[10px] border border-line bg-white px-4 text-[15px] font-semibold disabled:text-muted"
        >
          {pending ? labels.busy : exists ? labels.renew : labels.create}
        </button>
      </form>
      {state.error && (
        <p role="alert" className="text-sm font-semibold">
          {labels.failed}
        </p>
      )}
      {state.url && (
        <div className="flex flex-col gap-2 border border-foreground p-3" role="status">
          <p className="text-sm font-semibold">{labels.shown_once}</p>
          <input readOnly value={state.url} onFocus={(e) => e.currentTarget.select()} className="rounded border border-line px-3 py-2 font-mono text-xs" />
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard?.writeText(state.url!).then(() => setCopied(true), () => setCopied(false));
            }}
            className="min-h-11 self-start rounded-[10px] border border-foreground px-4 text-[15px] font-semibold"
          >
            {copied ? labels.copied : labels.copy}
          </button>
        </div>
      )}
    </div>
  );
}
