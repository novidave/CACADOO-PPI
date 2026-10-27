# POS Sync Agent — compatibility audit and phased plan

Audit date: 27 October 2026. Source baseline: `origin/main` at
`3d3eb761d0d449f26918f9e846c265dc46edbcde` (merged PR #61).
Branch: `feature/pos-sync-agent`.

## Scope and decision

This is section 10 steps 1–2 only. The supplied [handover](POS_AGENT_HANDOVER.md)
is preserved verbatim; its section 0 controls conflicting advice elsewhere in it.
`CLAUDE.md` was read in full, including the updates on current main. This audit
adds documentation only: no Electron scaffold, app changes, SQL changes, database
commands, deployments, production requests or vendor-device access.

**Recommendation:** reuse the existing ingestion behavior for verified complete
reported-inventory snapshots, after adding scoped device authorization and atomic
source arbitration. Reject catalog-only, estimated and incremental batches from
that path. Catalog-only publication needs an explicit database-to-public-output
contract first; substituting zero or an invented quantity is unsafe.

The desktop app and `agent-*` functions do not exist in this baseline. Their paths
below are proposals, not working integrations. No vendor compatibility or live
Supabase/Vercel parity is established by this audit.

## Verified repository map

All paths are relative to the repository root.

| Area | Exact existing paths and integration points |
| --- | --- |
| Rules and product context | `AGENTS.md`, `CLAUDE.md`, `README.md`, `docs/PRD.md` (notably 5.7, 6.1–6.3, security), `docs/ARCHITECTURE.md` (2.1–2.4, flows, security), `docs/SHOP_PC_SETUP.md` |
| Shop PC route | `src/app/[lang]/(account)/sync/page.tsx` implements `/[lang]/sync`; route groups are not URL segments. `src/app/manifest.ts` starts the installed browser app at `/sync`. |
| Watcher and manual upload | `src/components/FolderSync.tsx`: `check`, `upload`, `uploadChosenFile`; both file sources use the same Edge Function. Manual upload has no folder settle check. |
| Browser persistence | `src/lib/folderStore.ts`: IndexedDB `ppi-folder`/`kv`; `folder:<shopId>` and `attempt:<shopId>` are used by FolderSync. `newestStockFile`, `compress` implement selection and gzip. |
| Owner mapping UI | `src/app/[lang]/(account)/dashboard/translations/page.tsx` implements `/[lang]/dashboard/translations`; mapping writes are in `src/app/[lang]/(account)/dashboard/actions.ts`. |
| Auth and clients | `src/lib/auth.ts`, `src/lib/supabase/client.ts`, `src/lib/supabase/server.ts`, `src/lib/supabase/public.ts`, `src/lib/supabase/env.ts`; shop membership is enforced again in SQL. |
| Upload processing | `supabase/functions/stock-pull/index.ts`: `handler`, `receiveUpload`, `readBody`, `processFile`, `applyMapping`, `alreadyApplied`, `keepRawFile`, `recordImport`, translation/IndexNow/revalidation helpers. |
| Core tables and permissions | `supabase/migrations/20261001000002_tables.sql`, `20261001000003_auth_helpers.sql`, `20261001000004_rls.sql` (all under `supabase/migrations/`); later updates supersede some original policies/columns. |
| Full snapshot transaction | `supabase/migrations/20261008000001_stock_pull.sql`: `apply_stock_file(uuid,jsonb,timestamptz,jsonb)`; execution revoked from public/anon/authenticated and granted to service_role. |
| Check-in, original and current | `supabase/migrations/20261009000001_folder_upload.sql`: original `upload_check_in(uuid)`; latest definition in `supabase/sql/43_inventory_reset.sql:748`. |
| Mapping, latest definition | `supabase/sql/40_translations.sql:1642`: `owner_set_mapping`; requires source_code, name, quantity and price. Also handles language columns and file texts. |
| Privacy and public stock | `supabase/migrations/20261018000001_shop_page_updates.sql`: private-column/sample/report enforcement and latest `public_stock` view; `20261001000005_stock_logic.sql` defines freshness functions, with the latest availability_label override in `20261018000001_shop_page_updates.sql`. |
| Public search, latest definitions | `supabase/sql/42_performance.sql`: `search_stock`, `shop_stock`, stored search index; prior translations/search definitions in migration `20261014000001_item_translations.sql`. |
| Public consumers | `src/lib/stock.ts`, `src/components/StockLine.tsx`, `src/lib/publicApi.ts`, `src/app/mcp/route.ts`, `src/lib/jsonLd.ts`, `src/lib/shopChat.ts`, `src/lib/aiSearch.ts`, `src/lib/sources.ts`; pages under `src/app/[lang]/shops/[slug]/`, `src/app/[lang]/items/[id]/`, and `src/app/site/[lang]/[slug]/`. |
| Cache invalidation | `src/lib/publicCache.ts`, `src/lib/supabase/public.ts`, `src/app/api/revalidate/route.ts`; stock-pull calls `/api/revalidate` after updated stock and background translations. |
| Reset and deletion | `supabase/sql/43_inventory_reset.sql`, `src/app/[lang]/(account)/sync/inventoryActions.ts`, `src/lib/inventoryReset.ts`, `src/lib/stockImports.ts`, `src/components/InventoryDangerZone.tsx`, `src/components/RecentImports.tsx`. |
| Existing related local output | `src/components/ConversationFolderSync.tsx` exports finished assistant PDFs, not stock or translation files. `src/components/LanguageFileUpload.tsx` uploads secondary-language files. |
| Tests | `supabase/functions/stock-pull/index_test.ts`, `supabase/functions/paste_safe_test.ts`, `supabase/tests/database_test.sql`, `supabase/tests/run.sh`, `supabase/tests/supabase_shim.sql`, `src/lib/findable_test.ts`, `src/lib/chat_test.ts`, `src/lib/ownerItems_test.ts`, `src/lib/strings_test.ts`, `src/i18n/i18n_test.ts`. |
| Tooling | Root `package.json`/`package-lock.json`: Next.js 16.3.8, React 19, TypeScript, npm; Edge Functions use Deno (`supabase/functions/deno.json`, `deno.lock`). Existing lint/typecheck/build, test:functions, check:functions, test:db, test:site/chat/items/strings/i18n scripts. No agent package/build targets yet. |

Current SQL updates reach `supabase/sql/44_slider_ratio.sql`; **43 is already
`43_inventory_reset.sql`**. At this baseline the next free number is 45, not the
handover's illustrative 43. Recheck immediately before any approved SQL work;
new SQL belongs in one new numbered `supabase/sql/` file, never edits to applied
files or new files in `supabase/migrations/`. The owner alone applies it later.

## Current upload contract and where the agent fits

1. FolderSync checks every 15 minutes (20-second timer to catch up after sleep).
   It selects the newest direct `.xml/.csv/.txt/.xlsx` file, ignores dotfiles and
   `~$` files, waits 60 seconds since last modification, then compares size and
   modification time again after reading. Web Lock `ppi-folder-<shopId>` protects
   only cooperating tabs in that browser origin/profile.
2. With its Supabase owner session it calls RPC `upload_check_in(p_shop_id)`.
   That SECURITY DEFINER function checks `is_shop_member` or legacy `is_admin`,
   creates the sync_sources row if absent, updates `folder_seen_at`, and returns
   latest_file_time, last_checked_at, last_error, mapping_status, freshness_state,
   folder_seen_at, last_file_name and (update 43) files_cleared. It is a write,
   **not a read-only status call**, completeness proof or upload reservation.
3. The browser sends raw bytes to
   `POST <Supabase URL>/functions/v1/stock-pull?shop_id=<uuid>&file_time=<ISO>&file_name=<name>[&gzip=1]`
   with `Authorization: Bearer <owner access token>`, public `apikey`, and
   `Content-Type: application/octet-stream`. The Edge handler repeats check-in
   with the caller identity before using its own server-only service-role client.
4. It clamps future file times to now and substitutes now for missing/invalid
   file_time. `alreadyApplied` skips time <= latest_file_time only for a confirmed
   mapping. It does not verify source provenance, sequence or content hash.
5. `readBody` limits decompressed bytes to 50 MB; processFile rejects empty/no-row
   files. Format detection reads CSV/TXT, XML repeated records, or first-sheet
   XLSX; `.edf`, DBF and old `.xls` are not supported parsers. Encoding support
   includes update 40's preview/selection, beyond the older guide's UTF-8/1250.
6. The raw file is retained privately for seven days. Mapping is proposed, never
   auto-approved. No good rows or more than 5% unreadable rows returns
   layout_changed, retaining old stock. At up to 5%, good rows alone are applied.
7. `apply_stock_file` upserts product identities, shop_items and inventory in one
   transaction; missing shop items become quantity zero. File texts are applied
   separately afterward. Reports expose approved columns only (last ten per
   shop). A successful HTTP 200 can still contain result.status=error, proposed,
   waiting_for_approval or layout_changed; it is not proof stock was updated.
8. Background work preserves translations, IndexNow and public-cache refreshes.
   Additional existing branches are `preview=1`, `encoding=...`,
   `translation_lang=<lang>` (text-only secondary-file application), and
   `action=delete_files` (owner-authorized raw-file deletion). None is device auth.

### Proposed device integration (requires later approval)

- `apps/pos-sync-agent/` owns local acquisition, validation, source capability
  reporting, bounded durable queue and narrow desktop UI. It reads only an
  authorized export location or documented read-only connector. Preserve original
  names, quantities, decimal precision, currencies, source timestamps and encoding;
  no invented stock or lossy truncation. TXT is delimited text, not any vendor binary.
- Proposed `supabase/functions/agent-pair/index.ts`: owner starts and explicitly
  approves pairing for a shop; short-lived, single-use, rate-limited code. Store
  hashed device credentials server-side, scoped to one shop/source with revocation
  and expiry/rotation. Recheck current ownership on every operation.
- Proposed `supabase/functions/agent-status/index.ts`: separate device heartbeat
  and last source observation from applied stock freshness; return only necessary
  state and owner mapping status. Keep owner `upload_check_in` behavior compatible.
- Proposed `supabase/functions/agent-upload/index.ts`: authenticate device and
  derive shop/source from its binding, then validate completeness, mapping version,
  active source and replay state. Do not trust a supplied shop_id. Device tokens
  cannot currently pass upload_check_in and must not be disguised as owner JWTs.
  Do not call stock-pull with a service-role bearer to bypass its owner check.
- Extend stock-pull with a narrowly authorized internal device path, or a common
  processing boundary that preserves its single-file, paste-deployable constraint.
  Choose this explicitly in the next contract phase; blindly forwarding an opaque
  device credential or copying the importer into a second divergent function is
  not compatible today. Both browser and device flows must reach the same guarded
  apply transaction and preserve owner approval, reports, translations and cache
  invalidation. No desktop direct inventory writes or service-role key.
- Reject non-full, catalog-only or estimated batches before existing apply logic.
  Required metadata: device/source binding, source generation, full/completeness
  evidence, knowledge class, source observation time, receipt time, content hash,
  mapping version and idempotency key. Client completeness=true is insufficient:
  connector-specific end-of-export/page-count/count reconciliation is needed.

## Safety findings and required controls

| Risk in current behavior or proposed extension | Control required before enabling agents |
| --- | --- |
| A syntactically valid truncated file or a single REST page passes the row-quality checks and zeroes absent inventory. The 60-second wait is a heuristic, not proof of completion. | Stable bytes plus supported completion signal/atomic export where available; connector full-export reconciliation; reject empty, partial, duplicate-code or unexplained count-drop batches. Owner-reviewed recovery for suspicious drops; never manufacture missing values. |
| Up to 5% invalid rows are dropped, then their absent existing codes can be zeroed. SQL uses DISTINCT ON for duplicate codes and truncates codes/names. | Stricter agent snapshot preflight, unique-code/length checks and no partial apply; preserve existing browser semantics until a separately approved change. No silently truncated normalized records. |
| Timestamp skip is outside the apply transaction. apply_stock_file contains no source lease, FOR UPDATE timestamp recheck or idempotency receipt. Two overlapping requests can read the same old cursor and apply out of order. | Serialize per shop in the database; within one transaction recheck source generation, revocation/membership, mapping version, timestamp/sequence and content hash; persist idempotency result with the apply. Check-in's earlier row update does not cover the later transaction. |
| Browser Web Locks do not coordinate desktop, other profiles, other PCs or manual uploads. sync_sources has a shop-wide mapping/cursor, not independent source streams. | One authoritative source per shop for MVP; server-enforced source selection/generation covering browser/manual/device paths. Keep browser fallback, but require explicit owner handoff. Old queued uploads must fail after handoff; do not silently promote a fallback. No partitions in MVP. |
| Copied files acquire new modification times; missing/invalid times become now. Replays can appear fresh. | Immutable source observation time across retries, separate received_at; strict agent timestamp validation, future/skew handling and hash/sequence reconciliation. Never refresh stock because heartbeat succeeded. |
| HTTP success and durable stock commit differ; text/report/background work can fail after stock commit. | Interpret structured outcomes; persist terminal vs retryable results. Waiting mapping pauses application and prompts owner. On ambiguous failures replay the same idempotency key; a logical receipt must recover the committed outcome. |
| Existing raw upload carries every column to private storage; name heuristics do not prove privacy. Mapping a sensitive field into a public role could disclose it. | Section 0's stricter PC privacy boundary wins: omit purchase-price/supplier/margin/customer fields locally by default; allowlist only explicitly authorized public columns. There is no current “private mapping role” granting safe publication. Private retention needs explicit owner consent; no such values in proposals, previews, logs or queues by accident. Bind owner-approved mapping to the filtered format; never auto-approve changed headers. |
| A stolen owner refresh token grants wider authority than uploading one shop. | Per-device scoped tokens in tested OS-backed storage; fail closed if unavailable; revocation, audit, pairing brute-force/replay/CSRF protection. Renderer and logs never receive credentials. No embedded service role in Electron, .env files, website, Vercel or repo. |
| Electron/connector access reaches filesystem/LAN; hostile feed data or arbitrary URLs/commands could execute code or probe services. | contextIsolation, no nodeIntegration, sandbox, restrictive CSP and typed IPC; authorize sender/frame, paths and hosts, block traversal/symlink escape, redirects/DNS rebinding and unintended private/metadata destinations. Explicitly permit the selected local mServer only; no arbitrary shell export commands or internet exposure of mServer. Enforce parse/decompression/time limits, secure queue ACLs/encryption and redacted diagnostics. |
| Update 43 resets/deletes stock while an agent has old queued files; reset currently leaves no device generation barrier. | Serialize resets/restores/source changes with apply; invalidate old source generations and pending batches, honor files_cleared/reset state, and require explicit resumption with a newly observed complete export. Never resurrect deleted data automatically. |
| Cached pages or AI/schema.org still claim availability after a knowledge-class change. | Keep SQL authoritative, preserve revalidation and IndexNow hooks, audit every public consumer and cache after catalog/source-mode transitions. Never use payment as ranking input. |

## Catalog-only compatibility change

Today `inventory.quantity` is NOT NULL with default 0, applyMapping rejects absent
quantity, owner_set_mapping requires it, and apply_stock_file coalesces NULL to 0.
The public_stock view inner-joins inventory and derives availability from quantity
and shop-wide latest_file_time. Adding only an optional JSON quantity field would
therefore either reject the catalog or mislabel it as sold out. Omitting inventory
rows would hide those items entirely. Recent catalog delivery must not refresh
previous stock knowledge.

Design and review the following together before enabling class A:

1. Model `catalog_only` versus `reported_stock` explicitly at the authoritative
   source/batch and public item contract; reserve `estimated_stock` as unsupported.
   Represent unknown quantity as unknown (nullable quantity plus constrained state,
   or separate catalog/stock observations), never zero. Track catalog/price
   observation time separately from stock observation time. Define source-mode
   transitions so old reported stock cannot leak through a new catalog source.
2. Separate catalog upsert/reconciliation from full-stock apply: owner approval can
   omit quantity only for a catalog source; update names, identities and actual
   observed price without creating stock facts. Decide missing-catalog-item
   retirement independently; absence is not sold out. Reject incremental data from
   the full-snapshot path. Price-less catalogs also require explicit support: the
   current mapping requires price, so never synthesize it.
3. Update SQL views/functions first: public_stock, availability rules, search_stock,
   shop_stock, only_available and owner item counts/filters. Catalog quantity and
   availability remain NULL, is_available=false; only_available excludes them.
   Keep known reported zero distinct from unknown; stale stock stays suppressed.
   New catalog UI says “Sold here / availability unconfirmed”, not “in stock”.
   Preserve the one data-driven display rule, not owner display-mode overrides.
4. Propagate knowledge state and timestamps through `src/lib/stock.ts`, StockLine,
   public pages and own-domain pages, publicApi/OpenAPI/MCP, shopChat/aiSearch and
   sources' good-result logic. Catalog discovery must not count as verified
   available stock. JSON-LD may show an actually observed price under its policy,
   but must omit stock availability claims for unknown stock. Review llms.txt,
   freshness texts, ownerItems and cached public responses too.
5. Add sk/hu/en messages (same approach for agent UI), SQL checks and unit/smoke
   coverage for missing quantity, actual zero, stale/never-known, source switches,
   only_available, public APIs/AI and structured data. Keep originals/translations
   and private-field guarantees. Default existing sources to reported full stock
   only with their existing semantics; do not rewrite historical shop values.

These are required future cross-cutting shared-file changes, not edits in this
PR. A later approved SQL phase uses the next free numbered supabase/sql file and
adds every rule to database_test.sql; no applied SQL file is edited or executed
against production by the agent.

## Phased implementation plan — all later phases require owner OK

| Phase | Deliverable and boundary | Exit evidence |
| --- | --- | --- |
| 0 — this PR | Preserve handover; audit real paths/contracts, risks, catalog requirements and source arbitration. Stop for owner review. | Documentation-only diff; source references and byte-identical handover checked. |
| 1 — contract and auth | Agree reported-full-snapshot envelope and transactional receipt/source-generation design. Scoped pairing/status/upload in proposed agent-* paths; one newly numbered SQL file for owner review, no production execution. Shared stock-pull changes only after open-PR check and rebase. | Local-only wrong-shop/revoked/expired/replayed pairing, ownership-loss, concurrent/out-of-order snapshot and browser/manual arbitration tests; existing upload compatibility tests pass. |
| 2 — local Windows agent | Electron in apps/pos-sync-agent, sk/hu/en white/Quicksand UI, tray, sync/pause, authorized file watch/manual pick, secured bounded queue/backoff and diagnostics. Full reported stock only. | Stable-write/partial export/empty/duplicate/oversize/privacy tests, offline restart/replay tests, safe-storage failure tests; isolated local upload through existing processing verified without production. |
| 3 — non-production integration | Owner-approved mapping, full snapshot -> public search, cache refresh, revocation/source handoff and reset recovery. | Local/staging fixture proves missing items -> zero only for verified complete reported snapshots; failed imports leave old stock; server-rendered/API/MCP/AI outputs agree. No staging unless separately configured/authorized. |
| 4 — guarded catalog capability | Approve and implement the cross-cutting contract above before accepting catalog-only sources. Estimated quantities remain disabled. | Unknown never becomes zero/InStock/OutOfStock; no refreshed stock from catalog heartbeat; all public and owner outputs tested. Can be deferred while class B pilots. |
| 5 — verified connectors | Generic documented read-only REST only where pagination/completeness can be proven; then one authorized real POS installation at a time. | Exact model/firmware/edition/module/license and actual export fields recorded. POHODA XML/mServer, Elcom Euro2A .edf, MRP DBF, iKelp and Money S3 stay research targets until conversion, access and stock semantics are tested. PLU/sales alone are not inventory. |
| 6 — pilot packaging | Windows NSIS and portable EXE; macOS later on macOS; uninstall without touching POS. | Clean Windows install/start/restart/stop tests and real shop acceptance. macOS build/runtime tested separately. Signing/notarization is an owner decision; unsigned pilot warning documented, never disabling antivirus. |

Translation overlap: Claude Code's planned `preklady/` output from browser `/sync`
is a future coordination point. Do not implement it here or let stock watchers
upload translation-output files as full stock. Keep the input/output directories
separate; future ownership/handoff needs agreement. Existing secondary-language
uploads are not evidence that unattended translation-file export already exists.

Before any later shared-file edits: inspect open PRs and rebase onto newest main;
list all shared paths in the same PR. Expected touchpoints include stock-pull,
FolderSync, mapping actions/UI, sync reset actions, public stock consumers, message
files and SQL test assertions. Do not modify CLAUDE.md merely to authorize a design.

## Validation and limitations of this audit

Source inspection covers the stock path, latest SQL overrides, RLS/guards, test
assertions, package scripts and relevant product/architecture/shop-PC documentation.
Original docs contain historical guidance (e.g. removed display modes, the old
browser-only decision); current source and handover section 0 govern this proposal.

No application or database tests were rerun for this documentation-only change;
earlier environment-onboarding results were on an older commit and are not claimed
as validation of this baseline or any agent. Future validation uses the existing
lint/typecheck/build and relevant Deno scripts, plus test:db only against an
explicit throwaway local Postgres/PostGIS. E2E must use a local target and test
owner, never production; package test:e2e and preview CI are not pilot certification.

Git fetch of main succeeded. Both GraphQL and REST open-PR lookups returned
Forbidden from api.github.com, including the unsandboxed read attempt. Open-PR
conflict inspection remains unverified; no shared source files were edited. PR
publication will be attempted once for this branch; no merge or deployment is
part of this task. Live schema state, vendor protocols/licenses, Windows/macOS
installers and real-world completeness remain unverified.

**Stop here. Wait for the owner's OK before implementation.**
