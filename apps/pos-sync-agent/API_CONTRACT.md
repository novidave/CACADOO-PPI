# Device API integration proposal — version 1

This is a **client contract for the future web/backend work**, not an existing
service or deployment. Root website and stock-pull are unchanged. The owner starts
pairing in the web app; the app can later link to this connector's installers. Do
not wire the desktop to raw inventory tables or hand it an owner/service-role key.

All endpoints live at `<project-origin>/functions/v1/<name>` over HTTPS. The client
uses direct TLS with default certificate verification, resolves and pins a checked
public IPv4 address for the actual connection, refuses redirects, credentials in
URLs, non-443 ports and private/LAN hosts. Bodies/responses are bounded at 50 MB
and requests at 30 seconds. The client currently does not use a system HTTP proxy.

## `POST agent-pair`

Request: `{"version":1,"code":"<single-use owner-approved code>"}`.

Response:

```json
{
  "deviceId": "00000000-0000-4000-8000-000000000001",
  "shopId": "00000000-0000-4000-8000-000000000002",
  "sourceId": "00000000-0000-4000-8000-000000000003",
  "generation": 1,
  "token": "<opaque scoped device credential>",
  "expiresAt": "2026-11-01T12:00:00.000Z"
}
```

Owner web flow must check session and current membership, explicit device/shop/source
consent, short pairing TTL, rate limits and single-use atomic consumption. Device
credentials are hashed server-side, revocable and scoped to this source/shop;
never treat a caller-supplied shop id as authorization. Code must not grant owner,
admin, mapping-approval, deletion or raw-storage permissions. Expiry requires
re-pairing in this pilot; no refresh-token API is implemented.

## `GET agent-status`

`Authorization: Bearer <device token>`. Response:

```json
{
  "active": true,
  "generation": 1,
  "mappingApproved": true,
  "mappingVersion": "canonical-columns-v1",
  "latestSourceTime": null
}
```

Return last **applied source observation**, not heartbeat time. active must include
current membership, device revocation and authoritative source selection. The
client stops for inactive/wrong generation, expired credentials or unapproved
mapping, and checks status before every acquisition/retry. Status checks must not
make public stock fresher. The backend must also recheck everything at commit.

The owner mapping screen must explicitly approve this connector's canonical
public columns. The client never approves mapping. Because first acquisition is
gated on mappingApproved, the future pairing/setup flow must register these known
canonical column names for owner review without requiring an initial stock upload.
Otherwise first pairing would wait forever for a mapping proposal.

## `POST agent-upload`

`Authorization: Bearer <device token>`, `Content-Type: application/json`, and
`Idempotency-Key: <batch id>`. Example body (CSV content abbreviated):

```json
{
  "version": 1,
  "sourceId": "00000000-0000-4000-8000-000000000003",
  "generation": 1,
  "knowledge": "reported_stock",
  "mode": "full",
  "sourceTimestamp": "2026-10-27T12:00:00.000Z",
  "sha256": "<sha256 of exact UTF-8 CSV bytes>",
  "rowCount": 2,
  "mappingVersion": "canonical-columns-v1",
  "format": "csv",
  "encoding": "utf-8",
  "file": "source_code;name;quantity;price;currency\r\n..."
}
```

The idempotency key is SHA-256 of `generation:sourceTimestamp:contentHash`, scoped
server-side to the bound device/source/shop. Preserve timestamp, bytes, hash and
key on retry. The single queued snapshot also retains the approved mapping version;
a changed mapping pauses rather than reinterpreting an old batch. The body does
**not** claim that a client boolean proves completeness. Reject full-snapshot use
for incomplete sources, incremental pages, unknown quantity or catalog data.

A committed response must match the exact batch/source/generation:

```json
{
  "status": "updated",
  "idempotencyKey": "<same batch id>",
  "sourceId": "00000000-0000-4000-8000-000000000003",
  "generation": 1
}
```

`unchanged` is also a completed receipt with the same identity fields.
`{"status":"waiting_for_approval"}` pauses the client without discarding the batch.
HTTP 2xx with any other payload is not accepted as success. Use 401/403 for
invalid/revoked credentials, 409 for source/mapping/timestamp conflicts, 429 for
rate limits, and 5xx for transient failures. Client backoff is exponential; current
pilot does not parse Retry-After. No diagnostics may echo tokens or private values.

## Backend work still required (outside this change)

Use the audited stock-pull parsing/application behavior with a narrow, independently
authorized device entry. Device tokens cannot pass today's owner-only
upload_check_in; don't impersonate an owner or bypass it using a service bearer.
Keep any modified Edge Function single-file/paste-deployable. A separate design
review must choose the internal processing boundary instead of copying an importer.

Under a per-shop transactional lock: recheck membership, active source/generation,
revocation, mapping version, strict timestamp/sequence, completeness constraints,
byte hash, size/count and idempotency; persist the receipt with the application.
Return the stored receipt on a replay after a lost reply. Prevent concurrent browser,
manual and device writes by enforcing the same source selection on all paths.
Reset/restore/source handoff must invalidate generations so queued data cannot
resurrect removed stock. Preserve raw-file privacy, import reports, translations,
IndexNow and public cache refreshes after successful apply.

The backend envelope is JSON, so enforce a wire-size limit allowing for JSON escaping
and a separate 50 MB decoded-file limit; don't silently truncate. Catalog-only
support is a separate database/public-output contract. Do not fake stock with zeros.
No SQL or API endpoint in this proposal has been applied to a local or production
backend by this connector task. See the repository POS agent audit for the complete
future catalog/source-arbitration change list.
