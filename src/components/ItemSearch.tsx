"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";

/**
 * "Tovar v obchode" search on the shop page. A plain GET form (works without JavaScript: `#items` brings the list into
 * view after the reload); with JavaScript the results replace the list in place — the page stays where it is
 * (`scroll: false`, and the list never gets shorter than it was), nothing else on the page reloads.
 */
export function ItemSearch({
  path,
  q,
  labels,
}: {
  path: string;
  q: string;
  labels: { placeholder: string; button: string };
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <form
      method="get"
      action={`${path}#items`}
      className="flex gap-2"
      role="search"
      aria-busy={pending}
      onSubmit={(e) => {
        e.preventDefault();
        // Fewer results make the page shorter, and a shorter page pulls the view up: the list keeps at least the
        // height it had, so the screen does not move (any space left over is below the results).
        const list = document.getElementById("items");
        if (list) list.style.minHeight = `${list.offsetHeight}px`;
        const query = String(new FormData(e.currentTarget).get("q") ?? "").trim();
        // the phone's keyboard closes, so the results are not hidden under it
        (e.currentTarget.elements.namedItem("q") as HTMLInputElement | null)?.blur();
        const url = query ? `${path}?${new URLSearchParams({ q: query })}` : path;
        startTransition(() => router.replace(url, { scroll: false }));
      }}
    >
      <input
        type="search"
        name="q"
        defaultValue={q}
        placeholder={labels.placeholder}
        aria-label={labels.placeholder}
        enterKeyHint="search"
        className="min-w-0 flex-1 rounded border border-line px-3 py-2 outline-none focus:border-foreground"
      />
      <button
        type="submit"
        className="rounded border border-foreground px-4 py-2 font-medium aria-disabled:opacity-60"
        aria-disabled={pending}
        data-tap-busy
      >
        {labels.button}
      </button>
    </form>
  );
}
