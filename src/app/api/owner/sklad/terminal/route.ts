import { isLocale, type Locale } from "@/i18n/config";
import { getDictionary } from "@/i18n/dictionaries";
import { skladRpc } from "@/lib/skladDevice";
import { formatPrice, formatTime } from "@/lib/format";
import { payBySquareSvg } from "@/lib/payBySquare";
import { formatQty, paymentMessage } from "@/lib/sklad";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PRIVATE = { "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex" };

interface Terminal {
  state: "standby" | "waiting" | "paid";
  shop_name: string;
  id?: string;
  total?: number;
  pieces?: number;
  vs?: string;
  created_at?: string;
  paid_at?: string | null;
  location?: string | null;
  timezone?: string;
  payee?: string;
  iban?: string | null;
  bic?: string | null;
}

/**
 * The QR terminal's state (database update 68), read every 3 s by the spare phone at the counter — an owner's login or,
 * since update 72, a phone paired with the "terminal" tick: standby, the waiting QR sale with its PAY by square code (an
 * SVG made here) and its texts, or the sale just paid. owner_sklad_terminal decides; never cached.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const shopId = url.searchParams.get("shop") ?? "";
  const langParam = url.searchParams.get("lang") ?? "";
  const lang: Locale = isLocale(langParam) ? langParam : "sk";
  // the owner's login, or a phone paired with the "terminal" tick (database update 72)
  const rpc = await skladRpc();
  if (!rpc) return Response.json({ error: "login" }, { status: 401, headers: PRIVATE });
  if (!UUID.test(shopId)) return Response.json({ error: "shop" }, { status: 404, headers: PRIVATE });
  const { data, error } = await rpc("owner_sklad_terminal", { p_shop_id: shopId });
  if (error) return Response.json({ error: "failed" }, { status: error.code === "42501" || error.code === "28000" ? 403 : 500, headers: PRIVATE });
  const t = data as Terminal;
  if (t.state === "standby" || !t.id) return Response.json({ state: "standby", shop: t.shop_name }, { headers: PRIVATE });
  const s = (await getDictionary(lang)).sklad;
  const tz = t.timezone ?? "UTC";
  const created = new Date(t.created_at ?? Date.now());
  const message = paymentMessage(s.message_word, created, tz, lang);
  const svg =
    t.state === "waiting" && t.iban
      ? await payBySquareSvg({ iban: t.iban, bic: t.bic ?? null, payee: t.payee ?? t.shop_name, amount: Number(t.total), vs: t.vs ?? "", message })
      : null;
  return Response.json(
    {
      state: t.state,
      shop: t.shop_name,
      id: t.id,
      total: formatPrice(Number(t.total), lang, "EUR"),
      pieces: formatQty(Number(t.pieces), "ks", lang),
      vs: t.vs,
      created: formatTime(created, tz),
      paid: t.paid_at ? formatTime(new Date(t.paid_at), tz) : null,
      location: t.location ?? "",
      svg,
    },
    { headers: PRIVATE },
  );
}
