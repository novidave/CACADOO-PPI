import type { Metadata } from "next";
import { isLocale } from "@/i18n/config";
import { getDictionary } from "@/i18n/dictionaries";

// The courier app (database update 75): private, never indexed or cached; installable on its own (start = /kurier).
export async function generateMetadata({ params }: LayoutProps<"/[lang]/kurier">): Promise<Metadata> {
  const { lang } = await params;
  const title = isLocale(lang) ? (await getDictionary(lang)).courier.app_title : "Cacaduu";
  return {
    title,
    robots: { index: false, follow: false },
    manifest: `/${isLocale(lang) ? lang : "sk"}/kurier/manifest.webmanifest`,
  };
}
export const dynamic = "force-dynamic";

/** One phone column, no Cacaduu header (globals.css hides it next to [data-courier-app]). */
export default function CourierLayout({ children }: LayoutProps<"/[lang]/kurier">) {
  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-4" data-courier-app>
      {children}
    </div>
  );
}
