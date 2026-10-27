import { z } from "zod";
export const fields = [
  "source_code",
  "name",
  "quantity",
  "price",
  "currency",
  "ean",
  "brand",
] as const;
export type Field = (typeof fields)[number];
export type Row = Record<string, string>;
export const configSchema = z.object({
  backend: z.string().url(),
  kind: z.enum(["file", "rest"]),
  mapping: z.object({
    source_code: z.string().min(1),
    name: z.string().min(1),
    quantity: z.string().min(1),
    price: z.string().min(1),
    currency: z.string().min(1),
    ean: z.string().optional(),
    brand: z.string().optional(),
  }),
  expectedRows: z.number().int().positive().max(100000),
  knowledge: z.literal("reported_stock"),
  intervalMinutes: z.number().int().min(1).max(1440).default(15),
  rest: z
    .object({
      url: z.string().url(),
      itemsPath: z.string().min(1),
      totalPath: z.string().min(1),
      timePath: z.string().min(1),
      pageParam: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
      pageSizeParam: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
      pageSize: z.number().int().min(1).max(10000),
      token: z.string().max(4096).optional(),
    })
    .optional(),
});
export type Config = z.infer<typeof configSchema>;
export const bindingSchema = z.object({
  deviceId: z.string().uuid(),
  shopId: z.string().uuid(),
  sourceId: z.string().uuid(),
  generation: z.number().int().nonnegative(),
  token: z.string().min(16).max(4096),
  expiresAt: z.string().datetime(),
});
export type Binding = z.infer<typeof bindingSchema>;
export const statusSchema = z.object({
  active: z.boolean(),
  generation: z.number().int(),
  mappingApproved: z.boolean(),
  mappingVersion: z.string().min(1),
  latestSourceTime: z.string().datetime().nullable(),
});
export type Batch = {
  id: string;
  sourceTimestamp: string;
  hash: string;
  csv: string;
  rows: number;
  createdAt: number;
  attempts: number;
  nextAt: number;
  generation: number;
};
export const MAX_BYTES = 50 * 1024 * 1024;
export function privateColumn(name: string) {
  return (
    /purchase|cost|supplier|vendor|margin|profit|invoice|nakup|dodavatel|marz|zisk|faktur|beszerz|szallit|haszon|rechnung|lieferant/i.test(
      name.normalize("NFD").replace(/[\u0300-\u036f]/g, ""),
    ) || /^nc(?:\s|$)/i.test(name)
  );
}
export function assertHttps(value: string) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.hash)
    throw Error("HTTPS_REQUIRED");
  return url;
}
