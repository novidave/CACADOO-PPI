import { cookies } from "next/headers";
import { isLocale } from "@/i18n/config";
import { COURIER_COOKIE, courierCall } from "@/lib/courier";

/** "Odhlásiť sa" on the courier's phone: the key ends in the database, the cookie goes. */
export async function POST(request: Request) {
  const form = await request.formData().catch(() => new FormData());
  const lang = isLocale(String(form.get("lang") ?? "")) ? String(form.get("lang")) : "sk";
  await courierCall("logout");
  (await cookies()).delete(COURIER_COOKIE);
  return Response.redirect(new URL(`/${lang}/kurier`, request.url), 303);
}
