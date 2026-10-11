/**
 * Whether a query failed only because a column is not in the database yet (PostgREST: 42703),
 * e.g. public_shops.booking_url before database update 26. The caller then reads without it.
 */
export function missingColumn(error: { code?: string; message?: string } | null, column: string): boolean {
  return error?.code === "42703" && String(error.message ?? "").includes(column);
}
