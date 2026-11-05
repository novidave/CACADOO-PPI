import type { Dictionary } from "@/i18n/dictionaries";
import { PendingButton } from "@/components/PendingButton";
import { saveLimits } from "../translations/actions";

/**
 * The plans' numbers of pre-translated languages (database update 40: admin_save_translation_limits; on Limity plánov
 * since 2026-11-05, the cost and the budget stay on Preklady).
 */
export function TranslationLimitsAdmin({
  limits,
  dict,
  hidden,
}: {
  limits: { plan: "free" | "pro"; max_preferred: number }[] | null;
  dict: Dictionary;
  hidden: React.ReactNode;
}) {
  const a = dict.admin_tr;
  return (
    <section id="translation-limits" className="flex flex-col gap-3" aria-labelledby="translation-limits-heading">
      <h2 id="translation-limits-heading" className="text-lg font-semibold">
        {a.limits_title}
      </h2>
      <p className="text-sm text-muted">{a.limits_help}</p>
      {!limits ? (
        <p className="text-sm text-muted">{dict.owner_blog.unavailable}</p>
      ) : (
        <form action={saveLimits} className="flex flex-wrap items-end gap-3 text-sm" data-translation-limits>
          {hidden}
          {(["free", "pro"] as const).map((plan) => (
            <label key={plan} className="flex flex-col gap-1">
              <span className="text-muted">{plan === "free" ? a.limit_free : a.limit_pro}</span>
              <input type="number" name={plan} min={0} max={42} defaultValue={limits.find((l) => l.plan === plan)?.max_preferred ?? (plan === "free" ? 2 : 6)} className="w-24 rounded border border-line px-2 py-2" />
            </label>
          ))}
          <PendingButton pending={dict.owner.saving}>{a.save}</PendingButton>
        </form>
      )}
    </section>
  );
}
