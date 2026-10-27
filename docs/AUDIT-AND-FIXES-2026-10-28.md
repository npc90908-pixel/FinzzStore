# FINZZ Store — implementation pass after source audit

Date: 2026-10-28

## Implemented in this source pass

- Added Express 5 application boundary in `src/express-app.js`; `server.js` and the Vercel handler now dispatch through Express.
- Added EJS document template at `views/layouts/document.ejs`; `src/render.js` now renders the document shell with EJS and safe JSON serialization.
- Preserved the existing custom route handler as a compatibility adapter. This is intentional: current API contracts, CSRF/origin checks, webhook raw-body validation, and database services must not be broken by a wholesale route rewrite. The API routes have **not** all been individually ported to Express Router yet.
- Added `qrcode` server dependency and local QR image rendering from AstraPay's QRIS payload. The wallet UI displays QRIS directly inside FINZZ, amounts/fees/expiry, and an AstraPay checkout fallback.
- Added authenticated wallet polling every five seconds while a gateway invoice is pending. Polling only reads FINZZ's own wallet API; it does not trust browser redirects or public provider status as payment proof.
- Preserved the zero-fee AstraPay policy: provider QRIS/service fees must both be zero. A `pay_amount` unique-code offset may still make the payable amount higher; it is never credited to the wallet.
- The webhook path matches the QRIS fee field to the independently verified provider order, whose fee checks also reject any nonzero QRIS/service fee.
- Added database migration `012_astrapay_zero_fee_guard.sql` to enforce zero fees at the RPC and table-constraint layers without editing migration 011. The payable amount may include a unique-code offset; wallet credit remains the base/credit amount only.
- Updated the in-memory database driver to reject nonzero fees just like PostgreSQL.
- Updated deployment preflight: TeleKos webhook secret is optional when polling is used; TeleKos API key remains required for the live supplier path. AstraPay credentials are optional until automatic payment is enabled.
- Updated Vercel function file inclusion to include EJS templates under `views/**`.
- Regenerated `package-lock.json` in the import workflow; CI remains on its normal `npm ci` path with the committed lockfile.

## Checks completed here

- `node scripts/check.mjs`: PASS — 94/94 JavaScript files parse; no physical `.html` files; ESM-only source; no server secret markers in public assets.
- `bash -n deploy.sh`: PASS.
- `node --check server.js` and `node --check src/express-app.js`: PASS.
- AstraPay adapter smoke test: PASS — fees are Rp0, payable amount is Rp1,007 with a unique-code offset, and wallet credit is Rp1,000.
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
- Migration 012 now rejects any nonzero AstraPay fee both in the gateway RPCs
  and through a database check constraint. SQL and API tests assert that a
  unique-code offset remains payable but is not credited.
- The SQL suite and live-provider/browser checks still require CI or staging;
  no production database was modified as part of this import.
