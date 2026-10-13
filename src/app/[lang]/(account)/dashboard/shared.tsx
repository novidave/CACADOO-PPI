import Link from "next/link";
import { t, type Dictionary } from "@/i18n/dictionaries";
import type { MyShop } from "@/lib/myShops";
import { PendingButton } from "@/components/PendingButton";

/**
 * What the three Môj obchod pages share: the messages after a form, the shop switcher and
 * the small form parts. Each page keeps a form's message inside that form's section.
 */

const ERRORS = [
  "name",
  "limit",
  "columns",
  "website",
  "email",
  "facebook",
  "booking",
  "logo",
  "translation",
  "plan_active",
  "special_dates",
  "special_ranges",
  "plan_unavailable",
  "no_plan",
] as const;

export function errorText(dict: Dictionary, err: string): string {
  if (err === "logo") return dict.dashboard.logo_bad;
  if (err === "site_logo") return dict.sections.error_site_logo;
  if (err.startsWith("sections_failed:")) return t(dict.sections.error_failed, { message: err.slice("sections_failed:".length) });
  if (err.startsWith("sections_")) {
    const text = (dict.sections as Record<string, string>)[`error_${err.slice("sections_".length)}`];
    if (text) return text;
  }
  if (err.startsWith("docs:")) return t(dict.docs.error_failed, { message: err.slice("docs:".length) });
  if (err.startsWith("docs_")) {
    const text = (dict.docs as Record<string, string>)[`error_${err.slice("docs_".length)}`];
    if (text) return text;
  }
  if (err.startsWith("stripe:")) return t(dict.plan.failed, { message: err.slice("stripe:".length) });
  if (err.startsWith("cloud_")) {
    const code = err.slice("cloud_".length);
    if (code === "share_link") return dict.cloud.share_link;
    if (code.startsWith("other:")) return t(dict.cloud.error_other, { message: code.slice("other:".length) });
    // The provider's short reason code ("AADSTS90014"), for the owner to pass on.
    if (code.startsWith("failed:")) return t(dict.cloud.error_failed_why, { why: code.slice("failed:".length).replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 40) });
    return (dict.cloud as Record<string, string>)[`error_${code}`] ?? dict.cloud.error_failed;
  }
  const key = ERRORS.find((e) => e === err);
  if (key && key !== "logo") return key === "website" ? t(dict.account.error, { message: err }) : dict.owner[`error_${key}`];
  return t(dict.account.error, { message: err });
}

/** The "ok" messages of every section (unknown ones say "Saved"). */
export function okTexts(dict: Dictionary, extra: { retention?: number; backfilled?: number } = {}): Record<string, string> {
  const o = dict.owner;
  const d = dict.dashboard;
  return {
    columns: o.columns_saved,
    translation: d.translation_saved,
    translation_auto: d.translation_auto_done,
    docs_terms: dict.docs.ok_terms,
    docs_deleted: dict.docs.ok_deleted,
    docs_revoked: dict.docs.ok_revoked,
    docs_access: dict.docs.ok_access,
    shopper_pdf: dict.conversations.shopper_pdf_saved,
    assistant_cleaned: d.assistant_cleaned,
    retention: t(dict.conversations.retention_saved, { n: extra.retention ?? 90 }),
    conversation_deleted: dict.conversations.deleted,
    cloud_connected: dict.cloud.ok_connected,
    cloud_disconnected: dict.cloud.ok_disconnected,
    cloud_folder: dict.cloud.ok_folder,
    cloud_backfill: t(dict.cloud.ok_backfill, { n: extra.backfilled ?? 0 }),
    cloud_retry: dict.cloud.ok_retry,
    holidays_auto: dict.holidays.saved,
    special_saved: dict.holidays.special_saved,
    special_deleted: dict.holidays.special_deleted,
    section_uploaded: dict.sections.done,
    section_uploaded_removed: `${dict.sections.done} ${dict.sections.removed}`,
    section_saved: dict.sections.ok_saved,
    section_published: dict.sections.ok_published,
    section_hidden: dict.sections.ok_hidden,
    section_shown: dict.sections.ok_shown,
    section_deleted: dict.sections.ok_deleted,
    site_logo_saved: dict.sections.ok_site_logo,
    site_logo_removed: dict.sections.ok_site_logo_removed,
    site_logo_link_saved: dict.sections.ok_site_logo_link,
    site_logo_link_removed: dict.sections.ok_site_logo_link_removed,
  };
}

/**
 * The message after a form: inside its section when it came back with ?at=… (the page jumps
 * there and opens it), else at the top of the page.
 */
export function messages(dict: Dictionary, sp: Record<string, string | string[] | undefined>, extra: Parameters<typeof okTexts>[1] = {}) {
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const ok = one(sp.ok);
  const err = one(sp.err);
  const at = one(sp.at);
  const okText = (ok && okTexts(dict, extra)[ok]) || dict.account.saved;
  const box = (
    <p role="status" className={ok ? "border border-foreground p-3 font-medium" : "border border-line p-3"}>
      {ok ? okText : errorText(dict, err ?? "")}
    </p>
  );
  return {
    ok,
    err,
    at,
    okText,
    /** For one section: its message, if the form came back to it. */
    notice: (section: string) => (at === section && (ok || err) ? box : null),
    /** At the top: a message that belongs to no section. */
    top: !at && (ok || err) ? box : null,
    /** A section's props: opens it when the form came back to it. */
    section: (id: string) => ({ id, forceOpen: at === id }),
  };
}

/** The shop switcher of a Môj obchod page (only with more than one shop). */
export function ShopSwitcher({
  shops,
  current,
  href,
  label,
}: {
  shops: MyShop[];
  current: MyShop;
  href: (slug: string) => string;
  label: string;
}) {
  if (shops.length < 2) return null;
  return (
    <nav className="flex flex-wrap gap-3 text-sm" aria-label={label}>
      {shops.map((s) => (
        <Link
          key={s.id}
          href={href(s.slug)}
          className={s.id === current.id ? "font-semibold underline underline-offset-4" : "text-muted hover:underline"}
        >
          {s.name}
        </Link>
      ))}
    </nav>
  );
}

export const inputClass = "rounded border border-line px-3 py-2 outline-none focus:border-foreground";

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-sm">{label}</span>
      {children}
    </label>
  );
}

export function SubmitButton({ children, pending }: { children: React.ReactNode; pending?: string }) {
  if (pending) return <PendingButton pending={pending}>{children}</PendingButton>;
  return (
    <button type="submit" className="self-start rounded border border-foreground px-4 py-2 font-medium">
      {children}
    </button>
  );
}

/** The hidden fields every form of a Môj obchod page sends. */
export function hiddenFields(lang: string, shop: MyShop) {
  return function hidden(extra: Record<string, string> = {}) {
    return (
      <>
        <input type="hidden" name="lang" value={lang} />
        <input type="hidden" name="shop_id" value={shop.id} />
        <input type="hidden" name="shop_slug" value={shop.slug} />
        {Object.entries(extra).map(([k, v]) => (
          <input key={k} type="hidden" name={k} value={v} />
        ))}
      </>
    );
  };
}
