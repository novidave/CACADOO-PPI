import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { CORS_HEADERS, json, preflight, rateLimit } from "@/lib/apiHttp";
import { ApiError, DATA_RULES, getItem, getShop, searchStock } from "@/lib/publicApi";

/**
 * PPI MCP server (Streamable HTTP, stateless, read-only, no login).
 * AI assistants connect to https://<site>/mcp and get three tools that return
 * the same data and rules as the website and the public API.
 */

const INSTRUCTIONS =
  "PPI tells you which local shops have a product in stock right now, at what price, and how fresh that is. " +
  "Use search_stock for 'who has X near Y'. Always mention the shop, the price, the availability text and when the " +
  `stock was last updated, and link the source_url. ${DATA_RULES}`;

function result(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    structuredContent: data as Record<string, unknown>,
  };
}

function failure(e: unknown) {
  const message = e instanceof ApiError ? e.message : "Internal error";
  if (!(e instanceof ApiError)) console.error("mcp", e);
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

function buildServer() {
  const server = new McpServer({ name: "ppi", version: "1.0.0" }, { instructions: INSTRUCTIONS });
  const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

  server.registerTool(
    "search_stock",
    {
      title: "Search shop stock",
      description:
        "Find local shops that have a product in stock right now. Returns up to 50 items: available first, then " +
        "fresher data, then nearer. Each result has the name as the shop wrote it (name) and in the requested " +
        "language (name_translated), price, currency, availability, freshness (when the shop's stock was last " +
        "updated), the shop's name, address and coordinates, and a source_url to cite.",
      inputSchema: {
        query: z
          .string()
          .min(1)
          .max(200)
          .describe(
            "Product name in Slovak, Hungarian or English (every word must match, any order), brand, EAN barcode, " +
              "shop name, street or town. Accents and case are ignored.",
          ),
        near: z
          .string()
          .max(100)
          .optional()
          .describe("Town where PPI has shops (e.g. 'Michalovce') or coordinates 'lat,lng'. Omit to search all shops."),
        radius_km: z.number().min(0.1).max(500).optional().describe("Search radius around 'near' in km (default 10)."),
        only_available: z.boolean().optional().describe("Only items that are in stock and have fresh data."),
        lang: z
          .enum(["sk", "hu", "en"])
          .optional()
          .describe("Language of name_translated and of the source_url pages (default en)."),
      },
      annotations: { title: "Search shop stock", ...readOnly },
    },
    async ({ query, near, radius_km, only_available, lang }) => {
      try {
        return result(
          await searchStock({ q: query, near, radiusKm: radius_km, onlyAvailable: only_available, lang: lang ?? "en" }),
        );
      } catch (e) {
        return failure(e);
      }
    },
  );

  server.registerTool(
    "get_shop",
    {
      title: "Get a shop",
      description:
        "One shop by its slug (from search results): address, coordinates, phone, website, e-mail, Facebook page, opening hours, " +
        "open now, facilities (customer toilet, douchette, card payment) and stock freshness.",
      inputSchema: {
        slug: z.string().min(1).max(80).describe("Shop slug, e.g. 'potraviny-centrum'."),
        lang: z.enum(["sk", "hu", "en"]).optional(),
      },
      annotations: { title: "Get a shop", ...readOnly },
    },
    async ({ slug, lang }) => {
      try {
        return result(await getShop(slug, lang ?? "en"));
      } catch (e) {
        return failure(e);
      }
    },
  );

  server.registerTool(
    "get_item",
    {
      title: "Get an item",
      description: "One item by its id (from search results), plus the same product (EAN) in other shops, nearest first.",
      inputSchema: {
        id: z.string().uuid().describe("Item id from search_stock results."),
        lang: z.enum(["sk", "hu", "en"]).optional(),
      },
      annotations: { title: "Get an item", ...readOnly },
    },
    async ({ id, lang }) => {
      try {
        return result(await getItem(id, lang ?? "en"));
      } catch (e) {
        return failure(e);
      }
    },
  );

  return server;
}

export async function POST(request: Request) {
  const limited = await rateLimit(request, "/mcp");
  if (limited) return limited;

  // Stateless: a fresh server and transport per request, JSON responses.
  const server = buildServer();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    const response = await transport.handleRequest(request);
    const headers = new Headers(response.headers);
    for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
    return new Response(response.body, { status: response.status, headers });
  } finally {
    // Close after the response body has been produced (JSON mode).
    void transport.close();
    void server.close();
  }
}

/** No server-initiated streams in stateless mode. */
export function GET() {
  return json(
    {
      error: "This is the PPI MCP server. Connect an MCP client using Streamable HTTP (POST) to this URL.",
      tools: ["search_stock", "get_shop", "get_item"],
    },
    405,
    { Allow: "POST, OPTIONS" },
  );
}

export const DELETE = GET;
export const OPTIONS = preflight;
