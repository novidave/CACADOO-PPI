"use client";

import { useState } from "react";

/** "Kopírovať" next to a value the owner pastes elsewhere (a DNS record); "Skopírované" for 2 seconds. */
export function CopyButton({ text, labels }: { text: string; labels: { copy: string; copied: string } }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        await navigator.clipboard?.writeText(text).catch(() => null);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}
      className="underline underline-offset-4"
    >
      {copied ? labels.copied : labels.copy}
    </button>
  );
}
