import Link from "next/link";
import { t, type Dictionary } from "@/i18n/dictionaries";
import type { MyShop } from "@/lib/myShops";
import { setupHintKey, setupStepHref, type SetupState, type SetupStep } from "@/lib/setupSteps";
import { buttonClass, cardClass, ghostClass } from "@/components/owner/ui";
import { launchFoodOrders, skipSetupStep } from "./actions";
import { hiddenFields } from "./shared";

/**
 * "Nastavenie obchodu" (update 79): a checklist card at the top of Môj obchod until every step is done (or, optional,
 * skipped). The database decides each step (owner_setup_steps); here only the screen: each step a 52 px link to the
 * place where it is done, "Hotovo" / "Chýba – <why>", "Preskočiť" for an optional step, and on a restaurant's last step
 * "Prijímať objednávky" (the food switch) with the page's preview.
 */
export function SetupCard({
  state,
  shop,
  lang,
  dict,
  preview,
}: {
  state: SetupState;
  shop: MyShop;
  lang: string;
  dict: Dictionary;
  /** The shop's public page (null while it is hidden from visitors). */
  preview: string | null;
}) {
  const s = dict.setup as Record<string, string>;
  const hidden = hiddenFields(lang, shop);
  const percent = state.total ? Math.round((state.done / state.total) * 100) : 0;
  const why = (step: SetupStep) => step.missing.map((m) => s[`miss_${m}`] ?? m).join(" · ");

  return (
    <section className={cardClass} aria-labelledby="setup-title" data-setup-card={state.kind}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="setup-title" className="text-[19px] font-bold">
          {s.title}
        </h2>
        <span className="text-sm font-semibold tabular-nums" data-setup-progress>
          {t(s.progress, { done: state.done, total: state.total })}
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-[#EEEEEE]" aria-hidden="true">
        <div className="h-full rounded-full bg-[#111]" style={{ width: `${percent}%` }} />
      </div>
      <p className="text-sm text-[#5C5C5C]">{state.kind === "food" ? s.intro_food : s.intro_goods}</p>
      <ol className="flex flex-col divide-y divide-[#EEEEEE]">
        {state.steps.map((step) => {
          const settled = step.done || step.skipped;
          return (
            <li key={step.key} className="flex flex-col gap-2 py-2 sm:flex-row sm:items-center sm:justify-between" data-setup-step={step.key} data-setup-done={step.done ? "1" : "0"}>
              <Link href={setupStepHref(step.key, lang, shop.slug)} className="flex min-h-[52px] min-w-0 flex-1 items-center gap-3 rounded-xl px-1 hover:bg-[#F7F7F7]">
                <span
                  className={`flex size-7 flex-none items-center justify-center rounded-full border-2 ${settled ? "border-[#111] bg-[#111] text-white" : "border-[#BDBDBD] bg-white"}`}
                  aria-hidden="true"
                >
                  {step.done && (
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" focusable="false">
                      <path d="M5 12.5l4.5 4.5L19 7.5" />
                    </svg>
                  )}
                </span>
                <span className="flex min-w-0 flex-col">
                  <span className="flex flex-wrap items-center gap-x-2 text-base font-bold">
                    {s[`step_${step.key}`]}
                    {step.optional && <span className="rounded-full bg-[#F4F4F4] px-2 py-0.5 text-xs font-semibold text-[#5C5C5C]">{s.optional}</span>}
                  </span>
                  <span className="text-sm text-[#5C5C5C]">{s[setupHintKey(step.key, state.kind)]}</span>
                  <span className="text-sm font-semibold" data-setup-status>
                    {step.done ? s.done : step.skipped ? s.skipped : `${s.missing} – ${why(step)}`}
                  </span>
                </span>
              </Link>
              <div className="flex flex-none flex-wrap items-center gap-2 pl-10 sm:pl-0">
                {step.key === "launch" && !step.done && (
                  <>
                    {preview && (
                      <a href={preview} target="_blank" rel="noopener" className={`${ghostClass} min-h-11`}>
                        {s.preview}
                      </a>
                    )}
                    <form action={launchFoodOrders}>
                      {hidden({ at: "" })}
                      <button type="submit" className={`${buttonClass} min-h-11`} data-setup-launch>
                        {s.launch}
                      </button>
                    </form>
                  </>
                )}
                {step.optional && !step.done && (
                  <form action={skipSetupStep}>
                    {hidden({ at: "", step: step.key, skip: step.skipped ? "0" : "1" })}
                    <button type="submit" className={`${ghostClass} min-h-11`} data-setup-skip={step.key}>
                      {step.skipped ? s.unskip : s.skip}
                    </button>
                  </form>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
