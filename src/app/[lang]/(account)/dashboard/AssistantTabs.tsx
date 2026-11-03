/**
 * The Asistent tab row of update 63 became the menu items CRM, Rezervácie, Objednávky jedla and AI asistent with their
 * own tabs (back-end layout L2, @/components/owner/PageHead); what stays here is the count their badges show.
 */

/** How many shoppers wait for an answer in this shop (database update 59), for the tab's badge. */
export async function waitingCount(
  supabase: { rpc: (name: string) => PromiseLike<{ data: unknown; error: unknown }> },
  shopId: string,
): Promise<number> {
  const { data, error } = await supabase.rpc("owner_callbacks_waiting");
  if (error) return 0;
  return ((data ?? []) as { shop_id?: string; waiting: number }[])
    .filter((r) => !r.shop_id || r.shop_id === shopId)
    .reduce((n, r) => n + Number(r.waiting), 0);
}
