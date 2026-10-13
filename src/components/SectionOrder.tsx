"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { Dictionary } from "@/i18n/dictionaries";
import { deleteSection, reorderSections, setSectionState } from "@/app/[lang]/(account)/dashboard/sectionActions";

export interface OwnerSectionRow {
  id: string;
  title: string;
  /** "Zverejnené", "Nezverejnené – pozrite si náhľad", "Zobrazí sa od 1. 11. 2026" … */
  state: string;
  details: string;
  hasPdf: boolean;
  published: boolean;
  hidden: boolean;
}

/**
 * The sections of one position, in their order on the page: drag a row (or ↑ ↓) to move it;
 * Náhľad, Zverejniť, Skryť / Zobraziť, Upraviť, Nahradiť PDF, Vymazať. The database keeps the
 * order (owner_reorder_sections); nothing here decides what visitors see.
 */
export function SectionOrder({
  shop,
  position,
  heading,
  rows,
  labels,
}: {
  shop: { id: string; slug: string; lang: string };
  position: string;
  heading: string;
  rows: OwnerSectionRow[];
  labels: Dictionary["sections"];
}) {
  const router = useRouter();
  const [order, setOrder] = useState(rows.map((r) => r.id));
  const [dragging, setDragging] = useState<string | null>(null);
  const [shown, setShown] = useState(rows.map((r) => r.id).join());
  // New rows from the server (after a save): start from them again.
  const fresh = rows.map((r) => r.id).join();
  if (fresh !== shown) {
    setShown(fresh);
    setOrder(rows.map((r) => r.id));
  }
  const byId = new Map(rows.map((r) => [r.id, r]));
  const list = order.map((id) => byId.get(id)).filter((r): r is OwnerSectionRow => Boolean(r));

  async function save(next: string[]) {
    setOrder(next);
    await reorderSections({ shopId: shop.id, position, ids: next });
    router.refresh();
  }
  const move = (id: string, by: number) => {
    const i = order.indexOf(id);
    const j = i + by;
    if (i < 0 || j < 0 || j >= order.length) return;
    const next = [...order];
    [next[i], next[j]] = [next[j], next[i]];
    void save(next);
  };
  const hidden = (sectionId: string, extra: Record<string, string> = {}) => (
    <>
      <input type="hidden" name="lang" value={shop.lang} />
      <input type="hidden" name="shop_id" value={shop.id} />
      <input type="hidden" name="shop_slug" value={shop.slug} />
      <input type="hidden" name="section_id" value={sectionId} />
      {Object.entries(extra).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
    </>
  );
  const query = (extra: Record<string, string>) => `/${shop.lang}/dashboard?${new URLSearchParams({ shop: shop.slug, at: "sections", ...extra })}#sections`;
  const button = "underline underline-offset-4";

  return (
    <section className="flex flex-col gap-1" data-section-group={position}>
      <h4 className="text-sm text-muted">{heading}</h4>
      <ol className="divide-y divide-line border-y border-line">
        {list.map((row, i) => (
          <li
            key={row.id}
            draggable
            onDragStart={() => setDragging(row.id)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              if (!dragging || dragging === row.id) return;
              const next = order.filter((id) => id !== dragging);
              next.splice(next.indexOf(row.id) + (order.indexOf(dragging) < order.indexOf(row.id) ? 1 : 0), 0, dragging);
              setDragging(null);
              void save(next);
            }}
            onDragEnd={() => setDragging(null)}
            className={`flex flex-col gap-2 py-2 ${dragging === row.id ? "opacity-50" : ""}`}
            data-owner-section={row.id}
          >
            <div className="flex items-start gap-2">
              <span className="cursor-grab select-none px-1 text-muted" title={labels.drag} aria-hidden="true">
                ⋮⋮
              </span>
              <div className="min-w-0 flex-1">
                <p className="font-semibold">{row.title}</p>
                <p className="text-sm">
                  <span className="font-semibold" data-section-state>
                    {row.state}
                  </span>
                  {row.details && <span className="text-muted"> · {row.details}</span>}
                </p>
              </div>
              <span className="flex flex-col text-sm">
                <button type="button" onClick={() => move(row.id, -1)} disabled={i === 0} aria-label={`${labels.move_up}: ${row.title}`} className="px-1 disabled:text-line">
                  ↑
                </button>
                <button type="button" onClick={() => move(row.id, 1)} disabled={i === list.length - 1} aria-label={`${labels.move_down}: ${row.title}`} className="px-1 disabled:text-line">
                  ↓
                </button>
              </span>
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 pl-7 text-sm">
              {row.hasPdf && (
                <a href={`/${shop.lang}/dashboard/sections/${row.id}?shop=${shop.slug}`} className={button} data-section-preview>
                  {labels.preview}
                </a>
              )}
              {row.hasPdf && (!row.published || row.hidden) && (
                <form action={setSectionState}>
                  {hidden(row.id, { state: row.published ? "show" : "publish" })}
                  <button type="submit" className={`${button} font-semibold`} data-section-publish>
                    {row.published ? labels.show : labels.publish}
                  </button>
                </form>
              )}
              {row.published && !row.hidden && (
                <form action={setSectionState}>
                  {hidden(row.id, { state: "hide" })}
                  <button type="submit" className={button} data-section-hide>
                    {labels.hide}
                  </button>
                </form>
              )}
              <a href={query({ section: row.id })} className={button} data-section-edit>
                {labels.edit}
              </a>
              <a href={query({ section: row.id, replace: "1" })} className={button} data-section-replace>
                {labels.replace}
              </a>
              <form
                action={deleteSection}
                onSubmit={(e) => {
                  if (!window.confirm(labels.delete_confirm.replace("{title}", row.title))) e.preventDefault();
                }}
              >
                {hidden(row.id)}
                <button type="submit" className={button} data-section-delete>
                  {labels.delete}
                </button>
              </form>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
