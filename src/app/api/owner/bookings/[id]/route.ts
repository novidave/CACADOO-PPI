import { preflight } from "@/lib/apiHttp";
import { bodyArgs, ownerBookingCall } from "@/lib/ownerBookingsApi";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * PATCH /api/owner/bookings/<id> {starts_at, resource_id?, confirm?} — move a booking. Without "confirm": true it only
 * answers before → after and whether the new time is free; the customer's SMS goes only after the confirmed move.
 */
export async function PATCH(request: Request, { params }: RouteContext<"/api/owner/bookings/[id]">) {
  const { id } = await params;
  if (!UUID.test(id)) return Response.json({ error: "Unknown booking." }, { status: 404 });
  return ownerBookingCall(request, "move_booking", { ...(await bodyArgs(request)), booking_id: id });
}

/** DELETE /api/owner/bookings/<id>?confirm=true — cancel a booking (without confirm: what would be cancelled). */
export async function DELETE(request: Request, { params }: RouteContext<"/api/owner/bookings/[id]">) {
  const { id } = await params;
  if (!UUID.test(id)) return Response.json({ error: "Unknown booking." }, { status: 404 });
  const confirm = new URL(request.url).searchParams.get("confirm") === "true";
  return ownerBookingCall(request, "cancel_booking", { booking_id: id, confirm });
}

export const OPTIONS = preflight;
