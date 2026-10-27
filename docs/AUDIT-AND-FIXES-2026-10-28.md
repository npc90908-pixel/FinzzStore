# FINZZ Store — implementation pass after source audit

Date: 2026-10-28

## Implemented in this source pass

- Added Express 5 application boundary in `src/express-app.js`; `server.js` and the Vercel handler now dispatch through Express.
- Added EJS document template at `views/layouts/document.ejs`; `src/render.js` now renders the document shell with EJS and safe JSON serialization.
- Preserved the existing custom route handler as a compatibility adapter. This is intentional: current API contracts, CSRF/origin checks, webhook raw-body validation, and database services must not be broken by a wholesale route rewrite. The API routes have **not** all been individually ported to Express Router yet.
- Added `qrcode` server dependency and local QR image rendering from AstraPay's QRIS payload. The wallet UI displays QRIS directly inside FINZZ, amounts/fees/expiry, and an AstraPay checkout fallback.
- Added authenticated wallet polling every five seconds while a gateway invoice is pending. Polling only reads FINZZ's own wallet API; it does not trust browser redirects or public provider status as payment proof.
- Removed the AstraPay adapter's hard-coded zero-fee rejection. The adapter now checks the provider's base amount, credit amount, fee fields, and minimum total payable amount, while crediting only the expected wallet amount.
- Fixed the AstraPay webhook fee comparison: `fee_qris` is compared with the provider's QRIS fee field, not the sum of QRIS and service fees.
- Added database migration `012_astrapay_dynamic_fees.sql` to replace the two gateway RPCs without editing already-applied migration 011. It permits declared non-negative fees while ensuring the amount paid covers base amount plus declared fees. `pay_amount` may additionally include a unique payment code. Wallet credit remains the base/credit amount only.
- Updated the in-memory database driver to apply the same non-negative fee and payable amount checks as PostgreSQL.
- Updated deployment preflight: TeleKos webhook secret is optional when polling is used; TeleKos API key remains required for the live supplier path. AstraPay credentials are optional until automatic payment is enabled.
- Updated Vercel function file inclusion to include EJS templates under `views/**`.
- Updated CI to regenerate the lockfile before `npm ci` because this workspace could not reach the npm registry to resolve new packages.

## Checks completed here

- `node scripts/check.mjs`: PASS — 94/94 JavaScript files parse; no physical `.html` files; ESM-only source; no server secret markers in public assets.
- `bash -n deploy.sh`: PASS.
- `node --check server.js` and `node --check src/express-app.js`: PASS.
- AstraPay adapter smoke test with nonzero QRIS/service fees: PASS — fee total Rp7, customer payable Rp1,007, wallet credit Rp1,000.
- Structural assertions for EJS, Express wiring, and migration 012: PASS.

## Not verified / still required before production

- At the time of the original ZIP source pass, `npm test` could not start because dependencies were incomplete. The post-import integration run now passes; see the update at the end of this document.
- The local runtime is Node 22.22.3 while the project targets Node 24.x.
- The original source pass could not regenerate `package-lock.json`. The post-import integration run regenerated and installed the lockfile; see the update below.
- Live TeleKos calls cannot be verified without the FINZZ supplier API key and a reachable provider. No real order was created.
- Live AstraPay invoice, webhook, QR scan, and payment reconciliation cannot be verified without FINZZ's own project slug/API key/webhook secret and explicit permission to perform a live payment.
- No production database was connected or modified. Run `npm run db:migrate:dry`, inspect the proposed migration, back up the target database, and only then run `npm run db:migrate`.
- Browser-level visual/E2E testing of landing, dashboard, admin, mobile breakpoints, and console/network errors remains required in staging. This source pass fixes the known wallet QR/payment UX but does not certify every UI page bug-free.
- Express is the runtime boundary, but the old router is still behind the compatibility adapter. Full route-by-route Express Router migration remains a follow-up task and must preserve all API contracts.

## Follow-up audit — TeleKos and production connection errors

- TeleKos response-body reads now remain covered by the request timeout; a slow
  body cannot outlive the configured timeout after headers arrive.
- Successful HTTP responses are only counted as verified after valid JSON object
  parsing. Invalid response payloads no longer mark an endpoint verified.
- OTP messages are sorted newest-first using `received_at`, matching the provider
  contract even if the response array is returned in a different order.
- TeleKos webhook deliveries that fail processing or arrive before the local
  order row exists now remain retryable. Failed deliveries can be reclaimed by
  a later signed provider retry; successful delivery IDs remain idempotent.
- Added SQL migration `013_telekos_webhook_retry.sql` and appended its function
  update to `database/MIGRATIONS_APPLY_IN_SQL_EDITOR.sql`.
- The Vercel logs show Supabase `EMAXCONNSESSION` exhaustion. Production must use
  Supabase Transaction Pooler (`DATABASE_URL`, port `6543`) rather than Session
  Pooler (`5432`). This is a deployment environment setting and cannot be changed
  safely by editing source code alone.
- Live TeleKos credentials and a real order were not available here; no claim of
  live provider verification is made. Apply migration 013 to the actual database
  before expecting webhook retry recovery in production.

## Integration update — 2026-10-28

- Regenerated `package-lock.json` for Express 5, EJS, and QRCode; `npm ci` completed.
- `npm run check`: PASS — 94/94 JavaScript files parse.
- `npm test`: PASS — 129 tests.
- `npm audit --audit-level=high`: PASS — zero vulnerabilities.
- Added a Vercel/Express response-finish wait so the serverless handler does not
  resolve before Express finishes writing the response.
- Added integer validation for AstraPay fee amounts in migration 012 and its
  combined SQL-editor apply file.
- The SQL suite and live-provider/browser checks still require CI or staging;
  no production database was modified as part of this import.
