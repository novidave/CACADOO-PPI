import Link from "next/link";

/**
 * A stock-file page opened by a restaurant (update 79): "Pre reštauráciu sa nepoužíva" — the page stays reachable by its
 * address, it is only no longer in the menu; the way to the Menu, where a restaurant's dishes and prices are.
 */
export function NotForFood({
  lang,
  shop,
  labels,
  more,
}: {
  lang: string;
  shop: string;
  labels: { not_used_title: string; not_used_text: string; not_used_link: string };
  /** An extra link (e.g. "Zobraziť zoznam Tovar aj tak"). */
  more?: { href: string; label: string };
}) {
  return (
    <div className="flex flex-col gap-1.5 rounded-2xl border-[1.5px] border-[#111] bg-white p-4" role="note" data-not-for-food>
      <p className="text-base font-bold">{labels.not_used_title}</p>
      <p className="text-sm">{labels.not_used_text}</p>
      <p className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
        <Link href={`/${lang}/dashboard/assistant/orders/menu?${new URLSearchParams({ shop })}`} className="flex min-h-11 items-center font-semibold underline underline-offset-4">
          {labels.not_used_link}
        </Link>
        {more && (
          <Link href={more.href} className="flex min-h-11 items-center underline underline-offset-4" data-not-for-food-more>
            {more.label}
          </Link>
        )}
      </p>
    </div>
  );
}
