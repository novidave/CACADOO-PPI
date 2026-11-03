import { isLocale } from "@/i18n/config";
import { getDictionary } from "@/i18n/dictionaries";

/** The courier app on its own home screen (database update 75): starts at /<lang>/kurier, no browser bars. */
export async function GET(_request: Request, { params }: { params: Promise<{ lang: string }> }) {
  const { lang: value } = await params;
  const lang = isLocale(value) ? value : "sk";
  const c = (await getDictionary(lang)).courier;
  return Response.json(
    {
      name: c.app_title,
      short_name: c.title,
      description: c.app_description,
      lang,
      start_url: `/${lang}/kurier`,
      scope: `/${lang}/kurier`,
      display: "standalone",
      background_color: "#ffffff",
      theme_color: "#ffffff",
      icons: [
        { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
        { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
      ],
    },
    { headers: { "Content-Type": "application/manifest+json", "Cache-Control": "public, max-age=3600" } },
  );
}
