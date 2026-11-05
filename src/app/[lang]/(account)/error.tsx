"use client";

import { buttonClass } from "@/components/owner/ui";

// Last-resort error screen for the dashboard pages (texts kept short and
// in all three languages, because error screens cannot load the dictionaries).
export default function AccountError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="flex flex-col gap-3 border border-foreground p-4">
      <p className="font-semibold">Stránku sa nepodarilo načítať · Az oldalt nem sikerült betölteni · This page could not be loaded</p>
      {error.digest && <p className="text-sm text-muted">Ref: {error.digest}</p>}
      <button type="button" onClick={reset} className={`self-start ${buttonClass}`}>
        Skúsiť znova · Újra · Try again
      </button>
    </div>
  );
}
