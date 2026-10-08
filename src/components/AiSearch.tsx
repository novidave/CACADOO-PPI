"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { AiSearchResult } from "@/lib/aiSearch";

/**
 * The AI layer above the plain search results. Asks /api/ai-search once; when it cannot
 * help (no key, limits, error) the layer simply disappears and the plain results stay.
 */
export function AiSearch({
  q,
  lang,
  only,
  labels,
}: {
  q: string;
  lang: string;
  only: boolean;
  labels: { title: string; loading: string; searched: string; note: string; unavailable: string };
}) {
  const [result, setResult] = useState<AiSearchResult | null>(null);
  const [gone, setGone] = useState(false);
  // Only a logged-in shop owner is told why the AI search did not run (for testing).
  const [reason, setReason] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/ai-search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ q, lang, only }),
      signal: controller.signal,
    })
      .then((response) => (response.ok ? response.json() : { fallback: true }))
      .then((data: AiSearchResult | { fallback: true; reason?: string }) => {
        if (!("fallback" in data)) setResult(data);
        else if (data.reason) setReason(data.reason);
        else setGone(true);
      })
      .catch(() => {
        if (!controller.signal.aborted) setGone(true);
      });
    return () => controller.abort();
  }, [q, lang, only]);

  if (gone) return null;
  if (reason) {
    return (
      <p role="status" className="max-w-3xl border border-line p-3 text-sm">
        {labels.unavailable.replace("{reason}", reason)}
      </p>
    );
  }
  return (
    <section aria-live="polite" aria-busy={!result} className="flex max-w-3xl flex-col gap-3 border border-line p-4">
      <h2 className="font-semibold">{labels.title}</h2>
      {!result ? (
        <p className="text-muted">{labels.loading}</p>
      ) : (
        <>
          <p lang={result.language === "other" ? undefined : result.language}>{result.answer}</p>
          {result.cards.length > 0 && (
            <ul className="divide-y divide-line border-y border-line">
              {result.cards.map((card) => (
                <li key={card.href} className="flex flex-col gap-1 py-3">
                  <div className="flex items-baseline justify-between gap-3">
                    <div className="min-w-0">
                      <Link href={card.href} className="font-medium hover:underline">
                        {card.name}
                      </Link>
                      {card.translated && <p className="text-sm text-muted">{card.translated}</p>}
                    </div>
                    <span className="whitespace-nowrap font-medium">{card.price}</span>
                  </div>
                  <div className="text-sm text-muted">
                    {card.brand && `${card.brand} · `}
                    <Link href={card.shopHref} className="hover:underline">
                      {card.shop}
                    </Link>
                    {card.place && ` · ${card.place}`}
                  </div>
                  <div className="text-sm">
                    {card.availability && <span className="font-semibold">{card.availability} · </span>}
                    <span className={card.availability ? "text-muted" : ""}>{card.freshness}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {result.searched.length > 0 && (
            <p className="text-sm text-muted">{labels.searched.replace("{terms}", result.searched.join(", "))}</p>
          )}
          <p className="text-xs text-muted">{labels.note}</p>
        </>
      )}
    </section>
  );
}
