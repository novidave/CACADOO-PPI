# CACADUU — POS Sync Agent: Project Handover

**Prepared:** 27 October 2026  
**Intended recipient:** OpenAI Codex / developer taking over implementation  
**Project:** CACADUU / CACADOO-PPI  
**Repository:** https://github.com/novidave/CACADOO-PPI  
**Website:** https://cacaduu.com  
**Status:** Architecture and MVP planning. **Section 0 added after checking the repository (27 Oct 2026) — it overrides the rest where they differ.** This document is **not** a claim that the desktop agent or any specific POS integration is complete.  
**Last reviewed source:** Public GitHub README and architecture document (architecture documentation marked 10 October 2026); vendor pages listed at the end. Re-audit the current Git tree before editing.

---

## 0. Repository rules Codex must follow (added after checking the repository)

Codex reads `AGENTS.md`; this repository's real rules are in **`CLAUDE.md`** (Claude Code's file). **Read `CLAUDE.md` in full before anything else and follow its "Hard rules", "Stock upload" and "Shop PC" sections.** The most important ones for this project:

- **Workflow:** one branch (`feature/pos-sync-agent`), one pull request, **never merge**. Stop when ready and wait for the owner's OK. Never run anything against the production Supabase project or Vercel production.
- **Database changes:** NOT in `supabase/migrations/` (that folder holds updates 1–21 only; the live migration history is empty). Every new change is **one new numbered file in `supabase/sql/`** (the next free number, e.g. `43_pos_agent.sql`) that the owner pastes into the Supabase SQL Editor himself. Never edit an applied file. Add a check to `supabase/tests/database_test.sql` for every rule; `npm run test:db` must pass.
- **Secrets:** never the Supabase service-role/secret key in the web app, the Electron app, `.env*`, Vercel or the repo. Anything that needs it is a Supabase Edge Function (`supabase/functions/<name>/index.ts`, single file, paste-deployable — see `paste_safe_test.ts`).
- **Existing upload path (verified):** `stock-pull` receives `POST ?shop_id=&file_time=&file_name=[&gzip=1]` with the owner's JWT after `upload_check_in(shop_id)`; a file not newer than `sync_sources.latest_file_time` is skipped; mapping proposals are **never auto-approved**; `apply_stock_file()` applies a full snapshot (missing items → quantity 0); more than 5 % unreadable rows → old stock kept. The browser agent is `src/components/FolderSync.tsx` + `src/lib/folderStore.ts` (`/[lang]/sync`, Edge/Chrome, every 15 min).
- **Data rules:** PPI never edits, corrects or completes shop data; private columns (everything not in the approved mapping) stay in the private `raw-files` bucket only; purchase prices, suppliers and margins never leave the shop PC unless the owner explicitly maps them as private; payment never affects search ranking; availability and freshness labels are decided only in the database.
- **Texts:** every visible text in `src/i18n/messages/{sk,hu,en}.json` (Slovak is the source); the agent's own UI uses the same keys/approach (sk/hu/en at least).
- **Design:** the website is white background, black text, thin grey lines, Quicksand, no colours except the status dots. Use the same look for the agent unless the owner decides otherwise (this replaces "modern dark UI" in section 8).
- **Working next to Claude Code:** the owner also uses Claude Code on this repository. Keep changes inside `apps/pos-sync-agent/`, `docs/POS_AGENT.md`, new `supabase/functions/agent-*` and one new `supabase/sql/` file. Before touching shared files (`stock-pull`, `FolderSync`, `CLAUDE.md`, message files) check open pull requests and rebase on the newest `main`; list every shared file you change in the PR.
- **Planned overlap:** a planned Claude Code feature writes translation files (`preklady/`) from the browser `/sync` window. The agent could take this over later (it runs without an open browser). Do not build it now; mention it in the audit.
- **Releases:** an unsigned Windows installer shows a SmartScreen warning. Code signing (a certificate, yearly cost) is a separate decision for the owner; the pilot may ship unsigned with clear install instructions.

---

## 1. Mission

CACADUU helps customers discover **which nearby physical stores carry a product**, the price, and—**only when reliable stock data is available**—its current reported availability. CACADUU is the user's **own website and backend**, not Shopify.

Create **CACADUU POS Sync Agent**, a Windows/macOS desktop companion for shops with old or local inventory/POS software. Its job is to obtain data that the shop software legitimately makes accessible, validate and normalize it, and deliver it securely to CACADUU's existing ingestion stack.

**Important distinction:** The agent solves *local access* and *automated delivery*. It cannot magically enable a prohibited/disabled vendor feature, extract quantities a register never tracks, or circumvent software licensing.

## 2. Decisions already made

- **Marketplace goal:** Nearby product discovery from physical shops, not e-commerce checkout or order processing.
- **Website:** Existing functioning/partial CACADUU site; retain its technology and data. Public repository contains Next.js 16 + TypeScript on Vercel; Supabase Postgres/PostGIS, Auth, Storage and Edge Functions.
- **Initial shops:** Both legacy Slovak cash registers/inventory applications and modern API-based systems.
- **Import strategy:** Automatic retrieval **where supported**; manual export/upload otherwise.
- **Desktop platform:** Windows first, macOS eventually, using Electron + Node.js + TypeScript.
- **No Shopify dependency.** No separate marketplace database.
- **Connector ambition:** Expand to dozens/100 EU providers over time, **not** 100 working integrations in MVP. Unsupported connectors must be labeled unsupported.
- **Three data quality classes are required:** (A) catalog + price only, (B) reported inventory quantities, (C) derived/estimated quantities. See next section.

## 3. Why catalog vs quantity vs estimates matters

| Data source | What it supports | Acceptable public claim | Risk |
|---|---|---|---|
| **Catalog-only**: names, SKUs/EANs and prices | Discover what a store normally carries | **“Sold here / availability unconfirmed”**; show observed price with time if permitted | An item may be currently out of stock |
| **Actual inventory**: current source-system remaining quantities | Availability and quantity display | **“Shop reports X in stock”**, with timestamp/freshness | POS balance may be late or inaccurate |
| **Calculated inventory**: opening stock plus movements | Only if all receipts, sales, returns, breakage, adjustments, transfers etc. are captured | **“Estimated stock”** with confidence limitations | Sales alone cannot reveal remaining stock |

**Recommendation:** Support A and B in the platform, but do not conflate them. Delay C until data completeness can be validated. A legacy register may expose its product list and sales without ever maintaining an authoritative on-hand balance. Do not assume PLU quantity means stock.

**Existing compatibility issue:** CACADUU's documented `stock-pull` pipeline is designed for **complete stock snapshots** and marks absent items quantity zero. Catalog-only feeds and partial API updates cannot safely be fed into that same behavior without a deliberate backend/schema/UI change. First release can enable B for inventory-ready integrations while introducing an explicit **catalog-only** mode as a separate, guarded capability once designed/tested.

## 4. Why the desktop agent is useful (and when it isn't)

**Useful when:**
1. Inventory files are generated on a shop PC; an unattended watcher can recognize completed CSV/XML/XLSX/TXT exports and upload them.
2. An authorized local program/utility/CLI/API can export stock, but it isn't internet-connected; the agent can initiate export according to supported documentation.
3. A local mServer or LAN service (e.g., suitably configured POHODA) is available only inside the store.
4. Vendor-documented USB/COM communication can provide actual relevant product/quantity records.
5. Shops need retry queues, persistent background operation, connection diagnostics and easy status displays independent of an open browser tab.

**Unnecessary when:**
- A cloud POS offers a supported cloud API that CACADUU can poll directly server-side with suitable consent and authentication.
- A shop is satisfied using CACADUU's existing browser `/sync` interface and manual upload.

**Not a solution when:**
- A restricted license blocks programmatic data exchange.
- No supported export/API/device protocol is available.
- The cash register keeps only a PLU list and no stock balance; cannot produce reliable ‘X units left’ without another inventory source.

## 5. Existing CACADUU implementation — verify before coding

Public repository currently documents:

- **Stack:** Next.js 16 (App Router, TypeScript, Tailwind), Vercel, Supabase Postgres/PostGIS, Auth, Storage, Edge Functions.
- **Browser folder sync:** `src/components/FolderSync.tsx`, `src/lib/folderStore.ts`. Edge/Chrome local folder access, periodic checks (~15 minutes), with manual fallback.
- **Ingestion:** `supabase/functions/stock-pull/index.ts`. Raw file POST with owner's login and parameters resembling `shop_id`, `file_time`, `file_name`, optional `gzip=1`; mapping proposal/owner approval; file formats CSV/XML/TXT/XLSX.
- **Stock application:** Database routine `apply_stock_file(...)` applies a complete inventory snapshot transactionally. Items missing from an approved full snapshot are set to zero. Import records go into `stock_imports` and sync status into `sync_sources`.
- **Data:** `shops`, `shop_members`, `products`, `shop_items`, `inventory`; public stock view/search functions. Owner authentication and RLS exist.
- **Documented freshness:** `<30 min = current`, `<24 h = recent`, otherwise stale; preserve existing database rules unless deliberately changed.

**Critical:** These descriptions come from repository docs, not a test of live deployment, current schema migrations, or branch changes. Codex must inspect actual source and tests. The live site was not independently validated in this handover.

**Keep, don't replace:** existing imports, owner approval workflow, product identity and translations, search functions, public API and current website account/database architecture.

## 6. Proposed integration

```text
Legacy inventory app / register      Cloud POS with valid API
       |                                    |
       v                                    v
CACADUU Electron Agent            Future server-side cloud connector
  source -> extract/receive -> map -> validate -> queue
       |                                    |
       +----------- authenticated upload ---+
                          |
                CACADUU device-auth API
                          |
             Existing stock-pull processing
             (adapted safely as necessary)
                          |
            Supabase shops/products/inventory
                          |
                  CACADUU customer search
```

**Pairing (proposed; not verified as existing):** Shop owner logs into CACADUU website, generates short-lived pairing code, approves one device for one shop; agent exchanges it for scoped/revocable credentials, stores secrets with OS-backed facilities, and checks device status. Never embed Supabase service-role keys in Electron, commit secrets, or assume a typed `shop_id` is authority.

**Upload API (proposed):** Device-specific authenticated endpoint receiving normalized records or supported raw files; preserve owner mapping approval and full snapshot semantics. Names like `agent-pair`, `agent-upload` and `agent-status` are **proposals**, not known existing endpoints.

**Synchronization invariants:**
- One authoritative source per shop (or per explicitly managed inventory partition) for MVP.
- Accept **full snapshots only** through existing zero-missing-items code. Prevent accidental zeroing from partial API pages, unapproved mappings, empty files, stale files and incomplete exports.
- Idempotency key and monotonic source timestamp; reject out-of-order snapshots.
- Atomic validation → apply; log changes and return meaningful status.
- Upload queue encrypted/secured where appropriate, bounded retention, backoff retries and deduplication.
- Source timestamp and upload timestamp are distinct.
- A failed import or lost internet is **not** zero stock.
- Privately retain only required fields; never upload cost/margin/supplier details unless explicitly authorized by product scope.
- Support explicit `stock_state: unknown | reported | estimated` or equivalent backend representation; do not treat unknown as zero.

### Candidate typed data contract (conceptual)

```typescript
type StockKnowledge = 'catalog_only' | 'reported_stock' | 'estimated_stock';
type TransferMode = 'full' | 'incremental';

interface InventoryProduct {
  sourceProductId: string;
  ean?: string;
  sku?: string;
  name: string;
  price?: number;           // decimal handling/precision TBD
  currency?: string;
  quantity?: number;        // absent = unknown, NOT zero
  unit?: string;
  observedAt?: string;
}

interface InventoryBatch {
  sourceId: string;
  mode: TransferMode;
  completenessVerified: boolean;
  knowledge: StockKnowledge;
  sourceTimestamp: string;
  products: InventoryProduct[];
}

interface ConnectorCapabilities {
  canPullAutomatically: boolean;
  requiresLocalAccess: boolean;
  canProvideCatalog: boolean;
  canProvideReportedStock: boolean;
  hasFullSnapshot: boolean;
}
```

**Note:** Do not assume the existing database can accept this contract as-is. Codex must design migrations and adapters that preserve current behavior. A catalog-only public display requires UI, search, database rules and test changes.

## 7. Initial legacy POS targets and version/module gating

**Priority and confidence:** These are research/testing targets, not proven working connectors. Do not publish vendor compatibility without real hardware or licensed installation testing.

| Target | Practical method | Versions/modules needed to test | Unknowns / warnings |
|---|---|---|---|
| **Elcom EURO-50 / EURO-150 and older EURO models** | Vendor Euro2A utility / supported files, and perhaps documented device protocol | **Specific hardware model and firmware**, matching Euro2A release/driver; old EURO export supports `.edf` in a documented workflow | Exported PLU catalog may not contain remaining stock quantity; don't invent serial commands like `EXPORT PLU CSV` |
| **MRP Vizuálny systém (Sklad)** | Documented stock/DBF/file export | Installed MRP product/release, Sklad module, enabled export functions | Can it export unattended via supported CLI/task? Is quantity provided? Verify per shop |
| **STORMWARE POHODA** | XML inventory export via POHODA mServer or documented XML communication | Supported/licensed edition with XML/mServer enabled, correct user access and settings | **POHODA Start free edition has limits** (vendor currently lists 10 uses of data-handling functions after registration). Do not assume free perpetual polling |
| **iKelp** | Shop-approved file export or documented licensed API | Product edition and export/API module | Endpoint in original draft was unverified; discover actual API/format before implementation |
| **Money S3** | Documented S3 API / export | Appropriate API license/module and installation | Verify access terms, permissions, stock semantics |
| **Generic CSV/XML** | Completed file watcher, manual import, schema mapping | Any exporting stock system | Auto-send is possible even when auto-export is not; user may need to generate file manually |

**POHODA specifics confirmed in vendor docs:** POHODA mServer is configured locally and should remain on internal networks, not internet-exposed. Recent POHODA XML change log refers to stock export and `countIssue` for quantity available for issue (verify precise release, field semantics and licensing). It is XML communication—not an arbitrary generic REST GET.

**Elcom specifics confirmed in vendor docs:** Elcom FAQ documents the Euro2A PLU transfer workflow from older EURO devices using `.edf` files. This is **catalog transfer evidence**, not evidence of continuously retrievable current on-hand stock.

**Before selecting a 'version we need':** Inspect the exact POS model/software edition and firmware in the first participating shop. We cannot truthfully prescribe a single version for all EURO/MRP/POHODA installations.

## 8. MVP scope

### Must build in version 1

1. **Repository/DB audit and technical contract** before code changes.
2. **Desktop app** in `apps/pos-sync-agent/` (Electron + TypeScript): Cacaduu's design (see section 0), shop pairing, connector/source setup, sync now, pause, last result, freshness/last data time, logs, diagnostics, simple tray and optional start-on-login.
3. **File watcher** for authorized local folders: CSV, XML, TXT, XLSX; stable-write detection, parsing/validation and secure uploads; manual file pick.
4. **Generic configurable read-only REST connector** using documented endpoint/schema mapping; pagination, authorization, rate limits and full-snapshot verification. Disable/flag configurations that cannot prove completeness.
5. **Local source capability reporting**: “catalog only”, “reported stock”, “manual export required”, “automatic access not available”, etc.
6. **Device pairing/authentication** integrated with existing Supabase shop ownership; revocation and audit events.
7. **Reliable transfer**: retries, offline queue, deduplication, timestamp correctness and integrity checks.
8. **Preserve** browser `/sync` as fallback and avoid conflicting concurrent sources.
9. **Automated tests** for mapping, file truncation, partial pages, duplicate/out-of-order uploads, auth and offline recovery.
10. **Windows builds**: NSIS installer + portable EXE; macOS DMG built/tested on macOS. No empty icons. Do not require disabling antivirus.

### Next verified connector implementations

- POHODA XML/mServer against real authorized installation and sample files.
- Elcom Euro2A export workflow against a real matching EURO device; only add serial protocol when documented/tested.
- MRP Sklad file export/DBF against a real installation.
- iKelp/Money S3 after documentation and module access confirmed.

### Not MVP

- Building 100 fake stubs as if functional; 100 POS systems is an expansion roadmap.
- Direct eKasa tax/receipt processing or cash register sales edits.
- Writing back to POS, online checkout, Shopify, AI stock forecasts, automatic sales-derived inventory estimates.
- Reverse engineering or bypassing vendor licensing as a design strategy.

## 9. Suggested repository layout

```text
CACADOO-PPI/
  src/                                  # Existing Next.js website (keep)
  supabase/
    functions/
      stock-pull/                       # Existing: inspect / preserve
      agent-pair/                       # Proposed
      agent-upload/                     # Proposed
      agent-status/                     # Proposed
    sql/                                # ONE new numbered file (e.g. 43_pos_agent.sql), run by the owner
    tests/
  apps/
    pos-sync-agent/
      package.json
      src/
        main/                            # Electron main, scheduler, queue, tray
        preload/                         # narrowly scoped IPC
        renderer/                        # app UI
        connectors/                      # csv-xml, generic-rest, POHODA, etc.
        sync/                            # validation, transfer, dedupe
        security/
      tests/
      BUILD-WINDOWS.bat
      BUILD-MAC.sh
  docs/
    POS_AGENT.md                         # new architecture and support matrix
```

Enforce Electron `contextIsolation: true`, `nodeIntegration: false`, sandbox where feasible, restrictive IPC, safe local IPC permissions, secure URL validation to reduce SSRF, and local mServer connections only to user-authorized hosts. OS secure-storage strategy must be tested, including behavior when unavailable.

## 10. Build/release workflow

**Codex starts with audit only**; don't permit live production migrations or uploads as part of initial scaffold. Open new branch (e.g. `feature/pos-sync-agent`).

1. Read `AGENTS.md`, `README.md`, `docs/PRD.md`, `docs/ARCHITECTURE.md`, `docs/SHOP_PC_SETUP.md`, existing `FolderSync`, `folderStore`, `stock-pull`, migrations, RLS, tests and package scripts. Report exact real file paths and routes (do not invent).
2. Write a concise compatibility report and identify the change needed for catalog-only support and source arbitration.
3. Implement locally tested, secure device pairing and a non-production test upload path.
4. Scaffold Electron UI, connector registry, folder watcher, safe queue and diagnostics.
5. Exercise an end-to-end sample-file sync into a local/staging Supabase database and verify marketplace search behavior.
6. Test one actual vendor-specific connector against a **real supported environment**, including version/license detection and quantity semantics.
7. Implement build targets: `start`, `build:win`, `build:win-portable`, `build:mac`; package with electron-builder without broken/zero-byte custom icon config. Code signing/notarization is a separate release requirement.
8. Test Windows installer on a clean Windows host. Test macOS DMG on macOS. Report failures instead of claiming builds universally work.
9. Ship first as **pilot**, not as “100 EU POS supported”.

### Definition of done (pilot)

- Existing shop owner pairs and revokes agent in CACADUU.
- Agent reliably picks up complete file, rejects incomplete/unsafe snapshots and uploads exactly once logically.
- Owner column-mapping approval is respected.
- Search shows correct data and freshness; catalog-only items cannot masquerade as in-stock quantities.
- Unauthorized device cannot upload to another shop.
- Offline retry cannot overwrite newer stock.
- Agent can be stopped/uninstalled without affecting POS operation.
- Windows release tested; macOS release separately tested.
- At least one real legacy shop/source validated end to end.

## 11. Questions for first pilot shop (necessary to select connector/version)

1. What is the **exact cash-register model and firmware**, and which software manages stock (if any)?
2. Does it know **remaining on-hand quantities**, or only PLU entries and sales?
3. Can the system export CSV, XML, DBF or vendor-specific files, and **does that file contain quantity**?
4. Is there a supported CLI/API/USB protocol to **initiate** an export without clicking in the UI?
5. Which installed edition, activated module and license governs data exchange?
6. Can a shop PC remain powered on and connected to the internet?
7. Does the owner consent to an automatically synchronized product catalog and price/stock display on CACADUU?

## 12. Codex starter instruction — paste into Codex in the repo

> You are implementing **CACADUU POS Sync Agent** inside this existing repository. Read `AGENTS.md`, repository README, `docs/ARCHITECTURE.md`, `docs/PRD.md`, `docs/SHOP_PC_SETUP.md`, current `stock-pull` Edge Function, folder-sync components, DB migrations/RLS and tests. Read the accompanying `CACADUU_POS_Sync_Agent_HANDOVER_2026-10-27.md`. **First output**: an audit of current integration points, exact file paths, safety risks and a phased implementation plan. Do not alter production data or deploy. Then, on a feature branch, develop Windows-first Electron + TypeScript app with authenticated device pairing, safe file watcher, generic read-only REST connector, connector capability classification, queue/retries, logs and tests. Integrate with current Supabase ingestion rather than replacing it. Preserve full-snapshot semantics; prevent partial/empty files zeroing inventory; distinguish catalog-only from reported stock. Add vendor-specific connectors only when verified against official protocols and actual installations. Never claim untested compatibility. Build and test installers on supported operating systems and report actual results.

## 13. Source links / verification notes

**Existing CACADUU public repository:**
- https://github.com/novidave/CACADOO-PPI
- https://github.com/novidave/CACADOO-PPI/blob/main/README.md
- https://github.com/novidave/CACADOO-PPI/blob/main/docs/ARCHITECTURE.md
- https://github.com/novidave/CACADOO-PPI/blob/main/docs/PRD.md

**Vendor documentation:**
- STORMWARE POHODA mServer: https://www.stormware.sk/prirucka-pohoda-online/Datova_komunikacia/POHODA_mServer_/
- STORMWARE POHODA XML release changes (stock export): https://www.stormware.sk/pohoda/xml/historiezmen/
- STORMWARE POHODA Start edition limits: https://www.stormware.sk/pohoda/start/
- Elcom product transfer & Euro2A FAQ: https://www.elcom.eu/faq

**Verification classifications:**
- **Documented:** Repository's described architecture; POHODA mServer/XML stock export; registered free POHODA Start's 10 data-operation limit; Elcom Euro2A PLU `.edf` transfer.
- **Design proposal:** Device pairing, new agent endpoints, connector contract, catalog-only platform state, phased build and security policies.
- **Unverified:** Live deployment parity with repository, actual POS vendor editions/API module eligibility, serial protocols, automatic export permissions, remaining quantities exposed by any particular Elcom device, all compiled installers.

---

**Core directive:** Extend CACADUU's working stock-import ecosystem with a secure **local-to-cloud bridge** for legacy shops. Prioritize truthful product availability over claiming many connectors work.
