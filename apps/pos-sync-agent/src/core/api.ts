import { z } from "zod";
import {
  assertHttps,
  bindingSchema,
  statusSchema,
  type Binding,
  type Batch,
} from "./model";
import { jsonRequest } from "./network";
export type Requester = typeof jsonRequest;
export function endpoint(
  origin: string,
  name: "agent-pair" | "agent-status" | "agent-upload",
) {
  const u = assertHttps(origin);
  if (u.pathname !== "/" || u.search) throw Error("BACKEND_ORIGIN_REQUIRED");
  return new URL(`/functions/v1/${name}`, u).toString();
}
export async function pair(
  origin: string,
  code: string,
  request: Requester = jsonRequest,
) {
  const parsedBinding = bindingSchema.safeParse(
    await request(endpoint(origin, "agent-pair"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version: 1, code }),
    }),
  );
  if (!parsedBinding.success) throw Error("API_CONTRACT");
  const binding = parsedBinding.data;
  if (Date.parse(binding.expiresAt) <= Date.now()) throw Error("PAIR_EXPIRED");
  return binding;
}
export async function status(
  origin: string,
  binding: Binding,
  request: Requester = jsonRequest,
) {
  if (Date.parse(binding.expiresAt) <= Date.now()) throw Error("PAIR_EXPIRED");
  const parsedStatus = statusSchema.safeParse(
    await request(endpoint(origin, "agent-status"), {
      headers: { Authorization: `Bearer ${binding.token}` },
    }),
  );
  if (!parsedStatus.success) throw Error("API_CONTRACT");
  const value = parsedStatus.data;
  if (!value.active || value.generation !== binding.generation)
    throw Error("SOURCE_NOT_ACTIVE");
  if (!value.mappingApproved) throw Error("MAPPING_NOT_APPROVED");
  return value;
}
const receiptSchema = z.object({
  status: z.enum(["updated", "unchanged"]),
  idempotencyKey: z.string(),
  sourceId: z.string(),
  generation: z.number().int(),
});
export async function upload(
  origin: string,
  binding: Binding,
  batch: Batch,
  mappingVersion: string,
  request: Requester = jsonRequest,
) {
  if (batch.generation !== binding.generation) throw Error("SOURCE_NOT_ACTIVE");
  const result = await request(endpoint(origin, "agent-upload"), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${binding.token}`,
      "Content-Type": "application/json",
      "Idempotency-Key": batch.id,
    },
    body: JSON.stringify({
      version: 1,
      sourceId: binding.sourceId,
      generation: batch.generation,
      knowledge: "reported_stock",
      mode: "full",
      sourceTimestamp: batch.sourceTimestamp,
      sha256: batch.hash,
      rowCount: batch.rows,
      mappingVersion,
      format: "csv",
      encoding: "utf-8",
      file: batch.csv,
    }),
  });
  if (
    result &&
    typeof result === "object" &&
    (result as { status?: string }).status === "waiting_for_approval"
  )
    throw Error("MAPPING_NOT_APPROVED");
  const receipt = receiptSchema.safeParse(result);
  if (
    !receipt.success ||
    receipt.data.idempotencyKey !== batch.id ||
    receipt.data.sourceId !== binding.sourceId ||
    receipt.data.generation !== binding.generation
  )
    throw Error("UPLOAD_REJECTED");
  return receipt.data;
}
