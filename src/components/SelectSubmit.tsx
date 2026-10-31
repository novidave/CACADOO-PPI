"use client";

/**
 * A <select> of a plain GET form that sends the form as soon as another option is picked (Tovar's "Jazyk", update
 * 62). Without JavaScript the form's own button sends it.
 */
export function SelectSubmit({
  name,
  value,
  options,
  label,
  className,
  data,
}: {
  name: string;
  value: string;
  options: { value: string; label: string }[];
  label: string;
  className?: string;
  data?: string;
}) {
  return (
    <select
      name={name}
      defaultValue={value}
      aria-label={label}
      className={className}
      data-select-submit={data}
      onChange={(e) => e.currentTarget.form?.requestSubmit()}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
