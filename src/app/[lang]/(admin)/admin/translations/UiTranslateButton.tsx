"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { translateUiPart } from "./actions";

/** "Preložiť chýbajúce texty": parts of 150 until nothing is left, with a progress bar (the admin may leave meanwhile). */
export function UiTranslateButton({
  target,
  todo,
  labels,
}: {
  target: string;
  todo: number;
  labels: { button: string; progress: string; done: string; failed: string };
}) {
  const router = useRouter();
  const [state, setState] = useState<{ done: number; left: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true);
    setError(null);
    let done = 0;
    let left = todo;
    setState({ done, left });
    for (let round = 0; round < 100 && left > 0; round++) {
      const result = await translateUiPart(target);
      if (!result.ok) {
        setError(result.error);
        break;
      }
      done += result.value.saved;
      // nothing saved although texts are left: stop (the reason is in the function's log)
      if (result.value.saved === 0 && result.value.left >= left) {
        left = result.value.left;
        break;
      }
      left = result.value.left;
      setState({ done, left });
    }
    setState({ done, left });
    setBusy(false);
    router.refresh();
  };

  const all = Math.max(todo, 1);
  return (
    <div className="flex flex-col gap-2" data-ui-translate>
      <button type="button" onClick={run} disabled={busy || todo === 0} className="self-start rounded border border-foreground px-4 py-2 font-medium disabled:border-line disabled:text-muted" data-ui-translate-button>
        {labels.button}
      </button>
      {state && (
        <div className="flex flex-col gap-1" role="status">
          <span className="text-sm">
            {state.left === 0 ? labels.done.replace("{n}", String(state.done)) : labels.progress.replace("{done}", String(todo - state.left)).replace("{all}", String(todo))}
          </span>
          <div className="h-2 w-full max-w-sm border border-line" aria-hidden>
            <div className="h-full bg-foreground" style={{ width: `${Math.round(((todo - state.left) / all) * 100)}%` }} />
          </div>
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm">
          {labels.failed} ({error})
        </p>
      )}
    </div>
  );
}
