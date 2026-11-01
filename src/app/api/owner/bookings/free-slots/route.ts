import { preflight } from "@/lib/apiHttp";
import { ownerBookingCall, queryArgs } from "@/lib/ownerBookingsApi";

/** GET /api/owner/bookings/free-slots?shop=&service_id=&from=YYYY-MM-DD&days=1..14&resource_id=&people= (find_free_slots). */
export async function GET(request: Request) {
  return ownerBookingCall(request, "find_free_slots", queryArgs(request, ["shop", "service_id", "from", "days", "resource_id", "people"]));
}

export const OPTIONS = preflight;
