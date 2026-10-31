import "server-only";
import { functionFailure } from "./functionError";
import { createPublicClient } from "./supabase/public";

/**
 * Bookings through the shop assistant (database update 57): the website talks to the bookings Edge Function with the
 * secret it already shares with Supabase (ASSISTANT_ARCHIVE_SECRET, header x-ppi-website). The function and the
 * database decide everything: the free times (opening hours, other bookings, the shop's Google Calendar), the SMS code,
 * the confirmation. The shopper's name, number and address never go to the AI.
 */

/** The text of the consent the shopper ticks (`booking.consent`); the database keeps this version with the booking. */
export const CONSENT_VERSION = "booking-2026-10-30";

export interface Slot {
  starts_at: string;
  ends_at: string;
}

export interface SlotList {
  available: boolean;
  timezone?: string;
  service_name?: string | null;
  duration_minutes?: number;
  slots: Slot[];
}

function secret(): string | null {
  const value = process.env.ASSISTANT_ARCHIVE_SECRET?.trim();
  return value && value.length >= 32 ? value : null;
}

/** On when the website may talk to the bookings function. */
export function bookingsEnabled(): boolean {
  return secret() !== null && createPublicClient() !== null;
}

/** One call; the function's own refusal comes back as `error` (its reason code) with its HTTP status. */
export async function bookingsCall<T>(body: Record<string, unknown>): Promise<{ data: T | null; error: string | null; status: number; extra?: Record<string, unknown> }> {
  const key = secret();
  const supabase = createPublicClient();
  if (!key || !supabase) return { data: null, error: "unavailable", status: 503 };
  const { data, error } = await supabase.functions.invoke<T>("bookings", { body, headers: { "x-ppi-website": key } });
  if (!error) return { data: data ?? null, error: null, status: 200 };
  const failure = await functionFailure(error);
  if (!failure.error) console.error(`bookings: ${String(body.action)} failed (${failure.detail})`);
  // The function's answer beside its reason (e.g. attempts_left of a wrong code).
  const context = (error as { context?: unknown }).context;
  const extra = context instanceof Response ? ((await context.clone().json().catch(() => null)) as Record<string, unknown> | null) : null;
  return { data: null, error: failure.error ?? "failed", status: failure.status ?? 502, extra: extra ?? undefined };
}

/** Free times of a shop from a local day for up to 7 days (the assistant's find_slots). */
export async function findSlots(slug: string, from: string | null, days: number): Promise<SlotList | null> {
  const { data } = await bookingsCall<SlotList>({ action: "slots", slug, from, days: Math.min(Math.max(days, 1), 7) });
  return data;
}

// ---------------------------------------------------------------- update 63: the assistant's tools

/** A service the assistant may offer (shop_booking_services). */
export interface BookingService {
  id: string;
  name: string;
  duration_minutes: number;
  capacity: number;
  needs_resource: boolean;
  note: string | null;
}

/** A free start offered in one conversation: the short ref is the only thing the AI ever sends back. */
export interface OfferedSlot {
  ref: string;
  starts_at: string;
  ends_at: string;
  resource_name: string | null;
  seats_left: number;
}

export interface BookedSlot {
  id: string;
  starts_at: string;
  ends_at: string;
  service_name: string | null;
  resource_name: string | null;
  timezone: string;
}

export interface ChatConversation {
  id: string;
  token: string;
}

export async function bookingServices(slug: string): Promise<BookingService[]> {
  const { data } = await bookingsCall<{ services: BookingService[] }>({ action: "services", slug });
  return data?.services ?? [];
}

/** find_free_slots: booking_free_slots through booking_offer_slots (refs kept 30 minutes for this conversation). */
export async function offerSlots(slug: string, conversation: ChatConversation, serviceId: string, from: string, to: string) {
  return bookingsCall<{ available: boolean; timezone?: string; slots: OfferedSlot[] }>({
    action: "offer", slug, service_id: serviceId, from, to, conversation_id: conversation.id, conversation_token: conversation.token,
  });
}

/** book_slot: only a ref offered in this conversation, only for the contact verified in it (booking_create checks again). */
export async function bookOffered(slug: string, conversation: ChatConversation, ref: string, people = 1) {
  return bookingsCall<{ ok: boolean; booking: BookedSlot }>({
    action: "book", slug, ref, people, conversation_id: conversation.id, conversation_token: conversation.token,
  });
}

