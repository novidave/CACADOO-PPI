import { preflight } from "@/lib/apiHttp";
import { bodyArgs, ownerBookingCall, queryArgs } from "@/lib/ownerBookingsApi";

/** GET /api/owner/bookings?shop=&from=YYYY-MM-DD&to=YYYY-MM-DD&status= — the shop's bookings (list_bookings). */
export async function GET(request: Request) {
  return ownerBookingCall(request, "list_bookings", queryArgs(request, ["shop", "from", "to", "status", "limit", "offset"]));
}

/** POST /api/owner/bookings {shop?, service_id, starts_at, resource_id?, people?, contact_id? | name + phone, note?}. */
export async function POST(request: Request) {
  const b = await bodyArgs(request);
  return ownerBookingCall(request, "create_booking", b);
}

export const OPTIONS = preflight;
