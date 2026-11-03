"use client";

import { useFormStatus } from "react-dom";
import { buttonClass } from "./owner/ui";

/** Submit button that shows a "working…" text and is disabled while its form is being sent. */
export function PendingButton({ children, pending }: { children: React.ReactNode; pending: string }) {
  const status = useFormStatus();
  return (
    <button
      type="submit"
      disabled={status.pending}
      aria-busy={status.pending}
      // back-end layout L3: the owner pages' main button (52 px, black; @/components/owner/ui)
      className={`self-start ${buttonClass}`}
    >
      {status.pending ? pending : children}
    </button>
  );
}
