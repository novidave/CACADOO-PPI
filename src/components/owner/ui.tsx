import Link from "next/link";
import type { ReactNode } from "react";

/**
 * The owner pages' shared parts (back-end layout L3, 2026-11-03; canvas "Cacaduu – webová aplikácia (Môj obchod)").
 * One look for every Môj obchod page: black, white and grey, touch targets of at least 44 px, main buttons 52 px.
 * Pages use these (or the class names below) — never their own copies.
 */

/** A text field: 52 px high, radius 12, 17 px text. Also for <select> and <textarea> (which add their own rows). */
export const fieldClass =
  "min-h-[52px] w-full rounded-xl border border-[#D6D6D6] bg-white px-3.5 py-3 text-[17px] font-medium text-[#111] outline-none placeholder:text-[#8A8A8A] focus:border-[#111] disabled:bg-[#F6F6F6] disabled:text-[#5C5C5C]";
export const textareaClass = `${fieldClass} leading-snug`;
/** The main button: black, 52 px, radius 12. */
export const buttonClass =
  "inline-flex min-h-[52px] items-center justify-center gap-2 rounded-xl border border-[#111] bg-[#111] px-5 text-[17px] font-bold text-white disabled:border-[#EDEDED] disabled:bg-[#EDEDED] disabled:text-[#5C5C5C]";
/** The second button: white with a #D6D6D6 line. */
export const ghostClass =
  "inline-flex min-h-[52px] items-center justify-center gap-2 rounded-xl border border-[#D6D6D6] bg-white px-5 text-[17px] font-bold text-[#111] disabled:text-[#5C5C5C]";
/** A card: 1 px #E4E4E4 line, radius 16, padding 18. */
export const cardClass = "flex flex-col gap-3.5 rounded-2xl border border-[#E4E4E4] bg-white p-[18px]";

export function Card({
  title,
  actions,
  id,
  children,
  className = "",
  ...data
}: {
  title?: ReactNode;
  actions?: ReactNode;
  id?: string;
  children: ReactNode;
  className?: string;
} & Record<`data-${string}`, string | boolean | undefined>) {
  return (
    <section id={id} className={`${cardClass} scroll-mt-4 ${className}`} {...data}>
      {(title || actions) && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          {title && <h2 className="text-[19px] font-bold">{title}</h2>}
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

/** A field with its label above (14 px, semibold) and an optional hint under the label. */
export function Field({ label, hint, children, className = "" }: { label: ReactNode; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={`flex min-w-0 flex-col gap-1.5 ${className}`}>
      <span className="text-sm font-semibold text-[#111]">{label}</span>
      {hint && <span className="text-[13px] text-[#5C5C5C]">{hint}</span>}
      {children}
    </label>
  );
}

/** A button or a link that looks like one. */
export function Button({
  href,
  ghost = false,
  type = "button",
  children,
  className = "",
  ...rest
}: {
  href?: string;
  ghost?: boolean;
  type?: "button" | "submit";
  children: ReactNode;
  className?: string;
} & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "type" | "className" | "children">) {
  const cls = `${ghost ? ghostClass : buttonClass} ${className}`;
  if (href) {
    return (
      <Link href={href} className={cls}>
        {children}
      </Link>
    );
  }
  return (
    <button type={type} className={cls} {...rest}>
      {children}
    </button>
  );
}

/**
 * A switch: a real checkbox drawn 56×32 (globals.css `.ppi-toggle`), the label on the left. An unticked box is sent as
 * nothing, as before.
 */
export function Toggle({
  name,
  label,
  hint,
  defaultChecked,
  disabled,
}: {
  name: string;
  label: ReactNode;
  hint?: ReactNode;
  defaultChecked?: boolean;
  disabled?: boolean;
}) {
  return (
    <label className="flex min-h-14 items-center justify-between gap-3 text-base font-semibold">
      <span className="flex flex-col">
        {label}
        {hint && <span className="text-[13px] font-medium text-[#5C5C5C]">{hint}</span>}
      </span>
      <input type="checkbox" name={name} defaultChecked={defaultChecked} disabled={disabled} className="ppi-toggle" />
    </label>
  );
}

/** A segmented choice (radio buttons that look like one row of buttons, 48 px). */
export function Segmented({
  name,
  options,
  value,
  label,
}: {
  name: string;
  options: { value: string; label: ReactNode }[];
  value: string;
  label: string;
}) {
  return (
    <fieldset className="flex min-w-0 flex-col gap-1.5">
      <legend className="mb-1.5 text-sm font-semibold">{label}</legend>
      <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}>
        {options.map((o) => (
          <label key={o.value} className="relative">
            <input type="radio" name={name} value={o.value} defaultChecked={o.value === value} className="peer sr-only" />
            <span className="flex min-h-12 cursor-pointer items-center justify-center rounded-xl border border-[#D6D6D6] bg-white px-2 text-center text-base font-bold peer-checked:border-2 peer-checked:border-[#111] peer-checked:bg-[#111] peer-checked:text-white peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2">
              {o.label}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** A small rounded label (34 px), optionally with a status dot before the text. */
export function Chip({ children, dot }: { children: ReactNode; dot?: string }) {
  return (
    <span className="inline-flex h-[34px] items-center gap-1.5 whitespace-nowrap rounded-full border border-[#E4E4E4] px-3 text-sm font-semibold">
      {dot && <StatusDot color={dot} />}
      {children}
    </span>
  );
}

/** A status dot (always next to words — never colour alone). */
export function StatusDot({ color, size = 10 }: { color: string; size?: number }) {
  return (
    <span
      aria-hidden="true"
      className="inline-block flex-none rounded-full shadow-[0_0_0_1px_rgba(0,0,0,.25)]"
      style={{ width: size, height: size, background: color }}
    />
  );
}
