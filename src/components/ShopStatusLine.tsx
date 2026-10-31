import { shopStatus, statusParts, type StatusInput, type StatusLabels } from "@/lib/hours";
import { LiveStatusLazy } from "./LiveStatusLazy";

/**
 * "● Otvorené · zatvára o 17:00 · sviatok" on server pages: computed here with the shared rule (src/lib/hours.ts) at
 * the render time, kept fresh in the browser by `LiveStatusLazy` (which loads the rule only after the page appears).
 * Client components use `LiveStatus` (@/components/ShopStatus).
 */
export function ShopStatusLine({
  input,
  labels,
  lang,
  renderedAt,
  className,
  pill = false,
}: {
  input: StatusInput;
  labels: StatusLabels;
  lang: string;
  /** Date.now() on the server. */
  renderedAt: number;
  className?: string;
  pill?: boolean;
}) {
  const status = shopStatus(input, new Date(renderedAt));
  return <LiveStatusLazy first={{ state: status.state, ...statusParts(status, labels, lang) }} input={input} labels={labels} lang={lang} className={className} pill={pill} />;
}
