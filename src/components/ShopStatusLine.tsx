import { closedPillText, shopStatus, statusParts, type PillLabels, type StatusInput, type StatusLabels } from "@/lib/hours";
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
  labels: StatusLabels & Partial<PillLabels>;
  lang: string;
  /** Date.now() on the server. */
  renderedAt: number;
  className?: string;
  pill?: boolean;
}) {
  const status = shopStatus(input, new Date(renderedAt));
  const short = pill && labels.pill_opens_at ? closedPillText(status, labels as PillLabels) : null;
  return <LiveStatusLazy first={{ state: status.state, ...statusParts(status, labels, lang), short }} input={input} labels={labels} lang={lang} className={className} pill={pill} />;
}
