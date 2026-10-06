"use client";

import { useFormStatus } from "react-dom";

/** Submit button that shows a "working…" text and is disabled while its form is being sent. */
export function PendingButton({ children, pending }: { children: React.ReactNode; pending: string }) {
  const status = useFormStatus();
  return (
    <button
      type="submit"
      disabled={status.pending}
      aria-busy={status.pending}
      className="self-start rounded border border-foreground px-4 py-2 font-medium disabled:text-muted"
    >
      {status.pending ? pending : children}
    </button>
  );
}
