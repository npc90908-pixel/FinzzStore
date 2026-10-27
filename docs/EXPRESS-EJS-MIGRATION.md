# Express.js + EJS migration notes

## Runtime boundary

`server.js` creates the HTTP server from the Express application. Express owns the
request middleware boundary, disables the `X-Powered-By` header, configures the
EJS view root, and passes requests to the compatibility handler in `src/app.js`.
That compatibility handler is deliberately retained while API families are
migrated: it preserves existing CSRF/origin rules, webhook raw-body signature
verification, route contracts, and the established PostgreSQL repository layer.

`src/render.js` renders the shared document shell through `views/layouts/document.ejs`.
Existing browser modules in `public/js/pages/` remain responsible for interactive
page content during this migration stage. This is not a claim that every page has
already been rewritten as a standalone EJS template.

## Safe next migration slices

1. Port public page GET routes into `src/routes/web/*.js` Express routers.
2. Port read-only JSON endpoints and preserve response envelopes/status codes.
3. Port auth endpoints after request-origin, CSRF, session, and rate-limit tests pass.
4. Port payments and supplier routes last, preserving raw request bytes for HMAC
   verification and existing idempotency/database transaction behavior.
5. Remove the compatibility handler only after the full route-contract suite and
   staging browser tests pass.

## Database changes

Migration `012_astrapay_zero_fee_guard.sql` updates the AstraPay RPC functions
without editing migration 011 and adds a database constraint enforcing the
existing zero-fee policy. A gateway unique-code offset may still make
`pay_amount` higher than the deposit amount; the ledger credits only the verified
base amount, never that offset.

Run `npm run db:migrate:dry` first, review the output, back up production, and then
run `npm run db:migrate` against the intended database. No production database was
changed as part of the ZIP audit.
