/**
 * "Aký je to obchod?" (update 79): two big choice cards — a shop with goods or a restaurant. Real radio inputs (no
 * JavaScript; the form sends `kind`), each card ≥ 76 px high with its icon and one line; the chosen card is black-bordered,
 * the keyboard focus ring 2 px #2563EB.
 */
export type KindLabels = {
  kind_goods: string;
  kind_goods_line: string;
  kind_food: string;
  kind_food_line: string;
};

const ICONS = {
  // a box (stock)
  goods: "M3 8l9-5 9 5v8l-9 5-9-5zM3 8l9 5 9-5M12 13v8",
  // fork and knife
  food: "M7 3v7a2 2 0 0 0 2 2h0a2 2 0 0 0 2-2V3M9 12v9M16 3c-1.7 1.6-2.5 4-2.5 6.5V13H16v8",
} as const;

export function KindChoice({
  name = "kind",
  value,
  labels,
  required = true,
  form,
}: {
  name?: string;
  /** The kind chosen now (none = nothing chosen yet). */
  value?: "goods" | "food" | null;
  labels: KindLabels;
  required?: boolean;
  /** the id of the form the radios belong to, when they sit inside another form's markup */
  form?: string;
}) {
  const cards = [
    { kind: "goods", title: labels.kind_goods, line: labels.kind_goods_line },
    { kind: "food", title: labels.kind_food, line: labels.kind_food_line },
  ] as const;
  return (
    <div className="grid gap-3 sm:grid-cols-2" role="radiogroup" data-kind-choice>
      {cards.map((c) => (
        <label
          key={c.kind}
          className="flex min-h-[76px] cursor-pointer items-center gap-3.5 rounded-2xl border-[1.5px] border-[#E4E4E4] bg-white p-4 has-[:checked]:border-[#111] has-[:checked]:bg-[#F7F7F7] has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-[#2563EB]"
          data-kind-card={c.kind}
        >
          <input type="radio" name={name} value={c.kind} defaultChecked={value === c.kind} required={required} form={form} className="sr-only" />
          <span className="flex size-12 flex-none items-center justify-center rounded-xl bg-[#F4F4F4]" aria-hidden="true">
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" focusable="false">
              <path d={ICONS[c.kind]} />
            </svg>
          </span>
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="text-[17px] font-bold leading-snug">{c.title}</span>
            <span className="text-sm text-[#5C5C5C]">{c.line}</span>
          </span>
        </label>
      ))}
    </div>
  );
}
