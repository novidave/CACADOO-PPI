/**
 * "Nastavenie obchodu" (update 79): the setup steps of a shop and where each one is done. The database decides every
 * step (owner_setup_steps: done, optional, skipped and the missing codes); this file only names the screens. No
 * imports, so the unit tests read it as it is.
 */

export type SetupKind = "goods" | "food";
export type SetupStepKey = "details" | "hours" | "stock" | "languages" | "page" | "assistant" | "menu" | "orders" | "couriers" | "launch";

export interface SetupStep {
  key: SetupStepKey;
  done: boolean;
  optional: boolean;
  skipped: boolean;
  /** Why it is not done yet: address · city · country · contact · hours · stock · columns · languages · logo · plan ·
   * welcome · menu · menu_pdf · no_kind · zones · iban · couriers · enabled. */
  missing: string[];
}

export interface SetupState {
  kind: SetupKind;
  steps: SetupStep[];
  done: number;
  total: number;
  finished: boolean;
}

/** The steps of each kind, in their order (the same as SQL's owner_setup_steps). */
export const SETUP_STEPS: Record<SetupKind, SetupStepKey[]> = {
  goods: ["details", "hours", "stock", "languages", "page", "assistant"],
  food: ["details", "hours", "menu", "orders", "couriers", "assistant", "launch"],
};

/** Where a step is done: "/sk/dashboard/assistant/orders/menu?shop=bistro". */
export function setupStepHref(key: SetupStepKey, lang: string, shop: string): string {
  const q = (extra: Record<string, string> = {}) => `?${new URLSearchParams({ shop, ...extra })}`;
  switch (key) {
    case "details":
      return `/${lang}/dashboard${q({ at: "details" })}#details`;
    case "hours":
      return `/${lang}/dashboard${q({ at: "details" })}#hours`;
    case "stock":
      return `/${lang}/sync${q({ at: "source" })}#source`;
    case "languages":
      return `/${lang}/sync${q({ at: "review" })}#review`;
    case "page":
      return `/${lang}/dashboard${q({ at: "logo" })}#logo`;
    case "assistant":
      return `/${lang}/dashboard/assistant${q()}`;
    case "menu":
      return `/${lang}/dashboard/assistant/orders/menu${q()}`;
    case "orders":
    case "launch":
      return `/${lang}/dashboard/assistant/orders/settings${q()}`;
    case "couriers":
      return `/${lang}/dashboard/assistant/orders/couriers${q()}`;
  }
}

/** The step's one-line hint key (the assistant of a restaurant has its own). */
export function setupHintKey(key: SetupStepKey, kind: SetupKind): string {
  return key === "assistant" && kind === "food" ? "hint_assistant_food" : `hint_${key}`;
}

/** Reads owner_setup_steps' answer; anything unexpected → null (the card is then not shown). */
export function readSetup(data: unknown): SetupState | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if ((d.kind !== "goods" && d.kind !== "food") || !Array.isArray(d.steps)) return null;
  const steps = d.steps.flatMap((s): SetupStep[] => {
    if (!s || typeof s !== "object") return [];
    const x = s as Record<string, unknown>;
    if (typeof x.key !== "string" || !SETUP_STEPS[d.kind as SetupKind].includes(x.key as SetupStepKey)) return [];
    return [
      {
        key: x.key as SetupStepKey,
        done: x.done === true,
        optional: x.optional === true,
        skipped: x.skipped === true,
        missing: Array.isArray(x.missing) ? x.missing.filter((m): m is string => typeof m === "string") : [],
      },
    ];
  });
  return {
    kind: d.kind,
    steps,
    done: steps.filter((s) => s.done).length,
    total: steps.length,
    finished: steps.every((s) => s.done || (s.optional && s.skipped)),
  };
}
