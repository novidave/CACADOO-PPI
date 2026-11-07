"use client";

/**
 * A switch (`.ppi-toggle`, 56×32) that sends its form as soon as it is flipped (Novinky / Blog's "Publikovať
 * importované automaticky", 2026-11-07). The form gets `name` = `on` when on and `off` when off (a hidden field after
 * the box carries `off`, so the first value read is the box's when it is ticked). Without JavaScript the form's own
 * button (in `<noscript>`) sends it.
 */
export function ToggleSubmit({
  name,
  label,
  defaultChecked,
  on = "1",
  off = "0",
  data,
}: {
  name: string;
  label: string;
  defaultChecked: boolean;
  on?: string;
  off?: string;
  data?: string;
}) {
  return (
    <label className="flex min-h-14 items-center justify-between gap-3 text-[15px] font-semibold">
      {label}
      <input
        type="checkbox"
        name={name}
        value={on}
        defaultChecked={defaultChecked}
        className="ppi-toggle"
        onChange={(e) => e.currentTarget.form?.requestSubmit()}
        data-toggle-submit={data}
      />
      <input type="hidden" name={name} value={off} />
    </label>
  );
}
