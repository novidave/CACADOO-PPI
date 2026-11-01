import { preflight } from "@/lib/apiHttp";
import { ownerBookingCall, queryArgs } from "@/lib/ownerBookingsApi";

/** GET /api/owner/bookings/services?shop= — services, resources and rules (list_booking_services). */
export async function GET(request: Request) {
  return ownerBookingCall(request, "list_booking_services", queryArgs(request, ["shop"]));
}

export const OPTIONS = preflight;
