"use client";

import { useCallback, useState, type CSSProperties } from "react";
import { HoldLink } from "@/components/HoldLink";
import { smallLabel, type ContactButtonData, type ContactKey } from "@/lib/contactButtons";

export interface ContactButtonLabels {
  hold: string;
  /** "{label}: {done}" for the screen-reader announcement. */
  announce: string;
  done: Record<ContactKey, string>;
}

const fill = (text: string, values: Record<string, string>) => text.replace(/\{(\w+)\}/g, (all, key: string) => values[key] ?? all);

/**
 * The shop page's contact buttons (database update 51, Screen 11): two columns, a long button takes both. Each one is a
 * real link (`@/components/HoldLink`: works without JavaScript) that a finger or a mouse opens only after holding it
 * for 1.2 s; Enter / Space open it at once. The order, links, colours and widths come from `@/lib/contactButtons`.
 */
export function ContactButtons({ buttons, labels }: { buttons: ContactButtonData[]; labels: ContactButtonLabels }) {
  const [said, setSaid] = useState<{ n: number; text: string }>({ n: 0, text: "" });
  const announce = useCallback((text: string) => setSaid((s) => ({ n: s.n + 1, text })), []);
  if (buttons.length === 0) return null;
  return (
    <div className="grid grid-cols-2 gap-3" data-contact-buttons>
      {buttons.map((b) => (
        <HoldLink
          key={b.key}
          href={b.href}
          newTab={b.newTab}
          label={b.label}
          holdLabel={labels.hold}
          doneLabel={labels.done[b.key]}
          className={`ppi-cb ${b.width === "long" ? "col-span-2" : ""}`}
          style={{ "--c": b.color } as CSSProperties}
          data={{ contact: b.key, width: b.width }}
          small={smallLabel({ label: b.label, hold: labels.hold, done: labels.done[b.key] }, b.width)}
          onDone={() => announce(fill(labels.announce, { label: b.label, done: labels.done[b.key] }))}
        />
      ))}
      <span className="sr-only" aria-live="polite" data-contact-announce>
        {said.text && <span key={said.n}>{said.text}</span>}
      </span>
    </div>
  );
}
