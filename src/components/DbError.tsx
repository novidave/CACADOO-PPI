import { t, type Dictionary } from "@/i18n/dictionaries";

/** Shown on login-only pages when Supabase answers with an error, instead of a blank failure. */
export function DbError({ message, dict }: { message: string; dict: Dictionary }) {
  return (
    <div className="flex flex-col gap-2 border border-foreground p-4">
      <p className="font-semibold">{t(dict.account.db_error, { message })}</p>
      <p className="text-sm">{dict.account.db_update_hint}</p>
    </div>
  );
}
