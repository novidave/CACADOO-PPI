# Cacaduu Connector (pilot source client)

A standalone Electron/TypeScript companion. **Nothing in the Next.js website,
Supabase functions or database is changed by this package.** The web app's device
API is a future integration: see [API_CONTRACT.md](API_CONTRACT.md). Pairing and
real uploads cannot work until that compatible backend exists. No direct fallback
to stock-pull, owner refresh tokens or service-role credentials is implemented.

## What works in this package

- Choose a dedicated export file; periodically re-read that exact file (not an
  arbitrary newest file from a folder). CSV/TXT (UTF-8, semicolon/comma/tab/pipe),
  one unambiguous scalar-record XML list, first-sheet XLSX. No EDF, DBF or XLS.
- Public column selection, exact full-export row-count check, no unknown quantity,
  duplicate codes, private-looking mappings, stale/future source observations or
  silently truncated identifiers. A 60-second settle check and before/after file
  metadata comparison precede file reads. Local validation needs no pairing.
- A generic **documented public HTTPS JSON API** using page numbers starting at 1,
  configurable field paths, bearer auth, immutable snapshot time and exact total
  across pages. This is not a POHODA/mServer or arbitrary REST adapter.
- Canonical public CSV sent through the future device API, stable idempotency key,
  owner mapping-approval gate and source-generation/revocation gate. Purchase-cost
  in the sample never enters the outbound CSV. Original public values are kept.
- OS-encrypted config, API credentials and a durable single-snapshot queue. At most
  one pending batch, 50 MB source/output limit, 24-hour retention limit (expired
  batches pause and need explicit discard), 20 send attempts, exponential backoff
  capped at six hours. No raw source rows or credentials in logs/renderer.
- Tray, pause, explicit resume/sync, optional open-at-login. Restart always pauses.
  Single instance per OS user. sk/hu/en UI with English fallback for diagnostic
  messages; Quicksand bundled under its included OFL licence. CSP and restricted
  IPC; renderer has no Node or network access.

Full reported-stock snapshots only. Catalog-only and estimated sources are
rejected. The expected count is an owner-reviewed safeguard, **not proof of vendor
export completeness**: an incomplete export with the same row count could still
pass. Pilot use requires a vendor-supported complete export signal/procedure and
accurate source timestamps. A future connector must prove its own completeness.
Changes in legitimate inventory count intentionally stop sync until reviewed.

## Develop

Use Node 24 and npm, in this directory (independent lockfile; root files unchanged):

```bash
npm ci
npx --no-install install-electron  # fetch/verify Electron 45 once before GUI use
npm run typecheck
npm test
npm run build
npm start
```

For this cloud machine, the Electron binary downloader needs the existing HTTPS
proxy and a writable cache; keep verification enabled:

```bash
NODE_USE_ENV_PROXY=1 electron_config_cache=/workspace/.electron-cache npm ci --cache /workspace/.npm
NODE_USE_ENV_PROXY=1 electron_config_cache=/workspace/.electron-cache npx --no-install install-electron
```

The installer and caches stay outside version control. No backend/service starts
as part of install or build. The cloud machine's Linux sandbox helper currently
prevents an Electron GUI launch; don't disable the sandbox to work around it.
Use a supported desktop with OS secure storage. Linux `basic_text` storage is
refused. An unreadable encrypted state is preserved, not overwritten. Disconnect
clears local binding/queue only; owner revocation on the server remains necessary.

## First local trial (no upload)

1. Copy `samples/stock.csv` into a **dedicated** export location; the source file
   stays owned by the POS. The connector never writes/deletes it.
2. Enter the planned API project origin, choose **Export file**, expected rows **2**,
   and the default canonical column names. Saving pauses and clears pairing;
   changing source/config requires pairing again. REST bearer tokens must be
   re-entered when saving changed REST settings; saved secrets are never returned
   to the renderer. Currency is an explicit source column; none is invented.
3. Choose the file. After its last modification is at least one minute old, click
   **Validate file locally**. It checks and constructs the filtered public snapshot
   in memory, returns only its row count, and makes no network request.
4. Do not pair a production shop for this pilot. Once the non-production device
   API exists, obtain an owner-approved code, pair, approve the canonical columns
   on the web app, and explicitly resume. The active source gate must cover the
   existing browser/manual uploads too. Keep the browser as an owner-selected
   fallback, not a concurrent writer.

Code and name must be text (especially EANs/codes with leading zeroes in Excel).
XLSX numeric XML values are read as strings to avoid rounding; Excel formatting is
not reconstructed. XML does not flatten nested vendor formats. Windows-1250 and
other non-UTF-8 text files must be exported as UTF-8 first; decoding fails closed.
Source observation time must be genuine, not a copied file's new modification time.
Keep future `preklady/` translation outputs outside this input location.

## Build on the target OS

```bash
npm run build:win           # Windows NSIS installer
npm run build:win-portable  # portable EXE
npm run build:mac           # macOS DMG (on macOS)
```

These are packaging targets, **not tested installer releases**. Run Windows builds
on Windows, macOS on macOS; verify the system tray, startup, secure storage,
uninstall, file locking and offline recovery on a clean target machine. Unsigned
Windows installers may show SmartScreen; signing/notarization is an owner choice.
Never disable antivirus. A real nonempty Cacaduu ICO is bundled for Windows.

No named POS is certified. Start with a shop's complete CSV export. Vendor model,
firmware, module/licence, quantity semantics and unattended export need confirmation
before writing a POHODA, Elcom, MRP, Money S3 or iKelp-specific adapter. LAN/private
APIs, IPv6, arbitrary command execution, sales-derived inventory and translation
file output are deliberately unsupported in this pilot.

## Validation recorded in this cloud task

23 core/API/persistence tests passed on Node 24 with Electron 45 types.
Core/API unit tests exercise privacy, incomplete/duplicate/unknown-stock rejection,
row and timestamp validation, pagination consistency, private-host restrictions,
revocation/source generation and mapping approval, and retry receipt identity.
Type checking and renderer/main/preload build are separate from native runtime and
real integration tests. No production endpoint was called and no database command
was run. Native desktop launch and Windows/macOS installers remain unverified.
